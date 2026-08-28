/**
 * update-skill — persistent state.
 *
 * Lives in `update-skill/state.json` inside this extension's directory
 * (gitignored): when the last
 * background check ran, and the pinned upstream commit per installed skill.
 * Pinning mirrors how pi's own git packages work: a skill is "up to date"
 * when the pinned commit equals the current `origin/<branch>` commit for its
 * path; anything newer upstream counts as an update.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface UpdateSkillState {
	/** ISO timestamp of the last check (session-start or manual). null = never. */
	lastCheckedAt: string | null;
	/** Per-skill pinned upstream commit. A missing entry = not installed via update-skill. */
	skills: Record<string, { commit: string }>;
}

export const EMPTY_STATE: UpdateSkillState = { lastCheckedAt: null, skills: {} };

/** Load `update-skill/state.json` (relative to `dir`); missing or corrupt file → empty state. */
export function loadState(dir: string): UpdateSkillState {
	try {
		const parsed: unknown = JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
		if (isState(parsed)) return parsed;
		return structuredClone(EMPTY_STATE);
	} catch {
		return structuredClone(EMPTY_STATE);
	}
}

/** Persist state, creating the directory as needed. */
export function saveState(dir: string, state: UpdateSkillState): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "state.json"), JSON.stringify(state, null, "\t") + "\n", "utf8");
}

export function getPinned(state: UpdateSkillState, name: string): string | undefined {
	return state.skills[name]?.commit;
}

export function setPinned(state: UpdateSkillState, name: string, commit: string): void {
	state.skills[name] = { commit };
}

export function unpin(state: UpdateSkillState, name: string): void {
	delete state.skills[name];
}

/**
 * Whether a background check should run now: never ran, or the last one is
 * older than `cooldownMs`. Manual `/update-skill` always checks regardless.
 */
export function shouldCheck(state: UpdateSkillState, now: number, cooldownMs: number): boolean {
	if (state.lastCheckedAt === null) return true;
	const last = Date.parse(state.lastCheckedAt);
	if (Number.isNaN(last)) return true;
	return now - last > cooldownMs;
}

function isState(value: unknown): value is UpdateSkillState {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	if (!("skills" in record) || typeof record.skills !== "object" || record.skills === null) {
		return false;
	}
	if (record.lastCheckedAt !== null && typeof record.lastCheckedAt !== "string") return false;
	return true;
}
