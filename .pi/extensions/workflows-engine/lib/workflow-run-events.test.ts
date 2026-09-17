import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentResult, SubagentProgressEvent } from "../../_shared/subagent-service.ts";
import {
	applyWorkflowRunEvent,
	rebuildWorkflowRunState,
	type KnownWorkflowRunEvent,
	type WorkflowRunEventView,
} from "./workflow-run-events.ts";
import type { RunState } from "./workflow-run-state.ts";

const runCreated = (overrides: Record<string, unknown> = {}): WorkflowRunEventView => ({
	type: "run_created",
	ts: 1,
	runId: "run-1",
	workflowName: "demo",
	trust: "bundled",
	args: "args",
	sourceHash: "hash",
	description: "description",
	costShape: "quick",
	...overrides,
});

const stateFrom = (...events: WorkflowRunEventView[]): RunState => rebuildWorkflowRunState([runCreated(), ...events]);

const rawResult = (usage: Partial<AgentResult["usage"]> = {}): AgentResult => ({
	agent: "worker",
	task: "task",
	output: "done",
	exitCode: 0,
	progress: { agent: "worker", status: "completed", task: "task", recentTools: [], toolCount: 0, tokens: 0, durationMs: 0, lastMessage: "done" },
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0, ...usage },
});

afterEach(() => vi.restoreAllMocks());

describe("Workflow run event creation and ordering", () => {
	it("creates the full initial state and applies the event timestamp", () => {
		const state = rebuildWorkflowRunState([runCreated({ sourceSnapshotPath: "/snapshot", canEditFiles: true, ts: 12 })]);
		expect(state).toMatchObject({
			runId: "run-1", workflowName: "demo", trust: "bundled", args: "args", sourceHash: "hash",
			description: "description", costShape: "quick", sourceSnapshotPath: "/snapshot", canEditFiles: true,
			status: "created", startedAt: 12, updatedAt: 12, agentsStarted: 0, agentsRunning: 0,
			usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, turns: 0, cost: 0 },
		});
		expect(state.steps).toEqual({});
		expect(state.agents).toEqual({});
	});

	it("resets accumulated state on a later run_created", () => {
		const state = rebuildWorkflowRunState([
			runCreated(),
			{ type: "step_started", key: "old", ts: 2 },
			runCreated({ runId: "run-2", workflowName: "replacement", ts: 9 }),
		]);
		expect(state).toMatchObject({ runId: "run-2", workflowName: "replacement", startedAt: 9, updatedAt: 9 });
		expect(state.steps).toEqual({});
	});

	it("replaces state for creation and mutates state for later events", () => {
		const prior = stateFrom({ type: "step_started", key: "kept", ts: 2 });
		const replacement = applyWorkflowRunEvent(prior, runCreated({ runId: "new", ts: 3 }));
		expect(replacement).not.toBe(prior);
		expect(prior.steps.kept).toBeDefined();
		const mutated = applyWorkflowRunEvent(replacement, { type: "run_started", ts: 4 });
		expect(mutated).toBe(replacement);
	});

	it("preserves creation clock calls before overriding timestamps", () => {
		const now = vi.spyOn(Date, "now").mockReturnValue(50);
		applyWorkflowRunEvent(undefined, runCreated({ ts: 4 }));
		expect(now).toHaveBeenCalledTimes(1);
		now.mockClear();
		const state = applyWorkflowRunEvent(undefined, runCreated({ ts: 0 }));
		expect(now).toHaveBeenCalledTimes(2);
		expect(state.startedAt).toBe(50);
	});

	it("rejects every event class before creation and empty replay", () => {
		expect(() => applyWorkflowRunEvent(undefined, { type: "run_started", ts: 1 })).toThrow("Cannot apply run_started before run_created");
		expect(() => applyWorkflowRunEvent(undefined, { type: "future", ts: 1 })).toThrow("Cannot apply future before run_created");
		expect(() => applyWorkflowRunEvent(undefined, { type: "", ts: 1 })).toThrow("Cannot apply  before run_created");
		expect(() => rebuildWorkflowRunState([])).toThrow("Workflow event log is empty");
	});

	it("applies order-sensitive transitions in input order", () => {
		const state = stateFrom(
			{ type: "step_started", key: "step", ts: 2 },
			{ type: "step_completed", key: "step", result: 1, ts: 3 },
			{ type: "invalidated", key: "step", ts: 4 },
			{ type: "step_completed", key: "step", result: 2, ts: 5 },
			{ type: "run_failed", error: "old", ts: 6 },
			{ type: "run_completed", result: "done", ts: 7 },
		);
		expect(state.steps.step).toEqual({ status: "completed", result: 2, updatedAt: 5 });
		expect(state.invalidatedKeys).toEqual([]);
		expect(state).toMatchObject({ status: "completed", error: "old", result: "done", updatedAt: 7 });
	});
});

describe("run and phase transitions", () => {
	it("preserves each run transition's clearing and retention behavior", () => {
		let state = stateFrom({ type: "run_completed", result: "kept", ts: 2 });
		state.error = "old";
		state = applyWorkflowRunEvent(state, { type: "run_started", ts: 3 });
		expect(state).toMatchObject({ status: "running", result: "kept" });
		expect(state.error).toBeUndefined();
		expect(state.completedAt).toBeUndefined();
		state = applyWorkflowRunEvent(state, { type: "run_pausing", mode: "now", ts: 4 });
		expect(state).toMatchObject({ status: "pausing", result: "kept" });
		state = applyWorkflowRunEvent(state, { type: "run_paused", error: "", ts: 5 });
		expect(state).toMatchObject({ status: "paused", completedAt: 5, result: "kept" });
		expect(state.error).toBeUndefined();
		state = applyWorkflowRunEvent(state, { type: "run_resumed", ts: 6 });
		expect(state).toMatchObject({ status: "running", result: "kept" });
		state = applyWorkflowRunEvent(state, { type: "run_failed", error: "", ts: 7 });
		expect(state).toMatchObject({ status: "failed", error: "Workflow failed", completedAt: 7, result: "kept" });
		state = applyWorkflowRunEvent(state, { type: "run_stopped", error: "", ts: 8 });
		expect(state).toMatchObject({ status: "stopped", error: "Workflow stopped", completedAt: 8, result: "kept" });
	});

	it("replaces phase state while retaining currentPhase", () => {
		const state = stateFrom(
			{ type: "phase_started", name: "one", ts: 2 },
			{ type: "phase_completed", name: "one", ts: 3 },
			{ type: "phase_failed", name: "two", error: "", ts: 4 },
		);
		expect(state.currentPhase).toBe("one");
		expect(state.phases).toEqual({
			one: { status: "completed", updatedAt: 3 },
			two: { status: "failed", error: "Phase failed", updatedAt: 4 },
		});
	});
});

describe("step, dependency, and invalidation transitions", () => {
	it("stores payloads, deduplicates edges, and retains stale reverse edges", () => {
		const dependsOn = ["a", "a"];
		const metadata = { owner: "test" };
		let state = stateFrom({ type: "step_started", key: "step", dependsOn, metadata, ts: 2 });
		expect(state.steps.step).toEqual({ status: "running", updatedAt: 2, dependsOn, metadata });
		expect(state.steps.step.dependsOn).toBe(dependsOn);
		expect(state.dependencies.a).toEqual(["step"]);
		state = applyWorkflowRunEvent(state, { type: "step_started", key: "step", dependsOn: ["b"], ts: 3 });
		expect(state.dependencies).toEqual({ a: ["step"], b: ["step"] });
	});

	it("retains permissive dependsOn behavior", () => {
		expect(stateFrom({ type: "step_started", key: "step", dependsOn: "ab", ts: 2 } as WorkflowRunEventView).dependencies)
			.toEqual({ a: ["step"], b: ["step"] });
		expect(() => stateFrom({ type: "step_started", key: "step", dependsOn: 1, ts: 2 })).toThrow(TypeError);
	});

	it("replaces on completion, merges on failure, and handles absent targets", () => {
		let state = stateFrom({ type: "step_started", key: "step", dependsOn: ["a"], metadata: { x: 1 }, ts: 2 });
		state = applyWorkflowRunEvent(state, { type: "step_failed", key: "step", error: "bad", ts: 3 });
		expect(state.steps.step).toMatchObject({ status: "failed", error: "bad", dependsOn: ["a"], metadata: { x: 1 } });
		state = applyWorkflowRunEvent(state, { type: "step_completed", key: "step", result: 1, ts: 4 });
		expect(state.steps.step).toEqual({ status: "completed", result: 1, updatedAt: 4 });
		state = applyWorkflowRunEvent(state, { type: "step_failed", key: "missing", error: "", ts: 5 });
		expect(state.steps.missing).toEqual({ status: "failed", error: "Step failed", updatedAt: 5 });
	});

	it("updates reuse targets only and invalidates targets without their timestamps", () => {
		let state = stateFrom({ type: "step_started", key: "step", ts: 2 });
		state = applyWorkflowRunEvent(state, { type: "step_reused", key: "missing", ts: 3 });
		expect(state.updatedAt).toBe(3);
		expect(state.steps.missing).toBeUndefined();
		state = applyWorkflowRunEvent(state, { type: "step_reused", key: "step", ts: 4 });
		expect(state.steps.step.updatedAt).toBe(4);
		state = applyWorkflowRunEvent(state, { type: "invalidated", key: "step", root: "step", ts: 5 });
		state = applyWorkflowRunEvent(state, { type: "dependency_invalidated", key: "step", root: "root", ts: 6 });
		expect(state.steps.step).toMatchObject({ status: "invalidated", updatedAt: 4 });
		expect(state.invalidatedKeys).toEqual(["step"]);
		state = applyWorkflowRunEvent(state, { type: "invalidated", key: "absent", root: "absent", ts: 7 });
		expect(state.invalidatedKeys).toEqual(["step", "absent"]);
	});
});

describe("agent transitions and usage", () => {
	it("counts repeated starts and stores only the last 50 progress records", () => {
		let state = stateFrom({ type: "agent_started", key: "agent", agent: "worker", prompt: "one", ts: 2 });
		state = applyWorkflowRunEvent(state, { type: "agent_started", key: "agent", agent: "worker", prompt: "two", ts: 3 });
		expect(state).toMatchObject({ agentsStarted: 2, agentsRunning: 2 });
		for (let index = 0; index < 51; index++) {
			state = applyWorkflowRunEvent(state, { type: "agent_progress", key: "agent", event: { index }, ts: 10 + index });
		}
		expect(state.agents.agent.progress).toHaveLength(50);
		expect(state.agents.agent.progress?.[0]).toEqual({ index: 1 });
		state = applyWorkflowRunEvent(state, { type: "agent_tool", key: "agent", event: { ignored: true }, tool: "read", args: "file", ts: 100 });
		expect(state.agents.agent.progress?.at(-1)).toEqual({ type: "tool", tool: "read", args: "file" });
	});

	it("ignores progress and reuse for absent agents except for global time", () => {
		let state = stateFrom();
		state = applyWorkflowRunEvent(state, { type: "agent_progress", key: "missing", event: { value: 1 }, ts: 2 });
		state = applyWorkflowRunEvent(state, { type: "agent_tool", key: "missing", tool: "read", ts: 3 });
		state = applyWorkflowRunEvent(state, { type: "agent_reused", key: "missing", agent: "ignored", ts: 4 });
		expect(state.agents).toEqual({});
		expect(state.updatedAt).toBe(4);
	});

	it("merges completion and failure, floors running, and counts repeats", () => {
		const raw = rawResult({ input: 2, output: 3, cacheRead: 4, cacheWrite: 5, turns: 1, cost: 0.5 });
		let state = stateFrom({ type: "agent_failed", key: "agent", agent: "worker", error: "old", stopped: false, ts: 2 });
		state = applyWorkflowRunEvent(state, { type: "agent_completed", key: "agent", agent: "worker", result: "done", raw, usage: raw.usage, ts: 3 });
		expect(state).toMatchObject({ agentsFailed: 1, agentsCompleted: 1, agentsRunning: 0, tokens: 5, cost: 0.5 });
		expect(state.agents.agent).toMatchObject({ status: "completed", error: "old", result: "done", raw });
		state = applyWorkflowRunEvent(state, { type: "agent_completed", key: "agent", agent: "worker", result: "again", raw, usage: raw.usage, ts: 4 });
		expect(state).toMatchObject({ agentsCompleted: 2, agentsRunning: 0, tokens: 10, cost: 1 });
		state = applyWorkflowRunEvent(state, { type: "agent_failed", key: "agent", agent: "worker", error: "", stopped: true, ts: 5 });
		expect(state.agents.agent).toMatchObject({ status: "stopped", error: "Agent failed", result: "again", raw });
	});

	it("supports legacy usage aliases and current-name truthiness fallback", () => {
		const state = stateFrom(
			{ type: "agent_completed", key: "legacy", agent: "worker", usage: { inputTokens: "2", outputTokens: 3, cacheReadTokens: 4, cacheWriteTokens: 5, turns: "1", cost: "0.25" }, ts: 2 },
			{ type: "agent_completed", key: "mixed", agent: "worker", usage: { input: 0, inputTokens: 7, output: -2, cacheRead: 1, cacheWrite: 2, turns: 2, cost: 0.5 }, ts: 3 },
		);
		expect(state.usage).toEqual({ inputTokens: 9, outputTokens: 1, cacheReadTokens: 5, cacheWriteTokens: 7, turns: 3, cost: 0.75 });
		expect(state.tokens).toBe(10);
	});

	it.each([undefined, null, false, 0, "truthy", []])("treats non-record usage %j permissively", (usage) => {
		const state = stateFrom({ type: "agent_completed", key: "agent", agent: "worker", usage, ts: 2 });
		expect(state.usage).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, turns: 0, cost: 0 });
	});
});

describe("parallel, artifact, log, and compatibility behavior", () => {
	it("replaces parallel starts and merges completion and failure", () => {
		let state = stateFrom({ type: "parallel_started", key: "p", count: "2", concurrency: -1, ts: 2 });
		expect(state.parallel.p).toEqual({ status: "running", count: 2, concurrency: -1, updatedAt: 2 });
		state.parallel.p.error = "stale";
		state = applyWorkflowRunEvent(state, { type: "parallel_completed", key: "p", count: 0, ts: 3 });
		expect(state.parallel.p).toEqual({ status: "completed", count: 0, concurrency: -1, error: "stale", updatedAt: 3 });
		state = applyWorkflowRunEvent(state, { type: "parallel_failed", key: "missing", error: "", ts: 4 });
		expect(state.parallel.missing).toEqual({ status: "failed", error: "Parallel block failed", updatedAt: 4 });
	});

	it("deduplicates converted artifacts and preserves log details", () => {
		const details = { nested: { value: 1 } };
		const state = stateFrom(
			{ type: "artifact_written", path: 1, ts: 2 },
			{ type: "artifact_written", path: "1", ts: 3 },
			{ type: "log", message: false, details, ts: 4 },
		);
		expect(state.artifacts).toEqual(["1"]);
		expect(state.logs).toEqual([{ message: "", details, ts: 4 }]);
		expect(state.logs[0].details).toBe(details);
	});

	it("preserves run_created legacy fallbacks and pass-through values", () => {
		const state = rebuildWorkflowRunState([runCreated({
			workflowName: "", workflow: "legacy", trust: "", args: 0, sourceHash: false,
			description: null, costShape: "", sourceSnapshotPath: 5, canEditFiles: "yes",
		})]);
		expect(state).toMatchObject({ workflowName: "legacy", trust: "project", args: "", sourceHash: "", description: "", costShape: "unknown", sourceSnapshotPath: 5, canEditFiles: "yes" });
		expect(rebuildWorkflowRunState([runCreated({ workflowName: "current", workflow: "legacy" })]).workflowName).toBe("current");
	});

	it("keeps unknown names and fields while changing only global time", () => {
		const state = stateFrom({ type: "", ts: 2, future: { nested: true } });
		const before = { ...state, updatedAt: 1 };
		expect(state).toEqual({ ...before, updatedAt: 2 });
		applyWorkflowRunEvent(state, { type: "future", ts: 3, another: true });
		expect(state.updatedAt).toBe(3);
		expect("future" in state).toBe(false);
	});

	it.each([
		[undefined, 100], [null, 100], [0, 100], [false, 100], ["", 100], ["12", 12], [-2, -2], ["bad", Number.NaN],
	])("preserves timestamp conversion for %j", (ts, expected) => {
		vi.spyOn(Date, "now").mockReturnValue(100);
		const state = stateFrom({ type: "future", ts } as WorkflowRunEventView);
		if (Number.isNaN(expected)) expect(state.updatedAt).toBeNaN();
		else expect(state.updatedAt).toBe(expected);
	});

	it("preserves nonnumeric usage and parallel conversion as NaN", () => {
		const usage = stateFrom({ type: "agent_completed", key: "agent", agent: "worker", usage: { input: "bad" }, ts: 2 });
		expect(usage.usage.inputTokens).toBeNaN();
		const parallel = stateFrom({ type: "parallel_started", key: "p", count: "bad", concurrency: "bad", ts: 2 });
		expect(parallel.parallel.p.count).toBeNaN();
		expect(parallel.parallel.p.concurrency).toBeNaN();
	});
});

// Compile-time checks for the closed write vocabulary and open durable view.
const validNoPayload = { type: "run_started" } satisfies KnownWorkflowRunEvent;
const validOptional = { type: "run_paused" } satisfies KnownWorkflowRunEvent;
const validAgent = {
	type: "agent_progress", key: "agent", event: { type: "started", agent: "worker", task: "task" } satisfies SubagentProgressEvent,
} satisfies KnownWorkflowRunEvent;
const openFuture = { type: "future_event", future: { value: true } } satisfies WorkflowRunEventView;
void [validNoPayload, validOptional, validAgent, openFuture];
// @ts-expect-error Unknown engine event names are rejected.
const invalidName: KnownWorkflowRunEvent = { type: "future_event" };
// @ts-expect-error Required payload fields cannot be omitted.
const missingField: KnownWorkflowRunEvent = { type: "step_completed", key: "step" };
// @ts-expect-error Payload fields cannot be attached to another event family.
const wrongFamily: KnownWorkflowRunEvent = { type: "step_reused", key: "step", name: "phase" };
// @ts-expect-error No-payload events reject accidental fields.
const extraNoPayload: KnownWorkflowRunEvent = { type: "run_started", result: "wrong" };
void [invalidName, missingField, wrongFamily, extraNoPayload];
