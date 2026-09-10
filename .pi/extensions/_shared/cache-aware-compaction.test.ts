import type { AssistantMessage, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { streamSimple as codexStreamSimple } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { streamSimple as completionsStreamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import { buildSessionContext, convertToLlm } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCacheAwareCompaction } from "./cache-aware-compaction.ts";
import {
	clearToolOutputRetention,
	registerToolOutputRetention,
	type ToolOutputRetention,
} from "./tool-output-retention.ts";

const usage = {
	input: 700,
	output: 50,
	cacheRead: 600,
	cacheWrite: 0,
	totalTokens: 750,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function model(overrides: Record<string, unknown> = {}): Model<any> {
	return {
		id: "model-1",
		name: "Model 1",
		api: "test-api",
		provider: "provider-1",
		baseUrl: "https://original.example",
		reasoning: true,
		input: ["text"],
		cost: usage.cost,
		contextWindow: 10_000,
		maxTokens: 2_000,
		...overrides,
	} as Model<any>;
}

function user(content: string, timestamp: number) {
	return { role: "user" as const, content, timestamp };
}

function assistant(text: string, timestamp: number) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: "test-api",
		provider: "provider-1",
		model: "model-1",
		usage,
		stopReason: "stop" as const,
		timestamp,
	};
}

function entry(id: string, parentId: string | null, message: any) {
	return {
		type: "message" as const,
		id,
		parentId,
		timestamp: new Date(message.timestamp).toISOString(),
		message,
	};
}

function response(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "## Goal\nKeep working" }],
		api: "test-api",
		provider: "provider-1",
		model: "model-1",
		usage,
		stopReason: "stop",
		timestamp: 10,
		...overrides,
	};
}

function baseEntries() {
	return [
		entry("u1", null, user("old request", 1)),
		entry("a1", "u1", assistant("old answer", 2)),
		entry("u2", "a1", user("retained request", 3)),
	];
}

function preparation(firstKeptEntryId = "u2", overrides: Record<string, unknown> = {}) {
	return {
		firstKeptEntryId,
		messagesToSummarize: [user("old request", 1), assistant("old answer", 2)],
		turnPrefixMessages: [],
		isSplitTurn: false,
		tokensBefore: 1_000,
		fileOps: {
			read: new Set(["z.ts", "changed.ts"]),
			written: new Set(["new.ts"]),
			edited: new Set(["changed.ts"]),
		},
		settings: { enabled: false, reserveTokens: 1_000, keepRecentTokens: 200 },
		...overrides,
	};
}

function retention(projectHistory: ToolOutputRetention["projectHistory"]): ToolOutputRetention {
	return {
		rewriteFresh: vi.fn((input) => ({ changed: false, content: input.content, details: input.details })),
		projectHistory,
		retrieve: vi.fn((hash) => ({ found: false as const, hash })),
	};
}

function makeHarness(options: {
	entries?: any[];
	providerResponse?: AssistantMessage;
	providerError?: Error;
	auth?: Record<string, unknown>;
} = {}) {
	const currentModel = model();
	const systemPrompt = "unchanged system prompt";
	const thinkingLevel = "high";
	const sessionId = "session-123";
	const activeToolNames = ["second", "first"];
	const allTools = [
		{ name: "first", description: "First tool", parameters: { type: "object", properties: {} }, sourceInfo: {} },
		{ name: "second", description: "Second tool", parameters: { type: "object", properties: { value: { type: "string" } } }, sourceInfo: {} },
	];
	const calls: Array<{ model: Model<any>; context: Context; options: SimpleStreamOptions }> = [];
	const streamSimple = vi.fn((callModel: Model<any>, context: Context, streamOptions: SimpleStreamOptions) => {
		calls.push({ model: callModel, context, options: streamOptions });
		return {
			result: async () => {
				if (options.providerError) throw options.providerError;
				return options.providerResponse ?? response();
			},
		};
	});
	const pi: any = {
		on: vi.fn(),
		getActiveTools: vi.fn(() => [...activeToolNames]),
		getAllTools: vi.fn(() => allTools),
		getThinkingLevel: vi.fn(() => thinkingLevel),
	};
	const ctx: any = {
		model: currentModel,
		thinkingLevel,
		getSystemPrompt: vi.fn(() => systemPrompt),
		sessionManager: { getSessionId: vi.fn(() => sessionId) },
		modelRegistry: {
			getProvider: vi.fn(() => ({ streamSimple })),
			getApiKeyAndHeaders: vi.fn(async () => ({
				ok: true,
				apiKey: "secret-key",
				headers: { "x-auth": "secret-header" },
				baseUrl: "https://override.example",
				env: { PI_CACHE_RETENTION: "long", REGION: "test" },
				...options.auth,
			})),
		},
		ui: { notify: vi.fn() },
	};
	const controller = createCacheAwareCompaction(pi);
	const entries = options.entries ?? baseEntries();
	const event: any = {
		type: "session_before_compact",
		branchEntries: entries,
		preparation: preparation(),
		reason: "manual",
		willRetry: false,
		customInstructions: "Preserve the exact failing command.",
		signal: new AbortController().signal,
	};

	return {
		pi,
		ctx,
		event,
		entries,
		calls,
		streamSimple,
		controller,
	};
}

afterEach(clearToolOutputRetention);

describe("provider-rendered cache prefix", () => {
	it.each([
		["openai-codex-responses", codexStreamSimple],
		["openai-completions", completionsStreamSimple],
	] as const)("extends the %s payload without changing its prefix configuration", async (api, streamSimple) => {
		const payloads: any[] = [];
		const render = async (context: Context) => {
			const renderedModel = model({
				api,
				provider: "openai",
				baseUrl: api === "openai-codex-responses" ? "https://chatgpt.com/backend-api/codex" : "https://api.openai.com/v1",
				compat: { supportsReasoningEffort: true, supportsDeveloperRole: true },
			});
			const apiKey = api === "openai-codex-responses"
				? `${btoa("{}")}.${btoa(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "account-1" } }))}.sig`
				: "fake-key";
			await streamSimple(renderedModel as never, context, {
				apiKey,
				sessionId: "stable-session",
				cacheRetention: "long",
				reasoning: "high",
				transport: "sse",
				maxRetries: 0,
				fetch: async () => new Response(JSON.stringify({ error: { message: "fake transport" } }), {
					status: 500,
					headers: { "content-type": "application/json" },
				}),
				onPayload: (payload) => {
					payloads.push(payload);
				},
			}).result();
		};
		const tools = [{ name: "read", description: "Read", parameters: { type: "object" } }] as any;
		const history = [user("request", 1), assistant("answer", 2)];
		await render({ systemPrompt: "same system", messages: history, tools });
		await render({
			systemPrompt: "same system",
			messages: [...history, user("compaction instruction", 3)],
			tools,
		});

		expect(payloads).toHaveLength(2);
		const [normal, compacted] = payloads;
		const normalInput = api === "openai-completions" ? normal.messages : normal.input;
		const compactedInput = api === "openai-completions" ? compacted.messages : compacted.input;
		expect(compactedInput.slice(0, normalInput.length)).toEqual(normalInput);
		expect(compactedInput.length).toBeGreaterThan(normalInput.length);
		if (api === "openai-completions") {
			expect(compacted.tools).toEqual(normal.tools);
			expect(compacted.reasoning_effort).toEqual(normal.reasoning_effort);
			expect(compacted.prompt_cache_key).toEqual(normal.prompt_cache_key);
			expect(compacted.messages[0]).toEqual(normal.messages[0]);
		} else {
			expect(compacted.instructions).toBe(normal.instructions);
			expect(compacted.tools).toEqual(normal.tools);
			expect(compacted.reasoning).toEqual(normal.reasoning);
			expect(compacted.prompt_cache_key).toBe(normal.prompt_cache_key);
		}
	});
});

describe("cache-aware compaction", () => {
	it("projects canonical history before provider conversion and leaves the instruction last", async () => {
		const harness = makeHarness();
		const canonical = buildSessionContext(harness.entries).messages;
		const projected = canonical.map((message, index) => index === 0 ? user("projected old request", message.timestamp) : message);
		const projectHistory = vi.fn(() => ({ changed: true, messages: projected }));
		registerToolOutputRetention(retention(projectHistory));

		await harness.controller.compact(harness.event, harness.ctx);

		expect(projectHistory).toHaveBeenCalledOnce();
		expect(projectHistory).toHaveBeenCalledWith(canonical);
		expect(harness.calls[0].context.messages.slice(0, -1)).toEqual(convertToLlm(projected));
		expect(harness.calls[0].context.messages.at(-1)?.role).toBe("user");
		expect(JSON.stringify(harness.calls[0].context.messages.at(-1))).toContain("1 trailing provider message");
	});

	it("discovers retention registered after controller construction", async () => {
		const harness = makeHarness();
		const projectHistory = vi.fn((messages) => ({ changed: false, messages }));
		registerToolOutputRetention(retention(projectHistory));
		await harness.controller.compact(harness.event, harness.ctx);
		expect(projectHistory).toHaveBeenCalledOnce();
	});

	it("uses canonical history unchanged when no retention module is registered", async () => {
		const harness = makeHarness();
		await harness.controller.compact(harness.event, harness.ctx);
		expect(harness.calls[0].context.messages.slice(0, -1)).toEqual(convertToLlm(buildSessionContext(harness.entries).messages));
	});

	it("fails open to canonical history when retention projection throws", async () => {
		const harness = makeHarness();
		registerToolOutputRetention(retention(() => { throw new Error("projection failed"); }));
		await harness.controller.compact(harness.event, harness.ctx);
		expect(harness.calls[0].context.messages.slice(0, -1)).toEqual(convertToLlm(buildSessionContext(harness.entries).messages));
		expect(harness.ctx.ui.notify).not.toHaveBeenCalled();
	});

	it("preserves the provider prefix and appends exactly one instruction", async () => {
		const harness = makeHarness();

		const result = await harness.controller.compact(harness.event, harness.ctx);

		expect(result?.compaction?.summary).toContain("## Goal");
		expect(harness.calls).toHaveLength(1);
		const call = harness.calls[0];
		expect(call.context.systemPrompt).toBe("unchanged system prompt");
		expect(call.context.messages.slice(0, -1)).toEqual(convertToLlm(buildSessionContext(harness.entries).messages));
		expect(call.context.messages.at(-1)?.role).toBe("user");
		expect(call.context.messages).toHaveLength(convertToLlm(buildSessionContext(harness.entries).messages).length + 1);
		expect(call.context.tools?.map((tool) => tool.name)).toEqual(["second", "first"]);
		expect(JSON.stringify(call.context.messages.at(-1))).toContain("Preserve the exact failing command.");
		expect(JSON.stringify(call.context.messages.at(-1))).toContain("1 trailing provider message");
	});

	it("preserves model, reasoning, session routing, auth, provider environment, and renderer cache policy", async () => {
		const harness = makeHarness();
		await harness.controller.compact(harness.event, harness.ctx);

		const call = harness.calls[0];
		expect(call.model.baseUrl).toBe("https://override.example");
		expect(call.model.id).toBe("model-1");
		expect(call.options).toMatchObject({
			reasoning: "high",
			sessionId: "session-123",
			apiKey: "secret-key",
			headers: { "x-auth": "secret-header" },
			env: { PI_CACHE_RETENTION: "long", REGION: "test" },
		});
		expect(call.options).not.toHaveProperty("cacheRetention");
	});

	it("returns native-compatible metadata and file sections", async () => {
		const harness = makeHarness();
		const result = await harness.controller.compact(harness.event, harness.ctx);

		expect(result?.compaction).toMatchObject({
			firstKeptEntryId: "u2",
			tokensBefore: 1_000,
			usage,
			details: { readFiles: ["z.ts"], modifiedFiles: ["changed.ts", "new.ts"] },
		});
		expect(result?.compaction?.summary).toContain("<read-files>\nz.ts\n</read-files>");
		expect(result?.compaction?.summary).toContain("<modified-files>\nchanged.ts\nnew.ts\n</modified-files>");
	});

	it("uses the registered custom provider without requiring a prior request snapshot", async () => {
		const harness = makeHarness();
		expect(await harness.controller.compact(harness.event, harness.ctx)).toBeDefined();
		expect(harness.ctx.modelRegistry.getProvider).toHaveBeenCalledWith("provider-1");
		expect(harness.streamSimple).toHaveBeenCalledOnce();
		expect(harness.ctx.ui.notify).not.toHaveBeenCalled();
	});

	it("attempts custom compaction for image-containing contexts", async () => {
		const entries = baseEntries();
		entries[0] = entry("u1", null, {
			role: "user",
			content: [{ type: "image", data: "raw-image", mimeType: "image/png" }],
			timestamp: 1,
		});
		const harness = makeHarness({ entries });
		expect(await harness.controller.compact(harness.event, harness.ctx)).toBeDefined();
		expect(harness.streamSimple).toHaveBeenCalledOnce();
	});

	it("attempts custom compaction even when estimated output headroom is exhausted", async () => {
		const harness = makeHarness();
		harness.event.preparation.tokensBefore = 9_900;
		expect(await harness.controller.compact(harness.event, harness.ctx)).toBeDefined();
		expect(harness.streamSimple).toHaveBeenCalledOnce();
		expect(harness.calls[0].options.maxTokens).toBe(800);
	});

	it.each([
		["truncation", response({ stopReason: "length" })],
		["abort", response({ stopReason: "aborted" })],
		["deferred", response({ stopReason: "deferred" })],
		["error", response({ stopReason: "error", errorMessage: "bad" })],
		["tool use", response({ stopReason: "toolUse", content: [{ type: "toolCall", id: "1", name: "read", arguments: {} }] })],
		["empty output", response({ content: [{ type: "text", text: "  " }] })],
	] as const)("uses native fallback only after an unusable %s response", async (label, providerResponse) => {
		const harness = makeHarness({ providerResponse });
		const result = await harness.controller.compact(harness.event, harness.ctx);
		expect(harness.streamSimple).toHaveBeenCalledOnce();
		if (label === "abort") {
			expect(result).toEqual({ cancel: true });
			expect(harness.ctx.ui.notify).not.toHaveBeenCalled();
		} else {
			expect(result).toBeUndefined();
			expect(harness.ctx.ui.notify).toHaveBeenCalledOnce();
		}
	});

	it("uses native fallback when authentication is unavailable", async () => {
		const harness = makeHarness({ auth: { ok: false } });
		expect(await harness.controller.compact(harness.event, harness.ctx)).toBeUndefined();
		expect(harness.streamSimple).not.toHaveBeenCalled();
		expect(harness.ctx.ui.notify).toHaveBeenCalledOnce();
	});

	it("cancels rather than invoking native compaction after an abort", async () => {
		const harness = makeHarness({ providerError: new DOMException("aborted", "AbortError") });
		expect(await harness.controller.compact(harness.event, harness.ctx)).toEqual({ cancel: true });
		expect(harness.ctx.ui.notify).not.toHaveBeenCalled();
	});

	it("cancels when authentication completes after an abort", async () => {
		const harness = makeHarness();
		const abort = new AbortController();
		harness.event.signal = abort.signal;
		harness.ctx.modelRegistry.getApiKeyAndHeaders.mockImplementationOnce(async () => {
			abort.abort();
			return { ok: false };
		});

		expect(await harness.controller.compact(harness.event, harness.ctx)).toEqual({ cancel: true });
		expect(harness.streamSimple).not.toHaveBeenCalled();
		expect(harness.ctx.ui.notify).not.toHaveBeenCalled();
	});

	it("cancels when a provider returns a summary after an abort", async () => {
		const harness = makeHarness();
		const abort = new AbortController();
		harness.event.signal = abort.signal;
		harness.streamSimple.mockImplementationOnce(() => ({
			result: async () => {
				abort.abort();
				return response();
			},
		}));

		expect(await harness.controller.compact(harness.event, harness.ctx)).toEqual({ cancel: true });
		expect(harness.ctx.ui.notify).not.toHaveBeenCalled();
	});

	it("counts a split-turn retained suffix from firstKeptEntryId", async () => {
		const entries = [
			entry("u1", null, user("large turn", 1)),
			entry("a1", "u1", assistant("early work", 2)),
			entry("a2", "a1", assistant("retained work", 3)),
			entry("u2", "a2", user("also retained", 4)),
		];
		const harness = makeHarness({ entries });
		harness.event.preparation = preparation("a2", {
			isSplitTurn: true,
			messagesToSummarize: [],
			turnPrefixMessages: [user("large turn", 1), assistant("early work", 2)],
		});
		await harness.controller.compact(harness.event, harness.ctx);
		expect(JSON.stringify(harness.calls[0].context.messages.at(-1))).toContain("2 trailing provider messages");
	});

	it("keeps previous compaction summaries in the provider prefix", async () => {
		const entries: any[] = [
			entry("u1", null, user("old", 1)),
			entry("u2", "u1", user("kept before compact", 2)),
			{
				type: "compaction",
				id: "c1",
				parentId: "u2",
				timestamp: new Date(3).toISOString(),
				summary: "PREVIOUS SUMMARY TEXT",
				firstKeptEntryId: "u2",
				tokensBefore: 500,
			},
			entry("u3", "c1", user("new retained", 4)),
		];
		const harness = makeHarness({ entries });
		harness.event.preparation = preparation("u3");
		await harness.controller.compact(harness.event, harness.ctx);
		expect(JSON.stringify(harness.calls[0].context.messages.slice(0, -1))).toContain("PREVIOUS SUMMARY TEXT");
	});

	it("rejects an invalid retained-message boundary", async () => {
		const harness = makeHarness();
		harness.event.preparation.firstKeptEntryId = "missing";
		expect(await harness.controller.compact(harness.event, harness.ctx)).toBeUndefined();
		expect(harness.streamSimple).not.toHaveBeenCalled();
		expect(harness.ctx.ui.notify).toHaveBeenCalledOnce();
	});
});
