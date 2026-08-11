import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	getModelCommandHandler,
	installModelCommandHandler,
	parseModelCommand,
} from "../_shared/model-command-routing.ts";
import modelSelectorExtension from "./index.ts";
import {
	filterModels,
	findExactModel,
	getContextWindowChoices,
	GPT_56_LONG_CONTEXT,
	GPT_56_SHORT_CONTEXT,
	hasExplicitModelArgument,
	mergeContextWindowOverride,
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
		contextWindow: GPT_56_LONG_CONTEXT,
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

function createLifecycleHarness(options: {
	cancel?: boolean;
	hasConversationHistory?: boolean;
	mode?: "tui" | "print" | "json" | "rpc";
	refreshError?: Error;
	setModelResult?: boolean;
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
	const selectedModel = models[1] as any;
	const custom = vi.fn(async () => options.cancel ? undefined : selectedModel);
	const setModel = vi.fn(async () => options.setModelResult ?? true);
	const setThinkingLevel = vi.fn();
	const setEditorComponent = vi.fn();
	const notify = vi.fn();
	const ctx = {
		mode: options.mode ?? "tui",
		model: selectedModel,
		scopedModels: [],
		modelRegistry: {
			refresh: vi.fn(async () => ({
				aborted: false,
				errors: options.refreshError
					? new Map([[selectedModel.provider, options.refreshError]])
					: new Map(),
			})),
			getAvailable: vi.fn(() => [selectedModel]),
			find: vi.fn(() => selectedModel),
		},
		ui: {
			custom,
			select: vi.fn(async (_title: string, choices: string[]) => choices[0]),
			confirm: vi.fn(async () => true),
			notify,
			setEditorComponent,
		},
		getContextUsage: vi.fn(() => ({ tokens: 0 })),
		compact: vi.fn(),
		sessionManager: {
			getEntries: vi.fn(() => entries),
			getLeafId: vi.fn(() => entries.at(-1)?.id),
		},
	} as unknown as ExtensionContext;
	const pi = {
		on: (event: string, handler: (event: any, ctx: ExtensionContext) => unknown) => handlers.set(event, handler),
		setModel,
		getThinkingLevel: vi.fn(() => "medium"),
		setThinkingLevel,
	} as unknown as ExtensionAPI;
	modelSelectorExtension(pi);

	return {
		custom,
		setModel,
		setThinkingLevel,
		setEditorComponent,
		notify,
		emit: async (reason: "startup" | "reload" | "new" | "resume" | "fork") => {
			await handlers.get("session_start")?.({ type: "session_start", reason }, ctx);
		},
	};
}

describe("model selector lifecycle", () => {
	it("awaits one selector flow for an eligible startup and applies through pi.setModel", async () => {
		const harness = createLifecycleHarness();
		await harness.emit("startup");

		expect(harness.custom).toHaveBeenCalledTimes(1);
		expect(harness.setModel).toHaveBeenCalledTimes(1);
		expect(harness.setModel).toHaveBeenCalledWith(expect.objectContaining({ id: "claude-sonnet-4.6" }));
		expect(harness.setThinkingLevel).toHaveBeenCalledAfter(harness.setModel);
	});

	it("does not invoke the selector when startup restores conversation history", async () => {
		const harness = createLifecycleHarness({ hasConversationHistory: true });
		await harness.emit("startup");
		expect(harness.custom).not.toHaveBeenCalled();
		expect(harness.setModel).not.toHaveBeenCalled();
	});

	it.each(["reload", "resume", "fork"] as const)("does not invoke the selector for %s", async (reason) => {
		const harness = createLifecycleHarness();
		await harness.emit(reason);
		expect(harness.custom).not.toHaveBeenCalled();
		expect(harness.setModel).not.toHaveBeenCalled();
	});

	it("does not apply a model when selection is cancelled", async () => {
		const harness = createLifecycleHarness({ cancel: true });
		await harness.emit("startup");
		expect(harness.custom).toHaveBeenCalledTimes(1);
		expect(harness.setModel).not.toHaveBeenCalled();
		expect(harness.setThinkingLevel).not.toHaveBeenCalled();
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

	it("does not apply thinking when Pi rejects model authentication", async () => {
		const harness = createLifecycleHarness({ setModelResult: false });
		await harness.emit("startup");
		expect(harness.setModel).toHaveBeenCalledTimes(1);
		expect(harness.setThinkingLevel).not.toHaveBeenCalled();
		expect(harness.notify).toHaveBeenCalledWith(
			expect.stringContaining("No configured authentication"),
			"error",
		);
	});

	it.each(["print", "json", "rpc"] as const)("does not install or open selector UI in %s mode", async (mode) => {
		const harness = createLifecycleHarness({ mode });
		await harness.emit("startup");
		expect(harness.setEditorComponent).not.toHaveBeenCalled();
		expect(harness.custom).not.toHaveBeenCalled();
		expect(harness.setModel).not.toHaveBeenCalled();
	});
});

describe("model selection helpers", () => {
	it("offers short and long context profiles for GPT-5.6", () => {
		expect(getContextWindowChoices(models[0]!).map((choice) => choice.value)).toEqual([
			GPT_56_SHORT_CONTEXT,
			GPT_56_LONG_CONTEXT,
		]);
	});

	it("keeps catalogue context fixed for other models", () => {
		expect(getContextWindowChoices(models[1]!)).toEqual([
			expect.objectContaining({ value: 1_000_000 }),
		]);
	});

	it("finds canonical references and filters by model name", () => {
		expect(findExactModel(models, "github-copilot/gpt-5.6-sol")).toBe(models[0]);
		expect(filterModels(models, "sonnet")).toEqual([models[1]]);
	});
});

describe("models.json context overrides", () => {
	it("merges an override without discarding existing provider settings", () => {
		const result = mergeContextWindowOverride(
			{
				providers: {
					"github-copilot": {
						headers: { "x-test": "kept" },
						modelOverrides: {
							"gpt-5.6-sol": { name: "Sol custom" },
						},
					},
					anthropic: { baseUrl: "https://example.test" },
				},
			},
			"github-copilot",
			"gpt-5.6-sol",
			GPT_56_SHORT_CONTEXT,
		);

		expect(result).toEqual({
			providers: {
				"github-copilot": {
					headers: { "x-test": "kept" },
					modelOverrides: {
						"gpt-5.6-sol": {
							name: "Sol custom",
							contextWindow: GPT_56_SHORT_CONTEXT,
						},
					},
				},
				anthropic: { baseUrl: "https://example.test" },
			},
		});
	});

	it("rejects malformed structures instead of overwriting them", () => {
		expect(() => mergeContextWindowOverride(
			{ providers: { "github-copilot": [] } },
			"github-copilot",
			"gpt-5.6-sol",
			GPT_56_SHORT_CONTEXT,
		)).toThrow("Provider github-copilot must be a JSON object");
	});
});
