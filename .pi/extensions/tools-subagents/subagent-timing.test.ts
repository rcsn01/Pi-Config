import { describe, expect, it } from "vitest";
import { createSubagentTimingRecorder } from "./subagent-timing.ts";

describe("subagent timing recorder", () => {
	it("partitions wall time without double-counting concurrent or model-overlapping tools", () => {
		let now = 0;
		const timing = createSubagentTimingRecorder(() => now);
		const record = (event: Record<string, unknown>, at: number) => {
			now = at;
			timing.recordEvent(event);
		};

		record({ type: "agent_start" }, 10);
		record({ type: "turn_start" }, 20);
		record({ type: "tool_execution_start", toolCallId: "repo", toolName: "repo_query" }, 30);
		record({
			type: "tool_execution_end",
			toolCallId: "repo",
			result: { details: { operations: [{}, {}, {}] } },
		}, 50);
		record({ type: "message_end", message: { role: "assistant" } }, 80);
		record({ type: "tool_execution_start", toolCallId: "a", toolName: "read" }, 90);
		record({ type: "tool_execution_start", toolCallId: "b", toolName: "read" }, 100);
		record({ type: "tool_execution_end", toolCallId: "b" }, 120);
		record({ type: "tool_execution_end", toolCallId: "a" }, 130);
		record({ type: "agent_end" }, 140);
		now = 150;

		expect(timing.finish()).toEqual({
			totalMs: 150,
			startupMs: 10,
			modelPhaseMs: 40,
			toolWallMs: 60,
			repoQueryWallMs: 20,
			unclassifiedMs: 40,
			repositoryQueries: 1,
			repositoryOperations: 3,
			partial: false,
			anomalyCount: 0,
		});
	});

	it("closes unfinished intervals at settlement and marks incomplete streams partial", () => {
		let now = 0;
		const timing = createSubagentTimingRecorder(() => now);
		now = 10;
		timing.recordEvent({ type: "turn_start" });
		now = 20;
		timing.recordEvent({ type: "tool_execution_start", toolCallId: "repo", toolName: "repo_query" });
		now = 100;

		expect(timing.finish()).toEqual({
			totalMs: 100,
			startupMs: undefined,
			modelPhaseMs: 10,
			toolWallMs: 80,
			repoQueryWallMs: 80,
			unclassifiedMs: 10,
			repositoryQueries: 1,
			repositoryOperations: 0,
			partial: true,
			anomalyCount: 2,
		});
	});

	it("ignores malformed events and records duplicate or unmatched pairs as anomalies", () => {
		let now = 0;
		const timing = createSubagentTimingRecorder(() => now);
		timing.recordEvent("not an event");
		now = 5;
		timing.recordEvent({ type: "agent_start" });
		now = 6;
		timing.recordEvent({ type: "agent_start" });
		now = 7;
		timing.recordEvent({ type: "tool_execution_end", toolCallId: "missing" });
		now = 8;
		timing.recordEvent({ type: "agent_end" });
		now = 10;

		const result = timing.finish();
		expect(result).toMatchObject({
			totalMs: 10,
			startupMs: 5,
			partial: true,
			anomalyCount: 2,
		});
		expect(result.startupMs! + result.modelPhaseMs + result.toolWallMs + result.unclassifiedMs).toBe(10);
	});
});
