/**
 * Permission-mode persistence.
 *
 * Trusted projects: `<project>/.pi/pi-config.json` (`permissions.mode`) is the
 * source of truth — `/permissions` writes it, and it travels with the repo.
 * Untrusted projects (and projects without a declaration) fall back to the
 * legacy hashed state store `~/.pi/state/pi-config/<hash>/approval-mode.json`,
 * including the `.pi/approval-mode.json` migration. The fallback is read-only:
 * a trusted project adopts the pi-config document on its first mode change.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { isApprovalMode, type ApprovalMode } from "./mode-registry.ts";
import { mutatePiConfigDocument, piConfigPath, readPiConfigDocument } from "../_shared/pi-config.ts";
import { isRecord } from "../_shared/settings-document.ts";
import { projectStatePath } from "../_shared/state-paths.ts";

export interface ModeState {
	mode: ApprovalMode;
	setAt: number;
}

export interface ModePersistenceOptions {
	/** Honor the per-project `.pi/pi-config.json` document (pi project trust granted). */
	projectTrusted?: boolean;
}

const MODE_FILE = "approval-mode.json";
const LEGACY_MODE_FILE = path.join(".pi", MODE_FILE);

export const DEFAULT_MODE_STATE: ModeState = { mode: "default", setAt: Date.now() };

function parseModeState(raw: unknown): ModeState | null {
	if (!isRecord(raw) || !isApprovalMode(raw.mode)) return null;
	return { mode: raw.mode, setAt: typeof raw.setAt === "number" ? raw.setAt : Date.now() };
}

/** Read the mode declared in the trusted project document, or null. */
function readProjectMode(cwd: string): ModeState | null {
	return parseModeState(readPiConfigDocument(piConfigPath(cwd))?.permissions);
}

export function saveModeToFile(
	cwd: string,
	mode: ModeState,
	options: ModePersistenceOptions = {},
): void {
	if (options.projectTrusted) {
		// Merge-write so sibling namespaces (e.g. "profile") survive.
		mutatePiConfigDocument(piConfigPath(cwd), (document) => ({
			...document,
			permissions: {
				...(isRecord(document.permissions) ? document.permissions : {}),
				mode: mode.mode,
			},
		}));
		return;
	}
	try {
		const filePath = projectStatePath(cwd, MODE_FILE);
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, JSON.stringify(mode, null, "\t"), { encoding: "utf-8" });
	} catch {}
}

export function loadModeFromFile(
	cwd: string,
	options: ModePersistenceOptions = {},
): ModeState | null {
	if (options.projectTrusted) {
		const declared = readProjectMode(cwd);
		if (declared) return declared;
	}
	try {
		const filePath = projectStatePath(cwd, MODE_FILE);
		const legacyPath = path.join(cwd, LEGACY_MODE_FILE);
		if (!fs.existsSync(filePath) && fs.existsSync(legacyPath)) {
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.copyFileSync(legacyPath, filePath, fs.constants.COPYFILE_EXCL);
		}
		if (fs.existsSync(filePath)) {
			return parseModeState(JSON.parse(fs.readFileSync(filePath, "utf-8")));
		}
	} catch {}
	return null;
}