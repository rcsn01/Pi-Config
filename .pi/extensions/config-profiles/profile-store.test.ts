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

	it("mirrors edited settings into the active profile and preserves unknown fields", async () => {
		const settings = {
			model: "new",
			unknown: { nested: true },
			configProfiles: { active: "default", futureOption: 42 },
		};
		const { store, writeProfile, profilesDirectory, read } = fixture(settings);
		writeProfile("default", { model: "old" });
		expect(await store.synchronizeActiveProfile()).toBe("default");
		expect(read(join(profilesDirectory, "default.json"))).toEqual(settings);
	});

	it("leaves profiles untouched without a valid active marker", async () => {
		for (const marker of [undefined, { active: "../bad" }, { active: 3 }]) {
			const { store, writeProfile, profilesDirectory } = fixture(
				marker === undefined ? { model: "edited" } : { model: "edited", configProfiles: marker },
			);
			writeProfile("default", { model: "original" });
			const before = readFileSync(join(profilesDirectory, "default.json"), "utf-8");
			expect(await store.synchronizeActiveProfile()).toBeUndefined();
			expect(readFileSync(join(profilesDirectory, "default.json"), "utf-8")).toBe(before);
		}
	});

	it("reports a valid active marker whose profile is missing", async () => {
		const { store } = fixture({ configProfiles: { active: "missing" } });
		await expect(store.synchronizeActiveProfile()).rejects.toThrow(/does not exist/);
	});

	it("saves outgoing changes, fully replaces settings, and normalizes the destination marker", async () => {
		const current = {
			outgoingOnly: true,
			configProfiles: { active: "default", outgoingMetadata: "kept" },
		};
		const { store, writeProfile, settingsPath, profilesDirectory, read } = fixture(current);
		writeProfile("default", { stale: true });
		writeProfile("focused", {
			destinationOnly: true,
			configProfiles: { active: "wrong", destinationMetadata: "kept" },
		});

		expect(await store.switchProfile("focused")).toEqual({ changed: true, active: "focused" });
		expect(read(join(profilesDirectory, "default.json"))).toEqual(current);
		expect(read(settingsPath)).toEqual({
			destinationOnly: true,
			configProfiles: { active: "focused", destinationMetadata: "kept" },
		});
		expect(read(join(profilesDirectory, "focused.json"))).toEqual(read(settingsPath));
		expect(read(settingsPath)).not.toHaveProperty("outgoingOnly");
	});

	it("validates the destination before changing settings or the outgoing profile", async () => {
		const { store, writeProfile, settingsPath, profilesDirectory } = fixture({
			value: "edited",
			configProfiles: { active: "default" },
		});
		writeProfile("default", { value: "old" });
		writeFileSync(join(profilesDirectory, "broken.json"), "{");
		const beforeSettings = readFileSync(settingsPath, "utf-8");
		const beforeOutgoing = readFileSync(join(profilesDirectory, "default.json"), "utf-8");

		await expect(store.switchProfile("broken")).rejects.toThrow(/Cannot read/);
		expect(readFileSync(settingsPath, "utf-8")).toBe(beforeSettings);
		expect(readFileSync(join(profilesDirectory, "default.json"), "utf-8")).toBe(beforeOutgoing);
	});

	it("synchronizes an already-active profile without reporting a change", async () => {
		const settings = { edited: true, configProfiles: { active: "default" } };
		const { store, writeProfile, profilesDirectory, read } = fixture(settings);
		writeProfile("default", { edited: false, configProfiles: { active: "default" } });
		expect(await store.switchProfile("default")).toEqual({ changed: false, active: "default" });
		expect(read(join(profilesDirectory, "default.json"))).toEqual(settings);
	});

	it("cleans up atomic-write temporary files", async () => {
		const { store, writeProfile, root, profilesDirectory } = fixture();
		writeProfile("default", { configProfiles: { active: "default" } });
		await store.synchronizeActiveProfile();
		expect(readdirSync(root, { recursive: true }).filter((name) => String(name).endsWith(".tmp"))).toEqual([]);
		expect(readdirSync(profilesDirectory)).toEqual(["default.json"]);
	});
});
