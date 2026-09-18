import { describe, expect, it } from "vitest";
import {
	blockGoal,
	checkpointGoal,
	clearGoal,
	completeGoal,
	editGoal,
	GOAL_CUSTOM_TYPE,
	MAX_OBJECTIVE_LENGTH,
	limitGoal,
	pauseGoal,
	reconstructGoalState,
	resumeGoal,
	setGoal,
	type GoalState,
} from "./goal-state.ts";

const NOW = 1_000;

function goalState(overrides: Partial<GoalState> = {}): GoalState {
	return {
		goalId: "goal-1",
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
			state: { goalId: "goal-1", objective: "", status: "cleared", createdAt: 0, updatedAt: NOW },
		});
	});

	it("rejects cleared and missing goals", () => {
		expect(clearGoal(goalState({ status: "cleared", objective: "" }), NOW)).toEqual({ ok: false, reason: "no-goal" });
		expect(clearGoal(null, NOW)).toEqual({ ok: false, reason: "no-goal" });
	});
});

describe("setGoal", () => {
	it("creates an active goal with deterministic timestamps", () => {
		const outcome = setGoal("Write the docs", NOW, () => "goal-new");

		expect(outcome).toEqual({
			ok: true,
			goal: { goalId: "goal-new", objective: "Write the docs", status: "active", createdAt: NOW, updatedAt: NOW },
			action: "set",
			state: { goalId: "goal-new", objective: "Write the docs", status: "active", createdAt: NOW, updatedAt: NOW },
		});
	});

	it("enforces the objective length and empty rules of the command", () => {
		expect(setGoal("", NOW)).toEqual({ ok: false, reason: "empty-objective" });
		expect(setGoal("x".repeat(MAX_OBJECTIVE_LENGTH), NOW).ok).toBe(true);
		expect(setGoal("x".repeat(MAX_OBJECTIVE_LENGTH + 1), NOW)).toEqual({ ok: false, reason: "too-long" });
	});
});

describe("goal identity and terminal runtime states", () => {
	it("creates a fresh ID and preserves it across same-goal transitions", () => {
		const created = setGoal("Write the docs", NOW, () => "generated-id");
		expect(created.ok && created.goal?.goalId).toBe("generated-id");
		if (!created.ok || !created.goal) throw new Error("expected goal");
		for (const outcome of [
			pauseGoal(created.goal, NOW + 1),
			editGoal(created.goal, "Edited", NOW + 1),
			checkpointGoal(created.goal, "Progress", NOW + 1),
			completeGoal(created.goal, "Done", NOW + 1, [{ requirement: "Docs", verification: "Read", result: "passed" }]),
			blockGoal(created.goal, "Needs input", NOW + 1),
			limitGoal(created.goal, "30 continuations used", NOW + 1),
		]) {
			expect(outcome.ok && outcome.state.goalId).toBe("generated-id");
		}
	});

	it("blocks and limits only active goals with non-empty reasons", () => {
		expect(blockGoal(goalState(), "Needs credentials", NOW)).toMatchObject({
			ok: true,
			action: "block",
			state: { status: "blocked", blockedReason: "Needs credentials" },
		});
		expect(limitGoal(goalState(), "30 continuations used", NOW)).toMatchObject({
			ok: true,
			action: "limit",
			state: { status: "budget_limited", limitReason: "30 continuations used" },
		});
		expect(blockGoal(goalState(), "  ", NOW)).toEqual({ ok: false, reason: "empty-reason" });
		expect(limitGoal(goalState({ status: "paused" }), "limit", NOW)).toEqual({ ok: false, reason: "not-active" });
	});

	it("resumes paused, blocked, and budget-limited goals and clears terminal reasons", () => {
		for (const state of [
			goalState({ status: "paused" }),
			goalState({ status: "blocked", blockedReason: "Needs input" }),
			goalState({ status: "budget_limited", limitReason: "Limit" }),
		]) {
			const outcome = resumeGoal(state, NOW);
			expect(outcome).toMatchObject({ ok: true, action: "resume", state: { status: "active" } });
			expect(outcome.ok && outcome.state.blockedReason).toBeUndefined();
			expect(outcome.ok && outcome.state.limitReason).toBeUndefined();
		}
	});

	it("derives stable legacy IDs and ignores malformed goal entries", () => {
		const legacy = { objective: "Legacy", status: "active", createdAt: 1, updatedAt: 1 };
		const entries = [
			{ type: "custom", id: "entry-1", customType: GOAL_CUSTOM_TYPE, data: { action: "set", state: legacy } },
			entry({ action: "set", state: { objective: 42, status: "active", createdAt: 2, updatedAt: 2 } }),
		];
		expect(reconstructGoalState(entries)).toMatchObject({ ...legacy, goalId: "legacy:entry-1" });
		expect(reconstructGoalState(entries)?.goalId).toBe(reconstructGoalState(entries)?.goalId);
	});

	it("keeps a valid tombstone authoritative and sanitizes invalid optional evidence", () => {
		const tombstone = { objective: "", status: "cleared", createdAt: 0, updatedAt: 2 };
		const reconstructed = reconstructGoalState([
			{ type: "custom", id: "live", customType: GOAL_CUSTOM_TYPE, data: { action: "set", state: goalState() } },
			{ type: "custom", id: "clear", customType: GOAL_CUSTOM_TYPE, data: { action: "clear", state: tombstone } },
		]);
		expect(reconstructed).toMatchObject({ status: "cleared", goalId: "legacy:clear" });

		const completed = reconstructGoalState([{ type: "custom", id: "done", customType: GOAL_CUSTOM_TYPE, data: {
			action: "complete",
			state: { ...goalState({ status: "completed" }), completionEvidence: [{ nope: true }] },
		} }]);
		expect(completed?.completionEvidence).toBeUndefined();
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
			setGoal("New", NOW, () => "goal-new"),
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