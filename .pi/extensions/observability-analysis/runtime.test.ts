import { describe, expect, it, vi } from "vitest";
import { createAnalysisRuntime } from "./runtime.ts";

function fakeServer() {
	return { start: vi.fn(async () => ({ url: "http://localhost:1/#token=test" })), close: vi.fn(async () => {}) };
}

const assistant = (overrides: Record<string, unknown> = {}) => ({
	role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop",
	usage: { input: 5, cacheRead: 4, cacheWrite: 1, output: 3, reasoning: 2, totalTokens: 13, cost: { input: 1, cacheRead: 2, cacheWrite: 3, output: 4, total: 10 } },
	...overrides,
});

describe("analysis runtime", () => {
	it("does not retain events before successful activation and starts idempotently", async () => {
		const server = fakeServer();
		const runtime = createAnalysisRuntime({ serverFactory: () => server });
		runtime.observe({ type: "request", provider: "openai", api: "openai-responses", model: "gpt", payload: { input: "early" } });
		expect(runtime.getSummary().records).toHaveLength(0);
		expect((await runtime.start()).url).toContain("#token=");
		await runtime.start();
		expect(server.start).toHaveBeenCalledOnce();
	});

	it("captures requests from standard providers", async () => {
		const runtime = createAnalysisRuntime({ serverFactory: () => fakeServer(), now: () => 100 });
		await runtime.start();
		for (const [provider, api] of [
			["ollama", "openai-completions"],
			["ollama-cloud", "openai-completions"],
			["github-copilot", "anthropic-messages"],
			["openrouter", "openai-completions"],
		] as const) {
			runtime.observe({ type: "request", provider, api, model: "test", payload: { messages: [] } });
		}
		expect(runtime.getSummary().records.map((record) => record.provider)).toEqual([
			"ollama", "ollama-cloud", "github-copilot", "openrouter",
		]);
	});

	it("correlates status and output and estimates known prefix-cache placement", async () => {
		const runtime = createAnalysisRuntime({ serverFactory: () => fakeServer(), now: () => 100 });
		await runtime.start();
		runtime.observe({ type: "agent_start" });
		runtime.observe({ type: "turn_start", turnIndex: 2 });
		runtime.observe({ type: "request", provider: "github-copilot", api: "openai-responses", model: "gpt", payload: { instructions: "secret", input: [{ role: "user", content: "hi" }] } });
		runtime.observe({ type: "response", status: 200 });
		runtime.observe({ type: "assistant", message: assistant({ raw: { untouched: true } }) });
		const record = runtime.getRecord(1)!;
		expect(record).toMatchObject({ run: 1, turn: 2, status: 200, state: "complete", correlation: "exact", apiLabel: "OpenAI Responses", cachePlacement: "estimated" });
		expect(record.requestJson).toContain("secret");
		expect(record.assistantJson).toContain('"untouched": true');
		expect(record.sections.reduce((sum, row) => sum + (row.cachedTokens ?? 0), 0)).toBe(4);
	});

	it("keeps normalized usage without estimating cache placement for unknown APIs", async () => {
		const runtime = createAnalysisRuntime({ serverFactory: () => fakeServer() });
		await runtime.start();
		runtime.observe({ type: "request", provider: "custom", api: "custom-api", model: "test", payload: { contents: ["hi"] } });
		runtime.observe({ type: "assistant", message: assistant() });
		const record = runtime.getRecord(1)!;
		expect(record.usage).toMatchObject({ input: 5, cacheRead: 4 });
		expect(record.cachePlacement).toBeUndefined();
		expect(record.sections).toHaveLength(1);
		expect(record.sections[0]!.allocatedTokens).toBeUndefined();
	});

	it("marks multi-request correlations ambiguous instead of silently claiming certainty", async () => {
		const runtime = createAnalysisRuntime({ serverFactory: () => fakeServer() });
		await runtime.start();
		runtime.observe({ type: "agent_start" });
		runtime.observe({ type: "turn_start", turnIndex: 0 });
		for (const n of [1, 2]) runtime.observe({ type: "request", provider: "openai", api: "openai-responses", model: "gpt", payload: { n } });
		runtime.observe({ type: "response", status: 503 });
		runtime.observe({ type: "assistant", message: assistant({ errorMessage: "failed", stopReason: "error" }) });
		expect(runtime.getRecord(1)!.correlation).toBe("ambiguous");
		expect(runtime.getRecord(2)!.diagnostic).toContain("candidates");
		expect(runtime.getRecord(1)!.statusEvidence).toEqual([503]);
		expect(runtime.getRecord(2)!.status).toBeUndefined();
		expect(runtime.getRecord(2)!.assistantJson).toContain("failed");
		expect(runtime.getRecord(1)!.state).toBe("pending");
	});

	it("pauses at memory limits, preserves complete records, and clears to resume", async () => {
		const notifications: string[] = [];
		const runtime = createAnalysisRuntime({ serverFactory: () => fakeServer(), maxRecordBytes: 1800, maxTotalBytes: 2500, notify: (message) => notifications.push(message) });
		await runtime.start();
		runtime.observe({ type: "request", provider: "openai", api: "openai-responses", model: "gpt", payload: { input: "ok" } });
		runtime.observe({ type: "assistant", message: assistant() });
		expect(runtime.getRecord(1)!.state).toBe("complete");
		runtime.observe({ type: "request", provider: "openai", api: "openai-responses", model: "gpt", payload: { input: "x".repeat(5000) } });
		expect(runtime.getSummary().paused).toBe(true);
		expect(runtime.getRecord(1)!.state).toBe("complete");
		expect(notifications).toHaveLength(1);
		runtime.clear();
		expect(runtime.getSummary()).toMatchObject({ paused: false, retainedBytes: 0, records: [] });
	});

	it("removes an oversized pending record instead of retaining partial output", async () => {
		const runtime = createAnalysisRuntime({ serverFactory: () => fakeServer(), maxRecordBytes: 1200 });
		await runtime.start();
		runtime.observe({ type: "request", provider: "openai", api: "openai-responses", model: "gpt", payload: { input: "small" } });
		expect(runtime.getSummary().records).toHaveLength(1);
		runtime.observe({ type: "assistant", message: assistant({ content: [{ type: "text", text: "x".repeat(5000) }] }) });
		expect(runtime.getSummary()).toMatchObject({ paused: true, retainedBytes: 0, records: [] });
		expect(runtime.getSummary().diagnostic).toContain("removed rather than truncated");
	});

	it("revokes state and closes the server at shutdown", async () => {
		const server = fakeServer();
		const runtime = createAnalysisRuntime({ serverFactory: () => server });
		await runtime.start();
		runtime.observe({ type: "request", provider: "openai", api: "x", model: "x", payload: {} });
		await runtime.close();
		expect(server.close).toHaveBeenCalledOnce();
		expect(runtime.getSummary().activatedAt).toBeUndefined();
		expect(runtime.getSummary().records).toEqual([]);
	});
});
