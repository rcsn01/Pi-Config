import { describe, expect, it, vi } from "vitest";
import {
	applyModelSelection,
	applySelectionFromDocument,
	calculateCompactionReserveTokens,
	DEFAULT_COMPACTION_THRESHOLD,
	DEFAULT_CONTEXT_WINDOW,
	DEFAULT_KEEP_RECENT_TOKENS,
	mergeProjectCompactionSettings,
	mergeProjectModelSelection,
	parseProjectModelPreferences,
	PI_DEFAULT_CONTEXT_WINDOW,
	resolveContextWindow,
	resolveModelContext,
	selectionModeFromEntries,
	validateConcreteModelSelection,
	validateStoredModelSelection,
} from "./model-selection.ts";

const NORMAL_SELECTION = {
	provider: "ollama",
	modelId: "gpt-5.6-sol",
	thinkingLevel: "high",
	contextWindow: 256000,
} as const;

const PLAN_SELECTION = {
	provider: "ollama",
	modelId: "plan-model",
	thinkingLevel: "low",
	contextWindow: 131072,
} as const;

const planModel = {
	provider: "github-copilot",
	id: "gpt-5.6-sol",
	name: "GPT 5.6 Sol",
	contextWindow: 1_050_000,
	reasoning: true,
};

function profileFor(model: typeof planModel, thinkingLevel: string) {
	return { provider: model.provider, modelId: model.id, thinkingLevel, contextWindow: model.contextWindow };
}

describe("selectionModeFromEntries", () => {
	it("defaults to normal mode without plan-mode-state entries", () => {
		expect(selectionModeFromEntries([])).toBe("normal");
		expect(selectionModeFromEntries([{ type: "user" }, { type: "custom", customType: "other" }])).toBe("normal");
	});

	it("returns plan mode when plan-mode-state is active", () => {
		expect(selectionModeFromEntries([
			{ type: "custom", customType: "plan-mode-state", data: { active: true } },
		])).toBe("plan");
	});

	it("returns normal mode when plan-mode-state is inactive", () => {
		expect(selectionModeFromEntries([
			{ type: "custom", customType: "plan-mode-state", data: { active: false } },
		])).toBe("normal");
	});

	it("uses the latest plan-mode-state entry", () => {
		expect(selectionModeFromEntries([
			{ type: "custom", customType: "plan-mode-state", data: { active: false } },
			{ type: "custom", customType: "plan-mode-state", data: { active: true } },
		])).toBe("plan");
	});
});

describe("context window helpers", () => {
	it("passes large context windows through unchanged", () => {
		expect(resolveContextWindow(1_050_000)).toBe(1_050_000);
		expect(resolveContextWindow(1_000_000)).toBe(1_000_000);
	});

	it("defaults undeclared-context models (pi's 128K fallback) to 256K", () => {
		expect(resolveContextWindow(PI_DEFAULT_CONTEXT_WINDOW)).toBe(DEFAULT_CONTEXT_WINDOW);
	});

	it("passes context windows through unchanged", () => {
		expect(resolveContextWindow(100_000)).toBe(100_000);
		expect(resolveContextWindow(DEFAULT_CONTEXT_WINDOW)).toBe(DEFAULT_CONTEXT_WINDOW);
	});

	it("resolves a model's context window without mutating the catalogue model", () => {
		const model = { provider: "p", id: "m", name: "M", contextWindow: 1_050_000, reasoning: true };
		const configured = resolveModelContext(model);
		expect(configured.contextWindow).toBe(1_050_000);
		expect(model.contextWindow).toBe(1_050_000);
	});
});

describe("project model settings", () => {
	it("defaults the compaction threshold and calculates a 10% reserve", () => {
		expect(parseProjectModelPreferences({}).compactionThreshold).toBe(DEFAULT_COMPACTION_THRESHOLD);
		expect(calculateCompactionReserveTokens(272_000)).toBe(27_200);
		expect(calculateCompactionReserveTokens(1_050_000)).toBe(105_000);
		expect(calculateCompactionReserveTokens(101, 0.1)).toBe(11);
	});

	it("reads a manually configured compaction threshold", () => {
		expect(parseProjectModelPreferences({ compaction: { threshold: 0.2 } }).compactionThreshold).toBe(0.2);
		expect(calculateCompactionReserveTokens(100_000, 0.2)).toBe(20_000);
	});

	it("preserves default sentinels in stored normal and Plan selections", () => {
		expect(parseProjectModelPreferences({
			uiModelSelector: {
				profiles: {
					normal: { provider: "default", modelId: "default", thinkingLevel: "default", contextWindow: "default" },
					plan: { provider: "default", modelId: "default", thinkingLevel: "default", contextWindow: "default" },
				},
			},
		})).toMatchObject({
			profiles: {
				normal: { provider: "default", modelId: "default", thinkingLevel: "default", contextWindow: "default" },
				plan: { provider: "default", modelId: "default", thinkingLevel: "default", contextWindow: "default" },
			},
		});
	});

	it("merges context-sized compaction settings without discarding existing settings", () => {
		expect(mergeProjectCompactionSettings({
			theme: "dark",
			compaction: { enabled: true, reserveTokens: 1_000, keepRecentTokens: 20_000 },
			uiModelSelector: { label: "kept" },
		}, 1_050_000)).toEqual({
			theme: "dark",
			compaction: {
				enabled: true,
				reserveTokens: 105_000,
				keepRecentTokens: 20_000,
				threshold: DEFAULT_COMPACTION_THRESHOLD,
			},
			uiModelSelector: { label: "kept" },
		});
	});

	it("defaults keepRecentTokens when compaction declares none", () => {
		expect(mergeProjectCompactionSettings({
			compaction: { threshold: 0.1 },
		}, 256_000)).toEqual({
			compaction: {
				threshold: 0.1,
				reserveTokens: 25_600,
				keepRecentTokens: DEFAULT_KEEP_RECENT_TOKENS,
			},
		});
	});

	it("removes legacy default fields while preserving unrelated settings", () => {
		const result = mergeProjectModelSelection({
			defaultThinkingLevel: "medium",
			theme: "dark",
			uiModelSelector: {
				label: "kept",
				contextWindows: { "github-copilot/gpt-5.6-terra": 1_050_000 },
			},
		}, "normal", {
			provider: "github-copilot",
			modelId: "gpt-5.6-sol",
			thinkingLevel: "xhigh",
			contextWindow: 272_000,
		});

		expect(result).toEqual({
			theme: "dark",
			uiModelSelector: {
				label: "kept",
				contextWindows: { "github-copilot/gpt-5.6-terra": 1_050_000 },
				profiles: {
					normal: {
						provider: "github-copilot",
						modelId: "gpt-5.6-sol",
						thinkingLevel: "xhigh",
						contextWindow: 272_000,
					},
				},
			},
		});
	});

	it("keeps normal and Plan profiles independent without native defaults", () => {
		const normal = mergeProjectModelSelection({}, "normal", {
			provider: "anthropic",
			modelId: "claude-sonnet-4.6",
			thinkingLevel: "medium",
			contextWindow: 1_000_000,
		});
		const result = mergeProjectModelSelection(normal, "plan", {
			provider: "github-copilot",
			modelId: "gpt-5.6-sol",
			thinkingLevel: "xhigh",
			contextWindow: 272_000,
		});
		expect(result).toMatchObject({
			uiModelSelector: {
				profiles: {
					normal: { provider: "anthropic", contextWindow: 1_000_000 },
					plan: { provider: "github-copilot", contextWindow: 272_000 },
				},
			},
		});
	});

	it.each([
		{ uiModelSelector: [] },
		{ uiModelSelector: { contextWindows: [] } },
		{ uiModelSelector: { contextWindows: { "github-copilot/gpt-5.6-sol": 0 } } },
		{ uiModelSelector: { profiles: { normal: { provider: "test", modelId: "model", thinkingLevel: "ultra", contextWindow: 1 } } } },
		{ compaction: [] },
		{ compaction: { threshold: 0 } },
		{ compaction: { threshold: 1 } },
	])("rejects malformed settings %#", (settings) => {
		expect(() => parseProjectModelPreferences(settings)).toThrow();
	});
});

describe("selection validators", () => {
	it("accepts current profiles and legacy session profiles without context", () => {
		expect(validateConcreteModelSelection(profileFor(planModel, "xhigh")))
			.toEqual(profileFor(planModel, "xhigh"));
		expect(validateConcreteModelSelection({
			provider: planModel.provider,
			modelId: planModel.id,
			thinkingLevel: "high",
		})).toEqual({ provider: planModel.provider, modelId: planModel.id, thinkingLevel: "high" });
	});

	it("accepts stored default sentinels without treating them as concrete selections", () => {
		const stored = validateStoredModelSelection({
			provider: "default",
			modelId: "default",
			thinkingLevel: "default",
			contextWindow: "default",
		});
		expect(stored).toEqual({
			provider: "default",
			modelId: "default",
			thinkingLevel: "default",
			contextWindow: "default",
		});
		expect(() => validateConcreteModelSelection(stored)).toThrow(/concrete model settings/);
	});

	it("rejects malformed thinking levels and contexts", () => {
		expect(() => validateConcreteModelSelection({
			...profileFor(planModel, "high"), thinkingLevel: "turbo",
		})).toThrow("thinkingLevel is not supported");
		expect(() => validateConcreteModelSelection({
			...profileFor(planModel, "high"), contextWindow: 0,
		})).toThrow("contextWindow must be a positive integer");
	});
});

type CatalogueModel = {
	provider: string;
	id: string;
	name: string;
	contextWindow: number;
	reasoning: boolean;
};

function createHarness(options: {
	branch?: unknown[];
	model?: { provider: string; id: string; contextWindow?: number };
	thinkingLevel?: string;
	scopedModels?: unknown[];
	setModelResult?: boolean;
} = {}) {
	let thinkingLevel = options.thinkingLevel;
	const refresh = vi.fn(async () => ({ aborted: false, errors: new Map() }));
	const find = vi.fn((provider: string, id: string): CatalogueModel | undefined => ({
		provider,
		id,
		name: id,
		contextWindow: 256000,
		reasoning: true,
	}));
	const setModel = vi.fn(async () => options.setModelResult ?? true);
	const setThinkingLevel = vi.fn((level: string) => {
		thinkingLevel = level;
	});
	const syncCompaction = vi.fn(async () => {});
	const ctx = {
		model: options.model,
		scopedModels: options.scopedModels ?? [],
		modelRegistry: { refresh, find },
		sessionManager: { getBranch: vi.fn(() => options.branch ?? []) },
	};
	const pi = {
		setModel,
		setThinkingLevel,
		...(options.thinkingLevel !== undefined ? { getThinkingLevel: vi.fn(() => thinkingLevel) } : {}),
	};
	return {
		ctx: ctx as any,
		pi: pi as any,
		refresh,
		find,
		setModel,
		setThinkingLevel,
		syncCompaction,
		settingsStore: { syncCompaction },
	};
}

describe("applyModelSelection", () => {
	it("skips the slow path when the model and context window already match", async () => {
		const harness = createHarness({
			model: { provider: "ollama", id: "gpt-5.6-sol", contextWindow: 256000 },
			thinkingLevel: "high",
		});

		const result = await applyModelSelection(harness.pi, harness.ctx, NORMAL_SELECTION, {
			label: "Normal profile",
			settingsStore: harness.settingsStore,
		});

		expect(harness.refresh).not.toHaveBeenCalled();
		expect(harness.setModel).not.toHaveBeenCalled();
		expect(harness.setThinkingLevel).not.toHaveBeenCalled();
		expect(harness.syncCompaction).toHaveBeenCalledWith(256000);
		expect(result).toEqual(NORMAL_SELECTION);
	});

	it("reuses the current model without refresh when only the context window changes", async () => {
		const harness = createHarness({
			model: { provider: "ollama", id: "gpt-5.6-sol", contextWindow: 256000 },
		});

		await applyModelSelection(harness.pi, harness.ctx, { ...NORMAL_SELECTION, contextWindow: 131072 }, {
			label: "Normal profile",
			settingsStore: harness.settingsStore,
		});

		expect(harness.refresh).not.toHaveBeenCalled();
		expect(harness.setModel).toHaveBeenCalledWith(expect.objectContaining({
			provider: "ollama",
			id: "gpt-5.6-sol",
			contextWindow: 131072,
		}));
		expect(harness.syncCompaction).toHaveBeenCalledWith(131072);
	});

	it("inherits the current window for legacy selections without a context", async () => {
		const harness = createHarness({
			model: { provider: "ollama", id: "gpt-5.6-sol", contextWindow: 256000 },
		});

		const result = await applyModelSelection(harness.pi, harness.ctx, {
			provider: "ollama",
			modelId: "gpt-5.6-sol",
			thinkingLevel: "high",
		}, {
			label: "Normal profile",
			settingsStore: harness.settingsStore,
		});

		expect(harness.refresh).not.toHaveBeenCalled();
		expect(harness.setModel).not.toHaveBeenCalled();
		expect(result.contextWindow).toBe(256000);
		expect(harness.syncCompaction).toHaveBeenCalledWith(256000);
	});

	it("resolves a sentinel context window through the catalogue", async () => {
		const harness = createHarness({
			model: { provider: "ollama", id: "gpt-5.6-sol", contextWindow: 100000 },
		});

		await applyModelSelection(harness.pi, harness.ctx, { ...NORMAL_SELECTION, contextWindow: "default" }, {
			label: "Normal profile",
			settingsStore: harness.settingsStore,
		});

		expect(harness.refresh).toHaveBeenCalledWith({ allowNetwork: false, providers: ["ollama"] });
		expect(harness.setModel).toHaveBeenCalledWith(expect.objectContaining({ contextWindow: 256000 }));
		expect(harness.syncCompaction).toHaveBeenCalledWith(256000);
	});

	it("rejects when the model is outside the session's scope", async () => {
		const harness = createHarness({
			model: { provider: "ollama", id: "different-model", contextWindow: 256000 },
			scopedModels: [{ model: { provider: "other", id: "x" } }],
		});

		await expect(applyModelSelection(harness.pi, harness.ctx, NORMAL_SELECTION, {
			label: "Normal profile",
			settingsStore: harness.settingsStore,
		})).rejects.toThrow("outside this session's model scope");
	});

	it("sets the thinking level only when it differs", async () => {
		const harness = createHarness({
			model: { provider: "ollama", id: "other-model", contextWindow: 256000 },
			thinkingLevel: "high",
		});

		await applyModelSelection(harness.pi, harness.ctx, NORMAL_SELECTION, {
			label: "Normal profile",
			settingsStore: harness.settingsStore,
		});

		expect(harness.setModel).toHaveBeenCalledOnce();
		expect(harness.setThinkingLevel).not.toHaveBeenCalled();
	});

	it("returns the effective thinking level after Pi clamps it", async () => {
		const harness = createHarness({
			model: { provider: "ollama", id: "other-model", contextWindow: 256000 },
			thinkingLevel: "medium",
		});
		// Pi refuses to change the thinking level (clamped).
		harness.pi.setThinkingLevel = vi.fn();

		const result = await applyModelSelection(harness.pi, harness.ctx, { ...NORMAL_SELECTION, thinkingLevel: "xhigh" }, {
			label: "Normal profile",
			settingsStore: harness.settingsStore,
		});

		expect(harness.pi.setThinkingLevel).toHaveBeenCalledWith("xhigh");
		expect(result.thinkingLevel).toBe("medium");
	});
});

describe("applySelectionFromDocument", () => {
	it("applies the normal selection and returns it", async () => {
		const harness = createHarness();
		const document = { uiModelSelector: { profiles: { normal: NORMAL_SELECTION, plan: PLAN_SELECTION } } };

		const result = await applySelectionFromDocument(harness.pi, harness.ctx, document, harness.settingsStore);

		expect(result).toEqual(NORMAL_SELECTION);
		expect(harness.setModel).toHaveBeenCalledWith(expect.objectContaining({
			provider: "ollama",
			id: "gpt-5.6-sol",
			contextWindow: 256000,
		}));
		expect(harness.setThinkingLevel).toHaveBeenCalledWith("high");
		expect(harness.syncCompaction).toHaveBeenCalledWith(256000);
	});

	it("applies the plan selection when plan mode is active", async () => {
		const harness = createHarness({
			branch: [{ type: "custom", customType: "plan-mode-state", data: { active: true } }],
		});
		const document = { uiModelSelector: { profiles: { normal: NORMAL_SELECTION, plan: PLAN_SELECTION } } };

		const result = await applySelectionFromDocument(harness.pi, harness.ctx, document, harness.settingsStore);

		expect(result).toEqual(PLAN_SELECTION);
		expect(harness.setModel).toHaveBeenCalledWith(expect.objectContaining({ id: "plan-model", contextWindow: 131072 }));
		expect(harness.setThinkingLevel).toHaveBeenCalledWith("low");
	});

	it("resolves all-default selections through injected Pi native defaults", async () => {
		const harness = createHarness();
		const document = {
			uiModelSelector: {
				profiles: {
					normal: { provider: "default", modelId: "default", thinkingLevel: "default", contextWindow: "default" },
				},
			},
		};

		const result = await applySelectionFromDocument(
			harness.pi,
			harness.ctx,
			document,
			harness.settingsStore,
			{ provider: "openai-codex", modelId: "gpt-5.6-luna", thinkingLevel: "max" },
		);

		expect(result).toEqual({
			provider: "openai-codex",
			modelId: "gpt-5.6-luna",
			thinkingLevel: "max",
			contextWindow: 256000,
		});
		expect(harness.refresh).toHaveBeenCalledWith({
			allowNetwork: false,
			providers: ["openai-codex"],
		});
		expect(harness.setModel).toHaveBeenCalledWith(expect.objectContaining({
			provider: "openai-codex",
			id: "gpt-5.6-luna",
			contextWindow: 256000,
		}));
		expect(harness.setThinkingLevel).toHaveBeenCalledWith("max");
	});

	it("returns undefined without applying when the mode has no selection", async () => {
		const harness = createHarness();

		const result = await applySelectionFromDocument(harness.pi, harness.ctx, {}, harness.settingsStore);

		expect(result).toBeUndefined();
		expect(harness.setModel).not.toHaveBeenCalled();
		expect(harness.setThinkingLevel).not.toHaveBeenCalled();
		expect(harness.syncCompaction).not.toHaveBeenCalled();
	});

	it("still applies when the session model already matches but the window differs", async () => {
		const harness = createHarness({ model: { provider: "ollama", id: "gpt-5.6-sol" } });
		const document = {
			uiModelSelector: { profiles: { normal: { ...NORMAL_SELECTION, thinkingLevel: "max" } } },
		};

		await applySelectionFromDocument(harness.pi, harness.ctx, document, harness.settingsStore);

		// Thinking level and compaction follow the selection even though the
		// provider/model pair is already active; the missing context window
		// forces the update.
		expect(harness.setModel).toHaveBeenCalledOnce();
		expect(harness.setThinkingLevel).toHaveBeenCalledWith("max");
		expect(harness.syncCompaction).toHaveBeenCalledWith(256000);
	});

	it("rejects with a profile-labeled error when the model is unavailable", async () => {
		const harness = createHarness();
		harness.find.mockReturnValue(undefined);
		const document = { uiModelSelector: { profiles: { normal: NORMAL_SELECTION } } };

		await expect(
			applySelectionFromDocument(harness.pi, harness.ctx, document, harness.settingsStore),
		).rejects.toThrow("Profile model ollama/gpt-5.6-sol is unavailable.");
		expect(harness.setModel).not.toHaveBeenCalled();
	});

	it("rejects when the model has no configured authentication", async () => {
		const harness = createHarness({ setModelResult: false });
		const document = { uiModelSelector: { profiles: { normal: NORMAL_SELECTION } } };

		await expect(
			applySelectionFromDocument(harness.pi, harness.ctx, document, harness.settingsStore),
		).rejects.toThrow("No configured authentication for ollama/gpt-5.6-sol.");
	});
});
