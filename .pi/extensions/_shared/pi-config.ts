/**
 * Per-project Pi-Config document: `<project>/.pi/pi-config.json`.
 *
 * Extension-owned per-project state for the Pi-Config suite. Pi never parses,
 * merges, or validates this file — it is not part of the pi-native
 * `.pi/settings.json` namespace. It travels with the repo, so callers must
 * only honor it for trusted projects (`ctx.isProjectTrusted()`).
 *
 * Schema (namespaced, additive — readers ignore unknown keys):
 *   {
 *     "profile": "research",                  // Profile declared for this project
 *     "permissions": { "mode": "read-only" }, // approval mode for this project
 *     "execPolicy": { "rules": [ ... ] }      // execpolicy rules filling gaps in the global set
 *   }
 *
 * Precedence:
 *   profile       session entry > handoff > project `profile` > global settings marker
 *   approval mode project `permissions.mode` > legacy hashed state store > "default"
 *   exec policy   global rules > project rules > global defaultAction (global always wins)
 *
 * Full schema lives in `.pi/docs/pi-config.md`.
 */
import * as path from "node:path";
import { isRecord, readSettingsDocument, writeSettingsDocument } from "./settings-document.ts";

export function piConfigPath(cwd: string): string {
	return path.join(cwd, ".pi", "pi-config.json");
}

/**
 * Capability probe for `ctx.isProjectTrusted()`. The API only exists on newer
 * pi hosts, and extensions load into whatever binary runs them — an absent
 * probe means the per-project layer (including its trust gate) cannot be
 * evaluated, so callers treat the project as untrusted instead of crashing.
 */
export function isProjectTrustedContext(ctx: { isProjectTrusted?: () => boolean }): boolean {
	return typeof ctx.isProjectTrusted === "function" && ctx.isProjectTrusted();
}

/**
 * Read the document. Returns undefined when the file is missing, malformed, or
 * empty — callers treat that as "nothing declared" and fall back.
 */
export function readPiConfigDocument(documentPath: string): Record<string, unknown> | undefined {
	try {
		const document = readSettingsDocument(documentPath, { missing: "empty" });
		return isRecord(document) && Object.keys(document).length > 0 ? document : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Read-modify-write the document, preserving unknown keys and namespaces.
 * Synchronous and atomic (temp file + rename); the mode file has a single
 * in-process writer, so no mutation queue is needed.
 */
export function mutatePiConfigDocument(
	documentPath: string,
	mutate: (document: Record<string, unknown>) => Record<string, unknown>,
): Record<string, unknown> {
	const next = mutate(readPiConfigDocument(documentPath) ?? {});
	writeSettingsDocument(documentPath, next, { mode: 0o644 });
	return next;
}