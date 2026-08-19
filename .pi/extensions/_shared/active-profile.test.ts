import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	CONFIG_PROFILES_ENTRY_TYPE,
	profilePath,
	readActiveProfileName,
	resolveSessionProfilePath,
	sessionProfileName,
	validateProfileName,
} from "./active-profile.ts";

const roots: string[] = [];

function fixture(marker?: unknown) {
	const root = mkdtempSync(join(tmpdir(), "active-profile-"));
	roots.push(root);
	const settingsPath = join(root, "settings.json");
	const profilesDirectory = join(root, "profiles");
	mkdirSync(profilesDirectory);
	writeFileSync(settingsPath, `${JSON.stringify(marker === undefined ? {} : marker, null, 2)}\n`);
	return { settingsPath, profilesDirectory };
}

const entry = (active: unknown) => ({ type: "custom", customType: CONFIG_PROFILES_ENTRY_TYPE, data: { active } });

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("active profile helpers", () => {
	it("validates profile names", () => {
		expect(validateProfileName("dsv4-flash")).toBe("dsv4-flash");
		expect(() => validateProfileName("../secret")).toThrow(/Invalid profile name/);
	});

	it("reads the marker from settings.json, tolerating absence and invalid values", () => {
		const { settingsPath } = fixture({ configProfiles: { active: "focused" } });
		expect(readActiveProfileName(settingsPath)).toBe("focused");
		expect(readActiveProfileName(join(settingsPath, "..", "missing.json"))).toBeUndefined();
		expect(readActiveProfileName(fixture({ configProfiles: { active: "../bad" } }).settingsPath)).toBeUndefined();
		expect(readActiveProfileName(fixture({ configProfiles: { active: 3 } }).settingsPath)).toBeUndefined();
		expect(readActiveProfileName(fixture({ configProfiles: "nope" }).settingsPath)).toBeUndefined();
	});

	it("reads the last configProfiles session entry, validated", () => {
		expect(sessionProfileName([])).toBeUndefined();
		expect(sessionProfileName([entry("default")])).toBe("default");
		expect(sessionProfileName([entry("default"), entry("focused")])).toBe("focused");
		expect(sessionProfileName([entry("default"), { type: "custom", customType: "other", data: { active: "x" } }]))
			.toBe("default");
		expect(sessionProfileName([entry("../bad")])).toBeUndefined();
		expect(sessionProfileName([{ type: "custom", customType: CONFIG_PROFILES_ENTRY_TYPE, data: {} }])).toBeUndefined();
	});

	it("builds profile paths from validated names", () => {
		expect(profilePath("/p", "focused")).toBe(join("/p", "focused.json"));
		expect(() => profilePath("/p", "a/b")).toThrow(/Invalid profile name/);
	});

	it("prefers the marker on new session boundaries and the entry on reload", () => {
		const { settingsPath, profilesDirectory } = fixture({ configProfiles: { active: "focused" } });
		const entries = [entry("default")];

		expect(resolveSessionProfilePath(entries, settingsPath, profilesDirectory, "startup"))
			.toBe(join(profilesDirectory, "focused.json"));
		expect(resolveSessionProfilePath(entries, settingsPath, profilesDirectory, "reload"))
			.toBe(join(profilesDirectory, "default.json"));
	});

	it("falls back to the entry when the marker is absent, and vice versa", () => {
		const { settingsPath, profilesDirectory } = fixture({});
		expect(resolveSessionProfilePath([entry("default")], settingsPath, profilesDirectory, "startup"))
			.toBe(join(profilesDirectory, "default.json"));

		const marked = fixture({ configProfiles: { active: "focused" } });
		expect(resolveSessionProfilePath([], marked.settingsPath, marked.profilesDirectory, "reload"))
			.toBe(join(marked.profilesDirectory, "focused.json"));
	});

	it("returns undefined when neither source yields a valid name", () => {
		const { settingsPath, profilesDirectory } = fixture({});
		expect(resolveSessionProfilePath([], settingsPath, profilesDirectory, "startup")).toBeUndefined();
		expect(resolveSessionProfilePath([entry("../bad")], settingsPath, profilesDirectory, "reload")).toBeUndefined();
	});
});
