import { describe, expect, it } from "vitest";
import {
	checkpointGoal,
	clearGoal,
	completeGoal,
	editGoal,
	GOAL_CUSTOM_TYPE,
	MAX_OBJECTIVE_LENGTH,
	pauseGoal,
	reconstructGoalState,
	resumeGoal,
	setGoal,
	type GoalState,
} from "./goal-state.ts";

const NOW = 1_000;

function goalState(overrides: Partial<GoalState> = {}): GoalState {
	return {
		objective: "Ship the release",
		status: "active",
		createdAt: 500,
		updatedAt: 500,
		...overrides,
	};
}

function entry(data: unknown, customType = GOAL_CUSTOM_TYPE) {
	return { type: "custom", customType, data };
}

describe("reconstructGoalState", () => {
	it("selects the latest goal entry that carries a state", () => {
		const first = goalState({ objective: "First", createdAt: 1, updatedAt: 1 });
		const second = goalState({ objective: "Second", status: "paused", createdAt: 2, updatedAt: 2 });
		const goal = reconstructGoalState([
			entry({ action: "set", state: first }),
			{ type: "message", message: { role: "user", content: "hi" } },
			entry({ action: "pause", state: second }),
		]);

		expect(goal).toEqual(second);
	});

	it("skips goal entries without a state and other custom types", () => {
		const only = goalState();
		const goal = reconstructGoalState([
			entry({ action: "set" }),
			entry({ action: "set", state: only }, "other-custom-type"),
			entry({ action: "set", state: only }),
		]);

		expect(goal).toEqual(only);
		expect(reconstructGoalState([entry({ action: "set" })])).toBeNull();
		expect(reconstructGoalState([])).toBeNull();
	});

	it("returns the cleared tombstone as persisted", () => {
		const tombstone = goalState({ objective: "", status: "cleared", createdAt: 0 });
		const goal = reconstructGoalState([
			entry({ action: "set", state: goalState() }),
			entry({ action: "clear", state: tombstone }),
		]);

		expect(goal).toEqual(tombstone);
	});
});

describe("pauseGoal", () => {
	it("pauses an active goal immutably with a fresh updatedAt", () => {
		const active = goalState();
		const outcome = pauseGoal(active, NOW);

		expect(outcome).toEqual({
			ok: true,
			goal: { ...active, status: "paused", updatedAt: NOW },
			action: "pause",
			state: { ...active, status: "paused", updatedAt: NOW },
		});
		expect(active.status).toBe("active");
		expect(active.updatedAt).toBe(500);
	});

	it("rejects paused, completed, cleared, and missing goals", () => {
		expect(pauseGoal(goalState({ status: "paused" }), NOW)).toEqual({ ok: false, reason: "already-paused" });
		expect(pauseGoal(goalState({ status: "completed" }), NOW)).toEqual({ ok: false, reason: "completed" });
		expect(pauseGoal(goalState({ status: "cleared", objective: "" }), NOW)).toEqual({ ok: false, reason: "no-goal" });
		expect(pauseGoal(null, NOW)).toEqual({ ok: false, reason: "no-goal" });
	});
});

describe("resumeGoal", () => {
	it("resumes a paused goal immutably", () => {
		const paused = goalState({ status: "paused" });
		const outcome = resumeGoal(paused, NOW);

		expect(outcome.ok).toBe(true);
		expect(outcome.ok && outcome.goal).toEqual({ ...paused, status: "active", updatedAt: NOW });
		expect(outcome.ok && outcome.action).toBe("resume");
		expect(paused.status).toBe("paused");
	});

	it("rejects active, completed, cleared, and missing goals", () => {
		expect(resumeGoal(goalState(), NOW)).toEqual({ ok: false, reason: "already-active" });
		expect(resumeGoal(goalState({ status: "completed" }), NOW)).toEqual({ ok: false, reason: "completed" });
		expect(resumeGoal(goalState({ status: "cleared", objective: "" }), NOW)).toEqual({ ok: false, reason: "no-goal" });
		expect(resumeGoal(null, NOW)).toEqual({ ok: false, reason: "no-goal" });
	});
});

describe("editGoal", () => {
	it("replaces the objective of a live goal and persists as a set action", () => {
		const outcome = editGoal(goalState({ status: "paused" }), "New objective", NOW);

		expect(outcome.ok).toBe(true);
		expect(outcome.ok && outcome.goal).toMatchObject({ objective: "New objective", status: "paused", updatedAt: NOW });
		expect(outcome.ok && outcome.action).toBe("set");
	});

	it("rejects blank objectives and dead goals; length is unlimited (command behavior)", () => {
		expect(editGoal(goalState(), "", NOW)).toEqual({ ok: false, reason: "empty-objective" });
		// /goal edit has no length limit today.
		expect(editGoal(goalState(), "x".repeat(MAX_OBJECTIVE_LENGTH + 1), NOW).ok).toBe(true);
		// Completed goals can still be edited; only cleared/missing goals cannot.
		expect(editGoal(goalState({ status: "completed" }), "Next", NOW).ok).toBe(true);
		expect(editGoal(goalState({ status: "cleared", objective: "" }), "Next", NOW)).toEqual({ ok: false, reason: "no-goal" });
		expect(editGoal(null, "Next", NOW)).toEqual({ ok: false, reason: "no-goal" });
	});
});

describe("checkpointGoal", () => {
	it("records checkpoint progress on an active goal verbatim", () => {
		const outcome = checkpointGoal(goalState(), "Tests pass", NOW);

		expect(outcome.ok).toBe(true);
		expect(outcome.ok && outcome.goal).toMatchObject({ checkpointProgress: "Tests pass", updatedAt: NOW });
		expect(outcome.ok && outcome.action).toBe("checkpoint");
		// Empty summaries are stored as given (the command allows them).
		const empty = checkpointGoal(goalState(), "", NOW);
		expect(empty.ok && empty.goal?.checkpointProgress).toBe("");
	});

	it("rejects goals that exist but are not active, and missing goals", () => {
		expect(checkpointGoal(goalState({ status: "paused" }), "x", NOW)).toEqual({ ok: false, reason: "not-active" });
		expect(checkpointGoal(goalState({ status: "completed" }), "x", NOW)).toEqual({ ok: false, reason: "not-active" });
		// A cleared tombstone still exists as a state and reports not-active.
		expect(checkpointGoal(goalState({ status: "cleared", objective: "" }), "x", NOW)).toEqual({
			ok: false,
			reason: "not-active",
		});
		expect(checkpointGoal(null, "x", NOW)).toEqual({ ok: false, reason: "no-goal" });
	});
});

describe("completeGoal", () => {
	it("completes an active goal with the given summary", () => {
		const outcome = completeGoal(goalState(), "All tests green", NOW);

		expect(outcome.ok).toBe(true);
		expect(outcome.ok && outcome.goal).toMatchObject({
			status: "completed",
			completionSummary: "All tests green",
			updatedAt: NOW,
		});
		expect(outcome.ok && outcome.action).toBe("complete");
	});

	it("rejects non-active and missing goals", () => {
		expect(completeGoal(goalState({ status: "paused" }), "x", NOW)).toEqual({ ok: false, reason: "not-active" });
		expect(completeGoal(goalState({ status: "completed" }), "x", NOW)).toEqual({ ok: false, reason: "not-active" });
		expect(completeGoal(null, "x", NOW)).toEqual({ ok: false, reason: "no-goal" });
	});
});

describe("clearGoal", () => {
	it("clears a live goal to a null goal and a persisted tombstone", () => {
		const outcome = clearGoal(goalState({ status: "completed", completionSummary: "Done" }), NOW);

		expect(outcome).toEqual({
			ok: true,
			goal: null,
			action: "clear",
			state: { objective: "", status: "cleared", createdAt: 0, updatedAt: NOW },
		});
	});

	it("rejects cleared and missing goals", () => {
		expect(clearGoal(goalState({ status: "cleared", objective: "" }), NOW)).toEqual({ ok: false, reason: "no-goal" });
		expect(clearGoal(null, NOW)).toEqual({ ok: false, reason: "no-goal" });
	});
});

describe("setGoal", () => {
	it("creates an active goal with deterministic timestamps", () => {
		const outcome = setGoal("Write the docs", NOW);

		expect(outcome).toEqual({
			ok: true,
			goal: { objective: "Write the docs", status: "active", createdAt: NOW, updatedAt: NOW },
			action: "set",
			state: { objective: "Write the docs", status: "active", createdAt: NOW, updatedAt: NOW },
		});
	});

	it("enforces the objective length and empty rules of the command", () => {
		expect(setGoal("", NOW)).toEqual({ ok: false, reason: "empty-objective" });
		expect(setGoal("x".repeat(MAX_OBJECTIVE_LENGTH), NOW).ok).toBe(true);
		expect(setGoal("x".repeat(MAX_OBJECTIVE_LENGTH + 1), NOW)).toEqual({ ok: false, reason: "too-long" });
	});
});

describe("timestamp determinism", () => {
	it("uses the injected now for every produced timestamp", () => {
		for (const outcome of [
			pauseGoal(goalState(), NOW),
			resumeGoal(goalState({ status: "paused" }), NOW),
			editGoal(goalState(), "Next", NOW),
			checkpointGoal(goalState(), "Progress", NOW),
			completeGoal(goalState(), "Done", NOW),
			clearGoal(goalState(), NOW),
			setGoal("New", NOW),
		]) {
			expect(outcome.ok).toBe(true);
			if (outcome.ok) {
				expect(outcome.state.updatedAt).toBe(NOW);
				if (outcome.state.status !== "cleared") {
					expect(outcome.goal?.updatedAt).toBe(NOW);
				}
			}
		}
	});
});