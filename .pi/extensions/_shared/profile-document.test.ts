import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	CONFIG_PROFILES_ENTRY_TYPE,
	parseActiveProfileName,
	profilePath,
	profilesDirectoryFor,
	readActiveProfileName,
	readProjectProfile,
	sessionProfileName,
	validateProfileName,
} from "./profile-document.ts";
import { piConfigPath } from "./pi-config.ts";

const roots: string[] = [];

function fixture(marker?: unknown) {
	const root = mkdtempSync(join(tmpdir(), "profile-document-"));
	roots.push(root);
	const settingsPath = join(root, "settings.json");
	const profilesDirectory = join(root, "profiles");
	mkdirSync(profilesDirectory);
	writeFileSync(settingsPath, `${JSON.stringify(marker === undefined ? {} : marker, null, 2)}\n`);
	return { settingsPath, profilesDirectory };
}

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

	it("reads the marker while tolerating absent and invalid values", () => {
		expect(readActiveProfileName(fixture({ configProfiles: { active: "focused" } }).settingsPath)).toBe("focused");
		expect(readActiveProfileName(join(fixture().settingsPath, "..", "missing.json"))).toBeUndefined();
		expect(readActiveProfileName(fixture({ configProfiles: { active: "../bad" } }).settingsPath)).toBeUndefined();
		expect(readActiveProfileName(fixture({ configProfiles: { active: 3 } }).settingsPath)).toBeUndefined();
		expect(readActiveProfileName(fixture({ configProfiles: "nope" }).settingsPath)).toBeUndefined();
	});

	it("parses a marker from a supplied Settings document", () => {
		expect(parseActiveProfileName({ configProfiles: { active: "focused" } })).toBe("focused");
		expect(parseActiveProfileName({})).toBeUndefined();
		expect(parseActiveProfileName({ configProfiles: { active: 3 } })).toBeUndefined();
		expect(parseActiveProfileName({ configProfiles: "nope" })).toBeUndefined();
		expect(parseActiveProfileName({ configProfiles: { active: "../bad" } })).toBeUndefined();
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
	it("returns the validated declaration for a trusted project", () => {
		expect(readProjectProfile(projectFixture(JSON.stringify({ profile: "research" })), true)).toBe("research");
	});

	it("returns undefined for an untrusted project even with a valid declaration", () => {
		expect(readProjectProfile(projectFixture(JSON.stringify({ profile: "research" })), false)).toBeUndefined();
	});

	it("returns undefined for missing and malformed documents", () => {
		const emptyRoot = mkdtempSync(join(tmpdir(), "profile-document-project-"));
		roots.push(emptyRoot);
		expect(readProjectProfile(emptyRoot, true)).toBeUndefined();
		expect(readProjectProfile(projectFixture("{ not json"), true)).toBeUndefined();
	});

	it("returns undefined for an invalid profile name", () => {
		expect(readProjectProfile(projectFixture(JSON.stringify({ profile: "../escape" })), true)).toBeUndefined();
	});
});
