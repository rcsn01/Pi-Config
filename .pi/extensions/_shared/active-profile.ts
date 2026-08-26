/**
 * Shared config-profiles helpers.
 *
 * The active profile file (`.pi/profiles/<name>.json`) is the source of truth
 * for extension-managed settings, while `.pi/settings.json` holds only the
 * `configProfiles.active` marker plus shared pi-core settings. Each session
 * resolves its profile once at start. The session's remembered entry wins on
 * every boundary — another session's marker switch cannot change this
 * session's profile — and the marker is only the default for sessions without
 * a remembered choice. A fresh session created by `/clear` receives a scoped
 * handoff from the outgoing session before sibling `session_start` handlers
 * run. On reload only the remembered entry is consulted, so reloading never
 * picks up another session's switch. Sibling extensions therefore read and
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

const SESSION_PROFILE_HANDOFF_KEY = Symbol.for("pi.extensions.config-profiles.session-handoff.v1");

interface SessionProfileHandoff {
	previousSessionFile?: string;
	profile: string;
}

function sessionProfileHandoff(): SessionProfileHandoff | undefined {
	const globals = globalThis as typeof globalThis & { [SESSION_PROFILE_HANDOFF_KEY]?: SessionProfileHandoff };
	return globals[SESSION_PROFILE_HANDOFF_KEY];
}

/** Stage a profile for a fresh session before its session_start handlers run. */
export function stageSessionProfileHandoff(previousSessionFile: string | undefined, profile: string | undefined): void {
	const globals = globalThis as typeof globalThis & { [SESSION_PROFILE_HANDOFF_KEY]?: SessionProfileHandoff };
	if (profile === undefined) {
		clearSessionProfileHandoff(previousSessionFile);
		return;
	}
	globals[SESSION_PROFILE_HANDOFF_KEY] = {
		previousSessionFile,
		profile: validateProfileName(profile),
	};
}

/** Read a handoff only when it belongs to the session being replaced. */
export function readSessionProfileHandoff(previousSessionFile: string | undefined): string | undefined {
	const handoff = sessionProfileHandoff();
	if (!handoff || handoff.previousSessionFile !== previousSessionFile) return undefined;
	return handoff.profile;
}

/** Clear a completed or cancelled profile handoff. */
export function clearSessionProfileHandoff(previousSessionFile: string | undefined): void {
	const globals = globalThis as typeof globalThis & { [SESSION_PROFILE_HANDOFF_KEY]?: SessionProfileHandoff };
	const handoff = globals[SESSION_PROFILE_HANDOFF_KEY];
	if (handoff && handoff.previousSessionFile === previousSessionFile) delete globals[SESSION_PROFILE_HANDOFF_KEY];
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

/**
 * Extract the validated `configProfiles.active` marker name from a settings
 * document. Returns `undefined` when the namespace, value, or name is absent
 * or invalid — never throws.
 */
export function parseActiveProfileName(document: Record<string, unknown>): string | undefined {
	const namespace = document[CONFIG_PROFILES_KEY];
	if (!isRecord(namespace) || typeof namespace.active !== "string") return undefined;
	try {
		return validateProfileName(namespace.active);
	} catch {
		return undefined;
	}
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
	return parseActiveProfileName(document);
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

/** Why a session started; only `reload` changes the resolution rule. */
export type SessionBoundaryReason = "startup" | "reload" | "new" | "resume" | "fork";

/**
 * Non-reload resolution for callers outside `session_start`, e.g. the
 * `/profile` command: every non-reload boundary composes the same way
 * (entry ?? marker), so this names that composition without inventing a
 * boundary that never fires.
 */
export const NON_RELOAD_REASON: SessionBoundaryReason = "startup";

export interface SessionProfileResolver {
	/**
	 * Resolve the session's effective profile name. The remembered entry is
	 * authoritative on every boundary; a scoped new-session handoff is the
	 * fallback for `/clear`; the settings.json marker is the fallback otherwise,
	 * except on `reload`, where only the entry is consulted. `undefined` when
	 * nothing binds — never throws.
	 */
	resolveName(entries: readonly unknown[], reason: SessionBoundaryReason, previousSessionFile?: string): string | undefined;
	/** Resolve the session's effective settings document path. */
	resolve(entries: readonly unknown[], reason: SessionBoundaryReason, previousSessionFile?: string): string;
}

/**
 * Build the session-profile binding for one extension: owns the marker/entry
 * precedence, reload semantics, validation, and fallback behind two derived
 * methods — `resolveName` (the rule, returning a validated name or
 * `undefined`) and `resolve` (its concrete-path form). Another session's
 * `/profile` switch cannot change this session's profile: the entry wins on
 * every boundary, the marker is only the default for sessions without a
 * remembered choice, and on `reload` the marker is not consulted at all.
 * `resolve` always returns a concrete path: the profile file when a name
 * resolves, else the plain settings document.
 */
export function createSessionProfileResolver(options: {
	settingsPath: string;
	profilesDirectory: string;
}): SessionProfileResolver {
	const resolveName = (entries: readonly unknown[], reason: SessionBoundaryReason, previousSessionFile?: string): string | undefined => {
		const fromEntry = sessionProfileName(entries);
		if (reason === "reload") return fromEntry;
		const fromHandoff = reason === "new" ? readSessionProfileHandoff(previousSessionFile) : undefined;
		return fromEntry ?? fromHandoff ?? readActiveProfileName(options.settingsPath);
	};
	return {
		resolveName,
		resolve(entries, reason, previousSessionFile) {
			const name = resolveName(entries, reason, previousSessionFile);
			return name === undefined ? options.settingsPath : profilePath(options.profilesDirectory, name);
		},
	};
}
