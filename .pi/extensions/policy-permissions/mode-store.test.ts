import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { loadModeFromFile, saveModeToFile } from "./mode-store.ts";
import { piConfigPath } from "../_shared/pi-config.ts";

const trusted = { projectTrusted: true };

function projectWith(document?: unknown): string {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-mode-project-"));
	fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
	if (document !== undefined) fs.writeFileSync(piConfigPath(cwd), JSON.stringify(document));
	return cwd;
}

describe("mode-store", () => {
	it("round-trips a mode through the project document", () => {
		const cwd = projectWith();
		saveModeToFile(cwd, { mode: "auto-review", setAt: 1234 }, trusted);
		expect(loadModeFromFile(cwd, trusted)).toEqual({ mode: "auto-review", setAt: expect.any(Number) });
	});

	it("returns null when no project document exists", () => {
		expect(loadModeFromFile(projectWith(), trusted)).toBeNull();
	});

	it("returns null when the document declares no mode", () => {
		expect(loadModeFromFile(projectWith({ profile: "research" }), trusted)).toBeNull();
	});

	it("returns null for an invalid mode value", () => {
		expect(loadModeFromFile(projectWith({ permissions: { mode: "bogus" } }), trusted)).toBeNull();
	});

	it("an explicit default declaration is honored, not treated as absent", () => {
		const cwd = projectWith({ permissions: { mode: "default" } });
		expect(loadModeFromFile(cwd, trusted)).toEqual({ mode: "default", setAt: expect.any(Number) });
	});

	it("ignores a legacy .pi/approval-mode.json", () => {
		const cwd = projectWith();
		fs.writeFileSync(path.join(cwd, ".pi", "approval-mode.json"), JSON.stringify({ mode: "read-only", setAt: 99 }));
		expect(loadModeFromFile(cwd, trusted)).toBeNull();
		expect(loadModeFromFile(cwd)).toBeNull();
	});

	it("trusted saves write the project document and preserve siblings", () => {
		const cwd = projectWith({ profile: "research" });

		saveModeToFile(cwd, { mode: "auto-review", setAt: 5 }, trusted);

		expect(JSON.parse(fs.readFileSync(piConfigPath(cwd), "utf-8"))).toEqual({
			profile: "research",
			permissions: { mode: "auto-review" },
		});
	});

	it("untrusted projects ignore the project document on load", () => {
		const cwd = projectWith({ permissions: { mode: "full-access" } });
		expect(loadModeFromFile(cwd)).toBeNull();
	});

	it("untrusted saves write nothing", () => {
		const cwd = projectWith();
		saveModeToFile(cwd, { mode: "auto-review", setAt: 1 });
		expect(fs.existsSync(piConfigPath(cwd))).toBe(false);
	});
});
