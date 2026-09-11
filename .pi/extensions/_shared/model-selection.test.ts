import { describe, expect, it } from "vitest";
import {
	DEFAULT_CONTEXT_WINDOW,
	mergeProjectModelSelection,
	parseProjectModelPreferences,
	PI_DEFAULT_CONTEXT_WINDOW,
	resolveContextWindow,
	resolveModelContext,
	selectionModeFromEntries,
	validateConcreteModelSelection,
	validateStoredModelSelection,
} from "./model-selection.ts";

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

	it("returns plan mode for the current mode-shaped entries", () => {
		expect(selectionModeFromEntries([
			{ type: "custom", customType: "plan-mode-state", data: { mode: "plan", revision: 3 } },
		])).toBe("plan");
		expect(selectionModeFromEntries([
			{ type: "custom", customType: "plan-mode-state", data: { mode: "default", revision: 4 } },
		])).toBe("normal");
	});

	it("uses the latest plan-mode-state entry across both shapes", () => {
		expect(selectionModeFromEntries([
			{ type: "custom", customType: "plan-mode-state", data: { active: true } },
			{ type: "custom", customType: "plan-mode-state", data: { mode: "default", revision: 2 } },
		])).toBe("normal");
		expect(selectionModeFromEntries([
			{ type: "custom", customType: "plan-mode-state", data: { mode: "plan", revision: 1 } },
			{ type: "custom", customType: "plan-mode-state", data: { active: false } },
		])).toBe("normal");
		expect(selectionModeFromEntries([
			{ type: "custom", customType: "plan-mode-state", data: { mode: "default", revision: 1 } },
			{ type: "custom", customType: "plan-mode-state", data: { mode: "plan", revision: 2 } },
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
