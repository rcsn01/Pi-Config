import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { SEMANTIC_COMPACTION_FOCUS } from "../_shared/auto-compact.ts";
import { DEFAULT_SENTINEL } from "../_shared/pi-defaults.ts";
import {
	ModelSelectionPersistenceError,
	type ModelSelectionMode,
	type ModelSelectionSettings,
	type StoredModelSelectionSettings,
} from "../_shared/model-selection.ts";
import type { ModelPickerSelection } from "../_shared/model-picker.ts";
import {
	createModelSelectionLifecycle,
	ModelSelectionSessionClosedError,
	type ModelSelectionLifecycleAdapter,
	type ModelSelectionLifecycleNotice,
	type ModelSelectionLifecycleOutcome,
	type ModelSelectionRuntimeState,
} from "./model-selection-lifecycle.ts";

const currentModel = {
	provider: "current-provider",
	id: "current-model",
	name: "Current",
	contextWindow: 1_000_000,
	reasoning: true,
} as Model<Api>;
const pickedModel = {
	provider: "picked-provider",
	id: "picked-model",
	name: "Picked",
	contextWindow: 500_000,
	reasoning: true,
} as Model<Api>;
const picked: ModelPickerSelection = {
	model: pickedModel,
	thinkingLevel: "high",
	contextWindow: pickedModel.contextWindow,
};
const applied: ModelSelectionSettings = {
	provider: pickedModel.provider,
	modelId: pickedModel.id,
	thinkingLevel: "high",
	contextWindow: pickedModel.contextWindow,
};

function createHarness(options: {
	runtime?: ModelSelectionRuntimeState;
	selections?: Partial<Record<ModelSelectionMode, StoredModelSelectionSettings>>;
	loadResults?: Array<StoredModelSelectionSettings | undefined | Error>;
	picked?: ModelPickerSelection | undefined;
	applyStoredError?: unknown;
	applyPickedError?: unknown;
	appliedSelection?: ModelSelectionSettings;
	confirm?: boolean;
	idle?: boolean;
	setModelResult?: boolean;
} = {}) {
	const calls: string[] = [];
	const notices: ModelSelectionLifecycleNotice[] = [];
	const outcomes: ModelSelectionLifecycleOutcome[] = [];
	const loadResults = [...(options.loadResults ?? [])];
	const adapter: ModelSelectionLifecycleAdapter = {
		loadSelection: vi.fn(async (mode: ModelSelectionMode) => {
			calls.push(`load:${mode}`);
			if (loadResults.length > 0) {
				const result = loadResults.shift();
				if (result instanceof Error) throw result;
				return result;
			}
			return options.selections?.[mode];
		}),
		getRuntimeState: vi.fn(() => {
			calls.push("runtime");
			return options.runtime ?? { model: currentModel, thinkingLevel: "medium" as const, usageTokens: 0 };
		}),
		pick: vi.fn(async () => {
			calls.push("pick");
			return Object.hasOwn(options, "picked") ? options.picked : picked;
		}),
		applyStoredSelection: vi.fn(async () => {
			calls.push("apply-stored");
			if (options.applyStoredError) throw options.applyStoredError;
			return options.appliedSelection ?? applied;
		}),
		applyPickedSelection: vi.fn(async () => {
			calls.push("apply-live");
			if (options.applyPickedError) throw options.applyPickedError;
			calls.push("persist");
			return options.appliedSelection ?? applied;
		}),
		setModel: vi.fn(async () => {
			calls.push("set-model");
			return options.setModelResult ?? true;
		}),
		confirmContextReduction: vi.fn(async () => {
			calls.push("confirm");
			return options.confirm ?? true;
		}),
		isIdle: vi.fn(() => options.idle ?? true),
		requestCompaction: vi.fn(() => calls.push("compact")),
		reportNotice: vi.fn((notice) => notices.push(notice)),
		reportOutcome: vi.fn((outcome) => outcomes.push(outcome)),
	};
	return {
		adapter,
		calls,
		notices,
		outcomes,
		lifecycle: createModelSelectionLifecycle(adapter),
	};
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

async function initialize(
	harness: ReturnType<typeof createHarness>,
	overrides: Partial<{
		reason: "startup" | "reload" | "new" | "resume" | "fork";
		hasConversationHistory: boolean;
		argv: readonly string[];
		mode: ModelSelectionMode;
	}> = {},
) {
	return harness.lifecycle.initializeSession({
		reason: "startup",
		hasConversationHistory: false,
		argv: [],
		mode: "normal",
		...overrides,
	});
}

describe("ModelSelectionLifecycle session initialization", () => {
	it.each(["startup", "new"] as const)("opens selection for fresh %s sessions", async (reason) => {
		const harness = createHarness({ picked: undefined });
		await initialize(harness, { reason });
		expect(harness.adapter.pick).toHaveBeenCalledOnce();
	});

	it.each([
		["--model", "picked-provider/picked-model"],
		["--model=picked-provider/picked-model"],
	])("bypasses fresh selection for explicit model arguments", async (...argv) => {
		const harness = createHarness();
		expect(await initialize(harness, { argv })).toEqual({ kind: "unchanged", reason: "startup-bypassed" });
		expect(harness.adapter.loadSelection).not.toHaveBeenCalled();
	});

	it("does not treat unrelated --model text as an override", async () => {
		const harness = createHarness({ picked: undefined });
		await initialize(harness, { argv: ["--models", "x", "explain --model selection"] });
		expect(harness.adapter.pick).toHaveBeenCalledOnce();
	});

	it.each([
		["startup", true],
		["reload", false],
		["resume", false],
		["fork", false],
	] as const)("uses restored-context handling for %s", async (reason, hasConversationHistory) => {
		const harness = createHarness();
		expect(await initialize(harness, { reason, hasConversationHistory })).toEqual({
			kind: "unchanged",
			reason: "context-current",
		});
		expect(harness.adapter.loadSelection).toHaveBeenCalledOnce();
		expect(harness.adapter.loadSelection).toHaveBeenCalledWith("normal");
		expect(harness.adapter.pick).not.toHaveBeenCalled();
		expect(harness.adapter.applyPickedSelection).not.toHaveBeenCalled();
	});

	it("applies the normal Profile silently, even when Plan Mode is active", async () => {
		const normal = { provider: "normal", modelId: "model", thinkingLevel: "xhigh" as const, contextWindow: 256_000 };
		const plan = { provider: "plan", modelId: "model", thinkingLevel: "low" as const, contextWindow: 128_000 };
		const harness = createHarness({ selections: { normal, plan } });
		const outcome = await initialize(harness, { mode: "plan" });
		expect(outcome.kind).toBe("startup-profile-applied");
		expect(harness.adapter.loadSelection).toHaveBeenCalledWith("normal");
		expect(harness.adapter.applyStoredSelection).toHaveBeenCalledWith(normal, "Normal profile");
		expect(harness.adapter.pick).not.toHaveBeenCalled();
	});

	it("falls back to a second mode-specific read when the normal Profile is missing", async () => {
		const harness = createHarness({ picked: undefined });
		await initialize(harness, { mode: "plan" });
		expect(harness.calls).toEqual(["load:normal", "runtime", "load:plan", "pick"]);
	});

	it("reports a failed startup Profile and then falls back to the picker", async () => {
		const profile = { provider: "normal", modelId: "model", thinkingLevel: "high" as const, contextWindow: 256_000 };
		const failure = new Error("invalid profile");
		const harness = createHarness({
			selections: { normal: profile },
			applyStoredError: failure,
			picked: undefined,
		});
		await initialize(harness);
		expect(harness.notices).toEqual([{ kind: "startup-profile-apply-failed", cause: failure }]);
		expect(harness.adapter.pick).toHaveBeenCalledOnce();
	});

	it("preserves separate notices and reads when startup preference loading fails twice", async () => {
		const first = new Error("startup read");
		const second = new Error("picker read");
		const harness = createHarness({ loadResults: [first, second], picked: undefined });
		await initialize(harness);
		expect(harness.notices).toEqual([
			{ kind: "startup-profile-apply-failed", cause: first },
			{ kind: "saved-selection-read-failed", cause: second },
		]);
		expect(harness.adapter.loadSelection).toHaveBeenCalledTimes(2);
	});

	it("synchronizes matching Profile context through context normalization", async () => {
		const sentinelCurrent = { ...currentModel, contextWindow: 128_000 } as Model<Api>;
		const profile = {
			provider: sentinelCurrent.provider,
			modelId: sentinelCurrent.id,
			thinkingLevel: "medium" as const,
			contextWindow: 128_000,
		};
		const harness = createHarness({ runtime: { model: sentinelCurrent }, selections: { plan: profile } });
		const outcome = await initialize(harness, { reason: "reload", mode: "plan" });
		expect(outcome.kind).toBe("context-synchronized");
		expect(harness.adapter.loadSelection).toHaveBeenCalledWith("plan");
		expect(harness.adapter.setModel).toHaveBeenCalledWith(expect.objectContaining({ contextWindow: 256_000 }));
		expect(harness.adapter.pick).not.toHaveBeenCalled();
	});

	it("ignores mismatched Profile context and keeps a current normalized model unchanged", async () => {
		const mismatch = { provider: "other", modelId: "model", thinkingLevel: "medium" as const, contextWindow: 256_000 };
		const harness = createHarness({ selections: { normal: mismatch } });
		expect(await initialize(harness, { reason: "reload" })).toEqual({ kind: "unchanged", reason: "context-current" });
		expect(harness.adapter.setModel).not.toHaveBeenCalled();
	});

	it("returns no-current-model without loading preferences", async () => {
		const harness = createHarness({ runtime: {} });
		expect(await initialize(harness, { reason: "resume" })).toEqual({ kind: "unchanged", reason: "no-current-model" });
		expect(harness.adapter.loadSelection).not.toHaveBeenCalled();
	});

	it("rejects failed synchronized authentication with the established message", async () => {
		const profile = { provider: currentModel.provider, modelId: currentModel.id, thinkingLevel: "medium" as const, contextWindow: 500_000 };
		const harness = createHarness({ selections: { normal: profile }, setModelResult: false });
		await expect(initialize(harness, { reason: "reload" })).rejects.toThrow(
			"No configured authentication for current-provider/current-model",
		);
	});
});

describe("ModelSelectionLifecycle interactive selection", () => {
	it("uses saved defaults for the active mode and resolves saved context", async () => {
		const normal = { provider: "normal", modelId: "model", thinkingLevel: "low" as const, contextWindow: 300_000 };
		const plan = { provider: "plan", modelId: "model", thinkingLevel: "xhigh" as const, contextWindow: 128_000 };
		const harness = createHarness({ selections: { normal, plan }, picked: undefined });
		await harness.lifecycle.selectInteractively({ initialQuery: "  query  ", mode: "plan" });
		expect(harness.adapter.loadSelection).toHaveBeenCalledWith("plan");
		expect(harness.adapter.pick).toHaveBeenCalledWith(expect.objectContaining({
			initialQuery: "query",
			previous: { provider: "plan", modelId: "model", thinkingLevel: "xhigh", contextWindow: 256_000 },
		}));
	});

	it("does not seed concrete defaults from a default-sentinel Profile", async () => {
		const profile = { provider: DEFAULT_SENTINEL, modelId: DEFAULT_SENTINEL, thinkingLevel: DEFAULT_SENTINEL, contextWindow: DEFAULT_SENTINEL };
		const harness = createHarness({ selections: { normal: profile }, picked: undefined });
		await harness.lifecycle.selectInteractively({ initialQuery: "", mode: "normal" });
		expect(harness.adapter.pick).toHaveBeenCalledWith(expect.objectContaining({
			previous: { provider: currentModel.provider, modelId: currentModel.id, thinkingLevel: "medium" },
		}));
	});

	it("reports preference read failure and uses live defaults", async () => {
		const failure = new Error("read failed");
		const harness = createHarness({ loadResults: [failure], picked: undefined });
		await harness.lifecycle.selectInteractively({ initialQuery: "", mode: "normal" });
		expect(harness.notices).toEqual([{ kind: "saved-selection-read-failed", cause: failure }]);
		expect(harness.adapter.pick).toHaveBeenCalledWith(expect.objectContaining({
			previous: { provider: currentModel.provider, modelId: currentModel.id, thinkingLevel: "medium" },
		}));
	});

	it("cancellation performs no mutation, persistence, or compaction", async () => {
		const harness = createHarness({ picked: undefined });
		expect(await harness.lifecycle.selectInteractively({ initialQuery: "", mode: "normal" }))
			.toEqual({ kind: "unchanged", reason: "picker-cancelled" });
		expect(harness.adapter.applyPickedSelection).not.toHaveBeenCalled();
		expect(harness.adapter.requestCompaction).not.toHaveBeenCalled();
	});

	it("confirms at exactly 80% and applies, persists, then compacts", async () => {
		const harness = createHarness({ runtime: { model: currentModel, usageTokens: 400_000 } });
		const outcome = await harness.lifecycle.selectInteractively({ initialQuery: "", mode: "plan" });
		expect(harness.calls).toEqual(["runtime", "load:plan", "pick", "confirm", "apply-live", "persist", "compact"]);
		expect(harness.adapter.applyPickedSelection).toHaveBeenCalledWith(picked, "plan");
		expect(harness.adapter.requestCompaction).toHaveBeenCalledWith(SEMANTIC_COMPACTION_FOCUS);
		expect(outcome).toEqual(expect.objectContaining({ kind: "interactive-applied", compaction: "started" }));
	});

	it("does not confirm or compact just below the threshold", async () => {
		const harness = createHarness({ runtime: { model: currentModel, usageTokens: 399_999 } });
		const outcome = await harness.lifecycle.selectInteractively({ initialQuery: "", mode: "normal" });
		expect(harness.adapter.confirmContextReduction).not.toHaveBeenCalled();
		expect(outcome).toEqual(expect.objectContaining({ compaction: "none" }));
	});

	it.each([null, undefined, 900_000])("does not confirm without a qualifying reduction", async (usageTokens) => {
		const larger = { ...pickedModel, contextWindow: 1_000_000 } as Model<Api>;
		const harness = createHarness({
			runtime: { model: currentModel, usageTokens },
			picked: { model: larger, thinkingLevel: "high", contextWindow: larger.contextWindow },
		});
		await harness.lifecycle.selectInteractively({ initialQuery: "", mode: "normal" });
		expect(harness.adapter.confirmContextReduction).not.toHaveBeenCalled();
	});

	it("declining context reduction prevents application", async () => {
		const harness = createHarness({ runtime: { model: currentModel, usageTokens: 400_000 }, confirm: false });
		expect(await harness.lifecycle.selectInteractively({ initialQuery: "", mode: "normal" }))
			.toEqual({ kind: "unchanged", reason: "context-reduction-declined" });
		expect(harness.adapter.applyPickedSelection).not.toHaveBeenCalled();
	});

	it("returns Pi's effective thinking level while retaining the requested level", async () => {
		const effective = { ...applied, thinkingLevel: "low" as ModelThinkingLevel };
		const harness = createHarness({ appliedSelection: effective });
		expect(await harness.lifecycle.selectInteractively({ initialQuery: "", mode: "normal" })).toEqual({
			kind: "interactive-applied",
			selection: effective,
			requestedThinkingLevel: "high",
			compaction: "none",
		});
	});

	it("turns only persistence failures into partial-success outcomes and still compacts", async () => {
		const cause = new Error("disk read-only");
		const failure = new ModelSelectionPersistenceError(applied, cause);
		const harness = createHarness({
			runtime: { model: currentModel, usageTokens: 400_000 },
			applyPickedError: failure,
		});
		expect(await harness.lifecycle.selectInteractively({ initialQuery: "", mode: "normal" })).toEqual({
			kind: "interactive-applied-not-saved",
			selection: applied,
			requestedThinkingLevel: "high",
			cause,
			compaction: "started",
		});
		expect(harness.calls.at(-1)).toBe("compact");
	});

	it("defers required compaction without requesting it while busy", async () => {
		const harness = createHarness({ runtime: { model: currentModel, usageTokens: 400_000 }, idle: false });
		const outcome = await harness.lifecycle.selectInteractively({ initialQuery: "", mode: "normal" });
		expect(outcome).toEqual(expect.objectContaining({ compaction: "deferred" }));
		expect(harness.adapter.requestCompaction).not.toHaveBeenCalled();
	});

	it("propagates ordinary application failures without compaction", async () => {
		const failure = new Error("authentication failed");
		const harness = createHarness({
			runtime: { model: currentModel, usageTokens: 400_000 },
			applyPickedError: failure,
		});
		await expect(harness.lifecycle.selectInteractively({ initialQuery: "", mode: "normal" })).rejects.toBe(failure);
		expect(harness.adapter.requestCompaction).not.toHaveBeenCalled();
	});
});

describe("ModelSelectionLifecycle Session operation ownership", () => {
	it("stops admitting selections while disposal drains a preference read", async () => {
		const loading = deferred<StoredModelSelectionSettings | undefined>();
		const harness = createHarness({ picked: undefined });
		harness.adapter.loadSelection = vi.fn(() => loading.promise);
		const selection = harness.lifecycle.selectInteractively({ initialQuery: "", mode: "normal" });
		await vi.waitFor(() => expect(harness.adapter.loadSelection).toHaveBeenCalledOnce());

		let disposed = false;
		const firstDisposal = harness.lifecycle.dispose();
		expect(harness.lifecycle.dispose()).toBe(firstDisposal);
		const disposal = firstDisposal.then(() => { disposed = true; });
		await expect(harness.lifecycle.selectInteractively({ initialQuery: "again", mode: "normal" }))
			.rejects.toBeInstanceOf(ModelSelectionSessionClosedError);
		expect(disposed).toBe(false);

		loading.resolve(undefined);
		await expect(selection).resolves.toEqual({ kind: "unchanged", reason: "picker-cancelled" });
		await disposal;
		expect(disposed).toBe(true);
		expect(harness.outcomes).toEqual([{ kind: "unchanged", reason: "picker-cancelled" }]);
	});

	it("waits for a pending picker before disposal completes", async () => {
		const picking = deferred<ModelPickerSelection | undefined>();
		const harness = createHarness();
		harness.adapter.pick = vi.fn(() => picking.promise);
		const selection = harness.lifecycle.selectInteractively({ initialQuery: "", mode: "normal" });
		await vi.waitFor(() => expect(harness.adapter.pick).toHaveBeenCalledOnce());
		let disposed = false;
		const disposal = harness.lifecycle.dispose().then(() => { disposed = true; });
		expect(disposed).toBe(false);
		picking.resolve(undefined);
		await selection;
		await disposal;
		expect(disposed).toBe(true);
	});

	it("waits for pending application and persistence before disposal completes", async () => {
		const applying = deferred<ModelSelectionSettings>();
		const harness = createHarness();
		harness.adapter.applyPickedSelection = vi.fn(() => applying.promise);
		const selection = harness.lifecycle.selectInteractively({ initialQuery: "", mode: "normal" });
		await vi.waitFor(() => expect(harness.adapter.applyPickedSelection).toHaveBeenCalledOnce());
		let disposed = false;
		const disposal = harness.lifecycle.dispose().then(() => { disposed = true; });
		expect(disposed).toBe(false);
		applying.resolve(applied);
		await expect(selection).resolves.toEqual(expect.objectContaining({ kind: "interactive-applied" }));
		await disposal;
		expect(disposed).toBe(true);
	});

	it("waits for context-reduction confirmation before disposal completes", async () => {
		const confirmation = deferred<boolean>();
		const harness = createHarness({ runtime: { model: currentModel, usageTokens: 400_000 } });
		harness.adapter.confirmContextReduction = vi.fn(() => confirmation.promise);
		const selection = harness.lifecycle.selectInteractively({ initialQuery: "", mode: "normal" });
		await vi.waitFor(() => expect(harness.adapter.confirmContextReduction).toHaveBeenCalledOnce());
		let disposed = false;
		const disposal = harness.lifecycle.dispose().then(() => { disposed = true; });
		expect(disposed).toBe(false);
		confirmation.resolve(false);
		await expect(selection).resolves.toEqual({ kind: "unchanged", reason: "context-reduction-declined" });
		await disposal;
		expect(disposed).toBe(true);
		expect(harness.adapter.applyPickedSelection).not.toHaveBeenCalled();
	});

	it("permanently suppresses adapter calls after disposal", async () => {
		const harness = createHarness();
		await harness.lifecycle.dispose();
		await expect(initialize(harness)).rejects.toBeInstanceOf(ModelSelectionSessionClosedError);
		await expect(harness.lifecycle.selectInteractively({ initialQuery: "", mode: "normal" }))
			.rejects.toBeInstanceOf(ModelSelectionSessionClosedError);
		expect(harness.adapter.loadSelection).not.toHaveBeenCalled();
		expect(harness.adapter.pick).not.toHaveBeenCalled();
		expect(harness.outcomes).toEqual([]);
	});
});
