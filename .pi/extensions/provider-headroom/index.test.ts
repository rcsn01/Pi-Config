import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import {
	CCR_ENTRY_TYPE,
	CCR_METADATA_KEY,
	RETRIEVE_TOOL_NAME,
	createHeadroomExtension,
} from "./index.ts";

type Handler = (...args: any[]) => Promise<any> | any;

interface TestHarness {
	pi: ExtensionAPI;
	handlers: Map<string, Handler>;
	tools: Map<string, any>;
	active: string[];
	appended: Array<{ type: string; data: unknown }>;
}

function makeHarness(branch: unknown[] = []): TestHarness {
	const handlers = new Map<string, Handler>();
	const tools = new Map<string, any>();
	let active = ["bash"];
	const appended: Array<{ type: string; data: unknown }> = [];
	const sessionManager = {
		getBranch: () => branch,
		buildContextEntries: () => branch,
	};
	const pi = {
		on: vi.fn((event: string, handler: Handler) => handlers.set(event, handler)),
		registerTool: vi.fn((definition: any) => tools.set(definition.name, definition)),
		getActiveTools: vi.fn(() => active),
		setActiveTools: vi.fn((names: string[]) => {
			active = [...names];
		}),
		appendEntry: vi.fn((type: string, data: unknown) => {
			appended.push({ type, data });
			return `entry-${appended.length}`;
		}),
	} as unknown as ExtensionAPI;

	return {
		pi,
		handlers,
		tools,
		get active() {
			return active;
		},
		appended,
	};
}

function sessionContext(branch: unknown[] = []) {
	return {
		sessionManager: {
			getBranch: () => branch,
			buildContextEntries: () => branch,
		},
	};
}

function largeLog(count: number): string {
	return Array.from({ length: count }, (_item, index) =>
		index === Math.floor(count / 2)
			? `2026-01-01T00:${String(index).padStart(2, "0")} ERROR database timeout`
			: `2026-01-01T00:${String(index).padStart(2, "0")} INFO ordinary progress record ${index}`,
	).join("\n");
}

describe("provider-headroom extension", () => {
	it("rewrites fresh lossy results, persists CCR metadata, and exposes retrieval", async () => {
		const harness = makeHarness();
		createHeadroomExtension({ minChars: 100, maxLines: 6 })(harness.pi);
		const handler = harness.handlers.get("tool_result")!;
		const original = largeLog(24);

		const result = await handler(
			{
				type: "tool_result",
				toolCallId: "call-1",
				toolName: "bash",
				input: { command: "npm test" },
				content: [{ type: "text", text: original }],
				isError: false,
				details: { truncation: { truncated: false } },
			},
			sessionContext(),
		);

		expect(result.content[0].text).toContain("Retrieve original: hash=");
		expect(result.content[0].text.length).toBeLessThan(original.length);
		const metadata = result.details[CCR_METADATA_KEY];
		expect(metadata.entries).toHaveLength(1);
		expect(metadata.entries[0].original).toBe(original);
		expect(harness.active).toContain(RETRIEVE_TOOL_NAME);

		const retrieved = await harness.tools.get(RETRIEVE_TOOL_NAME).execute(
			"retrieve-1",
			{ hash: metadata.entries[0].hash },
			undefined,
			undefined,
			sessionContext(),
		);
		expect(retrieved.content).toEqual([{ type: "text", text: original }]);
	});

	it("leaves exact read results untouched", async () => {
		const harness = makeHarness();
		createHeadroomExtension({ minChars: 50, maxLines: 2 })(harness.pi);
		const original = [
			"export function one() { return 1; }",
			"export function two() { return 2; }",
			"export function three() { return 3; }",
		].join("\n");

		const result = await harness.handlers.get("tool_result")!(
			{
				type: "tool_result",
				toolCallId: "call-read",
				toolName: "read",
				input: { path: "src/example.ts" },
				content: [{ type: "text", text: original }],
				isError: false,
				details: undefined,
			},
			sessionContext(),
		);

		expect(result).toBeUndefined();
		const contextResult = await harness.handlers.get("context")!(
			{
				type: "context",
				messages: [
					{
						role: "toolResult",
						toolCallId: "first-read",
						toolName: "read",
						content: [{ type: "text", text: original }],
						isError: false,
						timestamp: 1,
					},
					{
						role: "toolResult",
						toolCallId: "second-read",
						toolName: "read",
						content: [{ type: "text", text: original }],
						isError: false,
						timestamp: 2,
					},
				],
			},
			sessionContext(),
		);
		expect(contextResult).toBeUndefined();
	});

	it("leaves shell reads untouched and remembers the protection in history", async () => {
		const harness = makeHarness();
		createHeadroomExtension({ minChars: 50, maxLines: 2 })(harness.pi);
		const original = [
			"import { readFile } from 'node:fs/promises';",
			"export function load(path: string) {",
			"\treturn readFile(path, 'utf8');",
			"}",
		].join("\n");

		const result = await harness.handlers.get("tool_result")!(
			{
				type: "tool_result",
				toolCallId: "call-shell-read",
				toolName: "bash",
				input: { command: "cat src/example.ts" },
				content: [{ type: "text", text: original }],
				isError: false,
				details: undefined,
			},
			sessionContext(),
		);

		expect(result.content[0].text).toBe(original);
		expect(result.details.__headroom_protected.verbatim).toBe(true);

		const historical = await harness.handlers.get("context")!(
			{
				type: "context",
				messages: [
					{
						role: "toolResult",
						toolCallId: "call-shell-read",
						toolName: "bash",
						content: [{ type: "text", text: original }],
						details: result.details,
						isError: false,
						timestamp: 1,
					},
				],
			},
			sessionContext(),
		);
		expect(historical).toBeUndefined();
	});

	it("rewrites historical results in the context hook and persists their originals", async () => {
		const harness = makeHarness();
		createHeadroomExtension({ minChars: 100, maxItems: 5 })(harness.pi);
		const original = JSON.stringify(
			Array.from({ length: 30 }, (_item, index) => ({ id: index, value: `row ${index}` })),
			null,
			2,
		);
		const toolMessage: ToolResultMessage = {
			role: "toolResult",
			toolCallId: "call-history",
			toolName: "bash",
			content: [{ type: "text", text: original }],
			isError: false,
			timestamp: 2,
		};
		const event = {
			type: "context",
			messages: [
				{ role: "user", content: "inspect the result", timestamp: 1 },
				toolMessage,
			],
		};

		const result = await harness.handlers.get("context")!(event, sessionContext());
		const rewritten = result.messages[1].content[0].text;

		expect(rewritten).toContain("_headroom_retrieve");
		expect(rewritten.length).toBeLessThan(original.length);
		expect(harness.appended).toHaveLength(1);
		expect(harness.appended[0].type).toBe(CCR_ENTRY_TYPE);
		expect((harness.appended[0].data as any).original).toBe(original);
		expect(harness.active).toContain(RETRIEVE_TOOL_NAME);

		const restoredBranch = [{ type: "custom", customType: CCR_ENTRY_TYPE, data: harness.appended[0].data }];
		const restored = makeHarness(restoredBranch);
		createHeadroomExtension({ minChars: 100, maxItems: 5 })(restored.pi);
		await restored.handlers.get("session_start")!({ type: "session_start" }, sessionContext(restoredBranch));
		expect(restored.active).toContain(RETRIEVE_TOOL_NAME);
		const restoredResult = await restored.tools.get(RETRIEVE_TOOL_NAME).execute(
			"retrieve-restored",
			{ hash: (harness.appended[0].data as any).hash },
			undefined,
			undefined,
			sessionContext(restoredBranch),
		);
		expect(restoredResult.content[0].text).toBe(original);
	});

	it("deduplicates an identical later tool result while keeping the first copy", async () => {
		const harness = makeHarness();
		createHeadroomExtension({ minChars: 50, dedupeMinChars: 20 })(harness.pi);
		const output = "2026-01-01T00:00 INFO " + "same result ".repeat(20);
		const messages = [
			{ role: "user", content: "run it", timestamp: 1 },
			{
				role: "toolResult",
				toolCallId: "first",
				toolName: "bash",
				content: [{ type: "text", text: output }],
				isError: false,
				timestamp: 2,
			},
			{
				role: "toolResult",
				toolCallId: "second",
				toolName: "bash",
				content: [{ type: "text", text: output }],
				isError: false,
				timestamp: 3,
			},
		];

		const result = await harness.handlers.get("context")!({ type: "context", messages }, sessionContext());

		expect(result.messages[1].content[0].text).toBe(output);
		expect(result.messages[2].content[0].text).toContain("identical to an earlier tool result");
	});

	it("can run without CCR and leaves retrieval inactive", async () => {
		const harness = makeHarness();
		createHeadroomExtension({ minChars: 100, maxLines: 4, ccr: false })(harness.pi);
		const original = largeLog(20);
		const result = await harness.handlers.get("tool_result")!(
			{
				type: "tool_result",
				toolCallId: "call-no-ccr",
				toolName: "bash",
				input: { command: "npm test" },
				content: [{ type: "text", text: original }],
				isError: false,
				details: undefined,
			},
			sessionContext(),
		);

		expect(result.content[0].text).toContain("Headroom omitted");
		expect(result.content[0].text).not.toContain("Retrieve original: hash=");
		expect(harness.active).not.toContain(RETRIEVE_TOOL_NAME);
		expect(result.details).toBeUndefined();
	});
});
