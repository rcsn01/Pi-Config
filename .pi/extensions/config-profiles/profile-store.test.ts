import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createProfileStore, validateProfileName } from "./profile-store.ts";

const temporaryDirectories: string[] = [];

function fixture(settings: Record<string, unknown> = { configProfiles: { active: "default" } }) {
	const root = mkdtempSync(join(tmpdir(), "config-profiles-"));
	temporaryDirectories.push(root);
	const profilesDirectory = join(root, "profiles");
	const settingsPath = join(root, "settings.json");
	mkdirSync(profilesDirectory);
	writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
	const store = createProfileStore({ settingsPath });
	const writeProfile = (name: string, value: unknown) =>
		writeFileSync(join(profilesDirectory, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`);
	const read = (path: string) => JSON.parse(readFileSync(path, "utf-8"));
	return { root, profilesDirectory, settingsPath, store, writeProfile, read };
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


	it("switches by updating only the marker and preserving every other settings key", async () => {
		const current = {
			compaction: { enabled: true, threshold: 0.1 },
			theme: "dark",
			configProfiles: { active: "default", metadata: "kept" },
		};
		const { store, writeProfile, settingsPath, profilesDirectory, read } = fixture(current);
		writeProfile("default", { stale: true });
		writeProfile("focused", {
			destinationOnly: true,
			configProfiles: { active: "wrong", destinationMetadata: "kept" },
		});

		expect(await store.switchProfile("focused")).toEqual({ changed: true, active: "focused" });
		expect(read(settingsPath)).toEqual({
			compaction: { enabled: true, threshold: 0.1 },
			theme: "dark",
			configProfiles: { active: "focused", metadata: "kept" },
		});
		// Profile files are never written by a switch.
		expect(read(join(profilesDirectory, "default.json"))).toEqual({ stale: true });
		expect(read(join(profilesDirectory, "focused.json"))).toEqual({
			destinationOnly: true,
			configProfiles: { active: "wrong", destinationMetadata: "kept" },
		});
	});

	it("validates the destination before changing the marker", async () => {
		const { store, writeProfile, settingsPath, profilesDirectory } = fixture({
			value: "edited",
			configProfiles: { active: "default" },
		});
		writeProfile("default", { value: "old" });
		writeFileSync(join(profilesDirectory, "broken.json"), "{");
		const beforeSettings = readFileSync(settingsPath, "utf-8");

		await expect(store.switchProfile("broken")).rejects.toThrow(/Cannot read/);
		expect(readFileSync(settingsPath, "utf-8")).toBe(beforeSettings);
	});

	it("reports an already-active profile without a change", async () => {
		const settings = { edited: true, configProfiles: { active: "default" } };
		const { store, writeProfile, settingsPath } = fixture(settings);
		writeProfile("default", { edited: false, configProfiles: { active: "default" } });
		expect(await store.switchProfile("default")).toEqual({ changed: false, active: "default" });
		expect(readFileSync(settingsPath, "utf-8")).toBe(`${JSON.stringify(settings, null, 2)}\n`);
	});

	it("creates and activates a copy of a named profile", async () => {
		const current = {
			compaction: { enabled: true },
			configProfiles: { active: "default", metadata: "kept" },
		};
		const { store, writeProfile, read, settingsPath, profilesDirectory } = fixture(current);
		writeProfile("default", {
			model: "original",
			configProfiles: { active: "default", sourceMetadata: "kept" },
		});

		expect(await store.createProfile("focused", "default")).toEqual({ name: "focused", source: "default" });
		expect(read(join(profilesDirectory, "focused.json"))).toEqual({
			model: "original",
			configProfiles: { active: "focused", sourceMetadata: "kept" },
		});
		expect(read(settingsPath)).toEqual({
			compaction: { enabled: true },
			configProfiles: { active: "focused", metadata: "kept" },
		});
	});

	it("creates a profile from settings.json when no source profile is bound", async () => {
		const settings = { theme: "dark", configProfiles: { active: "default" } };
		const { store, read, settingsPath, profilesDirectory } = fixture(settings);

		expect(await store.createProfile("first")).toEqual({ name: "first", source: undefined });
		expect(read(join(profilesDirectory, "first.json"))).toEqual({
			theme: "dark",
			configProfiles: { active: "first" },
		});
		expect(read(settingsPath)).toEqual({
			theme: "dark",
			configProfiles: { active: "first" },
		});
	});

	it("rejects duplicate profile names without overwriting anything", async () => {
		const settings = { configProfiles: { active: "default" } };
		const { store, writeProfile, read, settingsPath, profilesDirectory } = fixture(settings);
		writeProfile("default", { model: "default" });
		writeProfile("focused", { model: "existing" });
		const beforeSettings = read(settingsPath);

		await expect(store.createProfile("focused", "default")).rejects.toThrow('Profile "focused" already exists.');
		expect(read(join(profilesDirectory, "focused.json"))).toEqual({ model: "existing" });
		expect(read(settingsPath)).toEqual(beforeSettings);
	});

	it("deletes an inactive profile without changing the active marker", async () => {
		const { store, writeProfile, read, settingsPath, profilesDirectory } = fixture({
			configProfiles: { active: "focused" },
		});
		writeProfile("default", { model: "default" });
		writeProfile("focused", { model: "focused" });
		writeProfile("other", { model: "other" });

		expect(await store.deleteProfile("other")).toEqual({
			name: "other",
			replacement: "default",
			markerReplaced: false,
		});
		expect(readdirSync(profilesDirectory)).toEqual(["default.json", "focused.json"]);
		expect(read(settingsPath)).toEqual({ configProfiles: { active: "focused" } });
	});

	it("replaces the active marker before deleting an active profile", async () => {
		const { store, writeProfile, read, settingsPath, profilesDirectory } = fixture({
			configProfiles: { active: "focused" },
		});
		writeProfile("default", { model: "default" });
		writeProfile("focused", { model: "focused" });

		expect(await store.deleteProfile("focused")).toEqual({
			name: "focused",
			replacement: "default",
			markerReplaced: true,
		});
		expect(readdirSync(profilesDirectory)).toEqual(["default.json"]);
		expect(read(settingsPath)).toEqual({ configProfiles: { active: "default" } });
	});

	it("replaces the marker when the session profile is active but another profile is marked", async () => {
		const { store, writeProfile, read, settingsPath } = fixture({
			configProfiles: { active: "github" },
		});
		writeProfile("default", { model: "default" });
		writeProfile("focused", { model: "focused" });
		writeProfile("github", { model: "github" });

		expect(await store.deleteProfile("focused", { replaceMarker: true })).toEqual({
			name: "focused",
			replacement: "default",
			markerReplaced: true,
		});
		expect(read(settingsPath)).toEqual({ configProfiles: { active: "default" } });
	});

	it("keeps default undeletable", async () => {
		const { store, writeProfile, read, settingsPath, profilesDirectory } = fixture();
		writeProfile("default", { model: "default" });
		const beforeSettings = read(settingsPath);

		await expect(store.deleteProfile("default")).rejects.toThrow('The "default" profile cannot be deleted.');
		expect(readdirSync(profilesDirectory)).toEqual(["default.json"]);
		expect(read(settingsPath)).toEqual(beforeSettings);
	});

	it("validates the default replacement before deleting a profile", async () => {
		const { store, writeProfile, read, settingsPath, profilesDirectory } = fixture({
			configProfiles: { active: "focused" },
		});
		writeProfile("focused", { model: "focused" });
		writeFileSync(join(profilesDirectory, "default.json"), "{\n");
		const beforeSettings = read(settingsPath);

		await expect(store.deleteProfile("focused")).rejects.toThrow(/Cannot read/);
		expect(readdirSync(profilesDirectory)).toEqual(["default.json", "focused.json"]);
		expect(read(settingsPath)).toEqual(beforeSettings);
	});

	it("cleans up atomic-write temporary files", async () => {
		const { store, writeProfile, root, profilesDirectory } = fixture();
		writeProfile("default", { configProfiles: { active: "default" } });
		await store.switchProfile("default");
		expect(readdirSync(root, { recursive: true }).filter((name) => String(name).endsWith(".tmp"))).toEqual([]);
		expect(readdirSync(profilesDirectory)).toEqual(["default.json"]);
	});
});
