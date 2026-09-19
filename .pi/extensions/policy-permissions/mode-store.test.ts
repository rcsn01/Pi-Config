import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadModeFromFile, saveModeToFile } from "./mode-store.ts";
import { piConfigPath } from "../_shared/pi-config.ts";

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

	it("trusted projects read permissions.mode from .pi/pi-config.json", () => {
		withStateDir();
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mode-project-"));
		fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
		fs.writeFileSync(piConfigPath(cwd), JSON.stringify({ permissions: { mode: "read-only" } }));

		const loaded = loadModeFromFile(cwd, { projectTrusted: true });
		expect(loaded).toEqual({ mode: "read-only", setAt: expect.any(Number) });
	});

	it("an explicit default declaration is honored, not treated as absent", () => {
		withStateDir();
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mode-project-"));
		fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
		fs.writeFileSync(piConfigPath(cwd), JSON.stringify({ permissions: { mode: "default" } }));
		saveModeToFile(cwd, { mode: "auto-review", setAt: 1 });

		const loaded = loadModeFromFile(cwd, { projectTrusted: true });
		expect(loaded).toEqual({ mode: "default", setAt: expect.any(Number) });
	});

	it("trusted projects fall back to the state store when no project mode is declared", () => {
		withStateDir();
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mode-project-"));
		fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
		fs.writeFileSync(piConfigPath(cwd), JSON.stringify({ profile: "research" }));
		saveModeToFile(cwd, { mode: "auto-review", setAt: 7 });

		expect(loadModeFromFile(cwd, { projectTrusted: true })).toEqual({ mode: "auto-review", setAt: 7 });
	});

	it("an invalid project mode falls back to the state store", () => {
		withStateDir();
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mode-project-"));
		fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
		fs.writeFileSync(piConfigPath(cwd), JSON.stringify({ permissions: { mode: "bogus" } }));
		saveModeToFile(cwd, { mode: "read-only", setAt: 3 });

		expect(loadModeFromFile(cwd, { projectTrusted: true })).toEqual({ mode: "read-only", setAt: 3 });
	});

	it("trusted saves write the project document and preserve siblings", () => {
		withStateDir();
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mode-project-"));
		fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
		fs.writeFileSync(piConfigPath(cwd), JSON.stringify({ profile: "research" }));

		saveModeToFile(cwd, { mode: "auto-review", setAt: 5 }, { projectTrusted: true });

		expect(JSON.parse(fs.readFileSync(piConfigPath(cwd), "utf-8"))).toEqual({
			profile: "research",
			permissions: { mode: "auto-review" },
		});
	});

	it("untrusted projects ignore the project document", () => {
		withStateDir();
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mode-untrusted-"));
		fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
		fs.writeFileSync(piConfigPath(cwd), JSON.stringify({ permissions: { mode: "full-access" } }));

		expect(loadModeFromFile(cwd)).toBeNull();
	});
});
