/**
 * Pure goal state and transition rules for the /goal extension.
 *
 * This module owns the persisted state shape, session-entry reconstruction,
 * and every state transition. Transitions are immutable and inject `now` for
 * timestamps; each success carries the next in-memory goal plus the session
 * entry to persist. Callers (index.ts) own command parsing, confirmation
 * dialogs, notifications, rendering, and the appendEntry side effect.
 */

export interface GoalState {
	objective: string;
	status: "active" | "paused" | "completed" | "cleared";
	createdAt: number;
	updatedAt: number;
	/** Checkpoint progress reported by the agent */
	checkpointProgress?: string;
	/** Summary of what was accomplished (set when completed) */
	completionSummary?: string;
}

export interface GoalEntryData {
	action: "set" | "pause" | "resume" | "clear" | "complete" | "checkpoint";
	state: GoalState;
}

export const GOAL_CUSTOM_TYPE = "goal-state";

/** Maximum objective length accepted by /goal <objective> (matches command behavior). */
export const MAX_OBJECTIVE_LENGTH = 4000;

/**
 * Reconstruct the goal from session entries: the latest goal-state entry with
 * a state wins. A cleared tombstone is returned as a `cleared` state, exactly
 * as it was persisted; callers treat it as "no goal".
 */
export function reconstructGoalState(entries: readonly unknown[]): GoalState | null {
	let goal: GoalState | null = null;
	for (const entry of entries) {
		const candidate = entry as
			| { type?: unknown; customType?: unknown; data?: GoalEntryData | undefined }
			| null
			| undefined;
		if (!candidate || candidate.type !== "custom" || candidate.customType !== GOAL_CUSTOM_TYPE) continue;
		if (candidate.data && candidate.data.state) goal = candidate.data.state;
	}
	return goal;
}

/** Why a transition refused to run; callers map reasons to their own messages. */
export type GoalRejection =
	| "no-goal"
	| "already-paused"
	| "already-active"
	| "completed"
	| "not-active"
	| "empty-objective"
	| "too-long";

export interface AppliedGoalTransition {
	/** Next in-memory goal; null after a clear. */
	goal: GoalState | null;
	/** Session-entry action to persist alongside the state. */
	action: GoalEntryData["action"];
	/** State to persist (a cleared tombstone for clear). */
	state: GoalState;
}

export type GoalTransitionOutcome =
	| ({ ok: true } & AppliedGoalTransition)
	| { ok: false; reason: GoalRejection };

function hasLiveGoal(goal: GoalState | null): goal is GoalState {
	return goal !== null && goal.status !== "cleared";
}

function transitioned(goal: GoalState, action: GoalEntryData["action"], state: GoalState): GoalTransitionOutcome {
	return { ok: true, goal, action, state };
}

/** Pause an active goal. */
export function pauseGoal(goal: GoalState | null, now: number): GoalTransitionOutcome {
	if (!hasLiveGoal(goal)) return { ok: false, reason: "no-goal" };
	if (goal.status === "paused") return { ok: false, reason: "already-paused" };
	if (goal.status === "completed") return { ok: false, reason: "completed" };
	const next: GoalState = { ...goal, status: "paused", updatedAt: now };
	return transitioned(next, "pause", next);
}

/** Resume a paused goal. */
export function resumeGoal(goal: GoalState | null, now: number): GoalTransitionOutcome {
	if (!hasLiveGoal(goal)) return { ok: false, reason: "no-goal" };
	if (goal.status === "active") return { ok: false, reason: "already-active" };
	if (goal.status === "completed") return { ok: false, reason: "completed" };
	const next: GoalState = { ...goal, status: "active", updatedAt: now };
	return transitioned(next, "resume", next);
}

/**
 * Replace the objective of a live goal. Blank objectives are rejected; length
 * is not limited, matching the current /goal edit command behavior.
 */
export function editGoal(goal: GoalState | null, objective: string, now: number): GoalTransitionOutcome {
	if (!hasLiveGoal(goal)) return { ok: false, reason: "no-goal" };
	if (!objective) return { ok: false, reason: "empty-objective" };
	const next: GoalState = { ...goal, objective, updatedAt: now };
	return transitioned(next, "set", next);
}

/**
 * Record checkpoint progress on an active goal. Any summary text (including
 * empty) is stored as given; callers decide fallbacks.
 */
export function checkpointGoal(goal: GoalState | null, summary: string, now: number): GoalTransitionOutcome {
	if (goal === null) return { ok: false, reason: "no-goal" };
	if (goal.status !== "active") return { ok: false, reason: "not-active" };
	const next: GoalState = { ...goal, checkpointProgress: summary, updatedAt: now };
	return transitioned(next, "checkpoint", next);
}

/**
 * Complete an active goal. `summary` is stored verbatim as the completion
 * summary; callers decide fallbacks.
 */
export function completeGoal(goal: GoalState | null, summary: string, now: number): GoalTransitionOutcome {
	if (goal === null) return { ok: false, reason: "no-goal" };
	if (goal.status !== "active") return { ok: false, reason: "not-active" };
	const next: GoalState = { ...goal, status: "completed", completionSummary: summary, updatedAt: now };
	return transitioned(next, "complete", next);
}

/** Clear a live goal, producing the persisted tombstone. */
export function clearGoal(goal: GoalState | null, now: number): GoalTransitionOutcome {
	if (!hasLiveGoal(goal)) return { ok: false, reason: "no-goal" };
	const tombstone: GoalState = { objective: "", status: "cleared", createdAt: 0, updatedAt: now };
	return { ok: true, goal: null, action: "clear", state: tombstone };
}

/** Set a new active goal, replacing any existing one. */
export function setGoal(objective: string, now: number): GoalTransitionOutcome {
	if (!objective) return { ok: false, reason: "empty-objective" };
	if (objective.length > MAX_OBJECTIVE_LENGTH) return { ok: false, reason: "too-long" };
	const goal: GoalState = { objective, status: "active", createdAt: now, updatedAt: now };
	return transitioned(goal, "set", goal);
}