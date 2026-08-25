import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import autoCompactExtension, {
	classifyOverflowCompaction,
	disableNativeCompaction,
	disableNativeCompactionInFiles,
	SEMANTIC_COMPACTION_FOCUS,
	shouldCompactNow,
	vetoNativeCompaction,
} from "./index.ts";

describe("shouldCompactNow", () => {
	it("returns false when usage is undefined", () => {
		expect(shouldCompactNow(undefined)).toBe(false);
	});

	it("returns false when tokens are unknown (null)", () => {
		expect(shouldCompactNow({ tokens: null, contextWindow: 200_000, percent: null })).toBe(false);
	});

	it("returns false when the context window is not positive", () => {
		expect(shouldCompactNow({ tokens: 100, contextWindow: 0, percent: null })).toBe(false);
		expect(shouldCompactNow({ tokens: 100, contextWindow: -1, percent: null })).toBe(false);
	});

	it("returns false below the threshold", () => {
		expect(shouldCompactNow({ tokens: 159_999, contextWindow: 200_000, percent: 80 })).toBe(false);
	});

	it("returns true at the threshold", () => {
		expect(shouldCompactNow({ tokens: 160_000, contextWindow: 200_000, percent: 80 })).toBe(true);
	});

	it("returns true above the threshold", () => {
		expect(shouldCompactNow({ tokens: 180_000, contextWindow: 200_000, percent: 90 })).toBe(true);
	});

	it("honors a custom threshold", () => {
		expect(shouldCompactNow({ tokens: 50_000, contextWindow: 200_000, percent: 25 }, 0.25)).toBe(true);
		expect(shouldCompactNow({ tokens: 49_999, contextWindow: 200_000, percent: 25 }, 0.25)).toBe(false);
	});
});

const DEFAULT_USAGE = {
	input: 100,
	output: 50,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 150,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function activeModel(overrides: Record<string, unknown> = {}): any {
	return {
		id: "model-1",
		name: "Model 1",
		api: "test-api",
		provider: "provider-1",
		baseUrl: "http://localhost",
		reasoning: false,
		input: ["text"],
		cost: DEFAULT_USAGE.cost,
		contextWindow: 1_000,
		maxTokens: 200,
		...overrides,
	};
}

function assistantMessage(overrides: Record<string, any> = {}): any {
	const { usage, ...messageOverrides } = overrides;
	return {
		role: "assistant",
		content: [{ type: "text", text: "Response" }],
		api: "test-api",
		provider: "provider-1",
		model: "model-1",
		usage: { ...DEFAULT_USAGE, ...usage },
		stopReason: "stop",
		timestamp: 1,
		...messageOverrides,
	};
}

function makeExtensionHarness(options: {
	usage?: { tokens: number | null; contextWindow: number; percent: number | null };
	model?: any;
	idle?: boolean;
} = {}) {
	const handlers = new Map<string, (event: any, ctx: any) => unknown>();
	const compactions: any[] = [];
	const providerCalls: any[] = [];
	const sendMessage = vi.fn();
	let usage = options.usage ?? { tokens: 799, contextWindow: 1_000, percent: 79.9 };
	let idle = options.idle ?? true;
	const ctx: any = {
		cwd: "/workspace",
		model: options.model ?? activeModel(),
		thinkingLevel: "high",
		getContextUsage: vi.fn(() => usage),
		getSystemPrompt: vi.fn(() => "system prompt"),
		isIdle: vi.fn(() => idle),
		compact: vi.fn((compactOptions: any) => compactions.push(compactOptions)),
		sessionManager: { getSessionId: vi.fn(() => "session-1") },
		modelRegistry: {
			getProvider: vi.fn(() => ({
				streamSimple: (model: any, context: any, streamOptions: any) => ({
					result: async () => {
						providerCalls.push({ model, context, options: streamOptions });
						return assistantMessage({ content: [{ type: "text", text: "custom summary" }] });
					},
				}),
			})),
			getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: "key" })),
		},
		ui: { notify: vi.fn() },
	};
	const pi: any = {
		on: vi.fn((event: string, handler: (event: any, handlerContext: any) => unknown) => {
			handlers.set(event, handler);
		}),
		sendMessage,
		getActiveTools: vi.fn(() => ["read"]),
		getAllTools: vi.fn(() => [
			{ name: "read", description: "Read", parameters: { type: "object" }, sourceInfo: {} },
		]),
		getThinkingLevel: vi.fn(() => "high"),
	};
	autoCompactExtension(pi);
	return {
		handlers,
		compactions,
		providerCalls,
		sendMessage,
		ctx,
		setUsage(nextUsage: typeof usage) {
			usage = nextUsage;
		},
		setIdle(nextIdle: boolean) {
			idle = nextIdle;
		},
	};
}

type ExtensionHarness = ReturnType<typeof makeExtensionHarness>;

function manualCompactionEvent(reason: "manual" | "threshold" | "overflow" = "manual"): any {
	const oldUser = { role: "user", content: "old request", timestamp: 1 };
	const oldAssistant = assistantMessage({ timestamp: 2 });
	const keptUser = { role: "user", content: "kept request", timestamp: 3 };
	return {
		type: "session_before_compact",
		reason,
		willRetry: false,
		customInstructions: SEMANTIC_COMPACTION_FOCUS,
		signal: new AbortController().signal,
		branchEntries: [
			{ type: "message", id: "u1", parentId: null, timestamp: new Date(1).toISOString(), message: oldUser },
			{ type: "message", id: "a1", parentId: "u1", timestamp: new Date(2).toISOString(), message: oldAssistant },
			{ type: "message", id: "u2", parentId: "a1", timestamp: new Date(3).toISOString(), message: keptUser },
		],
		preparation: {
			firstKeptEntryId: "u2",
			messagesToSummarize: [oldUser, oldAssistant],
			turnPrefixMessages: [],
			isSplitTurn: false,
			tokensBefore: 500,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { enabled: false, reserveTokens: 1_000, keepRecentTokens: 200 },
		},
	};
}

function seedProviderSnapshot(harness: ExtensionHarness, event = manualCompactionEvent()): void {
	const messages = event.branchEntries.map((entry: any) => entry.message);
	harness.handlers.get("context")?.({ type: "context", messages }, harness.ctx);
	harness.handlers.get("before_provider_request")?.(
		{ type: "before_provider_request", payload: {} },
		harness.ctx,
	);
}

function emitTurn(
	harness: ExtensionHarness,
	message = assistantMessage(),
	toolResults: any[] = [],
): unknown {
	return harness.handlers.get("turn_end")?.(
		{ type: "turn_end", turnIndex: 0, message, toolResults },
		harness.ctx,
	);
}

function completeCompaction(harness: ExtensionHarness, index = harness.compactions.length - 1): void {
	harness.compactions[index]?.onComplete?.({});
}

function failCompaction(harness: ExtensionHarness, index = harness.compactions.length - 1): void {
	harness.compactions[index]?.onError?.(new Error("compaction failed"));
}

const EXPECTED_CONTINUATION = {
	customType: "auto-compact-continue",
	content: "Continue the task using the compacted context.",
	display: false,
};

const EXPECTED_CONTINUATION_OPTIONS = {
	deliverAs: "followUp",
	triggerTurn: true,
};

describe("classifyOverflowCompaction", () => {
	it("classifies explicit context errors and zero-output length overflows for resume", () => {
		expect(
			classifyOverflowCompaction(
				assistantMessage({
					stopReason: "error",
					errorMessage: "prompt is too long: 1100 tokens > 1000 maximum",
				}),
				activeModel(),
			),
		).toBe("compact-and-resume");
		expect(
			classifyOverflowCompaction(
				assistantMessage({
					stopReason: "length",
					usage: { input: 990, output: 0 },
				}),
				activeModel(),
			),
		).toBe("compact-and-resume");
	});

	it("classifies recoverable length truncation for resume", () => {
		expect(
			classifyOverflowCompaction(
				assistantMessage({ stopReason: "length", usage: { input: 500, output: 50 } }),
				activeModel(),
			),
		).toBe("compact-and-resume");
	});

	it("classifies a successful silent overflow without resume", () => {
		expect(
			classifyOverflowCompaction(
				assistantMessage({ usage: { input: 1_001, output: 50 } }),
				activeModel(),
			),
		).toBe("compact");
	});

	it("ignores non-assistant, model-mismatched, and ordinary responses", () => {
		expect(
			classifyOverflowCompaction({ role: "user" }, activeModel()),
		).toBeUndefined();
		expect(
			classifyOverflowCompaction(
				assistantMessage({ provider: "old-provider" }),
				activeModel(),
			),
		).toBeUndefined();
		expect(
			classifyOverflowCompaction(
				assistantMessage({ stopReason: "error", errorMessage: "service unavailable" }),
				activeModel(),
			),
		).toBeUndefined();
	});
});

describe("auto-compact extension events", () => {
	it("does not compact below 80% after tool results", () => {
		const harness = makeExtensionHarness({
			usage: { tokens: 799, contextWindow: 1_000, percent: 79.9 },
		});
		emitTurn(harness, assistantMessage({ stopReason: "toolUse" }), [{}]);
		expect(harness.compactions).toHaveLength(0);
	});

	it.each([
		["exactly", 800],
		["above", 900],
	])("compacts %s 80%% after tool results", (_label, tokens) => {
		const harness = makeExtensionHarness({
			usage: { tokens, contextWindow: 1_000, percent: tokens / 10 },
		});
		emitTurn(harness, assistantMessage({ stopReason: "toolUse" }), [{}]);
		expect(harness.compactions).toHaveLength(1);
		expect(harness.compactions[0].customInstructions).toBe(SEMANTIC_COMPACTION_FOCUS);
	});

	it("sends the hidden continuation after successful mid-turn compaction", () => {
		const harness = makeExtensionHarness({
			usage: { tokens: 800, contextWindow: 1_000, percent: 80 },
		});
		emitTurn(harness, assistantMessage({ stopReason: "toolUse" }), [{}]);
		completeCompaction(harness);
		expect(harness.sendMessage).toHaveBeenCalledWith(
			EXPECTED_CONTINUATION,
			EXPECTED_CONTINUATION_OPTIONS,
		);
	});

	it("uses identical semantic instructions and awaits pre-turn compaction", async () => {
		const harness = makeExtensionHarness({
			usage: { tokens: 800, contextWindow: 1_000, percent: 80 },
		});
		let settled = false;
		const pending = Promise.resolve(
			harness.handlers.get("before_agent_start")?.(
				{ type: "before_agent_start", prompt: "Next task" },
				harness.ctx,
			),
		).then(() => {
			settled = true;
		});

		await Promise.resolve();
		expect(harness.compactions).toHaveLength(1);
		expect(harness.compactions[0].customInstructions).toBe(SEMANTIC_COMPACTION_FOCUS);
		expect(settled).toBe(false);

		completeCompaction(harness);
		await pending;
		expect(settled).toBe(true);
	});

	it("recovers explicit overflow without tool results and resumes once compacted", () => {
		const harness = makeExtensionHarness();
		emitTurn(
			harness,
			assistantMessage({
				stopReason: "error",
				errorMessage: "prompt is too long: 1100 tokens > 1000 maximum",
			}),
		);

		expect(harness.compactions).toHaveLength(1);
		expect(harness.compactions[0].customInstructions).toBe(SEMANTIC_COMPACTION_FOCUS);
		completeCompaction(harness);
		expect(harness.sendMessage).toHaveBeenCalledWith(
			EXPECTED_CONTINUATION,
			EXPECTED_CONTINUATION_OPTIONS,
		);
	});

	it("compacts and resumes a recoverable length truncation", () => {
		const harness = makeExtensionHarness();
		emitTurn(
			harness,
			assistantMessage({ stopReason: "length", usage: { input: 500, output: 50 } }),
		);

		expect(harness.compactions).toHaveLength(1);
		completeCompaction(harness);
		expect(harness.sendMessage).toHaveBeenCalledWith(
			EXPECTED_CONTINUATION,
			EXPECTED_CONTINUATION_OPTIONS,
		);
	});

	it("compacts a successful silent overflow without repeating completed work", () => {
		const harness = makeExtensionHarness();
		emitTurn(harness, assistantMessage({ usage: { input: 1_001, output: 50 } }));

		expect(harness.compactions).toHaveLength(1);
		expect(harness.compactions[0].customInstructions).toBe(SEMANTIC_COMPACTION_FOCUS);
		completeCompaction(harness);
		expect(harness.sendMessage).not.toHaveBeenCalled();
	});

	it("ignores model-mismatched and ordinary provider failures", () => {
		const harness = makeExtensionHarness();
		emitTurn(
			harness,
			assistantMessage({
				provider: "old-provider",
				stopReason: "error",
				errorMessage: "prompt is too long: 1100 tokens > 1000 maximum",
			}),
		);
		emitTurn(
			harness,
			assistantMessage({ stopReason: "error", errorMessage: "service unavailable" }),
		);
		expect(harness.compactions).toHaveLength(0);
	});

	it("does not retry a second consecutive overflow indefinitely", () => {
		const harness = makeExtensionHarness();
		const overflow = assistantMessage({
			stopReason: "error",
			errorMessage: "prompt is too long: 1100 tokens > 1000 maximum",
		});
		emitTurn(harness, overflow);
		completeCompaction(harness);
		emitTurn(harness, overflow);

		expect(harness.compactions).toHaveLength(1);
		expect(harness.sendMessage).toHaveBeenCalledTimes(1);
	});

	it("allows overflow recovery again after a new user message", () => {
		const harness = makeExtensionHarness();
		const overflow = assistantMessage({
			stopReason: "error",
			errorMessage: "prompt is too long: 1100 tokens > 1000 maximum",
		});
		emitTurn(harness, overflow);
		completeCompaction(harness);
		emitTurn(harness, overflow);
		harness.handlers.get("message_start")?.(
			{ type: "message_start", message: { role: "user", content: "Try again" } },
			harness.ctx,
		);
		emitTurn(harness, overflow);

		expect(harness.compactions).toHaveLength(2);
	});

	it("allows overflow recovery again after a successful response", () => {
		const harness = makeExtensionHarness();
		const overflow = assistantMessage({
			stopReason: "error",
			errorMessage: "prompt is too long: 1100 tokens > 1000 maximum",
		});
		emitTurn(harness, overflow);
		completeCompaction(harness);
		emitTurn(harness, assistantMessage());
		emitTurn(harness, overflow);

		expect(harness.compactions).toHaveLength(2);
	});

	it("does not treat an aborted response as a successful guard reset", () => {
		const harness = makeExtensionHarness();
		const overflow = assistantMessage({
			stopReason: "error",
			errorMessage: "prompt is too long: 1100 tokens > 1000 maximum",
		});
		emitTurn(harness, overflow);
		completeCompaction(harness);
		emitTurn(harness, assistantMessage({ stopReason: "aborted" }));
		emitTurn(harness, overflow);

		expect(harness.compactions).toHaveLength(1);
	});

	it("clears the in-progress guard after failed compaction", () => {
		const harness = makeExtensionHarness({
			usage: { tokens: 800, contextWindow: 1_000, percent: 80 },
		});
		emitTurn(harness, assistantMessage({ stopReason: "toolUse" }), [{}]);
		failCompaction(harness);
		emitTurn(harness, assistantMessage({ stopReason: "toolUse" }), [{}]);

		expect(harness.compactions).toHaveLength(2);
	});

	it("routes genuine /compact through cache-aware compaction", async () => {
		const harness = makeExtensionHarness({
			model: activeModel({ contextWindow: 5_000, maxTokens: 1_000, reasoning: true }),
		});
		const event = manualCompactionEvent();
		seedProviderSnapshot(harness, event);

		const result = await harness.handlers.get("session_before_compact")?.(event, harness.ctx);

		expect(result).toMatchObject({
			compaction: { summary: "custom summary", firstKeptEntryId: "u2", tokensBefore: 500 },
		});
		expect(harness.providerCalls).toHaveLength(1);
	});

	it("routes extension-triggered ctx.compact through the same custom path", async () => {
		const harness = makeExtensionHarness({
			usage: { tokens: 4_000, contextWindow: 5_000, percent: 80 },
			model: activeModel({ contextWindow: 5_000, maxTokens: 1_000, reasoning: true }),
		});
		const event = manualCompactionEvent();
		seedProviderSnapshot(harness, event);
		emitTurn(harness, assistantMessage({ stopReason: "toolUse" }), [{}]);
		expect(harness.compactions).toHaveLength(1);

		const result = await harness.handlers.get("session_before_compact")?.(event, harness.ctx);
		expect(result).toHaveProperty("compaction.summary", "custom summary");
		expect(harness.providerCalls).toHaveLength(1);
	});

	it.each(["threshold", "overflow"] as const)("cancels native %s requests without a summary call", async (reason) => {
		const harness = makeExtensionHarness();
		const result = await harness.handlers.get("session_before_compact")?.(
			manualCompactionEvent(reason),
			harness.ctx,
		);
		expect(result).toEqual({ cancel: true });
		expect(harness.providerCalls).toHaveLength(0);
	});

	it("resets all guards on session shutdown", () => {
		const harness = makeExtensionHarness();
		const overflow = assistantMessage({
			stopReason: "error",
			errorMessage: "prompt is too long: 1100 tokens > 1000 maximum",
		});
		emitTurn(harness, overflow);
		completeCompaction(harness);
		emitTurn(harness, overflow);
		harness.handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "reload" }, harness.ctx);
		emitTurn(harness, overflow);

		expect(harness.compactions).toHaveLength(2);
	});
});

describe("vetoNativeCompaction", () => {
	it("cancels native threshold compaction", () => {
		expect(vetoNativeCompaction("threshold")).toEqual({ cancel: true });
	});

	it("cancels native overflow compaction", () => {
		expect(vetoNativeCompaction("overflow")).toEqual({ cancel: true });
	});

	it("lets manual compaction pass", () => {
		expect(vetoNativeCompaction("manual")).toBeUndefined();
	});
});

describe("disableNativeCompaction", () => {
	const root = mkdtempSync(join(tmpdir(), "auto-compact-"));
	const settingsPath = join(root, "settings.json");

	afterEach(() => {
		rmSync(settingsPath, { force: true });
	});

	it("writes enabled: false while preserving other keys", () => {
		writeFileSync(
			settingsPath,
			`${JSON.stringify(
				{
					theme: "dark",
					compaction: { enabled: true, threshold: 0.1, keepRecentTokens: 25_600 },
					extensions: [],
				},
				null,
				2,
			)}\n`,
		);

		expect(disableNativeCompaction(settingsPath)).toBe(true);

		const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
		expect(settings.compaction.enabled).toBe(false);
		expect(settings.compaction.threshold).toBe(0.1);
		expect(settings.compaction.keepRecentTokens).toBe(25_600);
		expect(settings.theme).toBe("dark");
		expect(settings.extensions).toEqual([]);
	});

	it("adds the compaction key when absent", () => {
		writeFileSync(settingsPath, `${JSON.stringify({ theme: "dark" }, null, 2)}\n`);

		expect(disableNativeCompaction(settingsPath)).toBe(true);

		const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
		expect(settings.compaction.enabled).toBe(false);
		expect(settings.theme).toBe("dark");
	});

	it("does not write when already disabled", () => {
		writeFileSync(
			settingsPath,
			`${JSON.stringify({ compaction: { enabled: false, threshold: 0.1 } }, null, 2)}\n`,
		);
		const before = readFileSync(settingsPath, "utf-8");

		expect(disableNativeCompaction(settingsPath)).toBe(false);
		expect(readFileSync(settingsPath, "utf-8")).toBe(before);
	});

	it("fails silently on a missing file", () => {
		expect(disableNativeCompaction(join(root, "does-not-exist.json"))).toBe(false);
	});

	it("fails silently on unparseable content", () => {
		writeFileSync(settingsPath, "not json {");
		expect(disableNativeCompaction(settingsPath)).toBe(false);
	});
});

describe("disableNativeCompactionInFiles", () => {
	const root = mkdtempSync(join(tmpdir(), "auto-compact-files-"));
	const globalPath = join(root, "global-settings.json");
	const projectPath = join(root, "project-settings.json");

	afterEach(() => {
		rmSync(globalPath, { force: true });
		rmSync(projectPath, { force: true });
	});

	it("writes every file that still has compaction enabled", () => {
		writeFileSync(globalPath, `${JSON.stringify({ compaction: { enabled: true } }, null, 2)}\n`);
		writeFileSync(projectPath, `${JSON.stringify({ compaction: { enabled: true, threshold: 0.1 } }, null, 2)}\n`);

		expect(disableNativeCompactionInFiles([globalPath, projectPath])).toEqual([globalPath, projectPath]);
		expect(JSON.parse(readFileSync(globalPath, "utf-8")).compaction.enabled).toBe(false);
		expect(JSON.parse(readFileSync(projectPath, "utf-8")).compaction.enabled).toBe(false);
		expect(JSON.parse(readFileSync(projectPath, "utf-8")).compaction.threshold).toBe(0.1);
	});

	it("skips already-disabled and unreadable files", () => {
		writeFileSync(globalPath, `${JSON.stringify({ compaction: { enabled: false } }, null, 2)}\n`);

		expect(disableNativeCompactionInFiles([globalPath, projectPath])).toEqual([]);
		expect(JSON.parse(readFileSync(globalPath, "utf-8")).compaction.enabled).toBe(false);
	});
});
