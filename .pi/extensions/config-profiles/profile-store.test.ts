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
	const store = createProfileStore({ settingsPath, profilesDirectory });
	const writeProfile = (name: string, value: unknown) =>
		writeFileSync(join(profilesDirectory, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`);
	const read = (path: string) => JSON.parse(readFileSync(path, "utf-8"));
	return { root, profilesDirectory, settingsPath, store, writeProfile, read };
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("profile store", () => {
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

	it("loads the active profile from the marker and its file", () => {
		const { store, writeProfile } = fixture();
		writeProfile("default", { model: "old", unknown: { nested: true } });
		expect(store.loadActiveProfile()).toEqual({ name: "default", document: { model: "old", unknown: { nested: true } } });
	});

	it("honors a supplied settings document in getActiveProfile", () => {
		const { store } = fixture();
		expect(store.getActiveProfile({ configProfiles: { active: "focused" } })).toBe("focused");
		expect(store.getActiveProfile({ configProfiles: { active: "../bad" } })).toBeUndefined();
		expect(store.getActiveProfile({})).toBeUndefined();
	});

	it("throws when settings.json is missing and no document is supplied", () => {
		const { root, store } = fixture();
		rmSync(join(root, "settings.json"));
		expect(() => store.getActiveProfile()).toThrow(/Cannot read/);
	});

	it("returns undefined without a valid active marker", () => {
		for (const marker of [undefined, { active: "../bad" }, { active: 3 }]) {
			const { store, writeProfile } = fixture(
				marker === undefined ? { model: "edited" } : { model: "edited", configProfiles: marker },
			);
			writeProfile("default", { model: "original" });
			expect(store.loadActiveProfile()).toBeUndefined();
		}
	});

	it("reports a valid active marker whose profile is missing", () => {
		const { store } = fixture({ configProfiles: { active: "missing" } });
		expect(() => store.loadActiveProfile()).toThrow(/Cannot read/);
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

	it("cleans up atomic-write temporary files", async () => {
		const { store, writeProfile, root, profilesDirectory } = fixture();
		writeProfile("default", { configProfiles: { active: "default" } });
		await store.switchProfile("default");
		expect(readdirSync(root, { recursive: true }).filter((name) => String(name).endsWith(".tmp"))).toEqual([]);
		expect(readdirSync(profilesDirectory)).toEqual(["default.json"]);
	});
});
