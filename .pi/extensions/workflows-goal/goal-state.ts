/** Pure persisted goal state, reconstruction, and immutable transitions. */

import { createHash, randomUUID } from "node:crypto";

export type GoalStatus =
	| "active"
	| "paused"
	| "blocked"
	| "completed"
	| "budget_limited"
	| "cleared";

export interface GoalEvidence {
	requirement: string;
	verification: string;
	result: "passed" | "failed";
}

export interface GoalState {
	goalId: string;
	objective: string;
	status: GoalStatus;
	createdAt: number;
	updatedAt: number;
	checkpointProgress?: string;
	completionSummary?: string;
	completionEvidence?: GoalEvidence[];
	blockedReason?: string;
	limitReason?: string;
}

export interface GoalEntryData {
	action: "set" | "pause" | "resume" | "clear" | "complete" | "checkpoint" | "block" | "limit";
	state: GoalState;
}

export const GOAL_CUSTOM_TYPE = "goal-state";
export const MAX_OBJECTIVE_LENGTH = 4000;

const GOAL_STATUSES = new Set<GoalStatus>([
	"active",
	"paused",
	"blocked",
	"completed",
	"budget_limited",
	"cleared",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validEvidence(value: unknown): value is GoalEvidence {
	return isRecord(value) &&
		typeof value.requirement === "string" &&
		typeof value.verification === "string" &&
		(value.result === "passed" || value.result === "failed");
}

function legacyGoalId(state: Record<string, unknown>, entryId: unknown, index: number): string {
	if (typeof entryId === "string" && entryId.length > 0) return `legacy:${entryId}`;
	const digest = createHash("sha256").update(`${JSON.stringify(state)}\0${index}`).digest("hex").slice(0, 16);
	return `legacy:${digest}`;
}

function parseGoalState(value: unknown, entryId: unknown, index: number): GoalState | null {
	if (!isRecord(value)) return null;
	if (typeof value.objective !== "string") return null;
	if (typeof value.status !== "string" || !GOAL_STATUSES.has(value.status as GoalStatus)) return null;
	if (typeof value.createdAt !== "number" || !Number.isFinite(value.createdAt)) return null;
	if (typeof value.updatedAt !== "number" || !Number.isFinite(value.updatedAt)) return null;

	for (const field of ["checkpointProgress", "completionSummary", "blockedReason", "limitReason"] as const) {
		if (value[field] !== undefined && typeof value[field] !== "string") return null;
	}
	if (value.status === "blocked" && !value.blockedReason?.toString().trim()) return null;
	if (value.status === "budget_limited" && !value.limitReason?.toString().trim()) return null;

	const goalId = typeof value.goalId === "string" && value.goalId.length > 0
		? value.goalId
		: legacyGoalId(value, entryId, index);
	const evidence = Array.isArray(value.completionEvidence) && value.completionEvidence.every(validEvidence)
		? value.completionEvidence.map((item) => ({ ...item }))
		: undefined;

	return {
		goalId,
		objective: value.objective,
		status: value.status as GoalStatus,
		createdAt: value.createdAt,
		updatedAt: value.updatedAt,
		...(typeof value.checkpointProgress === "string" ? { checkpointProgress: value.checkpointProgress } : {}),
		...(typeof value.completionSummary === "string" ? { completionSummary: value.completionSummary } : {}),
		...(evidence ? { completionEvidence: evidence } : {}),
		...(typeof value.blockedReason === "string" ? { blockedReason: value.blockedReason } : {}),
		...(typeof value.limitReason === "string" ? { limitReason: value.limitReason } : {}),
	};
}

/** Latest valid goal-state entry on the supplied active branch wins. */
export function reconstructGoalState(entries: readonly unknown[]): GoalState | null {
	let goal: GoalState | null = null;
	for (let index = 0; index < entries.length; index++) {
		const candidate = entries[index];
		if (!isRecord(candidate) || candidate.type !== "custom" || candidate.customType !== GOAL_CUSTOM_TYPE) continue;
		if (!isRecord(candidate.data) || !("state" in candidate.data)) continue;
		const parsed = parseGoalState(candidate.data.state, candidate.id, index);
		if (parsed) goal = parsed;
	}
	return goal;
}

export type GoalRejection =
	| "no-goal"
	| "already-paused"
	| "already-active"
	| "completed"
	| "not-active"
	| "empty-objective"
	| "empty-reason"
	| "too-long";

export interface AppliedGoalTransition {
	goal: GoalState | null;
	action: GoalEntryData["action"];
	state: GoalState;
}

export type GoalTransitionOutcome =
	| ({ ok: true } & AppliedGoalTransition)
	| { ok: false; reason: GoalRejection };

function hasLiveGoal(goal: GoalState | null): goal is GoalState {
	return goal !== null && goal.status !== "cleared";
}

function transitioned(goal: GoalState, action: GoalEntryData["action"]): GoalTransitionOutcome {
	return { ok: true, goal, action, state: goal };
}

export function pauseGoal(goal: GoalState | null, now: number): GoalTransitionOutcome {
	if (!hasLiveGoal(goal)) return { ok: false, reason: "no-goal" };
	if (goal.status === "paused") return { ok: false, reason: "already-paused" };
	if (goal.status === "completed") return { ok: false, reason: "completed" };
	if (goal.status !== "active") return { ok: false, reason: "not-active" };
	return transitioned({ ...goal, status: "paused", updatedAt: now }, "pause");
}

export function resumeGoal(goal: GoalState | null, now: number): GoalTransitionOutcome {
	if (!hasLiveGoal(goal)) return { ok: false, reason: "no-goal" };
	if (goal.status === "active") return { ok: false, reason: "already-active" };
	if (goal.status === "completed") return { ok: false, reason: "completed" };
	if (goal.status !== "paused" && goal.status !== "blocked" && goal.status !== "budget_limited") {
		return { ok: false, reason: "not-active" };
	}
	const { blockedReason: _blockedReason, limitReason: _limitReason, ...rest } = goal;
	return transitioned({ ...rest, status: "active", updatedAt: now }, "resume");
}

export function editGoal(goal: GoalState | null, objective: string, now: number): GoalTransitionOutcome {
	if (!hasLiveGoal(goal)) return { ok: false, reason: "no-goal" };
	if (!objective) return { ok: false, reason: "empty-objective" };
	return transitioned({ ...goal, objective, updatedAt: now }, "set");
}

export function checkpointGoal(goal: GoalState | null, summary: string, now: number): GoalTransitionOutcome {
	if (goal === null) return { ok: false, reason: "no-goal" };
	if (goal.status !== "active") return { ok: false, reason: "not-active" };
	return transitioned({ ...goal, checkpointProgress: summary, updatedAt: now }, "checkpoint");
}

export function completeGoal(
	goal: GoalState | null,
	summary: string,
	now: number,
	evidence?: GoalEvidence[],
): GoalTransitionOutcome {
	if (goal === null) return { ok: false, reason: "no-goal" };
	if (goal.status !== "active") return { ok: false, reason: "not-active" };
	return transitioned({
		...goal,
		status: "completed",
		completionSummary: summary,
		...(evidence ? { completionEvidence: evidence.map((item) => ({ ...item })) } : {}),
		updatedAt: now,
	}, "complete");
}

export function blockGoal(goal: GoalState | null, reason: string, now: number): GoalTransitionOutcome {
	if (goal === null) return { ok: false, reason: "no-goal" };
	if (goal.status !== "active") return { ok: false, reason: "not-active" };
	const trimmed = reason.trim();
	if (!trimmed) return { ok: false, reason: "empty-reason" };
	return transitioned({ ...goal, status: "blocked", blockedReason: trimmed, updatedAt: now }, "block");
}

export function limitGoal(goal: GoalState | null, reason: string, now: number): GoalTransitionOutcome {
	if (goal === null) return { ok: false, reason: "no-goal" };
	if (goal.status !== "active") return { ok: false, reason: "not-active" };
	const trimmed = reason.trim();
	if (!trimmed) return { ok: false, reason: "empty-reason" };
	return transitioned({ ...goal, status: "budget_limited", limitReason: trimmed, updatedAt: now }, "limit");
}

export function clearGoal(goal: GoalState | null, now: number): GoalTransitionOutcome {
	if (!hasLiveGoal(goal)) return { ok: false, reason: "no-goal" };
	const tombstone: GoalState = {
		goalId: goal.goalId,
		objective: "",
		status: "cleared",
		createdAt: 0,
		updatedAt: now,
	};
	return { ok: true, goal: null, action: "clear", state: tombstone };
}

export function setGoal(
	objective: string,
	now: number,
	createId: () => string = randomUUID,
): GoalTransitionOutcome {
	if (!objective) return { ok: false, reason: "empty-objective" };
	if (objective.length > MAX_OBJECTIVE_LENGTH) return { ok: false, reason: "too-long" };
	const goal: GoalState = {
		goalId: createId(),
		objective,
		status: "active",
		createdAt: now,
		updatedAt: now,
	};
	return transitioned(goal, "set");
}
