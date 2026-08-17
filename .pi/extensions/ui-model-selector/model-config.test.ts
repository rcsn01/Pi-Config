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
import { createModelSelectorExtension, selectionModeFromEntries } from "./index.ts";
import {
	calculateCompactionReserveTokens,
	DEFAULT_COMPACTION_THRESHOLD,
	DEFAULT_CONTEXT_WINDOW,
	filterModels,
	findExactModel,
	hasExplicitModelArgument,
	mergeProjectCompactionSettings,
	mergeProjectModelSelection,
	parseProjectModelPreferences,
	PI_DEFAULT_CONTEXT_WINDOW,
	resolveContextWindow,
	resolveModelContext,
	shouldOpenStartupModelSelector,
} from "./model-config.ts";
import { createProjectSettingsStore } from "./settings-store.ts";

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
	const load = vi.fn(async () => ({
		profiles: options.profiles ?? {},
		contextWindows: options.contextWindows ?? {},
		compactionThreshold: options.compactionThreshold ?? DEFAULT_COMPACTION_THRESHOLD,
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
	createModelSelectorExtension({ load, save, syncCompaction })(pi);

	return {
		custom,
		setModel,
		setThinkingLevel,
		setEditorComponent,
		notify,
		load,
		save,
		syncCompaction,
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
	it("detects normal and Plan Mode from durable session state", () => {
		expect(selectionModeFromEntries([])).toBe("normal");
		expect(selectionModeFromEntries([
			{ type: "custom", customType: "plan-mode-state", data: { active: true } },
		])).toBe("plan");
		expect(selectionModeFromEntries([
			{ type: "custom", customType: "plan-mode-state", data: { active: true } },
			{ type: "custom", customType: "plan-mode-state", data: { active: false } },
		])).toBe("normal");
	});

	it("passes large context windows through unchanged", () => {
		expect(resolveContextWindow(1_050_000)).toBe(1_050_000);
		expect(resolveContextWindow(1_000_000)).toBe(1_000_000);
	});

	it("defaults undeclared-context models (pi's 128K fallback) to 200K", () => {
		expect(resolveContextWindow(PI_DEFAULT_CONTEXT_WINDOW)).toBe(DEFAULT_CONTEXT_WINDOW);
	});

	it("passes context windows through unchanged", () => {
		expect(resolveContextWindow(100_000)).toBe(100_000);
		expect(resolveContextWindow(DEFAULT_CONTEXT_WINDOW)).toBe(DEFAULT_CONTEXT_WINDOW);
	});

	it("finds canonical references and filters by model name", () => {
		expect(findExactModel(models, "github-copilot/gpt-5.6-sol")).toBe(models[0]);
		expect(filterModels(models, "sonnet")).toEqual([models[1]]);
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

	it("resolves a model's context window without mutating the catalogue model", () => {
		const configured = resolveModelContext(models[0]!);
		expect(configured.contextWindow).toBe(1_050_000);
		expect(models[0]!.contextWindow).toBe(1_050_000);
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

	it("persists the threshold and updates reserves for both context profiles", async () => {
		const directory = mkdtempSync(join(tmpdir(), "ui-model-selector-"));
		const path = join(directory, "settings.json");
		writeFileSync(path, JSON.stringify({
			theme: "dark",
			compaction: { enabled: true, reserveTokens: 27_200, keepRecentTokens: 20_000 },
			uiModelSelector: {},
		}), "utf-8");
		try {
			const store = createProjectSettingsStore(path);
			await store.save("normal", {
				provider: "github-copilot",
				modelId: "gpt-5.6-sol",
				thinkingLevel: "xhigh",
				contextWindow: 1_050_000,
			});
			let settings = JSON.parse(readFileSync(path, "utf-8")) as Record<string, any>;
			expect(settings).toMatchObject({
				theme: "dark",
				compaction: {
					enabled: true,
					reserveTokens: 105_000,
					keepRecentTokens: 20_000,
					threshold: DEFAULT_COMPACTION_THRESHOLD,
				},
			});
			expect(settings.uiModelSelector.profiles.normal.contextWindow).toBe(1_050_000);

			await store.syncCompaction(272_000);
			settings = JSON.parse(readFileSync(path, "utf-8")) as Record<string, any>;
			expect(settings.compaction.reserveTokens).toBe(27_200);
			expect(settings.compaction.threshold).toBe(DEFAULT_COMPACTION_THRESHOLD);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it.each([
		["malformed JSON", "{ not valid json\n"],
		["an invalid saved context", JSON.stringify({
			uiModelSelector: { contextWindows: { "github-copilot/gpt-5.6-sol": -1 } },
		})],
	])("atomically preserves the file when %s prevents a save", async (_label, original) => {
		const directory = mkdtempSync(join(tmpdir(), "ui-model-selector-"));
		const path = join(directory, "settings.json");
		writeFileSync(path, original, "utf-8");
		try {
			const store = createProjectSettingsStore(path);
			await expect(store.save("normal", {
				provider: "github-copilot",
				modelId: "gpt-5.6-sol",
				thinkingLevel: "xhigh",
				contextWindow: 1_050_000,
			})).rejects.toThrow("Cannot read");
			expect(readFileSync(path, "utf-8")).toBe(original);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
