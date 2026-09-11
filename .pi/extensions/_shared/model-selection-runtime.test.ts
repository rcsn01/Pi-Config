import { describe, expect, it, vi } from "vitest";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
	applySelectionFromDocument,
	createModelSelectionRuntime,
	ModelSelectionNotSavedError,
	type ModelRuntimeFacts,
} from "./model-selection-runtime.ts";
import { DEFAULT_SENTINEL } from "./pi-defaults.ts";
import type { SupportedModelThinkingLevel } from "./model-thinking.ts";

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

const syncModel = {
	provider: "current-provider",
	id: "current-model",
	name: "Current",
	contextWindow: 1_000_000,
	reasoning: true,
} as Model<Api>;

type CatalogueModel = {
	provider: string;
	id: string;
	name: string;
	contextWindow: number;
	reasoning: boolean;
};

function createHarness(options: {
	branch?: unknown[];
	model?: { provider: string; id: string; contextWindow?: number; name?: string; reasoning?: boolean };
	thinkingLevel?: string;
	scopedModels?: unknown[];
	setModelResult?: boolean;
	setModelClobber?: string;
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
	const setModel = vi.fn(async (_model: unknown) => {
		if (options.setModelClobber !== undefined) thinkingLevel = options.setModelClobber;
		return options.setModelResult ?? true;
	});
	const setThinkingLevel = vi.fn((level: string) => {
		thinkingLevel = level;
	});
	const save = vi.fn(async () => {});
	const ctx = {
		model: options.model,
		scopedModels: options.scopedModels ?? [],
		modelRegistry: { refresh, find },
		sessionManager: { getBranch: vi.fn(() => options.branch ?? []) },
	} as any;
	const pi = {
		setModel,
		setThinkingLevel,
		...(options.thinkingLevel !== undefined ? { getThinkingLevel: vi.fn(() => thinkingLevel) } : {}),
	};
	const facts: ModelRuntimeFacts = {
		currentModel: () => ctx.model,
		currentThinkingLevel: () => typeof pi.getThinkingLevel === "function"
			? pi.getThinkingLevel() as SupportedModelThinkingLevel
			: undefined,
		setModel: (model) => pi.setModel(model),
		setThinkingLevel: (level) => pi.setThinkingLevel(level),
	};
	const runtime = createModelSelectionRuntime({ facts, catalogue: ctx, saver: { save } });
	return {
		ctx,
		pi: pi as any,
		facts,
		runtime,
		refresh,
		find,
		setModel,
		setThinkingLevel,
		save,
		persistence: { save },
	};
}

function syncHarness(options: {
	model?: { provider: string; id: string; contextWindow?: number; name?: string; reasoning?: boolean };
	setModelResult?: boolean;
	setModelClobber?: string;
} = {}) {
	const harness = createHarness({
		model: options.model ?? { ...syncModel },
		// The port always reports a readable level; the pre-read level travels
		// into synchronize as an explicit third argument, so tests decide per call.
		thinkingLevel: "medium",
		setModelResult: options.setModelResult,
		setModelClobber: options.setModelClobber,
	});
	return { ...harness, currentModel: harness.ctx.model as Model<Api> };
}

describe("applyStored", () => {
	it("skips the slow path when the model and context window already match", async () => {
		const harness = createHarness({
			model: { provider: "ollama", id: "gpt-5.6-sol", contextWindow: 256000 },
			thinkingLevel: "high",
		});

		const result = await harness.runtime.applyStored(NORMAL_SELECTION, {
			label: "Normal profile",
		});

		expect(harness.refresh).not.toHaveBeenCalled();
		expect(harness.setModel).not.toHaveBeenCalled();
		expect(harness.setThinkingLevel).not.toHaveBeenCalled();
		expect(result).toEqual(NORMAL_SELECTION);
	});

	it("reuses the current model without refresh when only the context window changes", async () => {
		const harness = createHarness({
			model: { provider: "ollama", id: "gpt-5.6-sol", contextWindow: 256000 },
		});

		await harness.runtime.applyStored({ ...NORMAL_SELECTION, contextWindow: 131072 }, {
			label: "Normal profile",
		});

		expect(harness.refresh).not.toHaveBeenCalled();
		expect(harness.setModel).toHaveBeenCalledWith(expect.objectContaining({
			provider: "ollama",
			id: "gpt-5.6-sol",
			contextWindow: 131072,
		}));
	});

	it("applies an explicit 128K stored context window verbatim", async () => {
		const harness = createHarness({
			model: { provider: "ollama", id: "gpt-5.6-sol", contextWindow: 256000 },
		});

		const result = await harness.runtime.applyStored({
			...NORMAL_SELECTION,
			contextWindow: 128_000,
		}, {
			label: "Normal profile",
		});

		expect(harness.refresh).not.toHaveBeenCalled();
		expect(harness.setModel).toHaveBeenCalledWith(expect.objectContaining({ contextWindow: 128_000 }));
		expect(result.contextWindow).toBe(128_000);
	});

	it("applies an explicit 128K stored context verbatim through a refreshed catalogue lookup", async () => {
		const harness = createHarness({
			model: { provider: "ollama", id: "different-model", contextWindow: 256000 },
		});

		await harness.runtime.applyStored({
			...NORMAL_SELECTION,
			contextWindow: 128_000,
		}, {
			label: "Normal profile",
		});

		expect(harness.setModel).toHaveBeenCalledWith(expect.objectContaining({ contextWindow: 128_000 }));
	});

	it("inherits the current window for legacy selections without a context", async () => {
		const harness = createHarness({
			model: { provider: "ollama", id: "gpt-5.6-sol", contextWindow: 256000 },
		});

		const result = await harness.runtime.applyStored({
			provider: "ollama",
			modelId: "gpt-5.6-sol",
			thinkingLevel: "high",
		}, {
			label: "Normal profile",
		});

		expect(harness.refresh).not.toHaveBeenCalled();
		expect(harness.setModel).not.toHaveBeenCalled();
		expect(result.contextWindow).toBe(256000);
	});

	it("resolves a sentinel context window through the catalogue", async () => {
		const harness = createHarness({
			model: { provider: "ollama", id: "gpt-5.6-sol", contextWindow: 100000 },
		});

		await harness.runtime.applyStored({ ...NORMAL_SELECTION, contextWindow: "default" }, {
			label: "Normal profile",
		});

		expect(harness.refresh).toHaveBeenCalledWith({ allowNetwork: false, providers: ["ollama"] });
		expect(harness.setModel).toHaveBeenCalledWith(expect.objectContaining({ contextWindow: 256000 }));
	});

	it("rejects when the model is outside the session's scope", async () => {
		const harness = createHarness({
			model: { provider: "ollama", id: "different-model", contextWindow: 256000 },
			scopedModels: [{ model: { provider: "other", id: "x" } }],
		});

		await expect(harness.runtime.applyStored(NORMAL_SELECTION, {
			label: "Normal profile",
		})).rejects.toThrow("outside this session's model scope");
	});

	it("rejects with the abort message when the catalogue refresh is aborted", async () => {
		const harness = createHarness();
		harness.refresh.mockResolvedValue({ aborted: true, errors: new Map() });
		const document = { uiModelSelector: { profiles: { normal: NORMAL_SELECTION } } };

		await expect(applySelectionFromDocument(harness.pi, harness.ctx, document))
			.rejects.toThrow("Refreshing ollama was aborted.");
		expect(harness.setModel).not.toHaveBeenCalled();
	});

	it("re-throws the raw provider refresh error", async () => {
		const harness = createHarness();
		const cause = new Error("catalogue offline");
		harness.refresh.mockResolvedValue({ aborted: false, errors: new Map([["ollama", cause]]) });
		const document = { uiModelSelector: { profiles: { normal: NORMAL_SELECTION } } };

		await expect(applySelectionFromDocument(harness.pi, harness.ctx, document)).rejects.toBe(cause);
		expect(harness.setModel).not.toHaveBeenCalled();
	});

	it("sets the thinking level only when it differs", async () => {
		const harness = createHarness({
			model: { provider: "ollama", id: "other-model", contextWindow: 256000 },
			thinkingLevel: "high",
		});

		await harness.runtime.applyStored(NORMAL_SELECTION, {
			label: "Normal profile",
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

		const result = await harness.runtime.applyStored({ ...NORMAL_SELECTION, thinkingLevel: "xhigh" }, {
			label: "Normal profile",
		});

		expect(harness.pi.setThinkingLevel).toHaveBeenCalledWith("xhigh");
		expect(result.thinkingLevel).toBe("medium");
	});

	it("resolves sentinel thinking through the current runtime level", async () => {
		const harness = createHarness({
			model: { provider: "ollama", id: "gpt-5.6-sol", contextWindow: 256000 },
			thinkingLevel: "low",
		});

		const result = await harness.runtime.applyStored({
			...NORMAL_SELECTION,
			thinkingLevel: "default",
		}, {
			label: "Normal profile",
			nativeDefaults: { provider: "unused", modelId: "unused" },
		});

		expect(result.thinkingLevel).toBe("low");
		expect(harness.setThinkingLevel).not.toHaveBeenCalled();
	});

	it("falls back to medium for sentinel thinking without a runtime level", async () => {
		const harness = createHarness({
			model: { provider: "ollama", id: "gpt-5.6-sol", contextWindow: 256000 },
		});

		const result = await harness.runtime.applyStored({
			...NORMAL_SELECTION,
			thinkingLevel: "default",
		}, {
			label: "Normal profile",
			nativeDefaults: { provider: "unused", modelId: "unused" },
		});

		expect(result.thinkingLevel).toBe("medium");
		expect(harness.setThinkingLevel).toHaveBeenCalledWith("medium");
	});

	it("rejects an out-of-vocabulary native defaultThinkingLevel", async () => {
		const harness = createHarness();

		await expect(harness.runtime.applyStored({
			...NORMAL_SELECTION,
			thinkingLevel: "default",
		}, {
			label: "Normal profile",
			nativeDefaults: { provider: "p", modelId: "m", thinkingLevel: "turbo" },
		})).rejects.toThrow("Pi's native defaultThinkingLevel is not supported: turbo.");
	});
});

describe("applyPicked", () => {
	const pickedModel = {
		provider: "anthropic",
		id: "claude-sonnet-4.6",
		name: "Claude Sonnet 4.6",
		contextWindow: 1_000_000,
		reasoning: true,
	} as any;

	it("uses the exact concrete picked model without refreshing or looking it up", async () => {
		const harness = createHarness({
			model: { provider: "ollama", id: "old-model", contextWindow: 256_000 },
			thinkingLevel: "medium",
		});

		await harness.runtime.applyPicked(pickedModel, "high", { mode: "normal" });

		expect(harness.refresh).not.toHaveBeenCalled();
		expect(harness.find).not.toHaveBeenCalled();
		expect(harness.setModel.mock.calls[0]?.[0]).toBe(pickedModel);
	});

	it("applies and persists a changed provider, model, and context window", async () => {
		const harness = createHarness({
			model: { provider: "ollama", id: "old-model", contextWindow: 256_000 },
			thinkingLevel: "low",
		});

		const result = await harness.runtime.applyPicked(pickedModel, "high", { mode: "normal" });

		expect(harness.setModel).toHaveBeenCalledWith(pickedModel);
		expect(harness.setThinkingLevel).toHaveBeenCalledWith("high");
		expect(harness.save).toHaveBeenCalledWith("normal", result);
		expect(result).toEqual({
			provider: "anthropic",
			modelId: "claude-sonnet-4.6",
			thinkingLevel: "high",
			contextWindow: 1_000_000,
		});
	});

	it("skips model application when provider, model, and context already match", async () => {
		const harness = createHarness({
			model: pickedModel,
			thinkingLevel: "high",
		});

		await harness.runtime.applyPicked(pickedModel, "high", { mode: "normal" });

		expect(harness.setModel).not.toHaveBeenCalled();
		expect(harness.setThinkingLevel).not.toHaveBeenCalled();
		expect(harness.save).toHaveBeenCalledOnce();
	});

	it("updates thinking and persists when model application is skipped", async () => {
		const harness = createHarness({
			model: pickedModel,
			thinkingLevel: "low",
		});

		const result = await harness.runtime.applyPicked(pickedModel, "xhigh", { mode: "normal" });

		expect(harness.setModel).not.toHaveBeenCalled();
		expect(harness.setThinkingLevel).toHaveBeenCalledWith("xhigh");
		expect(harness.save).toHaveBeenCalledWith("normal", result);
	});

	it("applies the model for a context-only change", async () => {
		const harness = createHarness({
			model: { ...pickedModel, contextWindow: 256_000 },
			thinkingLevel: "high",
		});

		await harness.runtime.applyPicked(pickedModel, "high", { mode: "normal" });

		expect(harness.setModel).toHaveBeenCalledWith(pickedModel);
	});

	it("rejects authentication failure before changing thinking or saving", async () => {
		const harness = createHarness({
			model: { provider: "ollama", id: "old-model", contextWindow: 256_000 },
			thinkingLevel: "low",
			setModelResult: false,
		});

		const error = await harness.runtime.applyPicked(pickedModel, "high", { mode: "normal" }).then(
			() => undefined,
			(error: unknown) => error,
		);

		expect((error as Error).message).toBe("No configured authentication for anthropic/claude-sonnet-4.6.");
		expect(harness.setThinkingLevel).not.toHaveBeenCalled();
		expect(harness.save).not.toHaveBeenCalled();
	});

	it("reads back and persists Pi's effective clamped thinking level", async () => {
		const harness = createHarness({
			model: { provider: "ollama", id: "old-model", contextWindow: 256_000 },
			thinkingLevel: "medium",
		});
		harness.pi.setThinkingLevel = vi.fn();

		const result = await harness.runtime.applyPicked(pickedModel, "max", { mode: "normal" });

		expect(result.thinkingLevel).toBe("medium");
		expect(harness.save).toHaveBeenCalledWith("normal", expect.objectContaining({
			thinkingLevel: "medium",
		}));
	});

	it("falls back to the requested thinking level when Pi's read-back reports none", async () => {
		const harness = createHarness({
			model: { provider: "ollama", id: "old-model", contextWindow: 256_000 },
			thinkingLevel: "medium",
		});
		// Pi exposes a thinking level but reports no value; the facts binding
		// reads `pi` at call time, so this override is seen by the commit.
		harness.pi.getThinkingLevel = vi.fn(() => undefined);

		const result = await harness.runtime.applyPicked(pickedModel, "xhigh", { mode: "normal" });

		expect(result.thinkingLevel).toBe("xhigh");
		expect(harness.setThinkingLevel).toHaveBeenCalledWith("xhigh");
		expect(harness.save).toHaveBeenCalledWith("normal", expect.objectContaining({
			thinkingLevel: "xhigh",
		}));
	});

	it.each(["normal", "plan"] as const)("persists effective selections in %s mode", async (mode) => {
		const harness = createHarness({ model: pickedModel, thinkingLevel: "high" });

		const result = await harness.runtime.applyPicked(pickedModel, "high", { mode });

		expect(harness.save).toHaveBeenCalledWith(mode, result);
	});

	it("rejects before the live commit when no saver is injected", async () => {
		const harness = createHarness({
			model: { provider: "ollama", id: "old-model", contextWindow: 256_000 },
			thinkingLevel: "medium",
		});
		const runtime = createModelSelectionRuntime({ facts: harness.facts, catalogue: harness.ctx });

		const error = await runtime.applyPicked(pickedModel, "high", { mode: "normal" }).then(
			() => undefined,
			(error: unknown) => error,
		);

		expect((error as Error).message).toBe("applyPicked requires an injected ModelSelectionSaver.");
		expect(harness.setModel).not.toHaveBeenCalled();
		expect(harness.save).not.toHaveBeenCalled();
	});

	it("wraps post-apply save failures without rolling back the live selection", async () => {
		const harness = createHarness({
			model: { provider: "ollama", id: "old-model", contextWindow: 256_000 },
			thinkingLevel: "medium",
		});
		const cause = new Error("disk full");
		harness.save.mockRejectedValueOnce(cause);
		const rollback = vi.fn();
		const persistence = { save: harness.save, rollback };
		const runtime = createModelSelectionRuntime({ facts: harness.facts, catalogue: harness.ctx, saver: persistence });
		let caught: unknown;

		try {
			await runtime.applyPicked(pickedModel, "high", { mode: "plan" });
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(ModelSelectionNotSavedError);
		if (!(caught instanceof ModelSelectionNotSavedError)) throw caught;
		expect(caught.appliedSelection).toEqual({
			provider: "anthropic",
			modelId: "claude-sonnet-4.6",
			thinkingLevel: "high",
			contextWindow: 1_000_000,
		});
		expect(caught.cause).toBe(cause);
		expect(harness.setModel).toHaveBeenCalledOnce();
		expect(rollback).not.toHaveBeenCalled();
	});

	it("reports the same typed partial failure when model application was skipped", async () => {
		const harness = createHarness({ model: pickedModel, thinkingLevel: "high" });
		const cause = new Error("read-only settings");
		harness.save.mockRejectedValueOnce(cause);

		const promise = harness.runtime.applyPicked(pickedModel, "high", { mode: "normal" });

		await expect(promise).rejects.toMatchObject({
			name: "ModelSelectionNotSavedError",
			appliedSelection: {
				provider: "anthropic",
				modelId: "claude-sonnet-4.6",
				thinkingLevel: "high",
				contextWindow: 1_000_000,
			},
			cause,
		});
		expect(harness.setModel).not.toHaveBeenCalled();
	});
});

describe("synchronize", () => {
	const matchingProfile = {
		provider: syncModel.provider,
		modelId: syncModel.id,
	} as const;

	it("synchronizes an explicit Profile context verbatim, even at pi's 128K sentinel", async () => {
		const sentinelCurrent = { ...syncModel, contextWindow: 128_000 };
		const profile = { ...matchingProfile, thinkingLevel: "medium" as const, contextWindow: 128_000 };
		const harness = syncHarness({ model: sentinelCurrent });

		const result = await harness.runtime.synchronize(harness.currentModel, profile, "medium");

		if (result.kind !== "synchronized") throw new Error("expected synchronized");
		expect(result.model).toBe(harness.setModel.mock.calls[0]?.[0]);
		expect(harness.setModel).toHaveBeenCalledWith(expect.objectContaining({ contextWindow: 128_000 }));
	});

	it("synchronizes a default-sentinel Profile context through context normalization", async () => {
		const sentinelCurrent = { ...syncModel, contextWindow: 128_000 };
		const profile = { ...matchingProfile, thinkingLevel: "medium" as const, contextWindow: DEFAULT_SENTINEL };
		const harness = syncHarness({ model: sentinelCurrent });

		const result = await harness.runtime.synchronize(harness.currentModel, profile, "medium");

		expect(result.kind).toBe("synchronized");
		expect(harness.setModel).toHaveBeenCalledWith(expect.objectContaining({ contextWindow: 256_000 }));
	});

	it("normalizes a 128K current model when the Profile declares no context", async () => {
		const sentinelCurrent = { ...syncModel, contextWindow: 128_000 };
		const profile = { provider: syncModel.provider, modelId: syncModel.id, thinkingLevel: "medium" as const };
		const harness = syncHarness({ model: sentinelCurrent });

		const result = await harness.runtime.synchronize(harness.currentModel, profile, "medium");

		expect(result).toEqual({ kind: "synchronized", model: expect.anything() });
		expect(harness.setModel).toHaveBeenCalledWith(expect.objectContaining({ contextWindow: 256_000 }));
	});

	it("re-applies the profile's thinking level when the model sync clobbers it", async () => {
		// pi's setModel imperatively applies per-model overrides or the global
		// default: simulate the clobber in the setModel fake. The pre-read level
		// is ignored here; the fresh post-setModel read decides.
		const profile = { ...matchingProfile, thinkingLevel: "high" as const, contextWindow: 256_000 };
		const harness = syncHarness({ setModelClobber: "low" });

		const result = await harness.runtime.synchronize(harness.currentModel, profile, "medium");

		if (result.kind !== "synchronized") throw new Error("expected synchronized");
		expect(result.model).toBe(harness.setModel.mock.calls[0]?.[0]);
		expect(harness.setThinkingLevel).toHaveBeenCalledWith("high");
	});

	it("re-applies the profile's thinking level even when the model already matches", async () => {
		const profile = { ...matchingProfile, thinkingLevel: "xhigh" as const, contextWindow: 1_000_000 };
		const harness = syncHarness();

		const result = await harness.runtime.synchronize(harness.currentModel, profile, "medium");

		expect(result).toEqual({ kind: "synchronized", model: harness.currentModel });
		expect(harness.setModel).not.toHaveBeenCalled();
		expect(harness.setThinkingLevel).toHaveBeenCalledWith("xhigh");
	});

	it("keeps pi's thinking level for default-sentinel profile thinking", async () => {
		const profile = { ...matchingProfile, thinkingLevel: DEFAULT_SENTINEL, contextWindow: 1_000_000 } as const;
		const harness = syncHarness();

		expect(await harness.runtime.synchronize(harness.currentModel, profile, "medium")).toEqual({ kind: "unchanged" });
		expect(harness.setThinkingLevel).not.toHaveBeenCalled();
	});

	it("does not apply profile thinking when the runtime level is unknown", async () => {
		const profile = { ...matchingProfile, thinkingLevel: "xhigh" as const, contextWindow: 1_000_000 };
		const harness = syncHarness();

		expect(await harness.runtime.synchronize(harness.currentModel, profile, undefined)).toEqual({ kind: "unchanged" });
		expect(harness.setThinkingLevel).not.toHaveBeenCalled();
	});

	it("ignores mismatched Profile context and keeps a current normalized model unchanged", async () => {
		const mismatch = { provider: "other", modelId: "model", thinkingLevel: "medium" as const, contextWindow: 256_000 };
		const harness = syncHarness();
		expect(await harness.runtime.synchronize(harness.currentModel, mismatch, "medium")).toEqual({ kind: "unchanged" });
		expect(harness.setModel).not.toHaveBeenCalled();
	});

	it("applies a differing concrete profile thinking level without a provider/modelId match", async () => {
		const mismatch = { provider: "other", modelId: "model", thinkingLevel: "xhigh" as const, contextWindow: 256_000 };
		const harness = syncHarness();

		const result = await harness.runtime.synchronize(harness.currentModel, mismatch, "medium");

		expect(result).toEqual({ kind: "synchronized", model: harness.currentModel });
		expect(harness.setModel).not.toHaveBeenCalled();
		expect(harness.setThinkingLevel).toHaveBeenCalledWith("xhigh");
	});

	it("never queries the catalogue", async () => {
		const profile = { ...matchingProfile, thinkingLevel: "high" as const, contextWindow: 500_000 };
		const harness = syncHarness();

		await harness.runtime.synchronize(harness.currentModel, profile, "medium");

		expect(harness.find).not.toHaveBeenCalled();
		expect(harness.refresh).not.toHaveBeenCalled();
	});

	it("rejects failed synchronized authentication with the exact legacy message", async () => {
		const profile = { ...matchingProfile, thinkingLevel: "medium" as const, contextWindow: 500_000 };
		const harness = syncHarness({ setModelResult: false });

		const error = await harness.runtime.synchronize(harness.currentModel, profile, "medium").then(
			() => undefined,
			(error: unknown) => error,
		);

		expect((error as Error).message).toBe("No configured authentication for current-provider/current-model");
	});
});

describe("applySelectionFromDocument", () => {
	it("applies the normal selection and returns it", async () => {
		const harness = createHarness();
		const document = { uiModelSelector: { profiles: { normal: NORMAL_SELECTION, plan: PLAN_SELECTION } } };

		const result = await applySelectionFromDocument(harness.pi, harness.ctx, document);

		expect(result).toEqual(NORMAL_SELECTION);
		expect(harness.setModel).toHaveBeenCalledWith(expect.objectContaining({
			provider: "ollama",
			id: "gpt-5.6-sol",
			contextWindow: 256000,
		}));
		expect(harness.setThinkingLevel).toHaveBeenCalledWith("high");
	});

	it("applies the plan selection when plan mode is active", async () => {
		const harness = createHarness({
			branch: [{ type: "custom", customType: "plan-mode-state", data: { active: true } }],
		});
		const document = { uiModelSelector: { profiles: { normal: NORMAL_SELECTION, plan: PLAN_SELECTION } } };

		const result = await applySelectionFromDocument(harness.pi, harness.ctx, document);

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

		const result = await applySelectionFromDocument(harness.pi, harness.ctx, {});

		expect(result).toBeUndefined();
		expect(harness.setModel).not.toHaveBeenCalled();
		expect(harness.setThinkingLevel).not.toHaveBeenCalled();
	});

	it("still applies when the session model already matches but the window differs", async () => {
		const harness = createHarness({ model: { provider: "ollama", id: "gpt-5.6-sol" } });
		const document = {
			uiModelSelector: { profiles: { normal: { ...NORMAL_SELECTION, thinkingLevel: "max" } } },
		};

		await applySelectionFromDocument(harness.pi, harness.ctx, document);

		// Thinking follows a changed selection even when the provider/model pair
		// is already active; the missing context window forces the update.
		expect(harness.setModel).toHaveBeenCalledOnce();
		expect(harness.setThinkingLevel).toHaveBeenCalledWith("max");
	});

	it("rejects with a profile-labeled error when the model is unavailable", async () => {
		const harness = createHarness();
		harness.find.mockReturnValue(undefined);
		const document = { uiModelSelector: { profiles: { normal: NORMAL_SELECTION } } };

		await expect(
			applySelectionFromDocument(harness.pi, harness.ctx, document),
		).rejects.toThrow("Profile model ollama/gpt-5.6-sol is unavailable.");
		expect(harness.setModel).not.toHaveBeenCalled();
	});

	it("rejects when the model has no configured authentication", async () => {
		const harness = createHarness({ setModelResult: false });
		const document = { uiModelSelector: { profiles: { normal: NORMAL_SELECTION } } };

		const error = await applySelectionFromDocument(harness.pi, harness.ctx, document).then(
			(result) => undefined,
			(error: unknown) => error,
		);

		expect((error as Error).message).toBe("No configured authentication for ollama/gpt-5.6-sol.");
	});
});
