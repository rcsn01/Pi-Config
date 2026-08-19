import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createProjectSettingsStore } from "./settings-store.ts";

const roots: string[] = [];

function fixture(options: {
	profile?: Record<string, unknown>;
	settings?: Record<string, unknown>;
} = {}) {
	const root = mkdtempSync(join(tmpdir(), "ui-model-selector-"));
	roots.push(root);
	const profilePath = join(root, "profiles", "focused.json");
	const settingsPath = join(root, "settings.json");
	mkdirSync(join(root, "profiles"));
	writeFileSync(profilePath, `${JSON.stringify(options.profile ?? {}, null, 2)}\n`);
	writeFileSync(settingsPath, `${JSON.stringify(options.settings ?? {}, null, 2)}\n`);
	const read = (path: string) => JSON.parse(readFileSync(path, "utf-8"));
	return { root, profilePath, settingsPath, read };
}

const NORMAL_SELECTION = {
	provider: "ollama",
	modelId: "gpt-5.6-sol",
	thinkingLevel: "high" as const,
	contextWindow: 256000,
};

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("split-path project settings store", () => {
	it("loads uiModelSelector from the profile and compaction from settings.json", async () => {
		const { profilePath, settingsPath } = fixture({
			profile: {
				compaction: { threshold: 0.5 }, // pi-core value in the profile is ignored
				uiModelSelector: { profiles: { normal: NORMAL_SELECTION } },
			},
			settings: { compaction: { threshold: 0.2 } },
		});
		const store = createProjectSettingsStore(profilePath, settingsPath);
		expect(await store.load()).toEqual({
			profiles: { normal: NORMAL_SELECTION },
			contextWindows: {},
			compactionThreshold: 0.2,
			keepRecentTokens: 25600,
		});
	});

	it("saves the model selection to the profile and compaction to settings.json", async () => {
		const { profilePath, settingsPath, read } = fixture({
			profile: { uiModelSelector: { profiles: {} } },
			settings: { compaction: { enabled: true, keepRecentTokens: 20000 } },
		});
		const store = createProjectSettingsStore(profilePath, settingsPath);
		await store.save("normal", NORMAL_SELECTION);

		expect(read(profilePath)).toEqual({
			uiModelSelector: { profiles: { normal: NORMAL_SELECTION } },
		});
		expect(read(settingsPath)).toEqual({
			compaction: {
				enabled: true,
				keepRecentTokens: 20000,
				threshold: 0.1,
				reserveTokens: 25600,
			},
		});
	});

	it("syncs compaction into settings.json without touching the profile", async () => {
		const { profilePath, settingsPath, read } = fixture({
			profile: { uiModelSelector: { profiles: { normal: NORMAL_SELECTION } } },
			settings: { compaction: { threshold: 0.1 } },
		});
		const store = createProjectSettingsStore(profilePath, settingsPath);
		await store.syncCompaction(131072);

		expect(read(settingsPath)).toEqual({
			compaction: { threshold: 0.1, reserveTokens: 13108, keepRecentTokens: 25600 },
		});
		expect(read(profilePath)).toEqual({
			uiModelSelector: { profiles: { normal: NORMAL_SELECTION } },
		});
	});

	it("repoints the store with setPaths", async () => {
		const { profilePath, settingsPath, read } = fixture({
			profile: { uiModelSelector: { profiles: {} } },
			settings: { compaction: { threshold: 0.1 } },
		});
		const otherProfile = join(profilePath, "..", "other.json");
		writeFileSync(otherProfile, `${JSON.stringify({ uiModelSelector: { profiles: {} } }, null, 2)}\n`);
		const store = createProjectSettingsStore(profilePath, settingsPath);
		store.setPaths(otherProfile, settingsPath);
		await store.save("plan", { ...NORMAL_SELECTION, modelId: "plan-model", contextWindow: 131072 });

		expect(read(otherProfile)).toEqual({
			uiModelSelector: { profiles: { plan: { ...NORMAL_SELECTION, modelId: "plan-model", contextWindow: 131072 } } },
		});
		expect(read(profilePath)).toEqual({ uiModelSelector: { profiles: {} } });
		expect(read(settingsPath)).toEqual({
			compaction: { threshold: 0.1, reserveTokens: 13108, keepRecentTokens: 25600 },
		});
	});

	it("defaults both paths to the same document for single-path callers", async () => {
		const { settingsPath, read } = fixture({ settings: { compaction: { threshold: 0.1 } } });
		const store = createProjectSettingsStore(settingsPath);
		await store.save("normal", NORMAL_SELECTION);
		expect(read(settingsPath)).toMatchObject({
			compaction: { threshold: 0.1, reserveTokens: 25600 },
			uiModelSelector: { profiles: { normal: NORMAL_SELECTION } },
		});
	});
});
