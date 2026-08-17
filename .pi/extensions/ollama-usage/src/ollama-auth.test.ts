import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	blobToPem,
	buildOpenSshBlob,
	makeFixtureKey,
} from "./fixture-key.ts";
import {
	buildAuthorization,
	inspectOllamaAuth,
	ollamaKeyPath,
	parseOpenSshEd25519Key,
	seedToPkcs8,
} from "./ollama-auth.ts";

async function fixtureHome(pem: string): Promise<string> {
	const home = await mkdtemp(join(tmpdir(), "ollama-auth-"));
	await mkdir(join(home, ".ollama"), { recursive: true });
	await writeFile(join(home, ".ollama", "id_ed25519"), pem, { mode: 0o600 });
	return home;
}

describe("Ollama Ed25519 key parsing (openssh-key-v1)", () => {
	it("parses an unencrypted openssh-key-v1 blob into a 32-byte seed and public key", () => {
		const fixture = makeFixtureKey();
		const parsed = parseOpenSshEd25519Key(fixture.pem);
		expect(parsed).toBeDefined();
		expect(parsed!.seed).toHaveLength(32);
		expect(parsed!.publicKey).toHaveLength(32);
		// The parsed public key is the raw 32 bytes carried at the tail of the
		// ssh wire blob.
		const wire = Buffer.from(fixture.publicKeyWireB64, "base64");
		const rawB64 = wire.subarray(wire.length - 32).toString("base64");
		expect(Buffer.from(parsed!.publicKey).toString("base64")).toBe(rawB64);
	});

	it("tolerates PEM armor whitespace and trailing comment/padding bytes", () => {
		const fixture = makeFixtureKey();
		const withComment = fixture.pem + "extra trailing comment\n";
		expect(parseOpenSshEd25519Key(withComment)).toBeDefined();
	});

	it.each([
		["garbage", "not a key at all"],
		["wrong magic", blobToPem(buildOpenSshBlob({
			seed: makeFixtureKey().seed,
			publicKey: makeFixtureKey().publicKey,
			magic: "openssh-key-v2\0",
		}))],
		["encrypted cipher", blobToPem(buildOpenSshBlob({
			seed: makeFixtureKey().seed,
			publicKey: makeFixtureKey().publicKey,
			cipher: "aes256-ctr",
		}))],
		["bcrypt kdf", blobToPem(buildOpenSshBlob({
			seed: makeFixtureKey().seed,
			publicKey: makeFixtureKey().publicKey,
			kdf: "bcrypt",
		}))],
		["multiple keys", blobToPem(buildOpenSshBlob({
			seed: makeFixtureKey().seed,
			publicKey: makeFixtureKey().publicKey,
			keyCount: 2,
		}))],
		["wrong key type", blobToPem(buildOpenSshBlob({
			seed: makeFixtureKey().seed,
			publicKey: makeFixtureKey().publicKey,
			keyType: "ssh-rsa",
		}))],
		["short public key", blobToPem(buildOpenSshBlob({
			seed: makeFixtureKey().seed,
			publicKey: makeFixtureKey().publicKey,
			pubkeySlice: new Uint8Array(16),
		}))],
		["short private key string", blobToPem(buildOpenSshBlob({
			seed: makeFixtureKey().seed,
			publicKey: makeFixtureKey().publicKey,
			privateSlice: new Uint8Array(32),
		}))],
		["mismatched checkint", blobToPem(buildOpenSshBlob({
			seed: makeFixtureKey().seed,
			publicKey: makeFixtureKey().publicKey,
			checkIntMismatch: true,
		}))],
	])("rejects %s", (_label, pem) => {
		expect(parseOpenSshEd25519Key(pem)).toBeUndefined();
	});

	it("rejects truncated binary blobs instead of throwing", () => {
		const fixture = makeFixtureKey();
		const full = Buffer.from(fixture.pem.replace(/^-----BEGIN OPENSSH PRIVATE KEY-----\n|\n-----END OPENSSH PRIVATE KEY-----\n?$/g, ""), "base64");
		for (const length of [0, 5, 15, 20, 50, full.length - 1]) {
			expect(() => parseOpenSshEd25519Key(blobToPem(full.subarray(0, length)))).not.toThrow();
		}
	});
});

describe("Ollama request signing", () => {
	it("signs the app challenge so crypto.subtle verifies it with the public key", async () => {
		const fixture = makeFixtureKey();
		const ts = "1787581800";
		const signed = await buildAuthorization(fixture.pem, ts);
		expect(signed).toBeDefined();

		const [pubkeyB64, signatureB64] = signed!.signature.split(":");
		expect(pubkeyB64).toBe(fixture.publicKeyWireB64);
		expect(signatureB64).toBeTruthy();

		const verifier = await crypto.subtle.importKey(
			"raw",
			fixture.publicKey,
			{ name: "Ed25519" },
			false,
			["verify"],
		);
		const challenge = new TextEncoder().encode(`GET,/api/usage?ts=${ts}`);
		const valid = await crypto.subtle.verify(
			"Ed25519",
			verifier,
			Buffer.from(signatureB64, "base64"),
			challenge,
		);
		expect(valid).toBe(true);

		// A different timestamp must not verify against the same signature.
		const wrong = await crypto.subtle.verify(
			"Ed25519",
			verifier,
			Buffer.from(signatureB64, "base64"),
			new TextEncoder().encode("GET,/api/usage?ts=1"),
		);
		expect(wrong).toBe(false);
	});

	it("signs the same challenge identically to a PKCS8-imported seed", async () => {
		const fixture = makeFixtureKey();
		const ts = "42";
		const key = await crypto.subtle.importKey(
			"pkcs8",
			seedToPkcs8(fixture.seed),
			{ name: "Ed25519" },
			true,
			["sign"],
		);
		const expected = await crypto.subtle.sign("Ed25519", key, new TextEncoder().encode(`GET,/api/usage?ts=${ts}`));
		const signed = await buildAuthorization(fixture.pem, ts);
		const [, signatureB64] = signed!.signature.split(":");
		expect(signatureB64).toBe(Buffer.from(expected).toString("base64"));
	});

	it("returns undefined for an unparseable key", async () => {
		await expect(buildAuthorization("not a key", "123")).resolves.toBeUndefined();
	});
});

describe("Ollama auth inspection", () => {
	it("resolves the fixed home-relative key path", () => {
		expect(ollamaKeyPath("/home/user")).toBe("/home/user/.ollama/id_ed25519");
	});

	it("reports a ready key carrying only the pem credential", async () => {
		const fixture = makeFixtureKey();
		const home = await fixtureHome(fixture.pem);
		const result = await inspectOllamaAuth({ home });
		expect(result).toMatchObject({
			state: "ready",
			fileFound: true,
			path: join(home, ".ollama", "id_ed25519"),
		});
		expect(JSON.stringify(result)).toContain(JSON.stringify(fixture.pem));
	});

	it("reports missing, invalid, and unreadable keys with actionable messages", async () => {
		const missing = await inspectOllamaAuth({ home: "/nonexistent-home-ollama" });
		expect(missing).toMatchObject({ state: "missing", fileFound: false });
		expect((missing as { message: string }).message).toContain("Sign in to the Ollama app");

		const invalidHome = await fixtureHome("not-an-openssh-key SECRET_VALUE");
		const invalid = await inspectOllamaAuth({ home: invalidHome });
		expect(invalid).toMatchObject({ state: "invalid", fileFound: true });
		expect(JSON.stringify(invalid)).not.toContain("SECRET_VALUE");

		const unreadable = await inspectOllamaAuth({
			home: "/home/user",
			read: (async () => { throw Object.assign(new Error("SECRET filesystem error"), { code: "EACCES" }); }) as any,
		});
		expect(unreadable).toMatchObject({ state: "unreadable", fileFound: true });
		expect(JSON.stringify(unreadable)).not.toContain("SECRET");
	});

	it("returns a ready credential that can sign for the probe", async () => {
		const fixture = makeFixtureKey();
		const home = await fixtureHome(fixture.pem);
		const result = await inspectOllamaAuth({ home });
		if (result.state !== "ready") throw new Error("expected ready");
		const signed = await buildAuthorization(result.credential.pem, "42");
		expect(signed).toBeDefined();
		expect(signed!.signature).toMatch(/^[A-Za-z0-9+/]+=*:[A-Za-z0-9+/]+=*$/);
	});
});
