/**
 * Shared config-profiles helpers.
 *
 * The active profile file (`.pi/profiles/<name>.json`) is the source of truth
 * for extension-managed settings, while `.pi/settings.json` holds only the
 * `configProfiles.active` marker plus shared pi-core settings. Each session
 * resolves its profile once at start (marker first on new session boundaries,
 * the remembered session entry first on reload) so sibling extensions read and
 * write the session's profile file instead of fighting over settings.json.
 *
 * Lifecycle policy: the binding is resolved once per `session_start` and each
 * consuming extension repoints its settings store at the resolved document
 * (a profile file when one is bound, else the plain settings document —
 * `resolve` always returns a concrete path). `session_tree` navigation updates
 * profile status but never rebinds stores.
 */

import { readFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { PROJECT_SETTINGS_PATH } from "./settings-document.ts";

/** Top-level settings.json key holding the active profile marker. */
export const CONFIG_PROFILES_KEY = "configProfiles";
/** Custom session entry type recording the session's profile name. */
export const CONFIG_PROFILES_ENTRY_TYPE = "configProfiles";

export const PI_DIRECTORY = dirname(PROJECT_SETTINGS_PATH);
export { PROJECT_SETTINGS_PATH } from "./settings-document.ts";
export const PROFILES_DIRECTORY = join(PI_DIRECTORY, "profiles");

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

/**
 * Read the `configProfiles.active` marker from settings.json. Returns
 * `undefined` when the file is missing, malformed, or the marker is absent or
 * invalid — never throws.
 */
export function readActiveProfileName(settingsPath: string): string | undefined {
	let document: unknown;
	try {
		document = JSON.parse(readFileSync(settingsPath, "utf-8"));
	} catch {
		return undefined;
	}
	if (!isRecord(document)) return undefined;
	const namespace = document[CONFIG_PROFILES_KEY];
	if (!isRecord(namespace) || typeof namespace.active !== "string") return undefined;
	try {
		return validateProfileName(namespace.active);
	} catch {
		return undefined;
	}
}

/**
 * Return the `active` name from the last custom session entry of type
 * `configProfiles` (validated), or `undefined` when absent or invalid.
 */
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

/** Absolute path of a profile file for a validated profile name. */
export function profilePath(profilesDirectory: string, name: string): string {
	return join(profilesDirectory, `${validateProfileName(name)}.json`);
}

export interface SessionProfileResolver {
	/** Resolve the session's effective settings document path. */
	resolve(entries: readonly unknown[], reason: string): string;
}

/**
 * Build the session-profile binding for one extension: owns the marker/entry
 * precedence, reload semantics, validation, fallback, and path construction
 * behind one method. On new session boundaries (`startup`/`resume`/`new`/
 * `fork`) the settings.json marker is authoritative (fallback: the remembered
 * session entry). On `reload`, only the remembered session entry is consulted,
 * so another session's `/profile` switch cannot change this session's profile.
 * Always returns a concrete path: the profile file when a name resolves, else
 * the plain settings document.
 */
export function createSessionProfileResolver(options: {
	settingsPath: string;
	profilesDirectory: string;
}): SessionProfileResolver {
	return {
		resolve(entries, reason) {
			const fromEntry = sessionProfileName(entries);
			if (reason === "reload") {
				return fromEntry === undefined ? options.settingsPath : profilePath(options.profilesDirectory, fromEntry);
			}
			const fromMarker = readActiveProfileName(options.settingsPath);
			const name = fromMarker ?? fromEntry;
			return name === undefined ? options.settingsPath : profilePath(options.profilesDirectory, name);
		},
	};
}
