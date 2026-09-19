import type { GoalState } from "./goal-state.ts";

export const GOAL_RUNTIME_CUSTOM_TYPE = "goal-runtime";

export interface GoalRuntimeConfig {
	maxContinuationRuns: number;
	maxNoProgressRuns: number;
	maxFailureRuns: number;
}

export const DEFAULT_GOAL_RUNTIME_CONFIG: GoalRuntimeConfig = {
	maxContinuationRuns: 30,
	maxNoProgressRuns: 3,
	maxFailureRuns: 3,
};

export function runtimeLines(runtime: GoalRuntimeSnapshot | null): string[] {
	if (!runtime) return [];
	const lines = [`Continuation runs: ${runtime.continuationRuns}/${DEFAULT_GOAL_RUNTIME_CONFIG.maxContinuationRuns}`];
	if (runtime.consecutiveNoProgressRuns > 0) lines.push(`Consecutive no-progress runs: ${runtime.consecutiveNoProgressRuns}`);
	if (runtime.consecutiveFailureRuns > 0) lines.push(`Consecutive failure runs: ${runtime.consecutiveFailureRuns}`);
	return lines;
}

export interface GoalRuntimeSnapshot {
	goalId: string;
	continuationRuns: number;
	consecutiveNoProgressRuns: number;
	consecutiveFailureRuns: number;
	updatedAt: number;
}

export interface AutomaticGoalRun {
	goalId: string;
	sawSuccessfulWork: boolean;
	sawExecutionAttempt: boolean;
	sawExecutionFailure: boolean;
	finalStopReason?: "stop" | "length" | "toolUse" | "error" | "aborted";
}

export interface GoalTurnObservation {
	message: { role?: string; stopReason?: string };
	toolResults: Array<{ toolName?: string; isError?: boolean; details?: unknown }>;
}

export type GoalContinuationDecision =
	| { action: "continue" }
	| { action: "skip"; reason: string }
	| { action: "stop"; status: "blocked" | "budget_limited"; reason: string };

export interface FinalizedGoalRun {
	snapshot: GoalRuntimeSnapshot;
	classification: "progress" | "no_progress" | "failure";
	terminalStopReason?: "error" | "length" | "aborted";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCounter(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parseRuntime(value: unknown): GoalRuntimeSnapshot | null {
	if (!isRecord(value) || typeof value.goalId !== "string" || value.goalId.length === 0) return null;
	if (!isCounter(value.continuationRuns)) return null;
	if (!isCounter(value.consecutiveNoProgressRuns)) return null;
	if (!isCounter(value.consecutiveFailureRuns)) return null;
	if (typeof value.updatedAt !== "number" || !Number.isFinite(value.updatedAt)) return null;
	return {
		goalId: value.goalId,
		continuationRuns: value.continuationRuns,
		consecutiveNoProgressRuns: value.consecutiveNoProgressRuns,
		consecutiveFailureRuns: value.consecutiveFailureRuns,
		updatedAt: value.updatedAt,
	};
}

export function reconstructGoalRuntime(
	entries: readonly unknown[],
	goalId: string,
	now: number,
): GoalRuntimeSnapshot {
	let snapshot: GoalRuntimeSnapshot | null = null;
	for (const entry of entries) {
		if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== GOAL_RUNTIME_CUSTOM_TYPE) continue;
		const parsed = parseRuntime(entry.data);
		if (parsed?.goalId === goalId) snapshot = parsed;
	}
	return snapshot ?? {
		goalId,
		continuationRuns: 0,
		consecutiveNoProgressRuns: 0,
		consecutiveFailureRuns: 0,
		updatedAt: now,
	};
}

export function startAutomaticRun(goalId: string): AutomaticGoalRun {
	return {
		goalId,
		sawSuccessfulWork: false,
		sawExecutionAttempt: false,
		sawExecutionFailure: false,
	};
}

function isSuccessfulCheckpoint(result: GoalTurnObservation["toolResults"][number]): boolean {
	if (result.toolName !== "goal" || result.isError === true || !isRecord(result.details)) return false;
	if (result.details.action !== "checkpoint" || !isRecord(result.details.state)) return false;
	return typeof result.details.state.checkpointProgress === "string" &&
		result.details.state.checkpointProgress.trim().length > 0;
}

export function recordGoalTurn(run: AutomaticGoalRun, event: GoalTurnObservation): AutomaticGoalRun {
	let sawSuccessfulWork = run.sawSuccessfulWork;
	let sawExecutionAttempt = run.sawExecutionAttempt;
	let sawExecutionFailure = run.sawExecutionFailure;

	for (const result of event.toolResults) {
		if (result.toolName === "goal") {
			if (isSuccessfulCheckpoint(result)) sawSuccessfulWork = true;
			continue;
		}
		sawExecutionAttempt = true;
		if (result.isError === true) sawExecutionFailure = true;
		else sawSuccessfulWork = true;
	}

	const stopReason = event.message.role === "assistant" &&
		["stop", "length", "toolUse", "error", "aborted"].includes(event.message.stopReason ?? "")
		? event.message.stopReason as AutomaticGoalRun["finalStopReason"]
		: run.finalStopReason;
	return {
		...run,
		sawSuccessfulWork,
		sawExecutionAttempt,
		sawExecutionFailure,
		...(stopReason ? { finalStopReason: stopReason } : {}),
	};
}

export function finalizeAutomaticRun(
	snapshot: GoalRuntimeSnapshot,
	run: AutomaticGoalRun,
	now: number,
): FinalizedGoalRun {
	const failureOnly = run.sawExecutionAttempt && run.sawExecutionFailure && !run.sawSuccessfulWork;
	const classification = run.sawSuccessfulWork ? "progress" : failureOnly ? "failure" : "no_progress";
	const next = run.sawSuccessfulWork
		? { ...snapshot, consecutiveNoProgressRuns: 0, consecutiveFailureRuns: 0, updatedAt: now }
		: failureOnly
			? {
				...snapshot,
				consecutiveNoProgressRuns: snapshot.consecutiveNoProgressRuns + 1,
				consecutiveFailureRuns: snapshot.consecutiveFailureRuns + 1,
				updatedAt: now,
			}
			: {
				...snapshot,
				consecutiveNoProgressRuns: snapshot.consecutiveNoProgressRuns + 1,
				consecutiveFailureRuns: 0,
				updatedAt: now,
			};
	const terminalStopReason = run.finalStopReason === "error" || run.finalStopReason === "length" || run.finalStopReason === "aborted"
		? run.finalStopReason
		: undefined;
	return { snapshot: next, classification, ...(terminalStopReason ? { terminalStopReason } : {}) };
}

export function recordContinuationRequested(snapshot: GoalRuntimeSnapshot, now: number): GoalRuntimeSnapshot {
	return { ...snapshot, continuationRuns: snapshot.continuationRuns + 1, updatedAt: now };
}

export function resetGoalRuntime(
	snapshot: GoalRuntimeSnapshot,
	now: number,
	resetContinuationRuns: boolean,
): GoalRuntimeSnapshot {
	return {
		...snapshot,
		continuationRuns: resetContinuationRuns ? 0 : snapshot.continuationRuns,
		consecutiveNoProgressRuns: 0,
		consecutiveFailureRuns: 0,
		updatedAt: now,
	};
}

export function decideGoalContinuation(
	goal: GoalState | null,
	runtime: GoalRuntimeSnapshot | null,
	config: GoalRuntimeConfig = DEFAULT_GOAL_RUNTIME_CONFIG,
): GoalContinuationDecision {
	if (!goal || goal.status === "cleared") return { action: "skip", reason: "no-goal" };
	if (goal.status !== "active") return { action: "skip", reason: "not-active" };
	if (!runtime || runtime.goalId !== goal.goalId) return { action: "skip", reason: "stale-goal" };
	if (runtime.consecutiveFailureRuns >= config.maxFailureRuns) {
		return { action: "stop", status: "blocked", reason: "Execution failed in three consecutive automatic runs." };
	}
	if (runtime.consecutiveNoProgressRuns >= config.maxNoProgressRuns) {
		return { action: "stop", status: "blocked", reason: "No meaningful progress in three consecutive automatic runs." };
	}
	if (runtime.continuationRuns >= config.maxContinuationRuns) {
		return {
			action: "stop",
			status: "budget_limited",
			reason: `Continuation limit reached (${config.maxContinuationRuns} runs).`,
		};
	}
	return { action: "continue" };
}
