import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { OllamaAuthInspection } from "./types.ts";

// The Ollama app signs ollama.com API requests with the Ed25519 key it
// writes to ~/.ollama/id_ed25519 (ollama/auth/auth.go: defaultPrivateKey).
// There is no environment override in the Ollama source: the path is fixed
// relative to the user's home directory, but is injectable for tests.
export function ollamaKeyPath(home = homedir()): string {
	return join(home, ".ollama", "id_ed25519");
}

const OPENSSH_MAGIC = "openssh-key-v1\0";
const ED25519_TYPE = "ssh-ed25519";

// Fixed PKCS8 DER envelope for an Ed25519 private key: the seed follows a
// 16-byte prefix. Node's webcrypto rejects raw (seed-only) imports for
// Ed25519 signing ("Unsupported key usage for a Ed25519 key"), so the seed
// is wrapped in its PKCS8 form, which both Node and browsers accept.
const ED25519_PKCS8_PREFIX = Uint8Array.from([
	0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);

export function seedToPkcs8(seed: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
	const result = new Uint8Array(ED25519_PKCS8_PREFIX.length + seed.length);
	result.set(ED25519_PKCS8_PREFIX, 0);
	result.set(seed, ED25519_PKCS8_PREFIX.length);
	return result;
}

// Strips PEM armor ("-----BEGIN/END OPENSSH PRIVATE KEY-----") and
// base64-decodes the body, the same way Go's ssh.ParsePrivateKey does.
// Returns undefined when the armor or base64 body is malformed.
function decodeOpenSshPem(pem: string): Uint8Array<ArrayBuffer> | undefined {
	const match = pem.match(/-----BEGIN OPENSSH PRIVATE KEY-----([\s\S]*?)-----END OPENSSH PRIVATE KEY-----/);
	if (!match) return undefined;
	const body = match[1]!.replace(/\s+/g, "");
	if (!body) return undefined;
	const decoded = Buffer.from(body, "base64");
	// Round-trip check: Buffer.from(base64) is lenient about invalid
	// characters, so confirm the body re-encodes to itself.
	const reencoded = decoded.toString("base64").replace(/=+$/, "");
	if (reencoded !== body.replace(/=+$/, "")) return undefined;
	return new Uint8Array(decoded);
}

function ascii(bytes: Uint8Array): string {
	let result = "";
	for (const byte of bytes) result += String.fromCharCode(byte);
	return result;
}

interface Slice {
	value: Uint8Array<ArrayBuffer>;
	next: number;
}

function readString(bytes: Uint8Array<ArrayBuffer>, offset: number): Slice | undefined {
	if (offset + 4 > bytes.length) return undefined;
	const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset);
	if (offset + 4 + length > bytes.length) return undefined;
	return { value: bytes.subarray(offset + 4, offset + 4 + length), next: offset + 4 + length };
}

function readUint32(bytes: Uint8Array<ArrayBuffer>, offset: number): number | undefined {
	if (offset + 4 > bytes.length) return undefined;
	return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset);
}

export interface ParsedEd25519Key {
	seed: Uint8Array<ArrayBuffer>;
	publicKey: Uint8Array<ArrayBuffer>;
}

// Parses an unencrypted OpenSSH private key blob ("openssh-key-v1" format,
// the layout `ssh-keygen -t ed25519` writes) and returns the raw 32-byte
// Ed25519 seed and public key. Returns undefined for anything else: wrong
// magic, a passphrase-encrypted key (cipher/kdf != "none"), multiple keys,
// or a non-ed25519 key type.
export function parseOpenSshEd25519Key(pem: string): ParsedEd25519Key | undefined {
	const decoded = decodeOpenSshPem(pem);
	if (!decoded) return undefined;
	const bytes: Uint8Array<ArrayBuffer> = decoded;
	const magic = new TextEncoder().encode(OPENSSH_MAGIC);
	if (bytes.length < magic.length || !magic.every((byte, index) => byte === bytes[index])) return undefined;
	let offset = magic.length;

	const cipher = readString(bytes, offset);
	if (!cipher || ascii(cipher.value) !== "none") return undefined;
	offset = cipher.next;

	const kdf = readString(bytes, offset);
	if (!kdf || ascii(kdf.value) !== "none") return undefined;
	offset = kdf.next;

	const kdfOptions = readString(bytes, offset);
	if (!kdfOptions) return undefined;
	offset = kdfOptions.next;

	if (readUint32(bytes, offset) !== 1) return undefined;
	offset += 4;

	const publicBlob = readString(bytes, offset);
	if (!publicBlob) return undefined;
	const algorithm = readString(publicBlob.value, 0);
	if (!algorithm || ascii(algorithm.value) !== ED25519_TYPE) return undefined;
	const publicKey = readString(publicBlob.value, algorithm.next);
	if (!publicKey || publicKey.value.length !== 32) return undefined;

	const privateSection = readString(bytes, publicBlob.next);
	if (!privateSection) return undefined;
	let privateOffset = 0;
	const checkInt = readUint32(privateSection.value, privateOffset);
	const checkIntAgain = readUint32(privateSection.value, privateOffset + 4);
	if (checkInt === undefined || checkIntAgain !== checkInt) return undefined;
	privateOffset += 8;
	const privateAlgorithm = readString(privateSection.value, privateOffset);
	if (!privateAlgorithm || ascii(privateAlgorithm.value) !== ED25519_TYPE) return undefined;
	privateOffset = privateAlgorithm.next;
	const privatePublic = readString(privateSection.value, privateOffset);
	if (!privatePublic || privatePublic.value.length !== 32) return undefined;
	privateOffset = privatePublic.next;
	const privateKey = readString(privateSection.value, privateOffset);
	if (!privateKey || privateKey.value.length !== 64) return undefined;
	// The 64-byte private string is the 32-byte seed followed by the 32-byte
	// public key; only the seed is needed to sign. Trailing comment and
	// block-size padding are ignored.

	return {
		seed: new Uint8Array(privateKey.value.subarray(0, 32)),
		publicKey: new Uint8Array(publicKey.value),
	};
}

// Builds the SSH wire blob for a public key: string("ssh-ed25519") followed
// by string(32-byte key). This is exactly what Go's ssh.MarshalAuthorizedKey
// base64-encodes after the "ssh-ed25519 " prefix, which is the pubkey half of
// the app's Authorization header (ollama/auth/auth.go Sign).
function sshPublicKeyBlob(publicKey: Uint8Array): Uint8Array {
	const type = new TextEncoder().encode(ED25519_TYPE);
	const result = new Uint8Array(8 + type.length + publicKey.length);
	const view = new DataView(result.buffer);
	view.setUint32(0, type.length);
	result.set(type, 4);
	view.setUint32(4 + type.length, publicKey.length);
	result.set(publicKey, 8 + type.length);
	return result;
}

export interface SignedAuthorization {
	// "pubkey:signature", each standard base64 — the exact value the Ollama
	// app places in the Authorization header (optionally prefixed with
	// "Bearer ").
	signature: string;
	publicKey: Uint8Array<ArrayBuffer>;
}

// Signs the challenge `GET,/api/usage?ts=<ts>` with the Ed25519 key, matching
// the Ollama app's doSelfSigned pattern (app/ui/ui.go). Returns undefined if
// the PEM is not a parseable Ed25519 key or signing is unavailable.
export async function buildAuthorization(pem: string, ts: string): Promise<SignedAuthorization | undefined> {
	const parsed = parseOpenSshEd25519Key(pem);
	if (!parsed) return undefined;
	try {
		// Node's webcrypto cannot import raw Ed25519 seeds, so the seed is
		// wrapped in its fixed PKCS8 envelope for signing. Node also cannot
		// export a public key from an Ed25519 private key, so the public key
		// embedded in the openssh-key-v1 blob is used for the header, after
		// verifying it matches the seed (the same consistency check Go's
		// ssh.ParsePrivateKey performs).
		const key = await crypto.subtle.importKey("pkcs8", seedToPkcs8(parsed.seed), { name: "Ed25519" }, false, ["sign"]);
		const challenge = new TextEncoder().encode(`GET,/api/usage?ts=${ts}`);
		const signed = await crypto.subtle.sign("Ed25519", key, challenge);
		const signature = new Uint8Array(signed);
		const verifier = await crypto.subtle.importKey("raw", parsed.publicKey, { name: "Ed25519" }, false, ["verify"]);
		const valid = await crypto.subtle.verify("Ed25519", verifier, signature, challenge);
		if (!valid) return undefined;
		const pubkey = Buffer.from(sshPublicKeyBlob(parsed.publicKey)).toString("base64");
		return { signature: `${pubkey}:${Buffer.from(signature).toString("base64")}`, publicKey: parsed.publicKey };
	} catch {
		return undefined;
	}
}

export async function inspectOllamaAuth(
	options: {
		home?: string;
		path?: string;
		read?: typeof readFile;
	} = {},
): Promise<OllamaAuthInspection> {
	const path = options.path ?? ollamaKeyPath(options.home);
	let pem: string;
	try {
		pem = await (options.read ?? readFile)(path, "utf8");
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") {
			return {
				state: "missing",
				path,
				fileFound: false,
				message: "The Ollama key was not found. Sign in to the Ollama app to create ~/.ollama/id_ed25519.",
			};
		}
		return {
			state: "unreadable",
			path,
			fileFound: true,
			message: "The Ollama key could not be read. Check its ownership and permissions.",
		};
	}
	if (!parseOpenSshEd25519Key(pem)) {
		return {
			state: "invalid",
			path,
			fileFound: true,
			message: "The Ollama key is not a valid Ed25519 OpenSSH key. Sign in to the Ollama app to regenerate it.",
		};
	}
	return { state: "ready", path, fileFound: true, credential: { pem, path } };
}
