import { describe, expect, it } from "vitest";
import type { GoalState } from "./goal-state.ts";
import {
	DEFAULT_GOAL_RUNTIME_CONFIG,
	decideGoalContinuation,
	finalizeAutomaticRun,
	reconstructGoalRuntime,
	recordContinuationRequested,
	recordGoalTurn,
	runtimeLines,
	startAutomaticRun,
} from "./goal-runtime.ts";

function goal(overrides: Partial<GoalState> = {}): GoalState {
	return {
		goalId: "goal-1",
		objective: "Ship",
		status: "active",
		createdAt: 1,
		updatedAt: 1,
		...overrides,
	};
}

function runtime(overrides: Record<string, number | string> = {}) {
	return {
		goalId: "goal-1",
		continuationRuns: 0,
		consecutiveNoProgressRuns: 0,
		consecutiveFailureRuns: 0,
		updatedAt: 1,
		...overrides,
	};
}

function assistant(stopReason = "stop") {
	return { role: "assistant", stopReason };
}

function result(toolName: string, isError = false, details?: unknown) {
	return { toolName, isError, details };
}

describe("goal runtime reconstruction", () => {
	it("selects the latest valid matching entry and ignores other goals and malformed counters", () => {
		const entries = [
			{ type: "custom", customType: "goal-runtime", data: runtime({ continuationRuns: 2 }) },
			{ type: "custom", customType: "goal-runtime", data: runtime({ goalId: "other", continuationRuns: 9 }) },
			{ type: "custom", customType: "goal-runtime", data: runtime({ continuationRuns: -1 }) },
			{ type: "custom", customType: "goal-runtime", data: runtime({ continuationRuns: 3 }) },
		];
		expect(reconstructGoalRuntime(entries, "goal-1", 10)).toEqual(runtime({ continuationRuns: 3 }));
	});

	it("initializes zero counters when no matching entry exists", () => {
		expect(reconstructGoalRuntime([], "goal-1", 10)).toEqual({
			goalId: "goal-1",
			continuationRuns: 0,
			consecutiveNoProgressRuns: 0,
			consecutiveFailureRuns: 0,
			updatedAt: 10,
		});
	});
});

describe("automatic goal run accounting", () => {
	it("aggregates several turns and finalizes once as progress", () => {
		let run = startAutomaticRun("goal-1");
		run = recordGoalTurn(run, { message: assistant("toolUse"), toolResults: [result("bash", true)] });
		run = recordGoalTurn(run, { message: assistant("stop"), toolResults: [result("read")] });
		const finalized = finalizeAutomaticRun(runtime({ consecutiveNoProgressRuns: 2, consecutiveFailureRuns: 2 }), run, 20);
		expect(finalized.classification).toBe("progress");
		expect(finalized.snapshot).toEqual(runtime({ updatedAt: 20 }));
	});

	it("counts a non-empty successful checkpoint but not goal status or empty checkpoint", () => {
		const checkpoint = result("goal", false, { action: "checkpoint", state: { checkpointProgress: "Tests pass" } });
		const empty = result("goal", false, { action: "checkpoint", state: { checkpointProgress: "" } });
		const status = result("goal", false, { action: "status" });
		expect(finalizeAutomaticRun(runtime(), recordGoalTurn(startAutomaticRun("goal-1"), {
			message: assistant(), toolResults: [checkpoint],
		}), 2).classification).toBe("progress");
		expect(finalizeAutomaticRun(runtime(), recordGoalTurn(startAutomaticRun("goal-1"), {
			message: assistant(), toolResults: [empty, status],
		}), 2).classification).toBe("no_progress");
	});

	it("classifies all failed execution attempts as failure and mixed results as progress", () => {
		const failed = recordGoalTurn(startAutomaticRun("goal-1"), {
			message: assistant(), toolResults: [result("bash", true), result("edit", true)],
		});
		expect(finalizeAutomaticRun(runtime(), failed, 2)).toMatchObject({
			classification: "failure",
			snapshot: { consecutiveNoProgressRuns: 1, consecutiveFailureRuns: 1 },
		});

		const mixed = recordGoalTurn(startAutomaticRun("goal-1"), {
			message: assistant(), toolResults: [result("bash", true), result("read", false)],
		});
		expect(finalizeAutomaticRun(runtime({ consecutiveNoProgressRuns: 2, consecutiveFailureRuns: 2 }), mixed, 2))
			.toMatchObject({ classification: "progress", snapshot: { consecutiveNoProgressRuns: 0, consecutiveFailureRuns: 0 } });
	});

	it("records terminal error, length, and abort stop reasons", () => {
		for (const stopReason of ["error", "length", "aborted"] as const) {
			const run = recordGoalTurn(startAutomaticRun("goal-1"), { message: assistant(stopReason), toolResults: [] });
			expect(finalizeAutomaticRun(runtime(), run, 2).terminalStopReason).toBe(stopReason);
		}
	});
});

describe("goal runtime formatting", () => {
	it("formats the shared runtime lines for command and tool output", () => {
		expect(runtimeLines(null)).toEqual([]);
		expect(runtimeLines(runtime({ continuationRuns: 2, consecutiveNoProgressRuns: 1, consecutiveFailureRuns: 2 }))).toEqual([
			"Continuation runs: 2/30",
			"Consecutive no-progress runs: 1",
			"Consecutive failure runs: 2",
		]);
	});
});

describe("goal continuation decisions", () => {
	it("continues an active matching goal below every limit", () => {
		expect(decideGoalContinuation(goal(), runtime(), DEFAULT_GOAL_RUNTIME_CONFIG)).toEqual({ action: "continue" });
	});

	it.each([null, "paused", "blocked", "completed", "budget_limited", "cleared"] as const)(
		"skips missing and non-active goal %s",
		(status) => {
			const state = status === null ? null : goal({ status, objective: status === "cleared" ? "" : "Ship" });
			expect(decideGoalContinuation(state, runtime(), DEFAULT_GOAL_RUNTIME_CONFIG).action).toBe("skip");
		},
	);

	it("skips a mismatched runtime", () => {
		expect(decideGoalContinuation(goal(), runtime({ goalId: "other" }), DEFAULT_GOAL_RUNTIME_CONFIG)).toEqual({
			action: "skip",
			reason: "stale-goal",
		});
	});

	it("permits continuation 30 and stops before continuation 31", () => {
		const at29 = runtime({ continuationRuns: 29 });
		expect(decideGoalContinuation(goal(), at29, DEFAULT_GOAL_RUNTIME_CONFIG).action).toBe("continue");
		expect(recordContinuationRequested(at29, 2).continuationRuns).toBe(30);
		expect(decideGoalContinuation(goal(), runtime({ continuationRuns: 30 }), DEFAULT_GOAL_RUNTIME_CONFIG)).toEqual({
			action: "stop",
			status: "budget_limited",
			reason: "Continuation limit reached (30 runs).",
		});
	});

	it("blocks at the no-progress and failure boundaries", () => {
		expect(decideGoalContinuation(goal(), runtime({ consecutiveNoProgressRuns: 3 }), DEFAULT_GOAL_RUNTIME_CONFIG))
			.toEqual({ action: "stop", status: "blocked", reason: "No meaningful progress in three consecutive automatic runs." });
		expect(decideGoalContinuation(goal(), runtime({ consecutiveFailureRuns: 3 }), DEFAULT_GOAL_RUNTIME_CONFIG))
			.toEqual({ action: "stop", status: "blocked", reason: "Execution failed in three consecutive automatic runs." });
	});
});
