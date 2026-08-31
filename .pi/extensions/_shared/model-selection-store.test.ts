import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import {
	createModelSelectionStore,
	ModelSelectionStoreError,
} from "./model-selection-store.ts";

const roots: string[] = [];

function fixture(document?: Record<string, unknown>) {
	const root = mkdtempSync(join(tmpdir(), "model-selection-store-"));
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

describe("ModelSelectionStore loads", () => {
	it("loads normal and plan independently", async () => {
		const { path } = fixture({
			uiModelSelector: { profiles: { normal: NORMAL_SELECTION, plan: PLAN_SELECTION } },
		});
		const store = createModelSelectionStore(path);
		expect(await store.load("normal")).toEqual(NORMAL_SELECTION);
		expect(await store.load("plan")).toEqual(PLAN_SELECTION);
	});

	it("returns undefined for absent modes and missing documents", async () => {
		const existing = fixture({ uiModelSelector: { profiles: { normal: NORMAL_SELECTION } } });
		expect(await createModelSelectionStore(existing.path).load("plan")).toBeUndefined();
		const missing = fixture();
		expect(await createModelSelectionStore(missing.path).load("normal")).toBeUndefined();
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
		const store = createModelSelectionStore(path);
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
		await expect(createModelSelectionStore(path).load("normal"))
			.rejects.toBeInstanceOf(ModelSelectionStoreError);
	});
});

describe("ModelSelectionStore saves", () => {
	it("writes both modes and serializes concurrent mutations without lost updates", async () => {
		const { path, read } = fixture({ uiModelSelector: { profiles: {} } });
		const first = createModelSelectionStore(path);
		const second = createModelSelectionStore(path);
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
		await createModelSelectionStore(path).save("normal", NORMAL_SELECTION);
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
		await createModelSelectionStore(path).save("plan", PLAN_SELECTION);
		expect(read()).toEqual({
			other: true,
			uiModelSelector: { profiles: { plan: PLAN_SELECTION } },
		});
	});

	it("creates a missing document", async () => {
		const { path, read } = fixture();
		await createModelSelectionStore(path).save("normal", NORMAL_SELECTION);
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
		await expect(createModelSelectionStore(path).save("normal", {
			...NORMAL_SELECTION,
			contextWindow,
		} as never)).rejects.toBeInstanceOf(ModelSelectionStoreError);
	});

	it.each([
		["provider", { ...NORMAL_SELECTION, provider: "" }],
		["model ID", { ...NORMAL_SELECTION, modelId: "" }],
		["thinking level", { ...NORMAL_SELECTION, thinkingLevel: "extreme" }],
	] as const)("rejects an invalid %s", async (_label, selection) => {
		const { path } = fixture({});
		await expect(createModelSelectionStore(path).save("normal", selection as never))
			.rejects.toBeInstanceOf(ModelSelectionStoreError);
	});

	it("repoints later operations to a new Profile path", async () => {
		const original = fixture({ uiModelSelector: { profiles: {} } });
		const otherPath = join(original.root, "focused.json");
		writeFileSync(otherPath, JSON.stringify({ uiModelSelector: { profiles: { plan: PLAN_SELECTION } } }));
		const store = createModelSelectionStore(original.path);
		store.setPath(otherPath);
		expect(await store.load("plan")).toEqual(PLAN_SELECTION);
		await store.save("normal", NORMAL_SELECTION);
		expect(original.read().uiModelSelector.profiles).toEqual({});
		expect(original.read(otherPath).uiModelSelector.profiles).toEqual({
			plan: PLAN_SELECTION,
			normal: NORMAL_SELECTION,
		});
	});

	it("retains the captured path while setPath changes", async () => {
		const original = fixture({ uiModelSelector: { profiles: {} } });
		const otherPath = join(original.root, "other.json");
		writeFileSync(otherPath, JSON.stringify({ uiModelSelector: { profiles: {} } }));
		let release!: () => void;
		const blocker = withFileMutationQueue(original.path, () => new Promise<void>((resolve) => {
			release = resolve;
		}));
		while (!release) await new Promise((resolve) => setTimeout(resolve, 0));
		const store = createModelSelectionStore(original.path);
		const save = store.save("plan", PLAN_SELECTION);
		store.setPath(otherPath);
		release();
		await Promise.all([blocker, save]);
		expect(original.read().uiModelSelector.profiles.plan).toEqual(PLAN_SELECTION);
		expect(original.read(otherPath).uiModelSelector.profiles).toEqual({});
	});
});

describe("ModelSelectionStoreError", () => {
	it("reports load metadata and preserves the original cause", async () => {
		const { path } = fixture();
		writeFileSync(path, "not json");
		const error = await createModelSelectionStore(path).load("plan").catch((cause) => cause);
		expect(error).toBeInstanceOf(ModelSelectionStoreError);
		expect(error).toMatchObject({ operation: "load", mode: "plan", path });
		expect(error.cause).toBeInstanceOf(Error);
		expect(error.message).toBe(`Cannot load plan model selection from ${path}: ${error.cause.message}`);
	});

	it("wraps Settings document write failures", async () => {
		const { root } = fixture();
		const parentFile = join(root, "not-a-directory");
		writeFileSync(parentFile, "blocked");
		const path = join(parentFile, "settings.json");
		const error = await createModelSelectionStore(path).save("plan", PLAN_SELECTION).catch((cause) => cause);
		expect(error).toBeInstanceOf(ModelSelectionStoreError);
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
		const error = await createModelSelectionStore(path).save("normal", selection).catch((value) => value);
		expect(error).toBeInstanceOf(ModelSelectionStoreError);
		expect(error).toMatchObject({ operation: "save", mode: "normal", path, cause });
		expect(error.message).toBe(`Cannot save normal model selection to ${path}: provider getter failed`);
	});
});
