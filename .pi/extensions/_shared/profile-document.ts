import { readFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
/** Top-level settings.json key holding the active profile marker. */
export const CONFIG_PROFILES_KEY = "configProfiles";
/** Custom session entry type recording the session's profile name. */
export const CONFIG_PROFILES_ENTRY_TYPE = "configProfiles";

/** Return the default Profile directory adjacent to a Settings document. */
export function profilesDirectoryFor(settingsPath: string): string {
	return join(dirname(settingsPath), "profiles");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Profile names are filename stems, never paths or names including `.json`. */
export function validateProfileName(name: string): string {
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || name === "." || name === ".." || extname(name) === ".json") {
		throw new Error(`Invalid profile name "${name}". Use letters, numbers, dots, underscores, or hyphens.`);
	}
	return name;
}

/** Return a validated active Profile marker, or undefined for an absent or invalid marker. */
export function parseActiveProfileName(document: Record<string, unknown>): string | undefined {
	const namespace = document[CONFIG_PROFILES_KEY];
	if (!isRecord(namespace) || typeof namespace.active !== "string") return undefined;
	try {
		return validateProfileName(namespace.active);
	} catch {
		return undefined;
	}
}

/** Read a Profile marker without throwing for a missing or malformed Settings document. */
export function readActiveProfileName(settingsPath: string): string | undefined {
	let document: unknown;
	try {
		document = JSON.parse(readFileSync(settingsPath, "utf-8"));
	} catch {
		return undefined;
	}
	if (!isRecord(document)) return undefined;
	return parseActiveProfileName(document);
}

/** Return the validated Profile name in the last configProfiles session entry. */
export function sessionProfileName(entries: readonly unknown[]): string | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index] as { type?: unknown; customType?: unknown; data?: unknown };
		if (entry?.type !== "custom" || entry.customType !== CONFIG_PROFILES_ENTRY_TYPE) continue;
		const data = entry.data as { active?: unknown } | undefined;
		if (typeof data?.active !== "string") return undefined;
		try {
			return validateProfileName(data.active);
		} catch {
			return undefined;
		}
	}
	return undefined;
}

/** Absolute Profile document path for a validated Profile name. */
export function profilePath(profilesDirectory: string, name: string): string {
	return join(profilesDirectory, `${validateProfileName(name)}.json`);
}
