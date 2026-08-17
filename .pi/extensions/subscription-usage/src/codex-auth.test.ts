import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { codexAuthPath, inspectCodexAuth, parseCodexAuth } from "./codex-auth.ts";

function jwt(exp: number): string {
	return `header.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.signature`;
}

async function fixture(value: string): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "codex-auth-"));
	const path = join(directory, "auth.json");
	await writeFile(path, value, { mode: 0o600 });
	return path;
}

describe("Codex CLI authentication", () => {
	it("resolves CODEX_HOME before the default home directory", () => {
		const previous = process.env.CODEX_HOME;
		process.env.CODEX_HOME = "/private/codex";
		try {
			expect(codexAuthPath()).toBe("/private/codex/auth.json");
		} finally {
			if (previous === undefined) delete process.env.CODEX_HOME;
			else process.env.CODEX_HOME = previous;
		}
	});

	it("extracts only the access token, account ID, and JWT expiry", () => {
		const accessToken = jwt(2_000_000_000);
		const parsed = parseCodexAuth({
			OPENAI_API_KEY: "must-not-be-used",
			tokens: {
				access_token: accessToken,
				account_id: "account-123",
				refresh_token: "must-not-be-copied",
			},
		});
		expect(parsed).toEqual({
			accessTokenPresent: true,
			accountIdPresent: true,
			credential: {
				accessToken,
				accountId: "account-123",
				expiresAt: new Date(2_000_000_000 * 1_000).toISOString(),
			},
		});
		expect(JSON.stringify(parsed)).not.toContain("must-not-be-copied");
		expect(JSON.stringify(parsed)).not.toContain("must-not-be-used");
	});

	it("reports missing, malformed, and incomplete files without exposing contents", async () => {
		const missing = join(tmpdir(), `missing-codex-${Date.now()}.json`);
		await expect(inspectCodexAuth(missing)).resolves.toMatchObject({
			state: "missing", fileFound: false, accessTokenPresent: false, accountIdPresent: false,
		});

		const malformed = await fixture("not-json SECRET_VALUE");
		const malformedResult = await inspectCodexAuth(malformed);
		expect(malformedResult).toMatchObject({ state: "invalid", fileFound: true });
		expect(JSON.stringify(malformedResult)).not.toContain("SECRET_VALUE");

		const incomplete = await fixture(JSON.stringify({ tokens: { access_token: "SECRET_TOKEN" } }));
		const incompleteResult = await inspectCodexAuth(incomplete);
		expect(incompleteResult).toMatchObject({
			state: "invalid", accessTokenPresent: true, accountIdPresent: false,
		});
		expect(JSON.stringify(incompleteResult)).not.toContain("SECRET_TOKEN");
	});

	it("distinguishes unreadable files and expired credentials", async () => {
		const unreadable = await inspectCodexAuth("/private/auth.json", {
			read: (async () => { throw Object.assign(new Error("SECRET filesystem error"), { code: "EACCES" }); }) as any,
		});
		expect(unreadable).toMatchObject({ state: "unreadable", fileFound: true });
		expect(JSON.stringify(unreadable)).not.toContain("SECRET");

		const path = await fixture(JSON.stringify({
			tokens: { access_token: jwt(100), account_id: "account" },
		}));
		await expect(inspectCodexAuth(path, { now: () => 101_000 })).resolves.toMatchObject({
			state: "expired", accessTokenPresent: true, accountIdPresent: true,
		});
	});

	it("returns a ready credential without persisting or transforming its values", async () => {
		const path = await fixture(JSON.stringify({
			tokens: { access_token: "opaque-token", account_id: "account-123", refresh_token: "refresh-secret" },
		}));
		const result = await inspectCodexAuth(path);
		expect(result).toMatchObject({
			state: "ready",
			credential: { accessToken: "opaque-token", accountId: "account-123" },
		});
		expect(JSON.stringify(result)).not.toContain("refresh-secret");
	});
});
