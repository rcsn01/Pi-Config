import { afterEach, describe, expect, it, vi } from "vitest";
import type { ParallelBatchSnapshot } from "./parallel-batch.ts";
import {
	createSubagentInvocationAdapter,
	type SubagentInvocationResult,
} from "./subagent-invocation.ts";
import { agentResult } from "./test-harness.ts";

afterEach(() => vi.useRealTimers());

describe("Subagent invocation adapter", () => {
	it("runs a single invocation as a one-task batch and adapts its result", async () => {
		const completed = agentResult({ agent: "worker", task: "Inspect code", output: "Evidence" });
		const runBatch = vi.fn(async () => [completed]);
		const adapter = createSubagentInvocationAdapter({ batch: { runBatch } });

		const result = await adapter.execute(
			{ tasks: [{ agent: "worker", task: "Inspect code", cwd: "/task" }] },
			{ cwd: "/workspace", cacheAffinitySeed: "session-123" },
		);

		expect(runBatch).toHaveBeenCalledWith(
			[{ agent: "worker", task: "Inspect code", cwd: "/task" }],
			expect.objectContaining({ cwd: "/workspace", cacheAffinitySeed: "session-123" }),
		);
		expect(result).toEqual({
			content: [{ type: "text", text: "Evidence" }],
			details: { mode: "single", results: [completed] },
		});
	});

	it("publishes single progress through immutable mode-specific updates", async () => {
		const first = agentResult({
			agent: "worker",
			task: "Inspect code",
			progress: { ...agentResult().progress, status: "running", lastMessage: "first" },
		});
		const second = agentResult({
			agent: "worker",
			task: "Inspect code",
			progress: { ...agentResult().progress, status: "running", lastMessage: "second" },
		});
		const completed = agentResult({ agent: "worker", task: "Inspect code" });
		const runBatch = vi.fn(async (_tasks, options) => {
			options.onSnapshot?.({ results: [first], changedIndex: 0, phase: "progress" });
			options.onSnapshot?.({ results: [second], changedIndex: 0, phase: "progress" });
			return [completed];
		});
		const adapter = createSubagentInvocationAdapter({ batch: { runBatch } });
		const updates: SubagentInvocationResult[] = [];

		await adapter.execute(
			{ tasks: [{ agent: "worker", task: "Inspect code" }] },
			{ cwd: "/workspace", onUpdate: (update) => updates.push(update) },
		);

		expect(updates.map((update) => update.content[0].text)).toEqual(["(running...)", "(running...)"]);
		expect(updates.map((update) => update.details.results[0].progress.lastMessage)).toEqual(["first", "second"]);
		expect(updates[0].details.results).not.toBe(updates[1].details.results);
	});

	it("adapts ordered parallel results and treats failed status as an error", async () => {
		const completed = agentResult({ agent: "worker", task: "first", output: "Done" });
		const failed = agentResult({
			agent: "explorer",
			task: "second",
			output: "Partial",
			exitCode: 0,
			progress: { ...agentResult().progress, agent: "explorer", status: "failed" },
		});
		const runBatch = vi.fn(async () => [completed, failed]);
		const adapter = createSubagentInvocationAdapter({ batch: { runBatch } });

		const result = await adapter.execute({
			tasks: [
				{ agent: "worker", task: "first" },
				{ agent: "explorer", task: "second", cwd: "/other" },
			],
		}, { cwd: "/workspace", maxConcurrency: 3 });

		expect(runBatch).toHaveBeenCalledWith(
			expect.arrayContaining([{ agent: "explorer", task: "second", cwd: "/other" }]),
			expect.objectContaining({ cwd: "/workspace", maxConcurrency: 3 }),
		);
		expect(result).toEqual({
			content: [{ type: "text", text: "## worker\n\nDone\n\n---\n\n## explorer (FAILED)\n\nPartial" }],
			details: { mode: "parallel", results: [completed, failed] },
			isError: true,
		});
	});

	it.each([
		["exit code", agentResult({ exitCode: 2 })],
		["failed status", agentResult({ progress: { ...agentResult().progress, status: "failed" } })],
		["progress error", agentResult({ progress: { ...agentResult().progress, error: "boom" } })],
	] as const)("applies the failure rule to a single result's %s", async (_label, failed) => {
		const adapter = createSubagentInvocationAdapter({
			batch: { runBatch: vi.fn(async () => [failed]) },
		});

		const result = await adapter.execute(
			{ tasks: [{ agent: "worker", task: "Inspect code" }] },
			{ cwd: "/workspace" },
		);

		expect(result.isError).toBe(true);
	});

	it("flushes terminal parallel progress and cancels a stale throttled update", async () => {
		vi.useFakeTimers();
		const started = agentResult({
			progress: { ...agentResult().progress, status: "running", lastMessage: "started" },
		});
		const first = agentResult({
			progress: { ...agentResult().progress, status: "running", lastMessage: "first" },
		});
		const stale = agentResult({
			progress: { ...agentResult().progress, status: "running", lastMessage: "stale" },
		});
		const completed = agentResult({ output: "Done" });
		const runBatch = vi.fn(async (_tasks, options) => {
			options.onSnapshot?.({ results: [started], changedIndex: 0, phase: "started" });
			options.onSnapshot?.({ results: [first], changedIndex: 0, phase: "progress" });
			options.onSnapshot?.({ results: [stale], changedIndex: 0, phase: "progress" });
			options.onSnapshot?.({ results: [completed], changedIndex: 0, phase: "completed" });
			return [completed];
		});
		const adapter = createSubagentInvocationAdapter({ batch: { runBatch } });
		const updates: SubagentInvocationResult[] = [];

		await adapter.execute(
			{ tasks: [
				{ agent: "worker", task: "Inspect code" },
				{ agent: "explorer", task: "Inspect tests" },
			] },
			{ cwd: "/workspace", onUpdate: (update) => updates.push(update) },
		);
		await vi.runAllTimersAsync();

		expect(updates.map((update) => update.details.results[0].progress.lastMessage)).toEqual([
			"started",
			"first",
			completed.progress.lastMessage,
		]);
		expect(updates.every((update) => update.content[0].text === "Running 2 tasks...")).toBe(true);
	});

	it("cancels throttled progress when the batch rejects", async () => {
		vi.useFakeTimers();
		const first = agentResult({
			progress: { ...agentResult().progress, status: "running", lastMessage: "first" },
		});
		const stale = agentResult({
			progress: { ...agentResult().progress, status: "running", lastMessage: "stale" },
		});
		let publishLateSnapshot: ((snapshot: ParallelBatchSnapshot) => void) | undefined;
		const runBatch = vi.fn(async (_tasks, options) => {
			publishLateSnapshot = options.onSnapshot;
			options.onSnapshot?.({ results: [first], changedIndex: 0, phase: "progress" });
			options.onSnapshot?.({ results: [stale], changedIndex: 0, phase: "progress" });
			throw new Error("batch failed");
		});
		const adapter = createSubagentInvocationAdapter({ batch: { runBatch } });
		const updates: SubagentInvocationResult[] = [];

		await expect(adapter.execute(
			{ tasks: [
				{ agent: "worker", task: "Inspect code" },
				{ agent: "explorer", task: "Inspect tests" },
			] },
			{ cwd: "/workspace", onUpdate: (update) => updates.push(update) },
		)).rejects.toThrow("batch failed");
		publishLateSnapshot?.({ results: [stale], changedIndex: 0, phase: "started" });
		publishLateSnapshot?.({ results: [stale], changedIndex: 0, phase: "progress" });
		await vi.runAllTimersAsync();

		expect(updates.map((update) => update.details.results[0].progress.lastMessage)).toEqual(["first"]);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("rejects an empty task list", async () => {
		const runBatch = vi.fn();
		const adapter = createSubagentInvocationAdapter({ batch: { runBatch } });

		await expect(adapter.execute({ tasks: [] }, { cwd: "/workspace" }))
			.rejects.toThrow("Provide at least one subagent task");
		expect(runBatch).not.toHaveBeenCalled();
	});
});
