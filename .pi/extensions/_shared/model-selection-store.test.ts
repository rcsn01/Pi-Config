import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createProjectSettingsStore } from "./model-selection-store.ts";

const roots: string[] = [];

function fixture(document: Record<string, unknown> = {}) {
	const root = mkdtempSync(join(tmpdir(), "model-selection-store-"));
	roots.push(root);
	const path = join(root, "settings.json");
	writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`);
	return { path, read: (file: string) => JSON.parse(readFileSync(file, "utf-8")) };
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

describe("project settings store", () => {
	it("loads uiModelSelector preferences from the single document", async () => {
		const { path } = fixture({
			uiModelSelector: {
				profiles: { normal: NORMAL_SELECTION },
				contextWindows: { "ollama/legacy": 131072 },
			},
		});
		const store = createProjectSettingsStore(path);
		expect(await store.load()).toEqual({
			profiles: { normal: NORMAL_SELECTION },
			contextWindows: { "ollama/legacy": 131072 },
		});
	});

	it("ignores pi-owned compaction settings entirely", async () => {
		const { path } = fixture({
			compaction: { threshold: 0.9, keepRecentTokens: 1234 },
			uiModelSelector: { profiles: { normal: NORMAL_SELECTION } },
		});
		const store = createProjectSettingsStore(path);
		expect(await store.load()).toEqual({
			profiles: { normal: NORMAL_SELECTION },
			contextWindows: {},
		});
	});

	it("saves the selection without touching compaction or unrelated settings", async () => {
		const { path, read } = fixture({
			theme: "dark",
			compaction: { enabled: false },
			uiModelSelector: { profiles: {} },
		});
		const store = createProjectSettingsStore(path);
		await store.save("normal", NORMAL_SELECTION);
		expect(read(path)).toEqual({
			theme: "dark",
			compaction: { enabled: false },
			uiModelSelector: { profiles: { normal: NORMAL_SELECTION } },
		});
	});

	it("repoints the store with setPath", async () => {
		const { path, read } = fixture({ uiModelSelector: { profiles: {} } });
		const other = join(path, "..", "other.json");
		writeFileSync(other, `${JSON.stringify({ uiModelSelector: { profiles: {} } }, null, 2)}\n`);
		const store = createProjectSettingsStore(path);
		store.setPath(other);
		await store.save("plan", { ...NORMAL_SELECTION, modelId: "plan-model", contextWindow: 131072 });

		expect(read(other)).toEqual({
			uiModelSelector: { profiles: { plan: { ...NORMAL_SELECTION, modelId: "plan-model", contextWindow: 131072 } } },
		});
		expect(read(path)).toEqual({ uiModelSelector: { profiles: {} } });
	});

	it("creates a missing document on save", async () => {
		const root = mkdtempSync(join(tmpdir(), "model-selection-store-"));
		roots.push(root);
		const missing = join(root, "profiles", "new.json");
		const store = createProjectSettingsStore(missing);
		await store.save("normal", NORMAL_SELECTION);
		expect(JSON.parse(readFileSync(missing, "utf-8"))).toEqual({
			uiModelSelector: { profiles: { normal: NORMAL_SELECTION } },
		});
	});
});
