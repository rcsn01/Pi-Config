import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EMPTY_STATE, loadState, saveState, type UpdateSkillState } from "./state.ts";

const directories: string[] = [];

function temporaryDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "update-skill-state-"));
	directories.push(directory);
	return directory;
}

afterEach(() => {
	for (const directory of directories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("loadState", () => {
	it("returns empty state when the file is missing", () => {
		expect(loadState(temporaryDirectory())).toEqual(EMPTY_STATE);
	});

	it("returns empty state for corrupt JSON", () => {
		const directory = temporaryDirectory();
		writeFileSync(join(directory, "state.json"), "{ not json", "utf8");
		expect(loadState(directory)).toEqual(EMPTY_STATE);
	});

	it("round-trips a saved state", () => {
		const directory = temporaryDirectory();
		const state: UpdateSkillState = {
			lastCheckedAt: "2025-01-01T00:00:00.000Z",
			skills: { "code-review": { commit: "abc123" } },
		};
		saveState(directory, state);
		expect(loadState(directory)).toEqual(state);
	});
});
