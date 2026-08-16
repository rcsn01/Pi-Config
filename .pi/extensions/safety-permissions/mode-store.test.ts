import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadModeFromFile, saveModeToFile } from "./mode-store.ts";

let prevStateDir: string | undefined;

afterEach(() => {
	if (prevStateDir === undefined) delete process.env.PI_CONFIG_STATE_DIR;
	else process.env.PI_CONFIG_STATE_DIR = prevStateDir;
	prevStateDir = undefined;
});

function withStateDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mode-test-"));
	prevStateDir = process.env.PI_CONFIG_STATE_DIR;
	process.env.PI_CONFIG_STATE_DIR = dir;
	return dir;
}

describe("mode-store", () => {
	it("round-trips a mode through save/load", () => {
		withStateDir();
		const cwd = "/workspace";
		saveModeToFile(cwd, { mode: "auto-review", setAt: 1234 });
		expect(loadModeFromFile(cwd)).toEqual({ mode: "auto-review", setAt: 1234 });
	});

	it("returns null when no mode file exists", () => {
		withStateDir();
		expect(loadModeFromFile("/nowhere")).toBeNull();
	});

	it("returns null for an invalid mode value", () => {
		withStateDir();
		const cwd = "/workspace";
		// Write an unknown mode to the computed state path (saveModeToFile does not validate).
		saveModeToFile(cwd, { mode: "bogus" as never, setAt: 1 });
		expect(loadModeFromFile(cwd)).toBeNull();
	});

	it("migrates a legacy .pi/approval-mode.json into the state file", () => {
		withStateDir();
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mode-legacy-"));
		const legacyDir = path.join(cwd, ".pi");
		fs.mkdirSync(legacyDir, { recursive: true });
		fs.writeFileSync(path.join(legacyDir, "approval-mode.json"), JSON.stringify({ mode: "read-only", setAt: 99 }));

		const loaded = loadModeFromFile(cwd);
		expect(loaded).toEqual({ mode: "read-only", setAt: 99 });
	});
});
