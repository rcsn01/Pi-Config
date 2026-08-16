/**
 * Permission-mode persistence: read/write the current approval mode to the
 * project state file, including legacy `.pi/approval-mode.json` migration.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { ApprovalMode } from "../_shared/command-policy.ts";
import { projectStatePath } from "../_shared/state-paths.ts";

export interface ModeState {
	mode: ApprovalMode;
	setAt: number;
}

const MODE_FILE = "approval-mode.json";
const LEGACY_MODE_FILE = path.join(".pi", MODE_FILE);

const VALID_MODES: ApprovalMode[] = ["read-only", "default", "auto-review", "full-access"];

export const DEFAULT_MODE_STATE: ModeState = { mode: "default", setAt: Date.now() };

export function saveModeToFile(cwd: string, mode: ModeState): void {
	try {
		const filePath = projectStatePath(cwd, MODE_FILE);
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, JSON.stringify(mode, null, "\t"), { encoding: "utf-8" });
	} catch {}
}

export function loadModeFromFile(cwd: string): ModeState | null {
	try {
		const filePath = projectStatePath(cwd, MODE_FILE);
		const legacyPath = path.join(cwd, LEGACY_MODE_FILE);
		if (!fs.existsSync(filePath) && fs.existsSync(legacyPath)) {
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.copyFileSync(legacyPath, filePath, fs.constants.COPYFILE_EXCL);
		}
		if (fs.existsSync(filePath)) {
			const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
			if (raw?.mode && VALID_MODES.includes(raw.mode)) {
				return { mode: raw.mode, setAt: raw.setAt || Date.now() };
			}
		}
	} catch {}
	return null;
}
