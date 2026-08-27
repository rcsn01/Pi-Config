import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	getModelCommandHandler,
	installModelCommandHandler,
	parseModelCommand,
} from "../_shared/model-command-routing.ts";
import { SEMANTIC_COMPACTION_FOCUS } from "../_shared/auto-compact.ts";
import { createModelSelectorExtension } from "./index.ts";
import {
	contextWindowChoices,
	filterModels,
	findExactModel,
	formatTokenCount,
	hasExplicitModelArgument,
	shouldOpenStartupModelSelector,
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

describe("startup model selection", () => {
	it("opens for a fresh startup and /new", () => {
		expect(shouldOpenStartupModelSelector("startup", false, [])).toBe(true);
		expect(shouldOpenStartupModelSelector("new", false, [])).toBe(true);
	});

	it("does not open when startup restores conversation history", () => {
		expect(shouldOpenStartupModelSelector("startup", true, [])).toBe(false);
	});

	it.each(["reload", "resume", "fork"] as const)("does not open for %s", (reason) => {
		expect(shouldOpenStartupModelSelector(reason, false, [])).toBe(false);
	});

	it("recognizes only the two explicit --model forms", () => {
		expect(hasExplicitModelArgument(["--model", "anthropic/claude-sonnet-4.6"])).toBe(true);
		expect(hasExplicitModelArgument(["--model=anthropic/claude-sonnet-4.6"])).toBe(true);
	});

	it.each(["startup", "new"] as const)("bypasses %s for either explicit model syntax", (reason) => {
		expect(shouldOpenStartupModelSelector(reason, false, ["--model", "gpt-5.6-sol"])).toBe(false);
		expect(shouldOpenStartupModelSelector(reason, false, ["--model=gpt-5.6-sol"])).toBe(false);
	});

	it("does not mistake model scoping, unrelated arguments, or prompt text for an override", () => {
		const argv = ["--models", "gpt-*", "--provider", "anthropic", "explain --model selection"];
		expect(hasExplicitModelArgument(argv)).toBe(false);
		expect(shouldOpenStartupModelSelector("startup", false, argv)).toBe(true);
		expect(shouldOpenStartupModelSelector("new", false, argv)).toBe(true);
	});
});

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

function createLifecycleHarness(options: {
	cancel?: boolean;
	cancelContext?: boolean;
	confirmApproved?: boolean;
	contextWindows?: Record<string, number>;
	planActive?: boolean;
	profiles?: Record<string, {
		provider: string;
		modelId: string;
		thinkingLevel: ThinkingLevel;
		contextWindow: number;
	}>;
	initialThinkingLevel?: ThinkingLevel;
	requestedThinkingLevel?: ThinkingLevel;
	effectiveThinkingLevel?: ThinkingLevel;
	requestedContextWindow?: number;
	idle?: boolean;
	hasConversationHistory?: boolean;
	mode?: "tui" | "print" | "json" | "rpc";
	refreshError?: Error;
	pickedModel?: (typeof models)[number];
	currentModel?: (typeof models)[number];
	setModelResult?: boolean;
	saveError?: Error;
	usageTokens?: number;
} = {}) {
	const handlers = new Map<string, (event: any, ctx: ExtensionContext) => unknown>();
	const entries = options.hasConversationHistory
		? [{
			type: "message",
			id: "message-1",
			parentId: null,
			timestamp: new Date().toISOString(),
			message: { role: "user", content: [{ type: "text", text: "Existing conversation" }] },
		}]
		: [];
	const pickedModel = (options.pickedModel ?? models[1]) as any;
	const currentModel = (options.currentModel ?? models[0]) as any;
	let thinkingLevel: ThinkingLevel = options.initialThinkingLevel ?? "medium";
	const custom = vi.fn(async () => options.cancel ? undefined : `${pickedModel.provider}/${pickedModel.id}`);
	const setModel = vi.fn(async () => options.setModelResult ?? true);
	const setThinkingLevel = vi.fn((level: ThinkingLevel) => {
		thinkingLevel = options.effectiveThinkingLevel ?? level;
	});
	const setEditorComponent = vi.fn();
	const notify = vi.fn();
	const save = vi.fn(async () => {
		if (options.saveError) throw options.saveError;
	});
	const setPath = vi.fn();
	const load = vi.fn(async () => ({
		profiles: options.profiles ?? {},
		contextWindows: options.contextWindows ?? {},
	}));
	const confirm = vi.fn(async () => options.confirmApproved ?? true);
	const compact = vi.fn();
	const select = vi.fn(async (title: string, choices: string[]) => {
		if (title.startsWith("Thinking ·")) {
			const requested = options.requestedThinkingLevel ?? "high";
			return choices.find((choice) => choice.includes(` ${requested} —`)) ?? choices[0];
		}
		if (options.cancelContext) return undefined;
		if (options.requestedContextWindow === undefined) return choices[0];
		return choices.find((choice) => choice.includes(formatTokenCount(options.requestedContextWindow!)));
	});
	const ctx = {
		mode: options.mode ?? "tui",
		model: currentModel,
		scopedModels: [],
		modelRegistry: {
			refresh: vi.fn(async () => ({
				aborted: false,
				errors: options.refreshError
					? new Map([[pickedModel.provider, options.refreshError]])
					: new Map(),
			})),
			getAvailable: vi.fn(() => models),
			find: vi.fn((provider: string, id: string) => models.find((model) => model.provider === provider && model.id === id)),
		},
		ui: {
			custom,
			select,
			confirm,
			notify,
			setEditorComponent,
		},
		getContextUsage: vi.fn(() => ({ tokens: options.usageTokens ?? 0 })),
		isIdle: vi.fn(() => options.idle ?? true),
		compact,
		sessionManager: {
			getEntries: vi.fn(() => entries),
			getBranch: vi.fn(() => options.planActive
				? [...entries, { type: "custom", customType: "plan-mode-state", data: { active: true } }]
				: entries),
			getLeafId: vi.fn(() => entries.at(-1)?.id),
		},
	} as unknown as ExtensionContext;
	const pi = {
		on: (event: string, handler: (event: any, ctx: ExtensionContext) => unknown) => handlers.set(event, handler),
		setModel,
		getThinkingLevel: vi.fn(() => thinkingLevel),
		setThinkingLevel,
	} as unknown as ExtensionAPI;
	createModelSelectorExtension({ load, save, setPath })(pi);

	return {
		custom,
		select,
		confirm,
		compact,
		setModel,
		setThinkingLevel,
		setEditorComponent,
		setPath,
		notify,
		load,
		save,
		emit: async (reason: "startup" | "reload" | "new" | "resume" | "fork") => {
			await handlers.get("session_start")?.({ type: "session_start", reason }, ctx);
		},
	};
}

describe("model selector lifecycle", () => {
	it("applies the session path before loading model settings", async () => {
		const harness = createLifecycleHarness();
		await harness.emit("startup");

		expect(harness.setPath).toHaveBeenCalledOnce();
		expect(harness.setPath.mock.invocationCallOrder[0]).toBeLessThan(harness.load.mock.invocationCallOrder[0]);
	});

	it("opens the picker and applies the selected model", async () => {
		const harness = createLifecycleHarness();
		await harness.emit("startup");

		expect(harness.custom).toHaveBeenCalledOnce();
		expect(harness.select).toHaveBeenCalledTimes(2);
		expect(harness.setModel).toHaveBeenCalledWith(expect.objectContaining({ id: "claude-sonnet-4.6" }));
		expect(harness.save).toHaveBeenCalledOnce();
	});

	it("stops without applying when the picker is cancelled", async () => {
		const harness = createLifecycleHarness({ cancel: true });
		await harness.emit("startup");

		expect(harness.custom).toHaveBeenCalledOnce();
		expect(harness.select).not.toHaveBeenCalled();
		expect(harness.setModel).not.toHaveBeenCalled();
		expect(harness.setThinkingLevel).not.toHaveBeenCalled();
		expect(harness.save).not.toHaveBeenCalled();
	});

	it("prompts before applying a smaller context to a high-usage session", async () => {
		const harness = createLifecycleHarness({ usageTokens: 950_000 });
		await harness.emit("startup");

		expect(harness.confirm).toHaveBeenCalledWith(
			"Context window reduction",
			expect.stringContaining("950K"),
		);
	});

	it("declining context reduction prevents apply, persistence, and compaction", async () => {
		const harness = createLifecycleHarness({ usageTokens: 950_000, confirmApproved: false });
		await harness.emit("startup");

		expect(harness.confirm).toHaveBeenCalledOnce();
		expect(harness.setModel).not.toHaveBeenCalled();
		expect(harness.setThinkingLevel).not.toHaveBeenCalled();
		expect(harness.save).not.toHaveBeenCalled();
		expect(harness.compact).not.toHaveBeenCalled();
	});

	it("applies and compacts exactly once after context reduction is approved", async () => {
		const harness = createLifecycleHarness({ usageTokens: 950_000 });
		await harness.emit("startup");

		expect(harness.setModel).toHaveBeenCalledOnce();
		expect(harness.save).toHaveBeenCalledOnce();
		expect(harness.compact).toHaveBeenCalledOnce();
		expect(harness.compact).toHaveBeenCalledWith(expect.objectContaining({
			customInstructions: SEMANTIC_COMPACTION_FOCUS,
		}));
	});

	it("compacts once and emits one explicit warning when persistence fails after reduction", async () => {
		const harness = createLifecycleHarness({
			usageTokens: 950_000,
			saveError: new Error("settings disk is read-only"),
		});
		await harness.emit("startup");

		expect(harness.setModel).toHaveBeenCalledOnce();
		expect(harness.compact).toHaveBeenCalledOnce();
		expect(harness.notify).toHaveBeenCalledOnce();
		expect(harness.notify).toHaveBeenCalledWith(
			expect.stringMatching(/was applied, but settings were not fully saved: settings disk is read-only/),
			"warning",
		);
		expect(harness.notify).not.toHaveBeenCalledWith(expect.anything(), "error");
	});

	it("reports authentication failure without persisting or compacting", async () => {
		const harness = createLifecycleHarness({ usageTokens: 950_000, setModelResult: false });
		await harness.emit("startup");

		expect(harness.setModel).toHaveBeenCalledOnce();
		expect(harness.setThinkingLevel).not.toHaveBeenCalled();
		expect(harness.save).not.toHaveBeenCalled();
		expect(harness.compact).not.toHaveBeenCalled();
		expect(harness.notify).toHaveBeenCalledWith(
			expect.stringContaining("No configured authentication"),
			"error",
		);
	});

	it("uses the returned effective thinking level in success notifications", async () => {
		const harness = createLifecycleHarness({ requestedThinkingLevel: "high" });
		await harness.emit("startup");

		expect(harness.notify).toHaveBeenCalledWith(
			"anthropic/claude-sonnet-4.6 · thinking high · context 1M",
			"info",
		);
	});

	it("warns when the returned effective thinking level was clamped", async () => {
		const harness = createLifecycleHarness({
			requestedThinkingLevel: "high",
			effectiveThinkingLevel: "low",
		});
		await harness.emit("startup");

		expect(harness.notify).toHaveBeenCalledWith(
			"anthropic/claude-sonnet-4.6 · thinking low (requested high) · context 1M",
			"warning",
		);
	});

	it("reports catalogue refresh failures without opening or applying the selector", async () => {
		const harness = createLifecycleHarness({ refreshError: new Error("catalogue unavailable") });
		await harness.emit("startup");
		expect(harness.notify).toHaveBeenCalledWith(
			expect.stringContaining("catalogue unavailable"),
			"error",
		);
		expect(harness.custom).not.toHaveBeenCalled();
		expect(harness.setModel).not.toHaveBeenCalled();
	});

	it("uses the complete normal profile as the fresh-session startup default", async () => {
		const harness = createLifecycleHarness({
			profiles: {
				normal: {
					provider: "github-copilot",
					modelId: "gpt-5.6-sol",
					thinkingLevel: "xhigh",
					contextWindow: 256_000,
				},
			},
		});
		await harness.emit("startup");

		expect(harness.setModel).toHaveBeenCalledWith(expect.objectContaining({
			provider: "github-copilot",
			id: "gpt-5.6-sol",
			contextWindow: 256_000,
		}));
		expect(harness.setThinkingLevel).toHaveBeenCalledWith("xhigh");
		expect(harness.custom).not.toHaveBeenCalled();
		expect(harness.save).not.toHaveBeenCalled();
	});

	it("keeps reload/resume context synchronization off the picker path", async () => {
		const harness = createLifecycleHarness({
			currentModel: models[1],
			profiles: {
				normal: {
					provider: "anthropic",
					modelId: "claude-sonnet-4.6",
					thinkingLevel: "medium",
					contextWindow: 256_000,
				},
			},
		});
		await harness.emit("reload");

		expect(harness.custom).not.toHaveBeenCalled();
		expect(harness.setModel).toHaveBeenCalledWith(expect.objectContaining({
			id: "claude-sonnet-4.6",
			contextWindow: 256_000,
		}));
		expect(harness.save).not.toHaveBeenCalled();
	});

	it("does not invoke the selector when startup restores conversation history", async () => {
		const harness = createLifecycleHarness({ hasConversationHistory: true });
		await harness.emit("startup");
		expect(harness.custom).not.toHaveBeenCalled();
		expect(harness.save).not.toHaveBeenCalled();
	});

	it.each(["print", "json", "rpc"] as const)("does not install or open selector UI in %s mode", async (mode) => {
		const harness = createLifecycleHarness({ mode });
		await harness.emit("startup");
		expect(harness.setEditorComponent).not.toHaveBeenCalled();
		expect(harness.custom).not.toHaveBeenCalled();
		expect(harness.setModel).not.toHaveBeenCalled();
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

	it("persists and applies a reduced context window, and shows it in the notify", async () => {
		const harness = createLifecycleHarness({ requestedContextWindow: 500_000 });
		await harness.emit("startup");

		expect(harness.setModel).toHaveBeenCalledWith(expect.objectContaining({
			id: "claude-sonnet-4.6",
			contextWindow: 500_000,
		}));
		expect(harness.save).toHaveBeenCalledWith("normal", expect.objectContaining({ contextWindow: 500_000 }));
		expect(harness.notify).toHaveBeenCalledWith(
			"anthropic/claude-sonnet-4.6 · thinking high · context 500K",
			"info",
		);
	});

	it("confirms at 80% of the chosen window but not just below it", async () => {
		const atThreshold = createLifecycleHarness({ requestedContextWindow: 500_000, usageTokens: 400_000 });
		await atThreshold.emit("startup");
		expect(atThreshold.confirm).toHaveBeenCalledOnce();

		const belowThreshold = createLifecycleHarness({ requestedContextWindow: 500_000, usageTokens: 399_999 });
		await belowThreshold.emit("startup");
		expect(belowThreshold.confirm).not.toHaveBeenCalled();
		expect(belowThreshold.compact).not.toHaveBeenCalled();
	});

	it("does not confirm on usage above 70% of a larger catalogue window", async () => {
		const harness = createLifecycleHarness({ usageTokens: 750_000 });
		await harness.emit("startup");
		expect(harness.confirm).not.toHaveBeenCalled();
	});

	it("aborts without applying when the context step is cancelled", async () => {
		const harness = createLifecycleHarness({ cancelContext: true });
		await harness.emit("startup");

		expect(harness.setModel).not.toHaveBeenCalled();
		expect(harness.setThinkingLevel).not.toHaveBeenCalled();
		expect(harness.save).not.toHaveBeenCalled();
		expect(harness.compact).not.toHaveBeenCalled();
	});

	it("lets auto-compact take over when the agent is busy", async () => {
		const harness = createLifecycleHarness({ usageTokens: 950_000, idle: false });
		await harness.emit("startup");

		expect(harness.setModel).toHaveBeenCalledOnce();
		expect(harness.compact).not.toHaveBeenCalled();
		expect(harness.notify).toHaveBeenCalledWith(
			expect.stringContaining("auto-compact"),
			"info",
		);
	});
});

describe("model selection helpers", () => {
	it("finds canonical references and filters by model name", () => {
		expect(findExactModel(models, "github-copilot/gpt-5.6-sol")).toBe(models[0]);
		expect(filterModels(models, "sonnet")).toEqual([models[1]]);
	});
});

