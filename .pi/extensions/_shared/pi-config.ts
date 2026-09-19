/**
 * Per-project Pi-Config document: `<project>/.pi/pi-config.json`.
 *
 * Extension-owned per-project state for the Pi-Config suite. Pi never parses,
 * merges, or validates this file — it is not part of the pi-native
 * `.pi/settings.json` namespace. It travels with the repo, so it is honored
 * only for trusted projects (`ctx.isProjectTrusted()`); every accessor here
 * takes an explicit `projectTrusted` flag and treats untrusted projects as
 * "nothing declared" without touching the file.
 *
 * Namespace semantics live with their domain owners — profile-document.ts
 * (`profile`), policy-permissions/mode-store.ts (`permissions`), and
 * command-policy.ts (`execPolicy`) validate and interpret their namespaces.
 * This module owns document mechanics: path composition, the trust gate,
 * atomic writes, and sibling/unknown-key preservation.
 *
 * Precedence (see .pi/docs/pi-config.md):
 *   profile       session entry > handoff > project `profile` > global marker
 *   approval mode project `permissions.mode` > hashed store > "default"
 *   exec policy   global rules > project rules > global defaultAction
 *
 * Mutation is a synchronous read-modify-write: the read, the mutation, and
 * the write never interleave within a process because none of them awaits,
 * so a mutation queue adds nothing. Atomicity across processes is out of
 * scope (two processes writing one document remain unsupported, as with
 * workflow run directories).
 *
 * Schema (namespaced, additive — readers ignore unknown keys):
 *   { "profile": "research", "permissions": { "mode": "read-only" },
 *     "execPolicy": { "rules": [ ... ] } }
 * Full schema lives in `.pi/docs/pi-config.md`.
 */
import * as path from "node:path";
import { isRecord, readSettingsDocument, writeSettingsDocument } from "./settings-document.ts";

/** Path of `<project>/.pi/pi-config.json`. */
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
 * Trust-gated read of the whole document. Returns undefined when the project
 * is untrusted (no filesystem access) or the document is missing, malformed,
 * or empty.
 */
export function readProjectDocument(
	cwd: string,
	projectTrusted: boolean,
): Record<string, unknown> | undefined {
	if (!projectTrusted) return undefined;
	return readDocumentAtPath(piConfigPath(cwd));
}

/**
 * Trust-gated namespace mutation. Reads the document, applies `mutate` to the
 * namespace object (undefined when absent), and writes the document back
 * atomically, preserving sibling namespaces and unknown keys. Returning
 * undefined from `mutate` removes the namespace. Untrusted projects: no read,
 * no write, returns undefined.
 */
export function mutateProjectNamespace(
	cwd: string,
	projectTrusted: boolean,
	namespace: string,
	mutate: (namespace: Record<string, unknown> | undefined) => Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
	if (!projectTrusted) return undefined;
	let applied: Record<string, unknown> | undefined;
	mutateDocumentAtPath(piConfigPath(cwd), (document) => {
		const existing = document[namespace];
		const current = isRecord(existing) ? existing : undefined;
		applied = mutate(current);
		if (applied === undefined) delete document[namespace];
		else document[namespace] = applied;
		return document;
	});
	return applied;
}

/**
 * Read the document at `documentPath`. Returns undefined when the file is
 * missing, malformed, or empty — callers treat that as "nothing declared" and
 * fall back.
 */
function readDocumentAtPath(documentPath: string): Record<string, unknown> | undefined {
	try {
		const document = readSettingsDocument(documentPath, { missing: "empty" });
		return isRecord(document) && Object.keys(document).length > 0 ? document : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Read-modify-write the document at `documentPath`, preserving unknown keys
 * and namespaces. Synchronous and atomic (temp file + rename).
 */
function mutateDocumentAtPath(
	documentPath: string,
	mutate: (document: Record<string, unknown>) => Record<string, unknown>,
): Record<string, unknown> {
	const next = mutate(readDocumentAtPath(documentPath) ?? {});
	writeSettingsDocument(documentPath, next, { mode: 0o644 });
	return next;
}