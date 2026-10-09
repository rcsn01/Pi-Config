import { dirname, extname, join } from "node:path";
import { mutateProjectDocument, readProjectDocument } from "./pi-config.ts";
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

/**
 * Return the validated Profile name declared in the per-project document
 * (`<project>/.pi/pi-config.json`), or undefined for a missing, malformed, or
 * invalid declaration. The active Profile is per-project state regardless of
 * project trust, so this read is not trust-gated.
 */
export function readProjectProfile(cwd: string): string | undefined {
	const profile = readProjectDocument(cwd, true)?.profile;
	if (typeof profile !== "string") return undefined;
	try {
		return validateProfileName(profile);
	} catch {
		return undefined;
	}
}

/**
 * Declare `name` as the project's active Profile, preserving every other key.
 * `undefined` removes the declaration (used to roll back a failed transition).
 */
export function writeProjectProfile(cwd: string, name: string | undefined): void {
	if (name !== undefined) validateProfileName(name);
	mutateProjectDocument(cwd, true, (document) => {
		if (name !== undefined) return { ...document, profile: name };
		const { profile: _previous, ...rest } = document;
		return rest;
	});
}

