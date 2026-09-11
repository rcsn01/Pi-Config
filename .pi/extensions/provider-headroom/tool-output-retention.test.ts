import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import {
	CCR_ENTRY_TYPE,
	CCR_METADATA_KEY,
	PROTECTION_METADATA_KEY,
	createToolOutputRetention,
	type HeadroomExtensionOptions,
	type ToolOutputRetentionHost,
} from "./tool-output-retention.ts";

function largeLog(count = 24): string {
	return Array.from({ length: count }, (_item, index) =>
		index === Math.floor(count / 2)
			? `2026-01-01T00:${String(index).padStart(2, "0")} ERROR database timeout`
			: `2026-01-01T00:${String(index).padStart(2, "0")} INFO ordinary progress record ${index}`,
	).join("\n");
}

function largeJson(count = 30): string {
	return JSON.stringify(Array.from({ length: count }, (_item, index) => ({ id: index, value: `row ${index}` })), null, 2);
}

function createHarness(
	branch: unknown[] = [],
	overrides: HeadroomExtensionOptions = {},
	contextEntries: readonly unknown[] = [{ type: "message", message: { role: "user", content: "database timeout" } }],
) {
	const appended: Array<{ type: string; data: unknown }> = [];
	const availability: boolean[] = [];
	const host: ToolOutputRetentionHost = {
		appendEntry: vi.fn((type, data) => appended.push({ type, data })),
		setRetrievalAvailable: vi.fn((available) => availability.push(available)),
	};
	const retention = createToolOutputRetention({ overrides, host, branch });
	return {
		retention,
		rewriteFresh: (input: Parameters<typeof retention.rewriteFresh>[0]) => retention.rewriteFresh(input, contextEntries),
		host,
		appended,
		availability,
	};
}

function fresh(text: string, overrides: Record<string, unknown> = {}) {
	return {
		toolName: "bash",
		input: { command: "npm test" },
		isError: false,
		content: [{ type: "text" as const, text }],
		details: undefined,
		...overrides,
	};
}

function toolMessage(text: string, overrides: Partial<ToolResultMessage> = {}): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "bash",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 2,
		...overrides,
	};
}

function storedEntry(original: string, overrides: Record<string, unknown> = {}) {
	return {
		version: 1,
		hash: "abcdefabcdefabcdefabcdef",
		original,
		toolName: "bash",
		strategy: "log_sample",
		omitted: 10,
		createdAt: 1,
		blockIndex: 0,
		...overrides,
	};
}

const ENV_NAMES = [
	"PI_HEADROOM_ENABLED",
	"PI_HEADROOM_CCR",
	"PI_HEADROOM_DEDUPE",
	"PI_HEADROOM_MODE",
	"PI_HEADROOM_MIN_CHARS",
	"PI_HEADROOM_MAX_LINES",
	"PI_HEADROOM_MAX_ITEMS",
	"PI_HEADROOM_MAX_SEARCH_MATCHES",
	"PI_HEADROOM_MAX_CHARS",
	"PI_HEADROOM_DEDUPE_MIN_CHARS",
] as const;

const originalEnv = new Map(ENV_NAMES.map((name) => [name, process.env[name]]));
afterEach(() => {
	for (const name of ENV_NAMES) {
		const value = originalEnv.get(name);
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
});

describe("tool-output retention", () => {
	it("rewrites a fresh lossy result and retrieves its exact original", () => {
		const harness = createHarness([], { minChars: 100, maxLines: 6 });
		const original = largeLog();
		const rewritten = harness.rewriteFresh(fresh(original, {
			details: { truncation: { truncated: false } },
		}));

		expect(rewritten.changed).toBe(true);
		expect(rewritten.content[0]).toMatchObject({ type: "text" });
		const metadata = (rewritten.details as any)[CCR_METADATA_KEY];
		expect(metadata.entries).toHaveLength(1);
		expect(metadata.entries[0]).toMatchObject({ original, blockIndex: 0, version: 1 });
		expect(metadata.entries[0].hash).toMatch(/^[a-f0-9]{24}$/);
		expect(harness.retention.retrieve(` HASH=${metadata.entries[0].hash.toUpperCase()} `)).toEqual({
			found: true,
			hash: metadata.entries[0].hash,
			original,
		});
		expect(harness.availability.at(-1)).toBe(true);
		expect(harness.appended).toEqual([]);
	});

	it("preserves fresh content and nested details while adding metadata", () => {
		const nested = { mode: "single", results: [{ output: largeLog(), progress: { status: "completed" }, usage: { input: 1 }, timing: { totalMs: 2 }, truncated: false }] };
		const image = { type: "image" as const, data: "raw", mimeType: "image/png" };
		const original = largeLog(100);
		nested.results[0]!.output = original;
		const content = [{ type: "text" as const, text: original }, image];
		const harness = createHarness([], { minChars: 100, maxLines: 6 });
		const rewritten = harness.rewriteFresh(fresh(original, {
			toolName: "subagent",
			content,
			details: nested,
			isError: true,
		}));
		expect(rewritten.changed).toBe(true);
		expect(rewritten.content).not.toBe(content);
		expect(rewritten.content[1]).toBe(image);
		expect((rewritten.details as any).mode).toBe("single");
		expect((rewritten.details as any).results).toBe(nested.results);
		expect((rewritten.details as any).results).toEqual(nested.results);
		expect(content[0]).toEqual({ type: "text", text: original });
	});

	it("protects shell reads with an additive details marker", () => {
		const details = { existing: { value: 1 } };
		const harness = createHarness([], { minChars: 1, maxLines: 1 });
		const result = harness.rewriteFresh(fresh("plain data\nline two", {
			input: { command: " cd src && SeD -n '1,2p' file.txt" },
			details,
		}));
		expect(result.changed).toBe(true);
		expect(result.content[0]).toEqual({ type: "text", text: "plain data\nline two" });
		expect(result.details).toMatchObject({ existing: details.existing, [PROTECTION_METADATA_KEY]: { version: 1, verbatim: true } });
		expect(details).not.toHaveProperty(PROTECTION_METADATA_KEY);
	});

	it("preserves non-record shell details and the uppercase tool-name marker asymmetry", () => {
		const lower = createHarness([], { minChars: 1 }).rewriteFresh(fresh("plain", {
			input: { command: "cat file.txt" },
			details: "opaque",
		}));
		expect(lower.details).toMatchObject({ originalDetails: "opaque", [PROTECTION_METADATA_KEY]: { verbatim: true } });

		const upper = createHarness([], { minChars: 1 }).rewriteFresh(fresh("plain", {
			toolName: "BASH",
			input: { command: "cat file.txt" },
			details: "opaque",
		}));
		expect(upper).toEqual({ changed: false, content: [{ type: "text", text: "plain" }], details: "opaque" });
	});

	it.each(["read", "WRITE", " edit ", "websearch", "webfetch", "web_search", "web_fetch", "headroom_retrieve", "file_read", "repo-read-file"])(
		"keeps protected tool %s verbatim",
		(toolName) => {
			const result = createHarness([], { minChars: 1, maxLines: 1 }).rewriteFresh(fresh(largeLog(), { toolName }));
			expect(result.changed).toBe(false);
		},
	);

	it.each(["grep", "FIND", " ls "])("allows only lossless changes for %s", (toolName) => {
		const text = `${Array.from({ length: 20 }, () => "same").join("\n")}\n${"x".repeat(200)}`;
		const result = createHarness([], { minChars: 1, maxLines: 1 }).rewriteFresh(fresh(text, { toolName }));
		expect(result.changed).toBe(true);
		expect(JSON.stringify(result.content)).not.toContain("Headroom omitted");
		expect(result.details).toBeUndefined();
	});

	it("keeps errors at 4000 characters and allows larger eligible errors", () => {
		const harness = createHarness([], { minChars: 1, maxLines: 2, maxChars: 20 });
		expect(harness.rewriteFresh(fresh("x".repeat(4_000), { isError: true })).changed).toBe(false);
		const largeError = Array.from({ length: 24 }, (_, i) => i === 12 ? `ERROR ${"x".repeat(220)}` : `INFO ${i} ${"x".repeat(220)}`).join("\n");
		expect(harness.rewriteFresh(fresh(largeError, { isError: true })).changed).toBe(true);
	});

	it("coalesces identical block metadata by hash while retaining the later block index", () => {
		const original = largeLog();
		const result = createHarness([], { minChars: 100, maxLines: 6 }).rewriteFresh(fresh(original, {
			content: [{ type: "text", text: original }, { type: "text", text: original }],
		}));
		const entries = (result.details as any)[CCR_METADATA_KEY].entries;
		expect(entries).toHaveLength(1);
		expect(entries[0].blockIndex).toBe(1);
		expect((result.content[0] as any).text).toContain(entries[0].hash);
		expect((result.content[1] as any).text).toContain(entries[0].hash);
	});

	it("projects historical results once without mutating the source", () => {
		const original = largeJson();
		const message = toolMessage(original, { usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 10, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, addedToolNames: ["later"] });
		const messages = [{ role: "user" as const, content: "inspect target", timestamp: 1 }, message];
		const harness = createHarness([], { minChars: 100, maxItems: 5 });
		const first = harness.retention.projectHistory(messages);
		const second = harness.retention.projectHistory(messages);
		expect(first.changed).toBe(true);
		expect((first.messages[1] as ToolResultMessage).content[0]).not.toEqual(message.content[0]);
		expect(message.content[0]).toEqual({ type: "text", text: original });
		expect(first.messages[1]).toMatchObject({ toolCallId: "call-1", toolName: "bash", addedToolNames: ["later"], isError: false });
		expect(harness.appended).toHaveLength(1);
		expect(harness.appended[0].type).toBe(CCR_ENTRY_TYPE);
		expect(second.changed).toBe(true);
		expect(harness.appended).toHaveLength(1);
		const repeated = harness.retention.projectHistory(first.messages);
		expect(repeated.changed).toBe(false);
		expect(repeated.messages).toBe(first.messages);
	});

	it("returns the original message array when projection is a no-op", () => {
		const messages = [{ role: "user" as const, content: "short", timestamp: 1 }];
		const result = createHarness().retention.projectHistory(messages);
		expect(result).toEqual({ changed: false, messages });
		expect(result.messages).toBe(messages);
	});

	it("keeps protected metadata byte-exact across historical projection", () => {
		const message = toolMessage(largeLog(), { details: { [PROTECTION_METADATA_KEY]: { version: 1, verbatim: true } } });
		const result = createHarness([], { minChars: 1, maxLines: 1 }).retention.projectHistory([message]);
		expect(result.changed).toBe(false);
		expect(result.messages[0]).toBe(message);
	});

	it("deduplicates later projected text while preserving the earliest anchor", () => {
		const output = "same result ".repeat(20);
		const first = toolMessage(output, { toolCallId: "first" });
		const second = toolMessage(output, { toolCallId: "second", timestamp: 3 });
		const result = createHarness([], { minChars: 1_000, dedupeMinChars: 20 }).retention.projectHistory([first, second]);
		expect((result.messages[0] as ToolResultMessage).content[0]).toEqual({ type: "text", text: output });
		expect(((result.messages[1] as ToolResultMessage).content[0] as any).text).toBe("[Headroom: identical to an earlier tool result above.]");
	});

	it("does not use a per-block changed result as a dedupe anchor", () => {
		const clean = "same ".repeat(120);
		const colored = `\u001b[31m${clean}\u001b[0m`;
		const messages = [toolMessage(colored), toolMessage(clean)];
		const result = createHarness([], { minChars: 500, dedupeMinChars: 20 }).retention.projectHistory(messages);
		expect(result.changed).toBe(true);
		expect(((result.messages[0] as ToolResultMessage).content[0] as any).text).toBe(clean);
		expect(((result.messages[1] as ToolResultMessage).content[0] as any).text).toBe(clean);
	});

	it("deduplicates a later block after it losslessly rewrites to an unchanged anchor", () => {
		const clean = "same ".repeat(120);
		const colored = `\u001b[31m${clean}\u001b[0m`;
		const result = createHarness([], { minChars: 500, dedupeMinChars: 20 }).retention.projectHistory([
			toolMessage(clean),
			toolMessage(colored),
		]);
		expect(((result.messages[1] as ToolResultMessage).content[0] as any).text).toBe("[Headroom: identical to an earlier tool result above.]");
	});

	it("does not use protected, CCR-backed, or multi-block messages as dedupe anchors", () => {
		const output = "same\nsame\nsame\n" + "x".repeat(60);
		const metadata = { [CCR_METADATA_KEY]: { version: 1, entries: [storedEntry(output)] } };
		const cases = [
			[toolMessage(output, { toolName: "read" }), toolMessage(output)],
			[toolMessage(output, { details: metadata }), toolMessage(output)],
			[toolMessage(output, { content: [{ type: "text", text: output }, { type: "text", text: "extra" }] }), toolMessage(output)],
		];
		for (const messages of cases) {
			const result = createHarness([], { minChars: 1_000, dedupeMinChars: 20 }).retention.projectHistory(messages);
			expect(result.changed).toBe(false);
		}
	});

	it("hydrates metadata from non-tool messages during projection", () => {
		const entry = storedEntry("from custom message");
		const message = { role: "custom", content: "display", details: { [CCR_METADATA_KEY]: { version: 1, entries: [entry] } }, timestamp: 1 } as any;
		const harness = createHarness();
		expect(harness.retention.projectHistory([message]).changed).toBe(false);
		expect(harness.retention.retrieve(entry.hash)).toEqual({ found: true, hash: entry.hash, original: "from custom message" });
		expect(harness.availability.at(-1)).toBe(true);
	});

	it("hydrates custom and role-agnostic message metadata in source order", () => {
		const first = storedEntry("first");
		const second = storedEntry("second", { createdAt: -1.5, extra: true });
		const branch = [
			{ type: "custom", customType: CCR_ENTRY_TYPE, data: first },
			{ type: "message", message: { role: "custom", details: { [CCR_METADATA_KEY]: { version: 1, entries: [second] } } } },
		];
		const harness = createHarness(branch);
		expect(harness.retention.retrieve(first.hash)).toEqual({ found: true, hash: first.hash, original: "second" });
		expect(harness.availability.at(-1)).toBe(true);
	});

	it("ignores malformed and unknown-version hydration records", () => {
		const branch = [
			{ type: "custom", customType: CCR_ENTRY_TYPE, data: storedEntry("bad", { version: 2 }) },
			{ type: "custom", customType: CCR_ENTRY_TYPE, data: storedEntry("bad", { hash: "UPPER" }) },
		];
		const harness = createHarness(branch);
		expect(harness.retention.retrieve("abcdefabcdefabcdefabcdef").found).toBe(false);
		expect(harness.availability.at(-1)).toBe(false);
	});

	it("resolves environment configuration on every operation with option precedence", () => {
		process.env.PI_HEADROOM_ENABLED = " false ";
		const harness = createHarness([], { enabled: true, minChars: 1, maxLines: 2 });
		expect(harness.rewriteFresh(fresh(largeLog())).changed).toBe(true);
		process.env.PI_HEADROOM_ENABLED = "0";
		const dynamic = createHarness([], { minChars: 1, maxLines: 2 });
		expect(dynamic.rewriteFresh(fresh(largeLog())).changed).toBe(false);
		process.env.PI_HEADROOM_ENABLED = "unexpected";
		expect(dynamic.rewriteFresh(fresh(largeLog())).changed).toBe(true);
	});

	it("uses exact mode and minimum-size environment semantics", () => {
		process.env.PI_HEADROOM_MIN_CHARS = "1";
		process.env.PI_HEADROOM_MAX_LINES = "5";
		process.env.PI_HEADROOM_MODE = "lossless";
		const harness = createHarness();
		expect(harness.rewriteFresh(fresh(largeLog())).changed).toBe(false);
		process.env.PI_HEADROOM_MODE = "LOSSLESS";
		expect(harness.rewriteFresh(fresh(largeLog())).changed).toBe(true);
		process.env.PI_HEADROOM_MIN_CHARS = "10000";
		expect(harness.rewriteFresh(fresh(largeLog())).changed).toBe(false);
	});

	it("uses line, item, search-match, and character limit environment variables", () => {
		process.env.PI_HEADROOM_MIN_CHARS = "1";
		process.env.PI_HEADROOM_CCR = "0";
		process.env.PI_HEADROOM_MAX_LINES = "5";
		process.env.PI_HEADROOM_MAX_CHARS = "100";
		expect(createHarness().rewriteFresh(fresh(largeLog())).changed).toBe(true);

		process.env.PI_HEADROOM_MAX_ITEMS = "4";
		const json = createHarness().rewriteFresh(fresh(largeJson(10)));
		expect(JSON.stringify(json.content)).toContain("_headroom_omitted");

		process.env.PI_HEADROOM_MAX_SEARCH_MATCHES = "4";
		const search = Array.from({ length: 18 }, (_, index) => index === 11
			? `src/error.ts:${index + 1}:ERROR connection refused`
			: `src/file-${index % 3}.ts:${index + 1}:ordinary match ${index}`
		).join("\n");
		expect(createHarness().rewriteFresh(fresh(search, { toolName: "search" })).changed).toBe(true);
	});

	it("uses dedupe minimum from the environment", () => {
		const output = "same result ".repeat(30);
		process.env.PI_HEADROOM_MIN_CHARS = "10000";
		process.env.PI_HEADROOM_DEDUPE_MIN_CHARS = "10000";
		const harness = createHarness();
		expect(harness.retention.projectHistory([toolMessage(output), toolMessage(output)]).changed).toBe(false);
		process.env.PI_HEADROOM_DEDUPE_MIN_CHARS = "20";
		expect(harness.retention.projectHistory([toolMessage(output), toolMessage(output)]).changed).toBe(true);
	});

	it.each(["0", "false", " NO ", "Off"])("treats %j as a false boolean environment value", (value) => {
		process.env.PI_HEADROOM_ENABLED = value;
		expect(createHarness([], { minChars: 1, maxLines: 2 }).rewriteFresh(fresh(largeLog())).changed).toBe(false);
	});

	it.each(["0", "-1", "1.5", "9007199254740992", "", "nope"])("falls back for invalid positive integer %j", (value) => {
		process.env.PI_HEADROOM_MIN_CHARS = value;
		const output = `${Array.from({ length: 20 }, () => "same").join("\n")}\nend`;
		expect(createHarness([], { maxLines: 1 }).rewriteFresh(fresh(output)).changed).toBe(false);
	});

	it("keeps CCR and dedupe disabled when their environment flags are false", () => {
		process.env.PI_HEADROOM_CCR = "off";
		process.env.PI_HEADROOM_DEDUPE = "NO";
		const harness = createHarness([], { minChars: 100, maxLines: 3, dedupeMinChars: 20 });
		const rewritten = harness.rewriteFresh(fresh(largeLog()));
		expect(JSON.stringify(rewritten.content)).not.toContain("Retrieve original");
		expect(rewritten.details).toBeUndefined();
		const output = "same result ".repeat(30);
		expect(harness.retention.projectHistory([toolMessage(output), toolMessage(output)]).changed).toBe(false);
		expect(harness.availability).not.toContain(true);
	});

	const rankingLog = JSON.stringify(Array.from({ length: 30 }, (_, index) => ({
		value: index === 9 ? "alphaquery uniquely relevant" : index === 20 ? "omegaquery uniquely relevant" : `ordinary filler record ${index}`,
	})));
	const reducedText = (entries: readonly unknown[]) => JSON.stringify(
		createHarness([], { minChars: 1, maxItems: 4, ccr: false }, entries).rewriteFresh(fresh(rankingLog)).content,
	);
	const historicalText = (messages: readonly any[]) => {
		const projected = createHarness([], { minChars: 1, maxItems: 4, ccr: false }).retention.projectHistory([...messages, toolMessage(rankingLog)]).messages;
		return JSON.stringify((projected.at(-1) as ToolResultMessage).content);
	};

	it("derives fresh queries from the last truthy user entry by array order and exact content extraction", () => {
		const user = (content: unknown, timestamp = 0) => ({ type: "message", message: { role: "user", content, timestamp } });
		expect(reducedText([user("omegaquery", 99), user("alphaquery", 1)])).toContain("alphaquery");
		expect(reducedText([user("alphaquery"), user([{ type: "image" }, { type: "text", text: "omegaquery" }])])).toContain("omegaquery");
		for (const content of ["", [], [{ type: "image" }], 42, [{ type: "text" }]])
			expect(reducedText([user("alphaquery"), user(content)])).toContain("alphaquery");
		for (const content of ["   ", [{ type: "text", text: "" }, { type: "text", text: "" }]])
			expect(reducedText([user("alphaquery"), user(content)])).not.toContain("alphaquery uniquely");
	});

	it("filters fresh Session entries and all non-user message roles", () => {
		const entries: any[] = [{ type: "message", message: { role: "user", content: "alphaquery" } }];
		for (const type of ["thinking_level_change", "model_change", "compaction", "branch_summary", "custom", "custom_message", "label", "session_info"])
			entries.push({ type, message: { role: "user", content: "omegaquery" } });
		entries.push(null, {}, { type: "message" }, { type: "message", message: null });
		for (const role of ["assistant", "toolResult", "bashExecution", "custom", "branchSummary", "compactionSummary"])
			entries.push({ type: "message", message: { role, content: "omegaquery" } });
		expect(reducedText(entries)).toContain("alphaquery");
	});

	it("fails fresh query extraction open for throwing records and non-iterable entries", () => {
		for (const property of ["type", "message", "role", "content", "text"]) {
			const throwing: any = property === "text"
				? { type: "message", message: { role: "user", content: [{ type: "text", get text() { throw new Error("bad"); } }] } }
				: property === "content"
					? { type: "message", message: { role: "user", get content() { throw new Error("bad"); } } }
					: property === "role"
						? { type: "message", message: { get role() { throw new Error("bad"); } } }
						: property === "message"
						? { type: "message", get message() { throw new Error("bad"); } }
						: { get type() { throw new Error("bad"); } };
			const text = reducedText([{ type: "message", message: { role: "user", content: "alphaquery" } }, throwing, { type: "message", message: { role: "user", content: "omegaquery" } }]);
			expect(text, property).not.toContain("alphaquery uniquely");
			expect(text, property).not.toContain("omegaquery uniquely");
		}
		expect(reducedText(42 as any)).toContain("Headroom omitted");
	});

	it("tails fresh queries at 8,000 UTF-16 code units", () => {
		const query = `alphaquery${"😀".repeat(4_001)}omegaquery`;
		const text = reducedText([{ type: "message", message: { role: "user", content: query } }]);
		expect(text).toContain("omegaquery uniquely");
		expect(text).not.toContain("alphaquery uniquely");
	});

	it("derives historical queries in reverse array order with exact filtering and extraction", () => {
		const user = (content: unknown, timestamp = 0) => ({ role: "user", content, timestamp });
		expect(historicalText([user("omegaquery", 99), user("alphaquery", 1)])).toContain("alphaquery uniquely");
		expect(historicalText([user("alphaquery"), user([{ type: "image" }, { type: "text", text: "omegaquery" }])])).toContain("omegaquery uniquely");
		const ignored = ["assistant", "toolResult", "bashExecution", "custom", "branchSummary", "compactionSummary"].map((role) => ({ role, content: "omegaquery", toolName: "bash", isError: false }));
		expect(historicalText([user("alphaquery"), user(""), user([]), user(42), ...ignored])).toContain("alphaquery uniquely");
		for (const content of [" ", [{ type: "text", text: "" }, { type: "text", text: "" }]])
			expect(historicalText([user("alphaquery"), user(content)])).not.toContain("alphaquery uniquely");
	});

	it("tails historical queries at 8,000 UTF-16 code units", () => {
		const text = historicalText([{ role: "user", content: `alphaquery${"😀".repeat(4_001)}omegaquery` }]);
		expect(text).toContain("omegaquery uniquely");
		expect(text).not.toContain("alphaquery uniquely");
	});

	it("keeps the historical walker short-circuit and propagation failure boundary", () => {
		const throwing = { role: "user", get content() { throw new Error("bad history"); } };
		expect(() => historicalText([throwing, { role: "user", content: "alphaquery" }])).not.toThrow();
		expect(() => historicalText([{ role: "user", content: "alphaquery" }, throwing])).toThrow("bad history");
	});
});
