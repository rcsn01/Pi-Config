import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	EMPTY_STATE,
	getPinned,
	loadState,
	saveState,
	setPinned,
	shouldCheck,
	unpin,
	type UpdateSkillState,
} from "./state.ts";

const HOUR = 60 * 60 * 1000;
const COOLDOWN = 24 * HOUR;

const dirs: string[] = [];

function tmpDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "update-skill-state-"));
	dirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("loadState", () => {
	it("returns empty state when the file is missing", () => {
		expect(loadState(tmpDir())).toEqual(EMPTY_STATE);
	});

	it("returns empty state for corrupt json", () => {
		const dir = tmpDir();
		writeFileSync(join(dir, "state.json"), "{ not json", "utf8");
		expect(loadState(dir)).toEqual(EMPTY_STATE);
	});

	it("round-trips a saved state", () => {
		const dir = tmpDir();
		const state: UpdateSkillState = {
			lastCheckedAt: "2025-01-01T00:00:00.000Z",
			skills: { "code-review": { commit: "abc123" } },
		};
		saveState(dir, state);
		expect(loadState(dir)).toEqual(state);
	});
});

describe("pins", () => {
	it("setPinned/getPinned/unpin", () => {
		const state = structuredClone(EMPTY_STATE);
		expect(getPinned(state, "tdd")).toBeUndefined();
		setPinned(state, "tdd", "deadbeef");
		expect(getPinned(state, "tdd")).toBe("deadbeef");
		unpin(state, "tdd");
		expect(getPinned(state, "tdd")).toBeUndefined();
	});
});

describe("shouldCheck", () => {
	it("always checks when never checked", () => {
		expect(shouldCheck(structuredClone(EMPTY_STATE), Date.now(), COOLDOWN)).toBe(true);
	});

	it("skips when checked within the cooldown", () => {
		const now = Date.now();
		const state: UpdateSkillState = {
			lastCheckedAt: new Date(now - HOUR).toISOString(),
			skills: {},
		};
		expect(shouldCheck(state, now, COOLDOWN)).toBe(false);
	});

	it("checks when the last check is older than the cooldown", () => {
		const now = Date.now();
		const state: UpdateSkillState = {
			lastCheckedAt: new Date(now - 25 * HOUR).toISOString(),
			skills: {},
		};
		expect(shouldCheck(state, now, COOLDOWN)).toBe(true);
	});

	it("checks when the stored timestamp is unparseable", () => {
		const state: UpdateSkillState = { lastCheckedAt: "yesterday-ish", skills: {} };
		expect(shouldCheck(state, Date.now(), COOLDOWN)).toBe(true);
	});
});
