import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CodexAuthInspection, CodexCredential } from "./types.ts";

export function codexAuthPath(): string {
	return join(process.env.CODEX_HOME || join(homedir(), ".codex"), "auth.json");
}

function object(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}

function jwtExpiry(accessToken: string): string | undefined {
	const payload = accessToken.split(".")[1];
	if (!payload) return undefined;
	try {
		const decoded = object(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
		const expires = decoded?.exp;
		if (typeof expires !== "number" || !Number.isFinite(expires)) return undefined;
		return new Date(expires * 1_000).toISOString();
	} catch {
		return undefined;
	}
}

export function parseCodexAuth(value: unknown): {
	credential?: CodexCredential;
	accessTokenPresent: boolean;
	accountIdPresent: boolean;
} {
	const root = object(value);
	const tokens = object(root?.tokens);
	const accessToken = tokens?.access_token;
	const accountId = tokens?.account_id;
	const accessTokenPresent = typeof accessToken === "string" && accessToken.length > 0;
	const accountIdPresent = typeof accountId === "string" && accountId.length > 0;
	return {
		accessTokenPresent,
		accountIdPresent,
		credential: accessTokenPresent && accountIdPresent
			? {
				accessToken,
				accountId,
				expiresAt: jwtExpiry(accessToken),
			}
			: undefined,
	};
}

export async function inspectCodexAuth(
	path = codexAuthPath(),
	options: {
		read?: typeof readFile;
		now?: () => number;
	} = {},
): Promise<CodexAuthInspection> {
	let contents: string;
	try {
		contents = await (options.read ?? readFile)(path, "utf8");
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") {
			return {
				state: "missing",
				path,
				fileFound: false,
				accessTokenPresent: false,
				accountIdPresent: false,
				message: `Codex auth file was not found. Run \`codex login\` and try again.`,
			};
		}
		return {
			state: "unreadable",
			path,
			fileFound: true,
			accessTokenPresent: false,
			accountIdPresent: false,
			message: "Codex auth file could not be read. Check its ownership and permissions.",
		};
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(contents);
	} catch {
		return {
			state: "invalid",
			path,
			fileFound: true,
			accessTokenPresent: false,
			accountIdPresent: false,
			message: "Codex auth file is not valid JSON. Run `codex login` to replace it.",
		};
	}

	const result = parseCodexAuth(parsed);
	if (!result.credential) {
		const missing = [
			!result.accessTokenPresent ? "access token" : undefined,
			!result.accountIdPresent ? "account ID" : undefined,
		].filter(Boolean).join(" and ");
		return {
			state: "invalid",
			path,
			fileFound: true,
			accessTokenPresent: result.accessTokenPresent,
			accountIdPresent: result.accountIdPresent,
			message: `Codex auth file is missing its ChatGPT ${missing}. Run \`codex login\` and try again.`,
		};
	}

	if (result.credential.expiresAt && Date.parse(result.credential.expiresAt) <= (options.now ?? Date.now)()) {
		return {
			state: "expired",
			path,
			fileFound: true,
			accessTokenPresent: true,
			accountIdPresent: true,
			message: "Codex access token has expired. Run `codex login` and try again.",
		};
	}

	return {
		state: "ready",
		path,
		fileFound: true,
		accessTokenPresent: true,
		accountIdPresent: true,
		credential: result.credential,
	};
}
