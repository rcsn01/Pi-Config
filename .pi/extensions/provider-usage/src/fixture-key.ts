// Test scaffolding: builds fresh throwaway Ed25519 keys in OpenSSH
// (openssh-key-v1) format — the exact layout `ssh-keygen -t ed25519 -N ""`
// writes — from Node's crypto primitives, without ever embedding or printing
// key material. The parse/sign/verify round-trips in the tests (via
// crypto.subtle) independently validate the construction.
import { generateKeyPairSync } from "node:crypto";

export interface FixtureKey {
	pem: string;
	seed: Uint8Array<ArrayBuffer>;
	publicKey: Uint8Array<ArrayBuffer>;
	publicKeyWireB64: string; // base64 of string("ssh-ed25519") + string(32-byte key)
}

export const sshString = (buf: Uint8Array): Uint8Array => {
	const out = new Uint8Array(4 + buf.length);
	new DataView(out.buffer).setUint32(0, buf.length);
	out.set(buf, 4);
	return out;
};

export const sshUint32 = (n: number): Uint8Array => {
	const out = new Uint8Array(4);
	new DataView(out.buffer).setUint32(0, n);
	return out;
};

export const concat = (...parts: Uint8Array[]): Uint8Array => {
	const total = parts.reduce((sum, part) => sum + part.length, 0);
	const out = new Uint8Array(total);
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
};

export const blobToPem = (blob: Uint8Array): string => {
	const wrapped = (Buffer.from(blob).toString("base64").match(/.{1,70}/g) ?? []).join("\n");
	return `-----BEGIN OPENSSH PRIVATE KEY-----\n${wrapped}\n-----END OPENSSH PRIVATE KEY-----\n`;
};

export interface OpenSshBlobOptions {
	seed: Uint8Array;
	publicKey: Uint8Array;
	cipher?: string;
	kdf?: string;
	keyType?: string;
	keyCount?: number;
	pubkeySlice?: Uint8Array;
	privateSlice?: Uint8Array;
	checkIntMismatch?: boolean;
	magic?: string;
}

// Builds an openssh-key-v1 blob. Callers may override individual fields to
// produce malformed variants for parser tests.
export function buildOpenSshBlob(options: OpenSshBlobOptions): Uint8Array {
	const {
		seed,
		publicKey,
		cipher = "none",
		kdf = "none",
		keyType = "ssh-ed25519",
		keyCount = 1,
		pubkeySlice = publicKey,
		privateSlice = concat(seed, publicKey),
		checkIntMismatch = false,
		magic = "openssh-key-v1\0",
	} = options;
	const type = new TextEncoder().encode(keyType);
	const publicBlob = concat(sshString(type), sshString(pubkeySlice));
	const checkint = Math.floor(Math.random() * 0xffffffff);
	const unpadded = concat(
		sshUint32(checkint),
		sshUint32(checkIntMismatch ? checkint + 1 : checkint),
		sshString(type),
		sshString(pubkeySlice),
		sshString(privateSlice),
		sshString(new Uint8Array(0)),
	);
	const padLen = (8 - (unpadded.length % 8)) % 8;
	const padding = Uint8Array.from({ length: padLen }, (_, i) => i + 1);
	return concat(
		new TextEncoder().encode(magic),
		sshString(new TextEncoder().encode(cipher)),
		sshString(new TextEncoder().encode(kdf)),
		sshString(new Uint8Array(0)),
		sshUint32(keyCount),
		sshString(publicBlob),
		sshString(concat(unpadded, padding)),
	);
}

export function makeFixtureKey(): FixtureKey {
	const { publicKey, privateKey } = generateKeyPairSync("ed25519");
	const pkcs8 = new Uint8Array(privateKey.export({ type: "pkcs8", format: "der" }));
	const spki = new Uint8Array(publicKey.export({ type: "spki", format: "der" }));
	const seed = pkcs8.subarray(pkcs8.length - 32);
	const pub = spki.subarray(spki.length - 32);
	const type = new TextEncoder().encode("ssh-ed25519");
	const publicBlob = concat(sshString(type), sshString(pub));
	return {
		pem: blobToPem(buildOpenSshBlob({ seed, publicKey: pub })),
		seed: new Uint8Array(seed),
		publicKey: new Uint8Array(pub),
		publicKeyWireB64: Buffer.from(publicBlob).toString("base64"),
	};
}
