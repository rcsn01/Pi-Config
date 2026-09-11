import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	clearToolOutputRetention,
	getToolOutputRetention,
} from "../_shared/tool-output-retention.ts";
import {
	CCR_ENTRY_TYPE,
	RETRIEVE_TOOL_NAME,
	createHeadroomExtension,
} from "./index.ts";

type Handler = (...args: any[]) => Promise<any> | any;

function storedEntry(original: string, hash = "abcdefabcdefabcdefabcdef") {
	return {
		version: 1,
		hash,
		original,
		toolName: "bash",
		strategy: "log_sample",
		omitted: 10,
		createdAt: 1,
		blockIndex: 0,
	};
}

function makeHarness(initialBranch: unknown[] = []) {
	const handlers = new Map<string, Handler>();
	const tools = new Map<string, any>();
	const appended: Array<{ type: string; data: unknown }> = [];
	let active = ["second", "bash", "first"];
	let branch = initialBranch;
	const sessionManager = {
		getBranch: vi.fn(() => branch),
		buildContextEntries: vi.fn(() => branch),
	};
	const pi = {
		on: vi.fn((event: string, handler: Handler) => handlers.set(event, handler)),
		registerTool: vi.fn((definition: any) => tools.set(definition.name, definition)),
		getActiveTools: vi.fn(() => [...active]),
		setActiveTools: vi.fn((names: string[]) => {
			active = [...names];
		}),
		appendEntry: vi.fn((type: string, data: unknown) => {
			appended.push({ type, data });
			return `entry-${appended.length}`;
		}),
	} as unknown as ExtensionAPI;
	const ctx = { sessionManager };
	return {
		pi,
		ctx,
		handlers,
		tools,
		appended,
		setBranch(next: unknown[]) { branch = next; },
		get active() { return active; },
	};
}

function largeLog(count = 24): string {
	return Array.from({ length: count }, (_item, index) =>
		index === 12 ? `2026-01-01T00:12 ERROR database timeout` : `2026-01-01T00:${String(index).padStart(2, "0")} INFO progress ${index}`,
	).join("\n");
}

afterEach(clearToolOutputRetention);

describe("provider-headroom adapter", () => {
	it("registers its tool and five lifecycle adapters", () => {
		const harness = makeHarness();
		createHeadroomExtension()(harness.pi);
		expect([...harness.tools]).toEqual([[RETRIEVE_TOOL_NAME, expect.any(Object)]]);
		expect([...harness.handlers.keys()]).toEqual([
			"session_start",
			"session_tree",
			"session_shutdown",
			"tool_result",
			"context",
		]);
	});

	it("fails open before session start and formats a missing retrieval", async () => {
		const harness = makeHarness();
		createHeadroomExtension()(harness.pi);
		expect(await harness.handlers.get("tool_result")!({ toolName: "bash" }, harness.ctx)).toBeUndefined();
		const result = await harness.tools.get(RETRIEVE_TOOL_NAME).execute("call", { hash: " HASH=ABC " });
		expect(result).toEqual({
			content: [{ type: "text", text: "No Headroom content is available for hash abc." }],
			details: { headroomRetrieve: true, hash: "abc", found: false },
		});
	});

	it("maps fresh and context events through the registered module", async () => {
		const branch = [{ type: "message", message: { role: "user", content: "latest query", timestamp: 1 } }];
		const harness = makeHarness(branch);
		createHeadroomExtension()(harness.pi);
		await harness.handlers.get("session_start")!({ type: "session_start" }, harness.ctx);
		const retention = getToolOutputRetention()!;
		const rewriteFresh = vi.fn(() => ({ changed: true, content: [{ type: "text" as const, text: "rewritten" }], details: { kept: true } }));
		const projectHistory = vi.fn((messages) => ({ changed: true, messages: [...messages] }));
		retention.rewriteFresh = rewriteFresh;
		retention.projectHistory = projectHistory;

		const event = {
			type: "tool_result",
			toolCallId: "call-1",
			toolName: "bash",
			input: { command: "npm test" },
			content: [{ type: "text", text: "original" }],
			isError: true,
			details: { original: true },
			usage: { totalTokens: 10 },
		};
		expect(await harness.handlers.get("tool_result")!(event, harness.ctx)).toEqual({
			content: [{ type: "text", text: "rewritten" }],
			details: { kept: true },
		});
		expect(rewriteFresh).toHaveBeenCalledWith({
			toolName: "bash",
			input: event.input,
			isError: true,
			content: event.content,
			details: event.details,
		}, branch);
		expect(harness.ctx.sessionManager.buildContextEntries).toHaveBeenCalledTimes(1);

		const messages = [{ role: "user", content: "request", timestamp: 1 }];
		expect(await harness.handlers.get("context")!({ type: "context", messages }, harness.ctx)).toEqual({ messages });
		expect(projectHistory).toHaveBeenCalledWith(messages);
	});

	it("still rewrites with empty entries when building live context throws", async () => {
		const harness = makeHarness();
		createHeadroomExtension()(harness.pi);
		await harness.handlers.get("session_start")!({ type: "session_start" }, harness.ctx);
		const retention = getToolOutputRetention()!;
		const rewriteFresh = vi.fn(() => ({ changed: true, content: [{ type: "text" as const, text: "rewritten" }], details: undefined }));
		retention.rewriteFresh = rewriteFresh;
		harness.ctx.sessionManager.buildContextEntries.mockImplementation(() => { throw new Error("context unavailable"); });
		const event = { toolName: "bash", input: {}, isError: false, content: [{ type: "text", text: "original" }], details: null };
		expect(await harness.handlers.get("tool_result")!(event, harness.ctx)).toEqual({ content: [{ type: "text", text: "rewritten" }], details: undefined });
		expect(rewriteFresh).toHaveBeenCalledWith({
			toolName: "bash", input: {}, isError: false, content: event.content, details: null,
		}, []);
		expect(harness.ctx.sessionManager.buildContextEntries).toHaveBeenCalledTimes(1);
	});

	it("hydrates retrieval on start without disturbing active-tool order", async () => {
		const entry = storedEntry("full original");
		const branch = [{ type: "custom", customType: CCR_ENTRY_TYPE, data: entry }];
		const harness = makeHarness(branch);
		createHeadroomExtension()(harness.pi);
		await harness.handlers.get("session_start")!({ type: "session_start" }, harness.ctx);
		expect(harness.active).toEqual(["second", "bash", "first", RETRIEVE_TOOL_NAME]);
		const result = await harness.tools.get(RETRIEVE_TOOL_NAME).execute("call", { hash: entry.hash.toUpperCase() });
		expect(result).toEqual({
			content: [{ type: "text", text: "full original" }],
			details: { headroomRetrieve: true, hash: entry.hash, found: true },
		});
	});

	it("rebuilds on tree navigation and drops abandoned-branch retrieval", async () => {
		const abandoned = storedEntry("abandoned", "aaaaaaaaaaaaaaaaaaaaaaaa");
		const selected = storedEntry("selected", "bbbbbbbbbbbbbbbbbbbbbbbb");
		const harness = makeHarness([{ type: "custom", customType: CCR_ENTRY_TYPE, data: abandoned }]);
		createHeadroomExtension()(harness.pi);
		await harness.handlers.get("session_start")!({ type: "session_start" }, harness.ctx);
		harness.setBranch([{ type: "custom", customType: CCR_ENTRY_TYPE, data: selected }]);
		await harness.handlers.get("session_tree")!({ type: "session_tree" }, harness.ctx);

		const tool = harness.tools.get(RETRIEVE_TOOL_NAME);
		expect((await tool.execute("call", { hash: abandoned.hash })).details.found).toBe(false);
		expect((await tool.execute("call", { hash: selected.hash })).content[0].text).toBe("selected");
	});

	it("unregisters on shutdown without allowing stale cleanup to remove a replacement", async () => {
		const first = makeHarness();
		createHeadroomExtension()(first.pi);
		await first.handlers.get("session_start")!({ type: "session_start" }, first.ctx);
		const second = makeHarness();
		createHeadroomExtension()(second.pi);
		await second.handlers.get("session_start")!({ type: "session_start" }, second.ctx);
		const replacement = getToolOutputRetention();
		await first.handlers.get("session_shutdown")!({ type: "session_shutdown" }, first.ctx);
		expect(getToolOutputRetention()).toBe(replacement);
		await second.handlers.get("session_shutdown")!({ type: "session_shutdown" }, second.ctx);
		expect(getToolOutputRetention()).toBeUndefined();
	});

	it("keeps module and host failures out of Pi event handling", async () => {
		const harness = makeHarness();
		(harness.pi.getActiveTools as any).mockImplementation(() => { throw new Error("tools unavailable"); });
		(harness.pi.appendEntry as any).mockImplementation(() => { throw new Error("session unavailable"); });
		createHeadroomExtension({ minChars: 1, maxLines: 2 })(harness.pi);
		await harness.handlers.get("session_start")!({ type: "session_start" }, harness.ctx);
		const retention = getToolOutputRetention()!;
		retention.rewriteFresh = () => { throw new Error("rewrite failed"); };
		retention.projectHistory = () => { throw new Error("projection failed"); };
		expect(await harness.handlers.get("tool_result")!({ toolName: "bash" }, harness.ctx)).toBeUndefined();
		expect(await harness.handlers.get("context")!({ messages: [] }, harness.ctx)).toBeUndefined();
	});

	it("historical persistence failure still returns a projection", async () => {
		const harness = makeHarness();
		(harness.pi.appendEntry as any).mockImplementation(() => { throw new Error("disk full"); });
		createHeadroomExtension({ minChars: 100, maxLines: 4 })(harness.pi);
		await harness.handlers.get("session_start")!({ type: "session_start" }, harness.ctx);
		const result = await harness.handlers.get("context")!({
			type: "context",
			messages: [{ role: "user", content: "inspect", timestamp: 1 }, {
				role: "toolResult",
				toolCallId: "call",
				toolName: "bash",
				content: [{ type: "text", text: largeLog() }],
				isError: false,
				timestamp: 2,
			}],
		}, harness.ctx);
		expect(result.messages[1].content[0].text).toContain("Retrieve original: hash=");
	});
});
