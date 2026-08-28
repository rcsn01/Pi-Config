import { describe, expect, it } from "vitest";
import { createAnalysisCapture } from "./analysis-capture.ts";

const assistant = (overrides: Record<string, unknown> = {}) => ({
	role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop",
	usage: { input: 5, cacheRead: 4, cacheWrite: 1, output: 3, reasoning: 2, totalTokens: 13, cost: { input: 1, cacheRead: 2, cacheWrite: 3, output: 4, total: 10 } },
	...overrides,
});

describe("analysis capture", () => {
	it("captures requests from standard providers", () => {
		const capture = createAnalysisCapture({ now: () => 100 });
		for (const [provider, api] of [
			["ollama", "openai-completions"],
			["ollama-cloud", "openai-completions"],
			["github-copilot", "anthropic-messages"],
			["openrouter", "openai-completions"],
		] as const) {
			capture.observe({ type: "request", provider, api, model: "test", payload: { messages: [] } });
		}
		expect(capture.getSummary().records.map((record) => record.provider)).toEqual([
			"ollama", "ollama-cloud", "github-copilot", "openrouter",
		]);
	});

	it("correlates status and output and estimates known prefix-cache placement", () => {
		const capture = createAnalysisCapture({ now: () => 100 });
		capture.observe({ type: "agent_start" });
		capture.observe({ type: "turn_start", turnIndex: 2 });
		capture.observe({ type: "request", provider: "github-copilot", api: "openai-responses", model: "gpt", payload: { instructions: "secret", input: [{ role: "user", content: "hi" }] } });
		capture.observe({ type: "response", status: 200 });
		capture.observe({ type: "assistant", message: assistant({ raw: { untouched: true } }) });
		const record = capture.getRecord(1)!;
		expect(record).toMatchObject({ run: 1, turn: 2, status: 200, state: "complete", correlation: "exact", apiLabel: "OpenAI Responses", cachePlacement: "estimated" });
		expect(record.requestJson).toContain("secret");
		expect(record.assistantJson).toContain('"untouched": true');
		expect(record.sections.reduce((sum, row) => sum + (row.cachedTokens ?? 0), 0)).toBe(4);
		expect(capture.getSummary().records[0]!.usage).toMatchObject({ input: 5, cacheRead: 4, cacheWrite: 1, output: 3 });
	});

	it("keeps normalized usage without estimating cache placement for unknown APIs", () => {
		const capture = createAnalysisCapture();
		capture.observe({ type: "request", provider: "custom", api: "custom-api", model: "test", payload: { contents: ["hi"] } });
		capture.observe({ type: "assistant", message: assistant() });
		const record = capture.getRecord(1)!;
		expect(record.usage).toMatchObject({ input: 5, cacheRead: 4 });
		expect(record.cachePlacement).toBeUndefined();
		expect(record.sections).toHaveLength(1);
		expect(record.sections[0]!.allocatedTokens).toBeUndefined();
	});

	it("marks multi-request correlations ambiguous instead of silently claiming certainty", () => {
		const capture = createAnalysisCapture();
		capture.observe({ type: "agent_start" });
		capture.observe({ type: "turn_start", turnIndex: 0 });
		for (const n of [1, 2]) capture.observe({ type: "request", provider: "openai", api: "openai-responses", model: "gpt", payload: { n } });
		capture.observe({ type: "response", status: 503 });
		capture.observe({ type: "assistant", message: assistant({ errorMessage: "failed", stopReason: "error" }) });
		expect(capture.getRecord(1)!.correlation).toBe("ambiguous");
		expect(capture.getRecord(2)!.diagnostic).toContain("candidates");
		expect(capture.getRecord(1)!.statusEvidence).toEqual([503]);
		expect(capture.getRecord(2)!.status).toBeUndefined();
		expect(capture.getRecord(2)!.assistantJson).toContain("failed");
		expect(capture.getRecord(1)!.state).toBe("pending");
	});

	it("tracks run, turn, and pending correlation independently for concurrent sources", () => {
		const capture = createAnalysisCapture();
		const worker = { channel: "subagent", invocationId: "worker-1", displayLabel: "worker" } as const;
		const explorer = { channel: "subagent", invocationId: "explorer-1", displayLabel: "explorer" } as const;
		for (const source of [worker, explorer]) {
			capture.observe({ type: "agent_start", source });
			capture.observe({ type: "turn_start", source, turnIndex: 0 });
			capture.observe({ type: "request", source, provider: "openai", api: "openai-responses", model: "gpt", payload: { source: source.displayLabel } });
		}
		capture.observe({ type: "response", source: explorer, status: 202 });
		capture.observe({ type: "assistant", source: explorer, message: assistant({ content: "explorer output" }) });
		capture.observe({ type: "response", source: worker, status: 201 });
		capture.observe({ type: "assistant", source: worker, message: assistant({ content: "worker output" }) });
		expect(capture.getRecord(1)).toMatchObject({ source: worker, run: 1, turn: 0, status: 201, correlation: "exact" });
		expect(capture.getRecord(2)).toMatchObject({ source: explorer, run: 1, turn: 0, status: 202, correlation: "exact" });
		expect(capture.getRecord(1)!.assistantJson).toContain("worker output");
		expect(capture.getRecord(2)!.assistantJson).toContain("explorer output");
	});

	it("stores compaction preparation and completion as Pi-level records", () => {
		const capture = createAnalysisCapture();
		const source = { channel: "compaction", invocationId: "compact-1", displayLabel: "Compaction" } as const;
		capture.observe({ type: "request", source, provider: "pi", api: "pi-compaction", model: "openai/gpt", fidelity: "pi-preparation", payload: {
			instructions: "focus on tests", previousSummary: "old", messagesToSummarize: [{ role: "user", content: "one" }],
			turnPrefixMessages: [{ role: "assistant", content: "two" }], options: { reason: "manual", settings: { keepRecentTokens: 20_000 } },
		} });
		capture.observe({ type: "assistant", source, message: { role: "assistant", summary: "saved", usage: assistant().usage } });
		const record = capture.getRecord(1)!;
		expect(record).toMatchObject({ fidelity: "pi-preparation", apiLabel: "Pi Compaction Preparation", state: "complete", source });
		expect(record.sections.map((section) => section.label)).toEqual([
			"compaction instructions", "previous summary", "summarized messages", "retained turn prefix", "compaction options",
		]);
		expect(record.assistantJson).toContain('"summary": "saved"');
		expect(record.usage).toMatchObject({ input: 5, output: 3 });
	});

	it("pauses at memory limits, preserves complete records, and clears to resume", () => {
		const notifications: string[] = [];
		const capture = createAnalysisCapture({ maxRecordBytes: 1800, maxTotalBytes: 2500, notify: (message) => notifications.push(message) });
		capture.observe({ type: "request", provider: "openai", api: "openai-responses", model: "gpt", payload: { input: "ok" } });
		capture.observe({ type: "assistant", message: assistant() });
		expect(capture.getRecord(1)!.state).toBe("complete");
		capture.observe({ type: "request", provider: "openai", api: "openai-responses", model: "gpt", payload: { input: "x".repeat(5000) } });
		expect(capture.getSummary().paused).toBe(true);
		expect(capture.getRecord(1)!.state).toBe("complete");
		expect(notifications).toHaveLength(1);
		capture.clear();
		expect(capture.getSummary()).toMatchObject({ paused: false, retainedBytes: 0, records: [] });
	});

	it("removes an oversized pending record instead of retaining partial output", () => {
		const capture = createAnalysisCapture({ maxRecordBytes: 1200 });
		capture.observe({ type: "request", provider: "openai", api: "openai-responses", model: "gpt", payload: { input: "small" } });
		expect(capture.getSummary().records).toHaveLength(1);
		capture.observe({ type: "assistant", message: assistant({ content: [{ type: "text", text: "x".repeat(5000) }] }) });
		expect(capture.getSummary()).toMatchObject({ paused: true, retainedBytes: 0, records: [] });
		expect(capture.getSummary().diagnostic).toContain("removed rather than truncated");
	});

	it("ignores events while paused and resumes with reset correlation after clear", () => {
		const capture = createAnalysisCapture({ maxRecordBytes: 1200 });
		capture.observe({ type: "agent_start" });
		capture.observe({ type: "turn_start", turnIndex: 4 });
		capture.observe({ type: "request", provider: "openai", api: "x", model: "gpt", payload: { input: "kept" } });
		capture.observe({ type: "request", provider: "openai", api: "x", model: "gpt", payload: { input: "x".repeat(5000) } });
		expect(capture.getSummary().paused).toBe(true);
		capture.observe({ type: "request", provider: "openai", api: "x", model: "gpt", payload: { input: "ignored" } });
		expect(capture.getSummary().records).toHaveLength(1);

		capture.clear();
		capture.observe({ type: "request", provider: "openai", api: "x", model: "gpt", payload: { input: "resumed" } });
		expect(capture.getSummary().records).toHaveLength(1);
		expect(capture.getRecord(3)).toMatchObject({ sequence: 3, run: 0, turn: -1 });
	});

	it("pauses without retaining a request when request serialization fails", () => {
		const capture = createAnalysisCapture();
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		capture.observe({ type: "request", provider: "openai", api: "x", model: "gpt", payload: circular });
		expect(capture.getSummary()).toMatchObject({ paused: true, retainedBytes: 0, records: [] });
		expect(capture.getSummary().diagnostic).toContain("JSON serialization failed");
	});

	it("leaves the request pending and ambiguous when assistant serialization fails", () => {
		const capture = createAnalysisCapture();
		capture.observe({ type: "request", provider: "openai", api: "x", model: "gpt", payload: {} });
		const circularAssistant = assistant() as ReturnType<typeof assistant> & { self?: unknown };
		circularAssistant.self = circularAssistant;
		capture.observe({ type: "assistant", message: circularAssistant });
		expect(capture.getRecord(1)).toMatchObject({ state: "pending", correlation: "ambiguous" });
		expect(capture.getRecord(1)!.diagnostic).toContain("JSON serialization failed");
		expect(capture.getSummary().paused).toBe(false);
	});

	it("ignores unmatched response and assistant events", () => {
		const capture = createAnalysisCapture();
		const before = capture.getSummary();
		capture.observe({ type: "response", status: 204 });
		capture.observe({ type: "assistant", message: assistant() });
		expect(capture.getSummary()).toEqual(before);
	});

	it("projects summaries without payloads and accounts for retained record replacements", () => {
		const capture = createAnalysisCapture();
		capture.observe({ type: "request", provider: "openai", api: "openai-responses", model: "gpt", payload: { input: "hello" } });
		const pending = capture.getRecord(1)!;
		expect(capture.getSummary().retainedBytes).toBe(pending.bytes);
		const summaryRecord = capture.getSummary().records[0]!;
		expect(summaryRecord).not.toHaveProperty("requestJson");
		expect(summaryRecord).not.toHaveProperty("assistantJson");
		expect(summaryRecord).not.toHaveProperty("sections");
		expect(summaryRecord).toHaveProperty("fidelity", "exact-provider");

		capture.observe({ type: "response", status: 200 });
		expect(capture.getSummary().retainedBytes).toBe(capture.getRecord(1)!.bytes);
		capture.observe({ type: "assistant", message: assistant() });
		expect(capture.getSummary().retainedBytes).toBe(capture.getRecord(1)!.bytes);
		capture.clear();
		expect(capture.getSummary().retainedBytes).toBe(0);
	});
});
