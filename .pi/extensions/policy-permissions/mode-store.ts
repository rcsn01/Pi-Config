/**
 * Permission-mode persistence.
 *
 * The only store is `<project>/.pi/pi-config.json` (`permissions.mode`) in
 * trusted projects — `/permissions` writes it, and it travels with the repo.
 * Untrusted projects persist nothing: loads return null and saves are no-ops,
 * so a mode change there lasts for the session only.
 */
import { isApprovalMode, type ApprovalMode } from "./mode-registry.ts";
import { mutateProjectNamespace, readProjectDocument } from "../_shared/pi-config.ts";
import { isRecord } from "../_shared/settings-document.ts";

export interface ModeState {
	mode: ApprovalMode;
	setAt: number;
}

export interface ModePersistenceOptions {
	/** Honor the per-project `.pi/pi-config.json` document (pi project trust granted). */
	projectTrusted?: boolean;
}

export const DEFAULT_MODE_STATE: ModeState = { mode: "default", setAt: Date.now() };

function parseModeState(raw: unknown): ModeState | null {
	if (!isRecord(raw) || !isApprovalMode(raw.mode)) return null;
	return { mode: raw.mode, setAt: typeof raw.setAt === "number" ? raw.setAt : Date.now() };
}

export function saveModeToFile(
	cwd: string,
	mode: ModeState,
	options: ModePersistenceOptions = {},
): void {
	// The module gates untrusted projects to a no-op. Namespace merge
	// preserves siblings (e.g. "profile").
	mutateProjectNamespace(
		cwd,
		options.projectTrusted === true,
		"permissions",
		(namespace) => ({ ...namespace, mode: mode.mode }),
	);
}

export function loadModeFromFile(
	cwd: string,
	options: ModePersistenceOptions = {},
): ModeState | null {
	if (options.projectTrusted !== true) return null;
	return parseModeState(readProjectDocument(cwd, true)?.permissions);
}
