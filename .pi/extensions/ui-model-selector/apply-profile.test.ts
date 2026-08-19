import { describe, expect, it, vi } from "vitest";
import {
	applyProfileModelSelection,
	selectionModeFromEntries,
} from "./apply-profile.ts";
import type { ProjectSettingsStore } from "./settings-store.ts";

const NORMAL_SELECTION = {
	provider: "ollama",
	modelId: "gpt-5.6-sol",
	thinkingLevel: "high",
	contextWindow: 256000,
};

const PLAN_SELECTION = {
	provider: "ollama",
	modelId: "plan-model",
	thinkingLevel: "low",
	contextWindow: 131072,
};

function createHarness(branch: unknown[] = [], model = { provider: "ollama", id: "current-model" }) {
	const setModel = vi.fn(async () => true);
	const setThinkingLevel = vi.fn();
	const syncCompaction = vi.fn(async () => {});
	const settingsStore = { syncCompaction } as unknown as ProjectSettingsStore;
	const ctx = {
		model,
		scopedModels: [],
		modelRegistry: {
			refresh: vi.fn(async () => ({ aborted: false, errors: new Map() })),
			find: vi.fn((provider: string, id: string) => ({
				provider,
				id,
				name: id,
				contextWindow: 256000,
				reasoning: true,
			})),
		},
		sessionManager: { getBranch: vi.fn(() => branch) },
	};
	const pi = { setModel, setThinkingLevel };
	return { ctx: ctx as any, pi: pi as any, setModel, setThinkingLevel, syncCompaction, settingsStore };
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

describe("applyProfileModelSelection", () => {
	it("applies the normal selection and returns it", async () => {
		const harness = createHarness();
		const document = { uiModelSelector: { profiles: { normal: NORMAL_SELECTION, plan: PLAN_SELECTION } } };

		const result = await applyProfileModelSelection(harness.pi, harness.ctx, document, harness.settingsStore);

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
		const harness = createHarness([{ type: "custom", customType: "plan-mode-state", data: { active: true } }]);
		const document = { uiModelSelector: { profiles: { normal: NORMAL_SELECTION, plan: PLAN_SELECTION } } };

		const result = await applyProfileModelSelection(harness.pi, harness.ctx, document, harness.settingsStore);

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

		const result = await applyProfileModelSelection(
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
		expect(harness.ctx.modelRegistry.refresh).toHaveBeenCalledWith({
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

		const result = await applyProfileModelSelection(harness.pi, harness.ctx, {}, harness.settingsStore);

		expect(result).toBeUndefined();
		expect(harness.setModel).not.toHaveBeenCalled();
		expect(harness.setThinkingLevel).not.toHaveBeenCalled();
		expect(harness.syncCompaction).not.toHaveBeenCalled();
	});

	it("always applies even when the session model already matches", async () => {
		const harness = createHarness([], { provider: "ollama", id: "gpt-5.6-sol" });
		const document = {
			uiModelSelector: { profiles: { normal: { ...NORMAL_SELECTION, thinkingLevel: "max" } } },
		};

		await applyProfileModelSelection(harness.pi, harness.ctx, document, harness.settingsStore);

		// Thinking level and compaction follow the selection even though the
		// provider/model pair is already active.
		expect(harness.setModel).toHaveBeenCalledOnce();
		expect(harness.setThinkingLevel).toHaveBeenCalledWith("max");
		expect(harness.syncCompaction).toHaveBeenCalledWith(256000);
	});

	it("rejects with a profile-labeled error when the model is unavailable", async () => {
		const harness = createHarness();
		harness.ctx.modelRegistry.find.mockReturnValue(undefined);
		const document = { uiModelSelector: { profiles: { normal: NORMAL_SELECTION } } };

		await expect(
			applyProfileModelSelection(harness.pi, harness.ctx, document, harness.settingsStore),
		).rejects.toThrow("Profile model ollama/gpt-5.6-sol is unavailable.");
		expect(harness.setModel).not.toHaveBeenCalled();
	});

	it("rejects when the model has no configured authentication", async () => {
		const harness = createHarness();
		harness.setModel.mockResolvedValue(false);
		const document = { uiModelSelector: { profiles: { normal: NORMAL_SELECTION } } };

		await expect(
			applyProfileModelSelection(harness.pi, harness.ctx, document, harness.settingsStore),
		).rejects.toThrow("No configured authentication for ollama/gpt-5.6-sol.");
	});
});
