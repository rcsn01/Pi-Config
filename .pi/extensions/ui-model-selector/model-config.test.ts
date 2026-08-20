import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	getModelCommandHandler,
	installModelCommandHandler,
	parseModelCommand,
} from "../_shared/model-command-routing.ts";
import { DEFAULT_COMPACTION_THRESHOLD, DEFAULT_KEEP_RECENT_TOKENS } from "../_shared/model-selection.ts";
import { createModelSelectorExtension } from "./index.ts";
import {
	filterModels,
	findExactModel,
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

function createLifecycleHarness(options: {
	cancel?: boolean;
	contextWindows?: Record<string, number>;
	planActive?: boolean;
	profiles?: Record<string, {
		provider: string;
		modelId: string;
		thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
		contextWindow: number;
	}>;
	effectiveThinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	compactionThreshold?: number;
	keepRecentTokens?: number;
	hasConversationHistory?: boolean;
	mode?: "tui" | "print" | "json" | "rpc";
	refreshError?: Error;
	selectedModel?: (typeof models)[number];
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
	const selectedModel = (options.selectedModel ?? models[1]) as any;
	const custom = vi.fn(async () => options.cancel ? undefined : selectedModel);
	const setModel = vi.fn(async () => options.setModelResult ?? true);
	const setThinkingLevel = vi.fn();
	const setEditorComponent = vi.fn();
	const notify = vi.fn();
	const save = vi.fn(async () => {});
	const syncCompaction = vi.fn(async () => {});
	const setPaths = vi.fn();
	const load = vi.fn(async () => ({
		profiles: options.profiles ?? {},
		contextWindows: options.contextWindows ?? {},
		compactionThreshold: options.compactionThreshold ?? DEFAULT_COMPACTION_THRESHOLD,
		keepRecentTokens: options.keepRecentTokens ?? DEFAULT_KEEP_RECENT_TOKENS,
	}));
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
			getAvailable: vi.fn(() => models),
			find: vi.fn((provider: string, id: string) => models.find((model) => model.provider === provider && model.id === id)),
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
			getBranch: vi.fn(() => options.planActive
				? [...entries, { type: "custom", customType: "plan-mode-state", data: { active: true } }]
				: entries),
			getLeafId: vi.fn(() => entries.at(-1)?.id),
		},
	} as unknown as ExtensionContext;
	const pi = {
		on: (event: string, handler: (event: any, ctx: ExtensionContext) => unknown) => handlers.set(event, handler),
		setModel,
		getThinkingLevel: vi.fn(() => options.effectiveThinkingLevel ?? "medium"),
		setThinkingLevel,
	} as unknown as ExtensionAPI;
	createModelSelectorExtension({ load, save, syncCompaction, setPaths })(pi);

	return {
		custom,
		setModel,
		setThinkingLevel,
		setEditorComponent,
		notify,
		load,
		save,
		syncCompaction,
		setPaths,
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
		expect(harness.syncCompaction).toHaveBeenCalledWith(1_000_000);
	});

	it.each(["reload", "resume", "fork"] as const)("does not invoke the selector for %s", async (reason) => {
		const harness = createLifecycleHarness();
		await harness.emit(reason);
		expect(harness.custom).not.toHaveBeenCalled();
		expect(harness.setModel).not.toHaveBeenCalled();
		expect(harness.syncCompaction).toHaveBeenCalledWith(1_000_000);
	});

	it("uses the complete normal profile as the fresh-session startup default", async () => {
		const harness = createLifecycleHarness({
			cancel: true,
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
		expect(harness.setModel).toHaveBeenCalledOnce();
		expect(harness.setModel).toHaveBeenCalledWith(expect.objectContaining({
			provider: "github-copilot",
			id: "gpt-5.6-sol",
			contextWindow: 256_000,
		}));
		expect(harness.setThinkingLevel).toHaveBeenCalledWith("xhigh");
		expect(harness.syncCompaction).toHaveBeenCalledWith(256_000);
		expect(harness.custom).not.toHaveBeenCalled();
		expect(harness.save).not.toHaveBeenCalled();
	});

	it("falls back to the selector when no normal startup profile exists", async () => {
		const harness = createLifecycleHarness();
		await harness.emit("startup");
		expect(harness.custom).toHaveBeenCalledOnce();
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

	it("does not persist or apply thinking when Pi rejects model authentication", async () => {
		const harness = createLifecycleHarness({ setModelResult: false });
		await harness.emit("startup");
		expect(harness.setModel).toHaveBeenCalledTimes(1);
		expect(harness.setThinkingLevel).not.toHaveBeenCalled();
		expect(harness.save).not.toHaveBeenCalled();
		expect(harness.notify).toHaveBeenCalledWith(
			expect.stringContaining("No configured authentication"),
			"error",
		);
	});

	it("persists the effective thinking level after Pi clamps it", async () => {
		const harness = createLifecycleHarness({ effectiveThinkingLevel: "high" });
		await harness.emit("startup");
		expect(harness.save).toHaveBeenCalledWith("normal", {
			provider: "anthropic",
			modelId: "claude-sonnet-4.6",
			thinkingLevel: "high",
			contextWindow: 1_000_000,
		});
	});

	it("persists Plan Mode selections under the plan profile instead of normal defaults", async () => {
		const harness = createLifecycleHarness({ planActive: true, effectiveThinkingLevel: "xhigh" });
		await harness.emit("startup");
		expect(harness.save).toHaveBeenCalledWith("plan", {
			provider: "anthropic",
			modelId: "claude-sonnet-4.6",
			thinkingLevel: "xhigh",
			contextWindow: 1_000_000,
		});
	});

	it("applies a saved context to an exact fresh selection", async () => {
		const harness = createLifecycleHarness({
			cancel: true,
			hasConversationHistory: true,
			contextWindows: { "github-copilot/gpt-5.6-sol": 272_000 },
		});
		await harness.emit("startup");
		await getModelCommandHandler()?.("github-copilot/gpt-5.6-sol");
		expect(harness.setModel).toHaveBeenCalledWith(expect.objectContaining({
			id: "gpt-5.6-sol",
			contextWindow: 1_050_000,
		}));
		expect(harness.save).toHaveBeenCalledWith("normal", expect.objectContaining({
			contextWindow: 1_050_000,
		}));
	});

	it("syncs compaction for an existing session without re-applying the model", async () => {
		const harness = createLifecycleHarness({
			hasConversationHistory: true,
			selectedModel: models[0],
			contextWindows: { "github-copilot/gpt-5.6-sol": 272_000 },
		});
		await harness.emit("startup");
		expect(harness.setModel).not.toHaveBeenCalled();
		expect(harness.syncCompaction).toHaveBeenCalledWith(1_050_000);
		expect(harness.save).not.toHaveBeenCalled();
	});

	it("refreshes the session model's context window from the profile on reload", async () => {
		const harness = createLifecycleHarness({
			selectedModel: models[1],
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
		expect(harness.setModel).toHaveBeenCalledOnce();
		expect(harness.setModel).toHaveBeenCalledWith(expect.objectContaining({
			id: "claude-sonnet-4.6",
			contextWindow: 256_000,
		}));
		expect(harness.syncCompaction).toHaveBeenCalledWith(256_000);
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

describe("model selection helpers", () => {
	it("finds canonical references and filters by model name", () => {
		expect(findExactModel(models, "github-copilot/gpt-5.6-sol")).toBe(models[0]);
		expect(filterModels(models, "sonnet")).toEqual([models[1]]);
	});
});

