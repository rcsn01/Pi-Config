import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	createModelSelectionPersistence,
	ModelSelectionPersistenceError,
} from "./model-selection-persistence.ts";

const roots: string[] = [];

function fixture(document?: Record<string, unknown>) {
	const root = mkdtempSync(join(tmpdir(), "model-selection-persistence-"));
	roots.push(root);
	const path = join(root, "settings.json");
	if (document !== undefined) writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`);
	return {
		root,
		path,
		read: (file = path) => JSON.parse(readFileSync(file, "utf-8")),
	};
}

const NORMAL_SELECTION = {
	provider: "ollama",
	modelId: "normal-model",
	thinkingLevel: "high" as const,
	contextWindow: 256_000,
};
const PLAN_SELECTION = {
	provider: "github-copilot",
	modelId: "plan-model",
	thinkingLevel: "low" as const,
	contextWindow: 131_072,
};

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("ModelSelectionPersistence loads", () => {
	it("loads normal and plan independently", async () => {
		const { path } = fixture({
			uiModelSelector: { profiles: { normal: NORMAL_SELECTION, plan: PLAN_SELECTION } },
		});
		const store = createModelSelectionPersistence(path);
		expect(await store.load("normal")).toEqual(NORMAL_SELECTION);
		expect(await store.load("plan")).toEqual(PLAN_SELECTION);
	});

	it("returns undefined for absent modes and missing documents", async () => {
		const existing = fixture({ uiModelSelector: { profiles: { normal: NORMAL_SELECTION } } });
		expect(await createModelSelectionPersistence(existing.path).load("plan")).toBeUndefined();
		const missing = fixture();
		expect(await createModelSelectionPersistence(missing.path).load("normal")).toBeUndefined();
	});

	it("accepts legacy missing context windows and default sentinels", async () => {
		const legacy = { provider: "legacy", modelId: "model", thinkingLevel: "medium" as const };
		const sentinel = {
			provider: "default",
			modelId: "default",
			thinkingLevel: "default",
			contextWindow: "default",
		};
		const { path } = fixture({ uiModelSelector: { profiles: { normal: legacy, plan: sentinel } } });
		const store = createModelSelectionPersistence(path);
		expect(await store.load("normal")).toEqual(legacy);
		expect(await store.load("plan")).toEqual(sentinel);
	});

	it.each([
		["malformed requested profile", { profiles: { normal: { ...NORMAL_SELECTION, provider: "" } } }],
		["malformed sibling profile", { profiles: { normal: NORMAL_SELECTION, plan: { ...PLAN_SELECTION, modelId: 3 } } }],
		["unsupported profile key", { profiles: { normal: NORMAL_SELECTION, review: PLAN_SELECTION } }],
		["malformed legacy contextWindows", { profiles: { normal: NORMAL_SELECTION }, contextWindows: { "x/y": 0 } }],
	] as const)("rejects a %s while loading", async (_label, selector) => {
		const { path } = fixture({ uiModelSelector: selector });
		await expect(createModelSelectionPersistence(path).load("normal"))
			.rejects.toBeInstanceOf(ModelSelectionPersistenceError);
	});
});

describe("ModelSelectionPersistence saves", () => {
	it("writes both modes and serializes concurrent mutations without lost updates", async () => {
		const { path, read } = fixture({ uiModelSelector: { profiles: {} } });
		const first = createModelSelectionPersistence(path);
		const second = createModelSelectionPersistence(path);
		await Promise.all([
			first.save("normal", NORMAL_SELECTION),
			second.save("plan", PLAN_SELECTION),
		]);
		expect(read().uiModelSelector.profiles).toEqual({
			normal: NORMAL_SELECTION,
			plan: PLAN_SELECTION,
		});
	});

	it("preserves sibling modes, selector fields, compaction, and unrelated fields", async () => {
		const { path, read } = fixture({
			theme: "dark",
			compaction: { enabled: false },
			uiModelSelector: {
				label: "preserved",
				profiles: { plan: PLAN_SELECTION },
				contextWindows: { "legacy/model": 100_000 },
			},
		});
		await createModelSelectionPersistence(path).save("normal", NORMAL_SELECTION);
		expect(read()).toEqual({
			theme: "dark",
			compaction: { enabled: false },
			uiModelSelector: {
				label: "preserved",
				profiles: { plan: PLAN_SELECTION, normal: NORMAL_SELECTION },
				contextWindows: { "legacy/model": 100_000 },
			},
		});
	});

	it("removes legacy top-level defaults", async () => {
		const { path, read } = fixture({
			defaultProvider: "old",
			defaultModel: "old",
			defaultThinkingLevel: "medium",
			other: true,
		});
		await createModelSelectionPersistence(path).save("plan", PLAN_SELECTION);
		expect(read()).toEqual({
			other: true,
			uiModelSelector: { profiles: { plan: PLAN_SELECTION } },
		});
	});

	it("creates a missing document", async () => {
		const { path, read } = fixture();
		await createModelSelectionPersistence(path).save("normal", NORMAL_SELECTION);
		expect(read()).toEqual({ uiModelSelector: { profiles: { normal: NORMAL_SELECTION } } });
	});

	it.each([
		["missing", undefined],
		["zero", 0],
		["negative", -1],
		["fractional", 1.5],
		["sentinel", "default"],
	] as const)("rejects a %s context window", async (_label, contextWindow) => {
		const { path } = fixture({});
		await expect(createModelSelectionPersistence(path).save("normal", {
			...NORMAL_SELECTION,
			contextWindow,
		} as never)).rejects.toBeInstanceOf(ModelSelectionPersistenceError);
	});

	it.each([
		["provider", { ...NORMAL_SELECTION, provider: "" }],
		["model ID", { ...NORMAL_SELECTION, modelId: "" }],
		["thinking level", { ...NORMAL_SELECTION, thinkingLevel: "extreme" }],
	] as const)("rejects an invalid %s", async (_label, selection) => {
		const { path } = fixture({});
		await expect(createModelSelectionPersistence(path).save("normal", selection as never))
			.rejects.toBeInstanceOf(ModelSelectionPersistenceError);
	});

	it("keeps separate persistence instances fixed to their Profile paths", async () => {
		const original = fixture({ uiModelSelector: { profiles: {} } });
		const otherPath = join(original.root, "focused.json");
		writeFileSync(otherPath, JSON.stringify({ uiModelSelector: { profiles: {} } }));
		const originalPersistence = createModelSelectionPersistence(original.path);
		const otherPersistence = createModelSelectionPersistence(otherPath);

		await Promise.all([
			originalPersistence.save("normal", NORMAL_SELECTION),
			otherPersistence.save("plan", PLAN_SELECTION),
		]);

		expect(original.read().uiModelSelector.profiles).toEqual({ normal: NORMAL_SELECTION });
		expect(original.read(otherPath).uiModelSelector.profiles).toEqual({ plan: PLAN_SELECTION });
	});
});

describe("ModelSelectionPersistenceError", () => {
	it("reports load metadata and preserves the original cause", async () => {
		const { path } = fixture();
		writeFileSync(path, "not json");
		const error = await createModelSelectionPersistence(path).load("plan").catch((cause) => cause);
		expect(error).toBeInstanceOf(ModelSelectionPersistenceError);
		expect(error).toMatchObject({ operation: "load", mode: "plan", path });
		expect(error.cause).toBeInstanceOf(Error);
		expect(error.message).toBe(`Cannot load plan model selection from ${path}: ${error.cause.message}`);
	});

	it("wraps Settings document write failures", async () => {
		const { root } = fixture();
		const parentFile = join(root, "not-a-directory");
		writeFileSync(parentFile, "blocked");
		const path = join(parentFile, "settings.json");
		const error = await createModelSelectionPersistence(path).save("plan", PLAN_SELECTION).catch((cause) => cause);
		expect(error).toBeInstanceOf(ModelSelectionPersistenceError);
		expect(error).toMatchObject({ operation: "save", mode: "plan", path });
		expect(error.cause).toBeInstanceOf(Error);
		expect(error.message).toBe(`Cannot save plan model selection to ${path}: ${error.cause.message}`);
	});

	it("reports save metadata and preserves the original validation cause", async () => {
		const { path } = fixture({});
		const cause = new Error("provider getter failed");
		const selection = {
			get provider(): string { throw cause; },
			modelId: "model",
			thinkingLevel: "medium" as const,
			contextWindow: 100_000,
		};
		const error = await createModelSelectionPersistence(path).save("normal", selection).catch((value) => value);
		expect(error).toBeInstanceOf(ModelSelectionPersistenceError);
		expect(error).toMatchObject({ operation: "save", mode: "normal", path, cause });
		expect(error.message).toBe(`Cannot save normal model selection to ${path}: provider getter failed`);
	});
});
