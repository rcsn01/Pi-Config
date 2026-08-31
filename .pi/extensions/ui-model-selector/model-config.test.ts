import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SEMANTIC_COMPACTION_FOCUS } from "../_shared/auto-compact.ts";
import {
	getModelCommandHandler,
	installModelCommandHandler,
	parseModelCommand,
} from "../_shared/model-command-routing.ts";
import { createModelSelectorExtension } from "./index.ts";
import {
	contextWindowChoices,
	filterModels,
	findExactModel,
	formatTokenCount,
} from "./model-config.ts";

afterEach(() => {
	const clearActiveHandler = installModelCommandHandler(async () => {});
	clearActiveHandler();
});

const models = [
	{
		provider: "github-copilot",
		id: "gpt-5.6-sol",
		name: "GPT 5.6 Sol",
		contextWindow: 1_050_000,
		reasoning: true,
	},
	{
		provider: "anthropic",
		id: "claude-sonnet-4.6",
		name: "Claude Sonnet 4.6",
		contextWindow: 1_000_000,
		reasoning: true,
	},
];

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

function createAdapterHarness(options: {
	cancel?: boolean;
	modelSelectionPromise?: Promise<string | undefined>;
	mode?: "tui" | "print" | "json" | "rpc";
	requestedThinkingLevel?: ThinkingLevel;
	effectiveThinkingLevel?: ThinkingLevel;
	requestedContextWindow?: number;
	usageTokens?: number;
	idle?: boolean;
	setModelResult?: boolean;
	saveError?: Error;
	savePromise?: Promise<void>;
	refreshError?: Error;
	persistenceFactoryError?: Error;
	profiles?: Record<string, {
		provider: string;
		modelId: string;
		thinkingLevel: ThinkingLevel;
		contextWindow: number;
	}>;
} = {}) {
	const handlers = new Map<string, (event: any, ctx: ExtensionContext) => unknown>();
	let thinkingLevel: ThinkingLevel = "medium";
	const custom = vi.fn(async () => options.cancel
		? undefined
		: options.modelSelectionPromise
			? await options.modelSelectionPromise
			: "anthropic/claude-sonnet-4.6");
	const select = vi.fn(async (title: string, choices: string[]) => {
		if (title.startsWith("Thinking ·")) {
			const requested = options.requestedThinkingLevel ?? "high";
			return choices.find((choice) => choice.includes(` ${requested} —`)) ?? choices[0];
		}
		if (options.requestedContextWindow === undefined) return choices[0];
		return choices.find((choice) => choice.includes(formatTokenCount(options.requestedContextWindow!)));
	});
	const notify = vi.fn();
	const setEditorComponent = vi.fn();
	const compact = vi.fn();
	const setModel = vi.fn(async () => options.setModelResult ?? true);
	const save = vi.fn(async (_mode: "normal" | "plan", _selection: unknown) => {
		if (options.saveError) throw options.saveError;
		if (options.savePromise) await options.savePromise;
	});
	const load = vi.fn(async (mode: "normal" | "plan") => options.profiles?.[mode]);
	const persistenceInstances: Array<{
		load: ReturnType<typeof vi.fn>;
		save: ReturnType<typeof vi.fn>;
	}> = [];
	const savedByInstance: number[] = [];
	const createModelSelectionPersistence = vi.fn((_settingsPath: string) => {
		if (options.persistenceFactoryError) throw options.persistenceFactoryError;
		const instanceIndex = persistenceInstances.length;
		const persistence = {
			load: vi.fn((mode: "normal" | "plan") => load(mode)),
			save: vi.fn(async (mode: "normal" | "plan", selection: unknown) => {
				savedByInstance.push(instanceIndex);
				await save(mode, selection);
			}),
		};
		persistenceInstances.push(persistence);
		return persistence;
	});
	const ctx = {
		mode: options.mode ?? "tui",
		model: models[0],
		scopedModels: [],
		modelRegistry: {
			refresh: vi.fn(async () => ({
				aborted: false,
				errors: options.refreshError
					? new Map([[models[1].provider, options.refreshError]])
					: new Map(),
			})),
			getAvailable: vi.fn(() => models),
			find: vi.fn((provider: string, id: string) =>
				models.find((model) => model.provider === provider && model.id === id)),
		},
		ui: {
			custom,
			select,
			confirm: vi.fn(async () => true),
			notify,
			setEditorComponent,
		},
		getContextUsage: vi.fn(() => ({ tokens: options.usageTokens ?? 0 })),
		isIdle: vi.fn(() => options.idle ?? true),
		compact,
		sessionManager: {
			getEntries: vi.fn(() => []),
			getBranch: vi.fn(() => []),
			getLeafId: vi.fn(() => undefined),
		},
	} as unknown as ExtensionContext;
	const pi = {
		on: (event: string, handler: (event: any, ctx: ExtensionContext) => unknown) => handlers.set(event, handler),
		setModel,
		getThinkingLevel: vi.fn(() => thinkingLevel),
		setThinkingLevel: vi.fn((level: ThinkingLevel) => {
			thinkingLevel = options.effectiveThinkingLevel ?? level;
		}),
	} as unknown as ExtensionAPI;
	createModelSelectorExtension({ createModelSelectionPersistence })(pi);

	return {
		ctx,
		custom,
		select,
		notify,
		setEditorComponent,
		compact,
		setModel,
		load,
		save,
		createModelSelectionPersistence,
		persistenceInstances,
		savedByInstance,
		emitStart: async (reason: "startup" | "reload" | "new" | "resume" | "fork" = "startup") => {
			await handlers.get("session_start")?.({ type: "session_start", reason }, ctx);
		},
		emitShutdown: async () => {
			await handlers.get("session_shutdown")?.({ type: "session_shutdown" }, ctx);
		},
	};
}

describe("model command routing", () => {
	it("parses exact /model commands and preserves arguments", () => {
		expect(parseModelCommand("/model")).toBe("");
		expect(parseModelCommand("/model github-copilot/gpt-5.6-sol")).toBe(
			"github-copilot/gpt-5.6-sol",
		);
		expect(parseModelCommand("  /model  \n")).toBe("");
	});

	it("ignores similarly named commands, prose, and multiline prompts", () => {
		expect(parseModelCommand("/models")).toBeUndefined();
		expect(parseModelCommand("please run /model")).toBeUndefined();
		expect(parseModelCommand("/model\nthen continue")).toBeUndefined();
	});

	it("does not let stale cleanup remove a newer active handler", () => {
		const first = async () => {};
		const second = async () => {};
		const uninstallFirst = installModelCommandHandler(first);
		const uninstallSecond = installModelCommandHandler(second);
		uninstallFirst();
		expect(getModelCommandHandler()).toBe(second);
		uninstallSecond();
		expect(getModelCommandHandler()).toBeUndefined();
	});
});

describe("Pi model-selection adapter", () => {
	it("constructs Session persistence before the first selection read", async () => {
		const harness = createAdapterHarness({ cancel: true });
		await harness.emitStart();
		expect(harness.createModelSelectionPersistence).toHaveBeenCalledOnce();
		expect(harness.createModelSelectionPersistence.mock.invocationCallOrder[0]).toBeLessThan(harness.load.mock.invocationCallOrder[0]);
		expect(harness.load).toHaveBeenCalledWith("normal");
	});

	it.each(["print", "json", "rpc"] as const)("does not install selector UI in %s mode", async (mode) => {
		const harness = createAdapterHarness({ mode });
		await harness.emitStart();
		expect(harness.createModelSelectionPersistence).toHaveBeenCalledOnce();
		expect(harness.load).not.toHaveBeenCalled();
		expect(harness.setEditorComponent).not.toHaveBeenCalled();
		expect(getModelCommandHandler()).toBeUndefined();
	});

	it("fails Session initialization instead of falling back when persistence construction fails", async () => {
		const harness = createAdapterHarness({ persistenceFactoryError: new Error("cannot bind Profile") });
		await expect(harness.emitStart()).rejects.toThrow("cannot bind Profile");
		expect(harness.load).not.toHaveBeenCalled();
		expect(harness.setEditorComponent).not.toHaveBeenCalled();
	});

	it("installs the command handler and routing editor", async () => {
		const harness = createAdapterHarness({ cancel: true });
		await harness.emitStart();
		expect(getModelCommandHandler()).toBeTypeOf("function");
		expect(harness.setEditorComponent).toHaveBeenCalledWith(expect.any(Function));
	});

	it("renders the exact successful selection notification", async () => {
		const harness = createAdapterHarness();
		await harness.emitStart();
		expect(harness.save).toHaveBeenCalledWith("normal", expect.objectContaining({
			provider: "anthropic",
			modelId: "claude-sonnet-4.6",
			thinkingLevel: "high",
			contextWindow: 1_000_000,
		}));
		expect(harness.notify).toHaveBeenCalledWith(
			"anthropic/claude-sonnet-4.6 · thinking high · context 1M",
			"info",
		);
	});

	it("warns when Pi clamps the requested thinking level", async () => {
		const harness = createAdapterHarness({ effectiveThinkingLevel: "low" });
		await harness.emitStart();
		expect(harness.notify).toHaveBeenCalledWith(
			"anthropic/claude-sonnet-4.6 · thinking low (requested high) · context 1M",
			"warning",
		);
	});

	it("renders a partial-persistence warning without an error notification", async () => {
		const harness = createAdapterHarness({ saveError: new Error("settings disk is read-only") });
		await harness.emitStart();
		expect(harness.notify).toHaveBeenCalledWith(
			"anthropic/claude-sonnet-4.6 was applied, but settings were not fully saved: settings disk is read-only",
			"warning",
		);
		expect(harness.notify).not.toHaveBeenCalledWith(expect.anything(), "error");
	});

	it("renders authentication failures as errors", async () => {
		const harness = createAdapterHarness({ setModelResult: false });
		await harness.emitStart();
		expect(harness.notify).toHaveBeenCalledWith(
			"No configured authentication for anthropic/claude-sonnet-4.6.",
			"error",
		);
		expect(harness.save).not.toHaveBeenCalled();
	});

	it("renders catalogue failures without opening the picker", async () => {
		const harness = createAdapterHarness({ refreshError: new Error("catalogue unavailable") });
		await harness.emitStart();
		expect(harness.notify).toHaveBeenCalledWith(expect.stringContaining("catalogue unavailable"), "error");
		expect(harness.custom).not.toHaveBeenCalled();
	});

	it("renders deferred compaction before the final selection notification", async () => {
		const harness = createAdapterHarness({ usageTokens: 900_000, idle: false });
		await harness.emitStart();
		expect(harness.compact).not.toHaveBeenCalled();
		expect(harness.notify.mock.calls).toEqual([
			["The agent is busy; auto-compact will compact and resume this turn.", "info"],
			["anthropic/claude-sonnet-4.6 · thinking high · context 1M", "info"],
		]);
	});

	it("translates immediate compaction with the semantic focus after persistence", async () => {
		const harness = createAdapterHarness({ usageTokens: 900_000 });
		await harness.emitStart();
		expect(harness.compact).toHaveBeenCalledWith(expect.objectContaining({
			customInstructions: SEMANTIC_COMPACTION_FOCUS,
		}));
		expect(harness.save.mock.invocationCallOrder[0]).toBeLessThan(
			harness.compact.mock.invocationCallOrder[0],
		);
	});

	it("renders asynchronous compaction callback failures", async () => {
		const harness = createAdapterHarness({ usageTokens: 900_000 });
		await harness.emitStart();
		const options = harness.compact.mock.calls[0][0];
		options.onError(new Error("summary failed"));
		expect(harness.notify).toHaveBeenCalledWith("Compaction failed: summary failed", "error");
	});

	it("replaces command ownership and persistence when the session initializes again", async () => {
		const harness = createAdapterHarness({ cancel: true });
		await harness.emitStart();
		const first = getModelCommandHandler();
		const firstPersistence = harness.persistenceInstances[0];
		await harness.emitStart("reload");
		expect(getModelCommandHandler()).toBeTypeOf("function");
		expect(getModelCommandHandler()).not.toBe(first);
		expect(harness.persistenceInstances).toHaveLength(2);
		expect(harness.persistenceInstances[1]).not.toBe(firstPersistence);
	});

	it("finishes an in-flight save before constructing the next Session persistence", async () => {
		const save = deferred<void>();
		const harness = createAdapterHarness({ savePromise: save.promise });
		await harness.emitStart("resume");
		const firstHandler = getModelCommandHandler()!;
		const oldSelection = firstHandler("");
		await vi.waitFor(() => expect(harness.persistenceInstances[0].save).toHaveBeenCalledOnce());

		const reload = harness.emitStart("reload");
		await Promise.resolve();
		expect(harness.persistenceInstances).toHaveLength(1);
		save.resolve();
		await Promise.all([oldSelection, reload]);

		expect(harness.persistenceInstances).toHaveLength(2);
		expect(harness.savedByInstance).toEqual([0]);
		expect(harness.persistenceInstances[1].save).not.toHaveBeenCalled();
	});

	it("silently rejects a captured handler after its Session is replaced", async () => {
		const harness = createAdapterHarness({ cancel: true });
		await harness.emitStart();
		const oldHandler = getModelCommandHandler()!;
		const oldLoad = harness.persistenceInstances[0].load;
		await harness.emitStart("reload");
		const loadCount = oldLoad.mock.calls.length;

		await expect(oldHandler("")).resolves.toBeUndefined();
		expect(oldLoad).toHaveBeenCalledTimes(loadCount);
		expect(harness.notify).not.toHaveBeenCalledWith("Model-selection Session is no longer active.", "error");
	});

	it("removes command ownership and editor installation on shutdown", async () => {
		const harness = createAdapterHarness({ cancel: true });
		await harness.emitStart();
		expect(getModelCommandHandler()).toBeTypeOf("function");
		await harness.emitShutdown();
		expect(getModelCommandHandler()).toBeUndefined();
		expect(harness.setEditorComponent).toHaveBeenLastCalledWith(undefined);
	});
});

describe("context window step", () => {
	it("derives rounded presets and omits windows below 128K", () => {
		expect(contextWindowChoices(1_048_576)).toEqual([1_048_576, 524_288, 393_216, 262_144]);
		expect(contextWindowChoices(1_000_000)).toEqual([1_000_000, 500_000, 375_000, 250_000]);
		expect(contextWindowChoices(512_000)).toEqual([512_000, 256_000, 192_000, 128_000]);
		expect(contextWindowChoices(500_000)).toEqual([500_000, 250_000, 187_500]);
		expect(contextWindowChoices(128_000)).toEqual([128_000]);
		expect(contextWindowChoices(2)).toEqual([]);
	});

	it("formats token counts", () => {
		expect(formatTokenCount(999)).toBe("999");
		expect(formatTokenCount(128_000)).toBe("128K");
		expect(formatTokenCount(1_050_000)).toBe("1.05M");
	});
});

describe("model selection helpers", () => {
	it("finds canonical references and filters by model name", () => {
		expect(findExactModel(models, "github-copilot/gpt-5.6-sol")).toBe(models[0]);
		expect(filterModels(models, "sonnet")).toEqual([models[1]]);
	});
});
