import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	CONFIG_PROFILES_ENTRY_TYPE,
	NON_RELOAD_REASON,
	createSessionProfileResolver,
	parseActiveProfileName,
	profilePath,
	readActiveProfileName,
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

	it("parses the marker from a supplied settings document", () => {
		expect(parseActiveProfileName({ configProfiles: { active: "focused" } })).toBe("focused");
		expect(parseActiveProfileName({})).toBeUndefined();
		expect(parseActiveProfileName({ configProfiles: { active: 3 } })).toBeUndefined();
		expect(parseActiveProfileName({ configProfiles: "nope" })).toBeUndefined();
		expect(parseActiveProfileName({ configProfiles: { active: "../bad" } })).toBeUndefined();
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

	describe("session profile resolver", () => {
		it.each(["startup", "resume", "fork"] as const)("prefers the session entry on %s", (reason) => {
			const { settingsPath, profilesDirectory } = fixture({ configProfiles: { active: "focused" } });
			const resolver = createSessionProfileResolver({ settingsPath, profilesDirectory });

			expect(resolver.resolve([entry("default")], reason)).toBe(join(profilesDirectory, "default.json"));
		});

		it("prefers a seeded entry over the marker on new sessions", () => {
			const { settingsPath, profilesDirectory } = fixture({ configProfiles: { active: "github" } });
			const resolver = createSessionProfileResolver({ settingsPath, profilesDirectory });

			expect(resolver.resolve([entry("focused")], "new")).toBe(join(profilesDirectory, "focused.json"));
		});

		it("falls back to the marker on unseeded new sessions", () => {
			const { settingsPath, profilesDirectory } = fixture({ configProfiles: { active: "github" } });
			const resolver = createSessionProfileResolver({ settingsPath, profilesDirectory });

			expect(resolver.resolve([], "new")).toBe(join(profilesDirectory, "github.json"));
		});

		it("uses the entry on reload even when the marker names another profile", () => {
			const { settingsPath, profilesDirectory } = fixture({ configProfiles: { active: "focused" } });
			const resolver = createSessionProfileResolver({ settingsPath, profilesDirectory });

			expect(resolver.resolve([entry("default")], "reload")).toBe(join(profilesDirectory, "default.json"));
		});

		it("uses the entry when the marker is absent", () => {
			const { settingsPath, profilesDirectory } = fixture({});
			const resolver = createSessionProfileResolver({ settingsPath, profilesDirectory });
			expect(resolver.resolve([entry("default")], "startup")).toBe(join(profilesDirectory, "default.json"));
		});

		it("uses the entry when the marker is invalid", () => {
			const { settingsPath, profilesDirectory } = fixture({ configProfiles: { active: "../bad" } });
			const resolver = createSessionProfileResolver({ settingsPath, profilesDirectory });
			expect(resolver.resolve([entry("default")], "startup")).toBe(join(profilesDirectory, "default.json"));
		});

		it("never falls back to the marker on reload, returning settings.json when no valid entry", () => {
			const marked = fixture({ configProfiles: { active: "focused" } });
			const resolver = createSessionProfileResolver({
				settingsPath: marked.settingsPath,
				profilesDirectory: marked.profilesDirectory,
			});
			expect(resolver.resolve([], "reload")).toBe(marked.settingsPath);
			expect(resolver.resolve([entry("../bad")], "reload")).toBe(marked.settingsPath);
		});

		it("returns settings.json when neither source yields a valid name", () => {
			const { settingsPath, profilesDirectory } = fixture({});
			const resolver = createSessionProfileResolver({ settingsPath, profilesDirectory });
			expect(resolver.resolve([], "startup")).toBe(settingsPath);
			expect(resolver.resolve([], "reload")).toBe(settingsPath);
		});

		it("always returns a concrete document path", () => {
			const { settingsPath, profilesDirectory } = fixture({ configProfiles: { active: "focused" } });
			const resolver = createSessionProfileResolver({ settingsPath, profilesDirectory });
			expect(resolver.resolve([entry("default")], "startup")).toBe(join(profilesDirectory, "default.json"));
			// A new session with neither source still yields the plain settings document.
			const unmarked = fixture({});
			const unmarkedResolver = createSessionProfileResolver({
				settingsPath: unmarked.settingsPath,
				profilesDirectory: unmarked.profilesDirectory,
			});
			expect(unmarkedResolver.resolve([], "fork")).toBe(unmarked.settingsPath);
		});
		describe("resolveName", () => {
			it("prefers the entry over the marker on non-reload boundaries", () => {
				const { settingsPath, profilesDirectory } = fixture({ configProfiles: { active: "focused" } });
				const resolver = createSessionProfileResolver({ settingsPath, profilesDirectory });

				expect(resolver.resolveName([entry("default")], "startup")).toBe("default");
				expect(resolver.resolveName([entry("default")], "fork")).toBe("default");
			});

			it("falls back to the marker when no entry binds", () => {
				const { settingsPath, profilesDirectory } = fixture({ configProfiles: { active: "focused" } });
				const resolver = createSessionProfileResolver({ settingsPath, profilesDirectory });

				expect(resolver.resolveName([], "new")).toBe("focused");
			});

			it("falls back to the marker when the entry is invalid", () => {
				const { settingsPath, profilesDirectory } = fixture({ configProfiles: { active: "focused" } });
				const resolver = createSessionProfileResolver({ settingsPath, profilesDirectory });

				expect(resolver.resolveName([entry("../bad")], "startup")).toBe("focused");
			});

			it("consults only the entry on reload", () => {
				const { settingsPath, profilesDirectory } = fixture({ configProfiles: { active: "focused" } });
				const resolver = createSessionProfileResolver({ settingsPath, profilesDirectory });

				expect(resolver.resolveName([entry("default")], "reload")).toBe("default");
				expect(resolver.resolveName([], "reload")).toBeUndefined();
				expect(resolver.resolveName([entry("../bad")], "reload")).toBeUndefined();
			});

			it("returns undefined when nothing binds", () => {
				const { settingsPath, profilesDirectory } = fixture({});
				const resolver = createSessionProfileResolver({ settingsPath, profilesDirectory });

				expect(resolver.resolveName([], "startup")).toBeUndefined();
				expect(resolver.resolveName([], "fork")).toBeUndefined();
			});

			it("composes entry ?? marker for NON_RELOAD_REASON like any non-reload boundary", () => {
				const { settingsPath, profilesDirectory } = fixture({ configProfiles: { active: "focused" } });
				const resolver = createSessionProfileResolver({ settingsPath, profilesDirectory });

				expect(resolver.resolveName([entry("default")], NON_RELOAD_REASON)).toBe("default");
				expect(resolver.resolveName([], NON_RELOAD_REASON)).toBe("focused");
			});

			it("drives the derived path resolution", () => {
				const { settingsPath, profilesDirectory } = fixture({ configProfiles: { active: "focused" } });
				const resolver = createSessionProfileResolver({ settingsPath, profilesDirectory });

				expect(resolver.resolve([entry("default")], "startup")).toBe(join(profilesDirectory, "default.json"));
				expect(resolver.resolve([], "startup")).toBe(join(profilesDirectory, "focused.json"));
				expect(resolver.resolve([], "reload")).toBe(settingsPath);
			});
		});
	});
});
