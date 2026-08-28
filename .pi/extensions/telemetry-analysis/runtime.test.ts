import { afterEach, describe, expect, it, vi } from "vitest";
import { createAnalysisRuntime, getPersistentAnalysisRuntime, persistentAnalysisRuntime } from "./runtime.ts";

afterEach(async () => persistentAnalysisRuntime.resetForTests());

function fakeServer() {
	return { start: vi.fn(async () => ({ url: "http://localhost:1/#token=test" })), close: vi.fn(async () => {}) };
}

const assistant = (overrides: Record<string, unknown> = {}) => ({
	role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop",
	usage: { input: 5, cacheRead: 4, cacheWrite: 1, output: 3, reasoning: 2, totalTokens: 13, cost: { input: 1, cacheRead: 2, cacheWrite: 3, output: 4, total: 10 } },
	...overrides,
});

describe("analysis runtime", () => {
	it("shares the active runtime and records across extension instances", async () => {
		const first = getPersistentAnalysisRuntime();
		const url = (await first.start()).url;
		first.observe({ type: "request", provider: "openai", api: "openai-responses", model: "gpt", payload: { input: "kept" } });

		const second = getPersistentAnalysisRuntime();
		expect(second).toBe(first);
		expect((await second.start()).url).toBe(url);
		expect(second.isActive()).toBe(true);
		expect(second.getSummary().records).toHaveLength(1);
	});

	it("keeps its close-during-start error at the dashboard seam", async () => {
		let rejectStart!: (error: unknown) => void;
		const server = {
			start: vi.fn(() => new Promise<{ url: string }>((_resolve, reject) => { rejectStart = reject; })),
			close: vi.fn(async () => rejectStart(new Error("listen cancelled"))),
		};
		const runtime = createAnalysisRuntime({ serverFactory: () => server });

		const starting = runtime.start();
		const closing = runtime.close();
		await expect(starting).rejects.toThrow("Analysis server was closed while starting.");
		await closing;
	});

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
		expect(runtime.getSummary().records[0]!.usage).toMatchObject({ input: 5, cacheRead: 4, cacheWrite: 1, output: 3 });
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

	it("tracks run, turn, and pending correlation independently for concurrent sources", async () => {
		const runtime = createAnalysisRuntime({ serverFactory: () => fakeServer() });
		await runtime.start();
		const worker = { channel: "subagent", invocationId: "worker-1", displayLabel: "worker" } as const;
		const explorer = { channel: "subagent", invocationId: "explorer-1", displayLabel: "explorer" } as const;
		for (const source of [worker, explorer]) {
			runtime.observe({ type: "agent_start", source });
			runtime.observe({ type: "turn_start", source, turnIndex: 0 });
			runtime.observe({ type: "request", source, provider: "openai", api: "openai-responses", model: "gpt", payload: { source: source.displayLabel } });
		}
		runtime.observe({ type: "response", source: explorer, status: 202 });
		runtime.observe({ type: "assistant", source: explorer, message: assistant({ content: "explorer output" }) });
		runtime.observe({ type: "response", source: worker, status: 201 });
		runtime.observe({ type: "assistant", source: worker, message: assistant({ content: "worker output" }) });
		expect(runtime.getRecord(1)).toMatchObject({ source: worker, run: 1, turn: 0, status: 201, correlation: "exact" });
		expect(runtime.getRecord(2)).toMatchObject({ source: explorer, run: 1, turn: 0, status: 202, correlation: "exact" });
		expect(runtime.getRecord(1)!.assistantJson).toContain("worker output");
		expect(runtime.getRecord(2)!.assistantJson).toContain("explorer output");
	});

	it("stores compaction preparation and completion as Pi-level records", async () => {
		const runtime = createAnalysisRuntime({ serverFactory: () => fakeServer() });
		await runtime.start();
		const source = { channel: "compaction", invocationId: "compact-1", displayLabel: "Compaction" } as const;
		runtime.observe({ type: "request", source, provider: "pi", api: "pi-compaction", model: "openai/gpt", fidelity: "pi-preparation", payload: {
			instructions: "focus on tests", previousSummary: "old", messagesToSummarize: [{ role: "user", content: "one" }],
			turnPrefixMessages: [{ role: "assistant", content: "two" }], options: { reason: "manual", settings: { keepRecentTokens: 20_000 } },
		} });
		runtime.observe({ type: "assistant", source, message: { role: "assistant", summary: "saved", usage: assistant().usage } });
		const record = runtime.getRecord(1)!;
		expect(record).toMatchObject({ fidelity: "pi-preparation", apiLabel: "Pi Compaction Preparation", state: "complete", source });
		expect(record.sections.map((section) => section.label)).toEqual([
			"compaction instructions", "previous summary", "summarized messages", "retained turn prefix", "compaction options",
		]);
		expect(record.assistantJson).toContain('"summary": "saved"');
		expect(record.usage).toMatchObject({ input: 5, output: 3 });
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
