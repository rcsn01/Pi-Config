import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentProgress, AgentResult, SubagentProgressEvent } from "../_shared/subagent-service.ts";
import { createSubagentChildEventIngestion, type SubagentChildProcessOutcome } from "./child-event-ingestion.ts";

function line(event: unknown): string {
	return `${JSON.stringify(event)}\n`;
}

function createRecorder(overrides: Partial<Parameters<typeof createSubagentChildEventIngestion>[0]> = {}) {
	const events: SubagentProgressEvent[] = [];
	const updates: AgentProgress[] = [];
	const ingestion = createSubagentChildEventIngestion({
		agentName: "worker",
		task: "inspect",
		model: "openai/launch",
		...overrides,
		onProgress: (event) => { events.push(event); },
		onUpdate: (progress) => { updates.push(structuredClone(progress)); },
	});
	return { ingestion, events, updates };
}

async function finish(
	ingestion: ReturnType<typeof createSubagentChildEventIngestion>,
	outcome: Partial<SubagentChildProcessOutcome> = {},
): Promise<AgentResult> {
	return ingestion.finish({ exitCode: 0, stderr: "", ...outcome });
}

afterEach(() => {
	vi.useRealTimers();
});

describe("Subagent child event ingestion", () => {
	it("frames split and trailing records while ignoring blank and malformed lines", async () => {
		const { ingestion, events } = createRecorder();
		const first = line({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "one " } });
		ingestion.write(Buffer.from(first.slice(0, 17)));
		ingestion.write(first.slice(17) + "\nnot-json\n" + line({ type: "unknown" }));
		ingestion.write(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "two" } }));

		const result = await finish(ingestion);

		expect(result.output).toBe("one two");
		expect(result.progress.status).toBe("completed");
		expect(events.filter((event) => event.type === "message").map((event) => event.message)).toEqual(["one", "one two"]);
	});

	it("resets streamed text at message start and preserves partial output without a final message", async () => {
		const { ingestion } = createRecorder();
		ingestion.write(line({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "discarded" } }));
		ingestion.write(line({ type: "message_start", message: { role: "assistant" } }));
		ingestion.write(line({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Partial " } }));
		ingestion.write(line({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "answer" } }));

		expect((await finish(ingestion)).output).toBe("Partial answer");
	});

	it("handles full, empty, and array assistant content", async () => {
		const { ingestion, events } = createRecorder();
		ingestion.write([
			line({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Partial answer" } }),
			line({ type: "message_update", message: { role: "assistant", content: "Full answer" }, assistantMessageEvent: { type: "text_delta", delta: " ignored" } }),
			line({ type: "message_end", message: { role: "assistant", content: "" } }),
		].join(""));
		const first = await finish(ingestion);
		expect(first.output).toBe("Full answer");

		const secondRecorder = createRecorder();
		secondRecorder.ingestion.write(line({
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "First" }, { type: "image", data: "ignored" }, { type: "text", text: "Second" }],
			},
		}));
		const second = await finish(secondRecorder.ingestion);
		expect(second.output).toBe("First\nSecond");
		expect(events.some((event) => event.type === "message" && event.message.includes("ignored"))).toBe(false);
	});

	it("builds prose previews without fenced code and deduplicates identical messages", async () => {
		const { ingestion, events } = createRecorder();
		const content = " One \n```ts\nconst hidden = true;\n```\nTwo\nThree\nFour";
		ingestion.write(line({ type: "message_update", message: { role: "assistant", content } }));
		ingestion.write(line({ type: "message_end", message: { role: "assistant", content } }));

		const result = await finish(ingestion);
		const messages = events.filter((event) => event.type === "message");
		expect(result.progress.lastMessage).toBe("One Two Three");
		expect(messages).toHaveLength(1);
		expect(messages[0]).toMatchObject({ message: "One Two Three" });
	});

	it("tracks tool progress, deduplicates calls, and keeps the newest 20 results", async () => {
		const { ingestion, events, updates } = createRecorder();
		for (let index = 0; index < 22; index++) {
			const start = { type: "tool_execution_start", toolName: "read", args: { path: `file-${index}` } };
			ingestion.write(line(start));
			if (index === 0) ingestion.write(line(start));
			ingestion.write(line({ type: "tool_execution_end" }));
		}
		ingestion.write(line({ type: "tool_result_end" }));

		const result = await finish(ingestion);
		const calls = events.filter((event) => event.type === "tool_call");
		const toolResults = events.filter((event) => event.type === "tool_result");
		expect(result.progress.toolCount).toBe(23);
		expect(calls).toHaveLength(22);
		expect(toolResults).toHaveLength(22);
		expect(result.progress.recentTools).toHaveLength(20);
		expect(result.progress.recentTools[0]).toEqual({ tool: "read", args: "file-2" });
		expect(result.progress.currentTool).toBeUndefined();
		expect(updates.length).toBeGreaterThan(0);
	});

	it("requests updates for tool starts, ends, and result completion", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(1_000);
		const { ingestion, updates } = createRecorder();
		ingestion.write(line({ type: "tool_execution_start", toolName: "read", args: { path: "file.ts" } }));
		expect(updates).toHaveLength(1);
		expect(updates[0]).toMatchObject({ toolCount: 1, currentTool: "read", currentToolArgs: "file.ts" });

		ingestion.write(line({ type: "tool_execution_end" }));
		await vi.advanceTimersByTimeAsync(150);
		expect(updates).toHaveLength(2);
		expect(updates[1]).toMatchObject({ recentTools: [{ tool: "read", args: "file.ts" }] });
		expect(updates[1].currentTool).toBeUndefined();

		ingestion.write(line({ type: "tool_result_end" }));
		await vi.advanceTimersByTimeAsync(150);
		expect(updates).toHaveLength(3);
		await finish(ingestion);
	});

	it("accumulates assistant usage and adopts the latest reported model", async () => {
		const { ingestion } = createRecorder();
		ingestion.write(line({
			type: "message_end",
			message: { role: "assistant", model: "openai/first", content: "one", usage: { input: 10, output: 2, cacheRead: 3, cacheWrite: 1, cost: { total: 0.2 } } },
		}));
		ingestion.write(line({
			type: "message_end",
			message: { role: "assistant", model: "openai/second", content: "two", usage: { input: 4, output: 5, cacheRead: 2, cacheWrite: 6, cost: { total: 0.3 } } },
		}));

		const result = await finish(ingestion);
		expect(result.model).toBe("openai/second");
		expect(result.usage).toEqual({ input: 14, output: 7, cacheRead: 5, cacheWrite: 7, cost: 0.5, turns: 2 });
		expect(result.progress.tokens).toBe(21);

		const noModel = createRecorder();
		noModel.ingestion.write(line({ type: "message_end", message: { role: "assistant", content: "done" } }));
		expect((await finish(noModel.ingestion)).model).toBe("openai/launch");
	});

	it.each([
		{
			name: "completes on a clean zero exit",
			outcome: { exitCode: 0, stderr: "" },
			status: "completed",
			output: "answer",
			error: undefined,
		},
		{
			name: "uses stderr for a nonzero exit",
			outcome: { exitCode: 2, stderr: " child failed \n" },
			status: "failed",
			output: "answer",
			error: "child failed",
		},
		{
			name: "uses a process error and output fallback",
			outcome: { exitCode: 1, stderr: "stderr", processError: "process failed" },
			status: "failed",
			output: "Error: process failed",
			error: "process failed",
			noAssistantOutput: true,
		},
		{
			name: "keeps an assistant error over process errors and stderr",
			outcome: { exitCode: 1, stderr: "stderr", processError: "process failed" },
			status: "failed",
			output: "answer",
			error: "assistant failed",
			assistantError: "assistant failed",
		},
		{
			name: "fails a nonzero exit without an error",
			outcome: { exitCode: 3, stderr: "" },
			status: "failed",
			output: "answer",
			error: undefined,
		},
		{
			name: "ignores stderr on a zero exit",
			outcome: { exitCode: 0, stderr: "warning" },
			status: "completed",
			output: "answer",
			error: undefined,
		},
	])("$name", async ({ outcome, status, output, error, noAssistantOutput, assistantError }) => {
		const { ingestion, events } = createRecorder();
		if (!noAssistantOutput) {
			ingestion.write(line({
				type: assistantError ? "message_update" : "message_end",
				message: { role: "assistant", content: "answer", errorMessage: assistantError },
			}));
		}
		const result = await finish(ingestion, outcome);
		const terminal = events.at(-1)!;

		expect(result.progress.status).toBe(status);
		expect(result.progress.error).toBe(error);
		expect(result.output).toBe(output);
		expect(terminal.type).toBe(status === "completed" ? "completed" : "failed");
		if (terminal.type === "completed" || terminal.type === "failed") expect(terminal.result).toBe(result);
		if (terminal.type === "failed") expect(terminal.error).toBe(error || output || "Subagent worker failed");
	});

	it("applies message-end errors even when the child exits successfully", async () => {
		for (const eventType of ["message_update", "message_end"]) {
			const { ingestion } = createRecorder();
			ingestion.write(line({ type: eventType, message: { role: "assistant", content: "partial", errorMessage: `${eventType} failed` } }));
			const result = await finish(ingestion);
			expect(result.progress).toMatchObject({ status: "failed", error: `${eventType} failed` });
		}
	});

	it("records original bytes and truncates only oversized output", async () => {
		const long = createRecorder({ agentName: "worker", task: "inspect", model: "openai/launch", maxOutputBytes: 10 });
		long.ingestion.write(line({ type: "message_end", message: { role: "assistant", content: "abc\ndef\nghi\njkl" } }));
		const truncated = await finish(long.ingestion);
		expect(truncated).toMatchObject({ originalOutputBytes: 15, truncated: true });
		expect(truncated.output).toBe("abc\ndef\n\n[Output truncated]");

		const short = createRecorder({ agentName: "worker", task: "inspect", model: "openai/launch", maxOutputBytes: 100 });
		short.ingestion.write(line({ type: "message_end", message: { role: "assistant", content: "short" } }));
		expect(await finish(short.ingestion)).toMatchObject({ output: "short", originalOutputBytes: 5 });
	});

	it("feeds complete lifecycle events to the timing recorder", async () => {
		const { ingestion } = createRecorder();
		ingestion.write([
			line({ type: "agent_start" }),
			line({ type: "turn_start" }),
			line({ type: "message_end", message: { role: "assistant", content: "done" } }),
			line({ type: "agent_end" }),
		].join(""));
		const result = await finish(ingestion);
		expect(result.timing).toMatchObject({ partial: false, anomalyCount: 0 });
	});

	it("runs the first update immediately, coalesces later updates, and cancels pending work at finish", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(1_000);
		const { ingestion, updates } = createRecorder();
		const update = line({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "x" } });

		ingestion.write(update);
		expect(updates).toHaveLength(1);
		ingestion.write(update);
		ingestion.write(update);
		expect(updates).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(149);
		expect(updates).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(updates).toHaveLength(2);
		ingestion.write(update);
		await finish(ingestion);
		await vi.advanceTimersByTimeAsync(500);
		expect(updates).toHaveLength(2);
	});
});
