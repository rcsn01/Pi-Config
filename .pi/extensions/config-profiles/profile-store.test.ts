import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createProfileStore, validateProfileName } from "./profile-store.ts";

const temporaryDirectories: string[] = [];

/**
 * Project layout: `<root>/.pi/settings.json`, `<root>/.pi/profiles/`, and the
 * active Profile marker in `<root>/.pi/pi-config.json` (`profile`).
 */
function fixture(settings: Record<string, unknown> = {}, activeProfile: string | undefined = "default") {
	const root = mkdtempSync(join(tmpdir(), "config-profiles-"));
	temporaryDirectories.push(root);
	const piDirectory = join(root, ".pi");
	const profilesDirectory = join(piDirectory, "profiles");
	const settingsPath = join(piDirectory, "settings.json");
	const piConfigPath = join(piDirectory, "pi-config.json");
	mkdirSync(profilesDirectory, { recursive: true });
	writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
	if (activeProfile !== undefined) {
		writeFileSync(piConfigPath, `${JSON.stringify({ profile: activeProfile }, null, 2)}\n`);
	}
	const store = createProfileStore({ settingsPath });
	const writeProfile = (name: string, value: unknown) =>
		writeFileSync(join(profilesDirectory, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`);
	const read = (path: string) => JSON.parse(readFileSync(path, "utf-8"));
	const activeMarker = () => (existsSync(piConfigPath) ? read(piConfigPath).profile : undefined);
	return { root, profilesDirectory, settingsPath, piConfigPath, store, writeProfile, read, activeMarker };
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("profile store", () => {
	it("preserves an explicitly supplied custom Profile directory", () => {
		const root = mkdtempSync(join(tmpdir(), "config-profiles-custom-"));
		temporaryDirectories.push(root);
		const settingsPath = join(root, "settings.json");
		const profilesDirectory = join(root, "custom-profiles");
		mkdirSync(profilesDirectory);
		writeFileSync(settingsPath, "{}\n");

		const store = createProfileStore({ settingsPath, profilesDirectory });

		expect(store.profilesDirectory).toBe(profilesDirectory);
	});

	it("discovers and sorts top-level JSON profile filenames", () => {
		const { profilesDirectory, store, writeProfile } = fixture();
		writeProfile("zeta", {});
		writeProfile("alpha", {});
		writeFileSync(join(profilesDirectory, "notes.txt"), "ignored");
		mkdirSync(join(profilesDirectory, "nested.json"));
		expect(store.listProfiles()).toEqual(["alpha", "zeta"]);
	});

	it.each(["", ".", "..", "../secret", "a/b", "name.json", "space name", "-leading"])(
		"rejects unsafe profile name %j",
		(name) => expect(() => validateProfileName(name)).toThrow(/Invalid profile name/),
	);

	it("rejects malformed JSON and non-object profile documents", () => {
		const { profilesDirectory, store, writeProfile } = fixture();
		writeFileSync(join(profilesDirectory, "broken.json"), "{");
		writeProfile("array", []);
		expect(() => store.readProfile("broken")).toThrow(/Cannot read/);
		expect(() => store.readProfile("array")).toThrow(/root value must be a JSON object/);
	});

	it("switches by updating only the project marker", async () => {
		const current = {
			compaction: { enabled: true, threshold: 0.1 },
			theme: "dark",
		};
		const { root, store, writeProfile, settingsPath, piConfigPath, profilesDirectory, read } = fixture(current);
		writeFileSync(piConfigPath, JSON.stringify({ profile: "default", permissions: { mode: "read-only" } }));
		writeProfile("default", { stale: true });
		writeProfile("focused", { destinationOnly: true });
		const beforeSettings = readFileSync(settingsPath, "utf-8");

		expect(await store.switchProfile(root, "focused")).toEqual({ changed: true, active: "focused" });
		expect(read(piConfigPath)).toEqual({ profile: "focused", permissions: { mode: "read-only" } });
		expect(readFileSync(settingsPath, "utf-8")).toBe(beforeSettings);
		// Profile files are never written by a switch.
		expect(read(join(profilesDirectory, "default.json"))).toEqual({ stale: true });
		expect(read(join(profilesDirectory, "focused.json"))).toEqual({ destinationOnly: true });
	});

	it("declares the project marker when none exists yet", async () => {
		const { root, store, writeProfile, activeMarker } = fixture({}, undefined);
		writeProfile("focused", {});

		expect(await store.switchProfile(root, "focused")).toEqual({ changed: true, active: "focused" });
		expect(activeMarker()).toBe("focused");
	});

	it("applies a Profile's keepRecentTokens while preserving other core compaction settings", async () => {
		const { root, store, writeProfile, read, settingsPath, activeMarker } = fixture({
			compaction: { enabled: false, reserveTokens: 12_000, keepRecentTokens: 20_000 },
		});
		writeProfile("default", { compaction: { keepRecentTokens: 20_000 } });
		writeProfile("focused", {
			compaction: { enabled: true, reserveTokens: 1, keepRecentTokens: 4_000 },
		});

		await store.switchProfile(root, "focused");

		expect(read(settingsPath)).toEqual({
			compaction: { enabled: false, reserveTokens: 12_000, keepRecentTokens: 4_000 },
		});
		expect(activeMarker()).toBe("focused");
	});

	it("resynchronizes keepRecentTokens when the Profile marker is already active", async () => {
		const { root, store, writeProfile, read, settingsPath } = fixture(
			{ compaction: { enabled: false, keepRecentTokens: 20_000 } },
			"focused",
		);
		writeProfile("focused", { compaction: { keepRecentTokens: 4_000 } });

		expect(await store.switchProfile(root, "focused")).toEqual({ changed: true, active: "focused" });
		expect(read(settingsPath).compaction).toEqual({ enabled: false, keepRecentTokens: 4_000 });
	});

	it.each([-1, 1.5, "20000"])(
		"rejects invalid keepRecentTokens %j before changing the marker",
		async (keepRecentTokens) => {
			const { root, store, writeProfile, settingsPath, activeMarker } = fixture({
				compaction: { enabled: false, keepRecentTokens: 20_000 },
			});
			writeProfile("focused", { compaction: { keepRecentTokens } });
			const beforeSettings = readFileSync(settingsPath, "utf-8");

			await expect(store.switchProfile(root, "focused")).rejects.toThrow(/non-negative integer/);
			expect(readFileSync(settingsPath, "utf-8")).toBe(beforeSettings);
			expect(activeMarker()).toBe("default");
		},
	);

	it("validates the destination before changing the marker", async () => {
		const { root, store, writeProfile, settingsPath, profilesDirectory, activeMarker } = fixture({ value: "edited" });
		writeProfile("default", { value: "old" });
		writeFileSync(join(profilesDirectory, "broken.json"), "{");
		const beforeSettings = readFileSync(settingsPath, "utf-8");

		await expect(store.switchProfile(root, "broken")).rejects.toThrow(/Cannot read/);
		expect(readFileSync(settingsPath, "utf-8")).toBe(beforeSettings);
		expect(activeMarker()).toBe("default");
	});

	it("reports an already-active profile without a change", async () => {
		const settings = { edited: true };
		const { root, store, writeProfile, settingsPath, piConfigPath } = fixture(settings);
		writeProfile("default", { edited: false });
		const beforeProject = readFileSync(piConfigPath, "utf-8");
		expect(await store.switchProfile(root, "default")).toEqual({ changed: false, active: "default" });
		expect(readFileSync(settingsPath, "utf-8")).toBe(`${JSON.stringify(settings, null, 2)}\n`);
		expect(readFileSync(piConfigPath, "utf-8")).toBe(beforeProject);
	});

	it("creates and activates a copy of a named profile", async () => {
		const current = {
			compaction: { enabled: true, reserveTokens: 12_000, keepRecentTokens: 20_000 },
		};
		const { root, store, writeProfile, read, settingsPath, profilesDirectory, activeMarker } = fixture(current);
		writeProfile("default", {
			model: "original",
			compaction: { enabled: false, keepRecentTokens: 4_000 },
		});

		expect(await store.createProfile(root, "focused", "default")).toEqual({ name: "focused", source: "default" });
		expect(read(join(profilesDirectory, "focused.json"))).toEqual({
			model: "original",
			compaction: { enabled: false, keepRecentTokens: 4_000 },
		});
		expect(read(settingsPath)).toEqual({
			compaction: { enabled: true, reserveTokens: 12_000, keepRecentTokens: 4_000 },
		});
		expect(activeMarker()).toBe("focused");
	});

	it("creates a profile from settings.json when no source profile is bound", async () => {
		const settings = { theme: "dark" };
		const { root, store, read, settingsPath, profilesDirectory, activeMarker } = fixture(settings);

		expect(await store.createProfile(root, "first")).toEqual({ name: "first", source: undefined });
		expect(read(join(profilesDirectory, "first.json"))).toEqual({ theme: "dark" });
		expect(read(settingsPath)).toEqual({ theme: "dark" });
		expect(activeMarker()).toBe("first");
	});

	it("rejects duplicate profile names without overwriting anything", async () => {
		const { root, store, writeProfile, read, settingsPath, profilesDirectory, activeMarker } = fixture();
		writeProfile("default", { model: "default" });
		writeProfile("focused", { model: "existing" });
		const beforeSettings = read(settingsPath);

		await expect(store.createProfile(root, "focused", "default")).rejects.toThrow('Profile "focused" already exists.');
		expect(read(join(profilesDirectory, "focused.json"))).toEqual({ model: "existing" });
		expect(read(settingsPath)).toEqual(beforeSettings);
		expect(activeMarker()).toBe("default");
	});

	it("deletes an inactive profile without changing the active marker", async () => {
		const { root, store, writeProfile, profilesDirectory, activeMarker } = fixture({}, "focused");
		writeProfile("default", { model: "default" });
		writeProfile("focused", { model: "focused" });
		writeProfile("other", { model: "other" });

		expect(await store.deleteProfile(root, "other")).toEqual({
			name: "other",
			replacement: "default",
			markerReplaced: false,
		});
		expect(readdirSync(profilesDirectory)).toEqual(["default.json", "focused.json"]);
		expect(activeMarker()).toBe("focused");
	});

	it("replaces the active marker before deleting an active profile", async () => {
		const { root, store, writeProfile, profilesDirectory, activeMarker } = fixture({}, "focused");
		writeProfile("default", { model: "default" });
		writeProfile("focused", { model: "focused" });

		expect(await store.deleteProfile(root, "focused")).toEqual({
			name: "focused",
			replacement: "default",
			markerReplaced: true,
		});
		expect(readdirSync(profilesDirectory)).toEqual(["default.json"]);
		expect(activeMarker()).toBe("default");
	});

	it("applies the default Profile's keepRecentTokens when deleting the active Profile", async () => {
		const { root, store, writeProfile, read, settingsPath, activeMarker } = fixture(
			{ compaction: { enabled: false, keepRecentTokens: 4_000 } },
			"focused",
		);
		writeProfile("default", { compaction: { keepRecentTokens: 20_000 } });
		writeProfile("focused", { compaction: { keepRecentTokens: 4_000 } });

		await store.deleteProfile(root, "focused");

		expect(read(settingsPath)).toEqual({ compaction: { enabled: false, keepRecentTokens: 20_000 } });
		expect(activeMarker()).toBe("default");
	});

	it("resynchronizes the fallback when deleting a session-bound Profile whose marker is already default", async () => {
		const { root, store, writeProfile, read, settingsPath, activeMarker } = fixture({
			compaction: { enabled: false, keepRecentTokens: 4_000 },
		});
		writeProfile("default", { compaction: { keepRecentTokens: 20_000 } });
		writeProfile("focused", { compaction: { keepRecentTokens: 4_000 } });

		expect(await store.deleteProfile(root, "focused", { replaceMarker: true })).toEqual({
			name: "focused",
			replacement: "default",
			markerReplaced: false,
		});
		expect(read(settingsPath)).toEqual({ compaction: { enabled: false, keepRecentTokens: 20_000 } });
		expect(activeMarker()).toBe("default");
	});

	it("replaces the marker when the session profile is active but another profile is marked", async () => {
		const { root, store, writeProfile, activeMarker } = fixture({}, "github");
		writeProfile("default", { model: "default" });
		writeProfile("focused", { model: "focused" });
		writeProfile("github", { model: "github" });

		expect(await store.deleteProfile(root, "focused", { replaceMarker: true })).toEqual({
			name: "focused",
			replacement: "default",
			markerReplaced: true,
		});
		expect(activeMarker()).toBe("default");
	});

	it("keeps default undeletable", async () => {
		const { root, store, writeProfile, read, settingsPath, profilesDirectory, activeMarker } = fixture();
		writeProfile("default", { model: "default" });
		const beforeSettings = read(settingsPath);

		await expect(store.deleteProfile(root, "default")).rejects.toThrow('The "default" profile cannot be deleted.');
		expect(readdirSync(profilesDirectory)).toEqual(["default.json"]);
		expect(read(settingsPath)).toEqual(beforeSettings);
		expect(activeMarker()).toBe("default");
	});

	it("validates the default replacement before deleting a profile", async () => {
		const { root, store, writeProfile, read, settingsPath, profilesDirectory, activeMarker } = fixture({}, "focused");
		writeProfile("focused", { model: "focused" });
		writeFileSync(join(profilesDirectory, "default.json"), "{\n");
		const beforeSettings = read(settingsPath);

		await expect(store.deleteProfile(root, "focused")).rejects.toThrow(/Cannot read/);
		expect(readdirSync(profilesDirectory)).toEqual(["default.json", "focused.json"]);
		expect(read(settingsPath)).toEqual(beforeSettings);
		expect(activeMarker()).toBe("focused");
	});

	it("cleans up atomic-write temporary files", async () => {
		const { root, store, writeProfile, profilesDirectory } = fixture({}, undefined);
		writeProfile("default", { compaction: { keepRecentTokens: 1 } });
		await store.switchProfile(root, "default");
		expect(readdirSync(root, { recursive: true }).filter((name) => String(name).endsWith(".tmp"))).toEqual([]);
		expect(readdirSync(profilesDirectory)).toEqual(["default.json"]);
	});
});
