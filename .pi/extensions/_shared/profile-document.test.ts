import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	CONFIG_PROFILES_ENTRY_TYPE,
	profilePath,
	profilesDirectoryFor,
	readProjectProfile,
	sessionProfileName,
	validateProfileName,
	writeProjectProfile,
} from "./profile-document.ts";
import { piConfigPath } from "./pi-config.ts";

const roots: string[] = [];

function projectFixture(contents: string): string {
	const root = mkdtempSync(join(tmpdir(), "profile-document-project-"));
	roots.push(root);
	mkdirSync(join(root, ".pi"), { recursive: true });
	writeFileSync(piConfigPath(root), contents);
	return root;
}

const entry = (active: unknown) => ({
	type: "custom",
	customType: CONFIG_PROFILES_ENTRY_TYPE,
	data: { active },
});

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Profile document helpers", () => {
	it("validates Profile names", () => {
		expect(validateProfileName("dsv4-flash")).toBe("dsv4-flash");
		expect(() => validateProfileName("../secret")).toThrow(/Invalid profile name/);
	});

	it("reads the last validated Profile session entry", () => {
		expect(sessionProfileName([])).toBeUndefined();
		expect(sessionProfileName([entry("default")])).toBe("default");
		expect(sessionProfileName([entry("default"), entry("focused")])).toBe("focused");
		expect(sessionProfileName([entry("default"), { type: "custom", customType: "other", data: { active: "x" } }]))
			.toBe("default");
		expect(sessionProfileName([entry("../bad")])).toBeUndefined();
	});

	it("derives the default Profile directory from the Settings document", () => {
		const settingsPath = join("project-root", ".pi", "settings.json");
		expect(profilesDirectoryFor(settingsPath)).toBe(join("project-root", ".pi", "profiles"));
	});

	it("builds Profile paths from validated names", () => {
		expect(profilePath("/p", "focused")).toBe(join("/p", "focused.json"));
		expect(() => profilePath("/p", "a/b")).toThrow(/Invalid profile name/);
	});
});

describe("readProjectProfile", () => {
	it("returns the validated declaration", () => {
		expect(readProjectProfile(projectFixture(JSON.stringify({ profile: "research" })))).toBe("research");
	});

	it("returns undefined for missing and malformed documents", () => {
		const emptyRoot = mkdtempSync(join(tmpdir(), "profile-document-project-"));
		roots.push(emptyRoot);
		expect(readProjectProfile(emptyRoot)).toBeUndefined();
		expect(readProjectProfile(projectFixture("{ not json"))).toBeUndefined();
	});

	it("returns undefined for an invalid profile name", () => {
		expect(readProjectProfile(projectFixture(JSON.stringify({ profile: "../escape" })))).toBeUndefined();
	});
});

describe("writeProjectProfile", () => {
	it("sets and removes the declaration while preserving siblings", () => {
		const root = projectFixture(JSON.stringify({ permissions: { mode: "read-only" } }));
		writeProjectProfile(root, "research");
		expect(JSON.parse(readFileSync(piConfigPath(root), "utf-8"))).toEqual({
			permissions: { mode: "read-only" },
			profile: "research",
		});
		writeProjectProfile(root, undefined);
		expect(JSON.parse(readFileSync(piConfigPath(root), "utf-8"))).toEqual({ permissions: { mode: "read-only" } });
	});

	it("rejects invalid names without writing", () => {
		const root = projectFixture("{}");
		expect(() => writeProjectProfile(root, "../escape")).toThrow(/Invalid profile name/);
		expect(readFileSync(piConfigPath(root), "utf-8")).toBe("{}");
	});
});
