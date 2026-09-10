import type { AssistantMessage, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { buildSessionContext, convertToLlm } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCacheAwareCompaction } from "../_shared/cache-aware-compaction.ts";
import { clearToolOutputRetention, getToolOutputRetention } from "../_shared/tool-output-retention.ts";
import { CCR_ENTRY_TYPE, RETRIEVE_TOOL_NAME, createHeadroomExtension } from "./index.ts";

const usage = {
	input: 100,
	output: 20,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 120,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function user(content: string, timestamp: number) {
	return { role: "user" as const, content, timestamp };
}

function toolResult(content: string, timestamp: number, toolCallId = `call-${timestamp}`) {
	return {
		role: "toolResult" as const,
		toolCallId,
		toolName: "bash",
		content: [{ type: "text" as const, text: content }],
		isError: false,
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

function largeLog(): string {
	return Array.from({ length: 30 }, (_item, index) =>
		index === 15 ? "2026-01-01T00:15 ERROR database timeout" : `2026-01-01T00:${String(index).padStart(2, "0")} INFO ordinary progress ${index}`,
	).join("\n");
}

function harness(initialBranch: any[]) {
	let branch = initialBranch;
	let active = ["bash"];
	const handlers = new Map<string, (...args: any[]) => any>();
	const tools = new Map<string, any>();
	const appended: Array<{ type: string; data: any }> = [];
	const calls: Array<{ context: Context; options: SimpleStreamOptions }> = [];
	const model: Model<any> = {
		id: "model",
		name: "Model",
		api: "test-api",
		provider: "provider",
		baseUrl: "https://example.test",
		reasoning: false,
		input: ["text"],
		cost: usage.cost,
		contextWindow: 10_000,
		maxTokens: 2_000,
	};
	const provider = {
		streamSimple: vi.fn((_model: Model<any>, context: Context, options: SimpleStreamOptions) => {
			calls.push({ context, options });
			return {
				result: async (): Promise<AssistantMessage> => ({
					role: "assistant",
					content: [{ type: "text", text: "## Goal\nContinue" }],
					api: "test-api",
					provider: "provider",
					model: "model",
					usage,
					stopReason: "stop",
					timestamp: 100,
				}),
			};
		}),
	};
	const pi: any = {
		on: vi.fn((name: string, callback: (...args: any[]) => any) => handlers.set(name, callback)),
		registerTool: vi.fn((definition: any) => tools.set(definition.name, definition)),
		appendEntry: vi.fn((type: string, data: any) => {
			appended.push({ type, data });
			return `custom-${appended.length}`;
		}),
		getActiveTools: vi.fn(() => [...active]),
		setActiveTools: vi.fn((names: string[]) => { active = [...names]; }),
		getAllTools: vi.fn(() => []),
		getThinkingLevel: vi.fn(() => "off"),
	};
	const sessionManager = {
		getBranch: vi.fn(() => branch),
		buildContextEntries: vi.fn(() => branch),
		getSessionId: vi.fn(() => "session"),
	};
	const ctx: any = {
		model,
		thinkingLevel: "off",
		getSystemPrompt: vi.fn(() => "system"),
		sessionManager,
		modelRegistry: {
			getProvider: vi.fn(() => provider),
			getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: "key" })),
		},
		ui: { notify: vi.fn() },
	};
	return {
		pi,
		ctx,
		handlers,
		tools,
		appended,
		calls,
		setBranch(next: any[]) { branch = next; },
		get active() { return active; },
	};
}

function compactionEvent(branchEntries: any[]) {
	return {
		type: "session_before_compact",
		branchEntries,
		preparation: {
			firstKeptEntryId: branchEntries.at(-1).id,
			messagesToSummarize: [],
			turnPrefixMessages: [],
			isSplitTurn: false,
			tokensBefore: 1_000,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { enabled: false, reserveTokens: 1_000, keepRecentTokens: 200 },
		},
		reason: "manual",
		willRetry: false,
		signal: new AbortController().signal,
	};
}

afterEach(clearToolOutputRetention);

describe("Provider Headroom and cache-aware compaction", () => {
	it("shares one active-branch projection and drops it after tree changes and shutdown", async () => {
		const duplicate = "identical result ".repeat(20);
		const clean = "same ".repeat(120);
		const colored = `\u001b[31m${clean}\u001b[0m`;
		const original = largeLog();
		const branch = [
			entry("u1", null, user("find the timeout", 1)),
			entry("t1", "u1", toolResult(duplicate, 2, "duplicate-anchor")),
			entry("t2", "t1", toolResult(duplicate, 3, "duplicate-copy")),
			entry("t3", "t2", toolResult(colored, 4, "changed-first")),
			entry("t4", "t3", toolResult(clean, 5, "not-a-duplicate")),
			entry("t5", "t4", toolResult(original, 6, "lossy")),
		];
		const test = harness(branch);
		createHeadroomExtension({ minChars: 500, maxLines: 5, dedupeMinChars: 20 })(test.pi);
		await test.handlers.get("session_start")!({ type: "session_start" }, test.ctx);

		const canonical = buildSessionContext(branch).messages;
		const normal = await test.handlers.get("context")!({ type: "context", messages: canonical }, test.ctx);
		expect(normal.messages[1].content[0].text).toBe(duplicate);
		expect(normal.messages[2].content[0].text).toContain("identical to an earlier tool result");
		expect(normal.messages[3].content[0].text).toBe(clean);
		expect(normal.messages[4].content[0].text).toBe(clean);
		expect(normal.messages[5].content[0].text).toContain("Retrieve original: hash=");
		expect(test.appended).toHaveLength(1);
		expect(test.appended[0].type).toBe(CCR_ENTRY_TYPE);

		await createCacheAwareCompaction(test.pi).compact(compactionEvent(branch) as any, test.ctx);
		expect(test.calls[0].context.messages.slice(0, -1)).toEqual(convertToLlm(normal.messages));
		expect(test.calls[0].context.messages.at(-1)?.role).toBe("user");
		expect(test.appended).toHaveLength(1);

		const hash = test.appended[0].data.hash;
		const retrieved = await test.tools.get(RETRIEVE_TOOL_NAME).execute("call", { hash });
		expect(retrieved.content).toEqual([{ type: "text", text: original }]);
		expect(retrieved.details).toEqual({ headroomRetrieve: true, hash, found: true });

		test.setBranch([]);
		await test.handlers.get("session_tree")!({ type: "session_tree" }, test.ctx);
		expect((await test.tools.get(RETRIEVE_TOOL_NAME).execute("call", { hash })).details.found).toBe(false);

		const selected = { version: 1, hash: "bbbbbbbbbbbbbbbbbbbbbbbb", original: "selected", toolName: "bash", strategy: "log_sample", omitted: 1, createdAt: 1, blockIndex: 0 };
		test.setBranch([{ type: "custom", id: "c1", parentId: null, timestamp: new Date(7).toISOString(), customType: CCR_ENTRY_TYPE, data: selected }]);
		await test.handlers.get("session_tree")!({ type: "session_tree" }, test.ctx);
		expect((await test.tools.get(RETRIEVE_TOOL_NAME).execute("call", { hash: selected.hash })).details.found).toBe(true);

		await test.handlers.get("session_shutdown")!({ type: "session_shutdown" }, test.ctx);
		expect(getToolOutputRetention()).toBeUndefined();
		const unprojectedBranch = [entry("u2", null, user("unchanged", 8))];
		await createCacheAwareCompaction(test.pi).compact(compactionEvent(unprojectedBranch) as any, test.ctx);
		expect(test.calls[1].context.messages.slice(0, -1)).toEqual(convertToLlm(buildSessionContext(unprojectedBranch).messages));
	});
});
