import {
	blockGoal,
	checkpointGoal,
	completeGoal,
	limitGoal,
	pauseGoal,
	reconstructGoalState,
	type AppliedGoalTransition,
	type GoalEvidence,
	type GoalState,
} from "./goal-state.ts";
import {
	decideGoalContinuation,
	finalizeAutomaticRun,
	recordContinuationRequested,
	recordGoalTurn,
	reconstructGoalRuntime,
	resetGoalRuntime,
	runtimeLines,
	startAutomaticRun,
	type AutomaticGoalRun,
	type GoalRuntimeSnapshot,
	type GoalTurnObservation,
} from "./goal-runtime.ts";
import {
	runGoalCommand,
	type GoalCommandHost,
} from "./goal-commands.ts";
import { goalPromptAddendum } from "./goal-prompts.ts";

export const GOAL_CONTINUATION_CUSTOM_TYPE = "goal-continuation";
export const GOAL_CONTINUATION_MESSAGE = `The persistent goal is still active. Continue with the next concrete action.

Inspect current state instead of repeating the previous summary. Perform useful
work or gather new evidence. A prose-only plan or status recap is not progress.
After meaningful progress, call goal with action=checkpoint. If every requirement
is verified, call goal with action=complete and provide structured evidence. If
work cannot continue without user input or an external state change, call goal
with action=blocked and give the specific reason.`;

export const COMPACTION_STATE_EVENT = "session-compaction:state";

export type CompactionStateEvent = {
	inProgress: boolean;
	source: "turn_end" | "before_agent_start";
	resumesRun: boolean;
	succeeded?: boolean;
	error?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isCompactionStateEvent(value: unknown): value is CompactionStateEvent {
	if (!isRecord(value)) return false;
	if (typeof value.inProgress !== "boolean") return false;
	if (value.source !== "turn_end" && value.source !== "before_agent_start") return false;
	if (typeof value.resumesRun !== "boolean") return false;
	if (Object.prototype.hasOwnProperty.call(value, "succeeded") && typeof value.succeeded !== "boolean") return false;
	if (Object.prototype.hasOwnProperty.call(value, "error") && typeof value.error !== "string") return false;
	return true;
}

export interface GoalLifecycleHost extends GoalCommandHost {
	appendGoalTransition(outcome: AppliedGoalTransition): void;
	appendRuntime(snapshot: GoalRuntimeSnapshot): void;
	updateWidget(goal: GoalState | null): void;
	notify(message: string, severity: "info" | "warning" | "error"): void;
	sendContinuation(goalId: string): void;
	sendKickoff(message: string, queued: boolean): void;
	isIdle(): boolean;
	hasPendingMessages(): boolean;
}

export interface GoalLifecycleDependencies {
	now?: () => number;
}

export interface GoalToolRequest {
	action: "status" | "checkpoint" | "complete" | "blocked";
	summary?: string;
	remaining?: string;
	reason?: string;
	evidence?: GoalEvidence[];
}

export interface GoalToolOutcome {
	action: GoalToolRequest["action"];
	state: GoalState | null;
	runtime: GoalRuntimeSnapshot | null;
	error?: string;
	isError?: boolean;
	evidence?: GoalEvidence[];
}

export type GoalLifecycleEvent =
	| { type: "sessionStarted"; branch: readonly unknown[]; host: GoalLifecycleHost }
	| { type: "branchChanged"; branch: readonly unknown[]; host: GoalLifecycleHost }
	| { type: "sessionStopping"; host: GoalLifecycleHost }
	| { type: "agentPromptConstruction"; systemPrompt: string; host: GoalLifecycleHost }
	| { type: "messageStarted"; role?: string; customType?: string; goalId?: string; host: GoalLifecycleHost }
	| { type: "turnEnded"; observation: GoalTurnObservation; host: GoalLifecycleHost }
	| { type: "agentSettled"; host: GoalLifecycleHost }
	| { type: "compactionStateChanged"; event: CompactionStateEvent; host: GoalLifecycleHost }
	| { type: "commandRequested"; args: string; host: GoalLifecycleHost; preSession?: true }
	| { type: "toolRequested"; request: GoalToolRequest; host: GoalLifecycleHost; preSession?: true };

export type GoalLifecycleResult<E extends GoalLifecycleEvent> =
	E extends { type: "agentPromptConstruction" }
		? { systemPrompt?: string } | undefined
		: E extends { type: "toolRequested" }
			? GoalToolOutcome
			: void;

export interface GoalLifecycle {
	dispatch<E extends GoalLifecycleEvent>(event: E): Promise<GoalLifecycleResult<E>>;
}

function createQueue() {
	let tail: Promise<void> | undefined;

	function track<T>(result: Promise<T>): Promise<T> {
		let release!: Promise<void>;
		release = result.then(
			() => {
				if (tail === release) tail = undefined;
			},
			() => {
				if (tail === release) tail = undefined;
			},
		);
		tail = release;
		return result;
	}

	function enqueue<T>(task: () => T | PromiseLike<T>): Promise<T> {
		if (!tail) {
			try {
				return track(Promise.resolve(task()));
			} catch (error) {
				return track(Promise.reject(error));
			}
		}
		return track(tail.then(task, task));
	}

	return enqueue;
}

export function createGoalLifecycle(dependencies: GoalLifecycleDependencies = {}): GoalLifecycle {
	const now = dependencies.now ?? Date.now;
	const enqueue = createQueue();

	let goal: GoalState | null = null;
	let runtime: GoalRuntimeSnapshot | null = null;
	let pendingAutomaticGoalId: string | null = null;
	let automaticRun: AutomaticGoalRun | null = null;
	let extensionCompactionInProgress = false;
	let extensionCompactionSource: CompactionStateEvent["source"] | null = null;
	let deferredCompactionGoalId: string | null = null;
	let activeHost: GoalLifecycleHost | undefined;
	let activeSession = false;
	let lifecycleGeneration = 0;

	function clearTransientRun(): void {
		pendingAutomaticGoalId = null;
		automaticRun = null;
		deferredCompactionGoalId = null;
	}

	function clearCompactionState(): void {
		extensionCompactionInProgress = false;
		extensionCompactionSource = null;
	}

	function isCurrent(host: GoalLifecycleHost, generation: number, preSession: boolean): boolean {
		if (lifecycleGeneration !== generation) return false;
		if (preSession) return !activeSession;
		return activeSession && activeHost === host;
	}

	function widgetGoal(): GoalState | null {
		return goal && goal.status !== "cleared" ? goal : null;
	}

	function neutralToolOutcome(request: GoalToolRequest): GoalToolOutcome {
		return request.action === "status"
			? { action: request.action, state: null, runtime: null }
			: { action: request.action, state: null, runtime: null, error: "No active goal.", isError: true };
	}

	function applyTransition(host: GoalLifecycleHost, outcome: AppliedGoalTransition): void {
		const previousId = goal?.goalId;
		goal = outcome.goal;
		host.appendGoalTransition(outcome);
		const terminal = outcome.action === "pause" || outcome.action === "clear" || outcome.action === "block" ||
			outcome.action === "complete" || outcome.action === "limit";
		if (terminal || goal?.goalId !== previousId) clearTransientRun();
	}

	function persistRuntime(host: GoalLifecycleHost): void {
		if (runtime) host.appendRuntime(runtime);
	}

	function notifyTerminal(
		host: GoalLifecycleHost,
		status: "blocked" | "budget_limited" | "paused" | "completed",
		reason: string,
	): void {
		const labels = {
			blocked: "Goal blocked",
			budget_limited: "Goal budget limited",
			paused: "Goal paused",
			completed: "Goal completed",
		};
		host.notify(`${labels[status]}: ${reason}`, status === "completed" ? "info" : "warning");
	}

	function stopGoal(host: GoalLifecycleHost, status: "blocked" | "budget_limited", reason: string): void {
		if (!goal || goal.status !== "active") return;
		const outcome = status === "blocked" ? blockGoal(goal, reason, now()) : limitGoal(goal, reason, now());
		if (!outcome.ok) return;
		applyTransition(host, outcome);
		persistRuntime(host);
		host.updateWidget(widgetGoal());
		notifyTerminal(host, status, reason);
	}

	function scheduleContinuation(host: GoalLifecycleHost): void {
		if (!goal || goal.status !== "active" || !runtime || runtime.goalId !== goal.goalId) return;
		if (extensionCompactionInProgress || !host.isIdle() || host.hasPendingMessages() || pendingAutomaticGoalId !== null) return;
		const decision = decideGoalContinuation(goal, runtime);
		if (decision.action === "skip") return;
		if (decision.action === "stop") {
			stopGoal(host, decision.status, decision.reason);
			return;
		}
		const goalId = goal.goalId;
		runtime = recordContinuationRequested(runtime, now());
		persistRuntime(host);
		pendingAutomaticGoalId = goalId;
		try {
			host.sendContinuation(goalId);
		} catch (error) {
			pendingAutomaticGoalId = null;
			host.notify(`Goal continuation failed: ${error instanceof Error ? error.message : String(error)}`, "error");
		}
	}

	function compactionStateChanged(host: GoalLifecycleHost, event: CompactionStateEvent): void {
		if (event.inProgress) {
			extensionCompactionInProgress = true;
			extensionCompactionSource = event.source;
			return;
		}
		extensionCompactionInProgress = false;
		extensionCompactionSource = null;
		const deferredId = deferredCompactionGoalId;
		deferredCompactionGoalId = null;
		if (!deferredId || !goal || goal.goalId !== deferredId || goal.status !== "active") return;
		if (event.succeeded === true) {
			if (!event.resumesRun) scheduleContinuation(host);
			return;
		}
		stopGoal(host, "blocked", event.error?.trim() || "Session compaction failed.");
	}

	function executeTool(host: GoalLifecycleHost, request: GoalToolRequest): GoalToolOutcome {
		if (!goal) return neutralToolOutcome(request);
		const currentRuntime = () => runtime ? { ...runtime } : null;
		switch (request.action) {
			case "status":
				return { action: request.action, state: { ...goal }, runtime: currentRuntime() };
			case "checkpoint": {
				const summary = request.summary?.trim() ?? "";
				if (!summary) return { action: request.action, state: { ...goal }, runtime: currentRuntime(), error: "Cannot checkpoint: a non-empty summary is required.", isError: true };
				const outcome = checkpointGoal(goal, summary, now());
				if (!outcome.ok) return { action: request.action, state: { ...goal }, runtime: currentRuntime(), error: `Cannot checkpoint: goal is ${goal.status}.`, isError: true };
				applyTransition(host, outcome);
				host.updateWidget(widgetGoal());
				return { action: request.action, state: outcome.state, runtime: currentRuntime() };
			}
			case "complete": {
				const error = evidenceError(request.summary, request.evidence);
				if (error || goal.status !== "active") {
					const text = error ?? `Cannot complete: goal is ${goal.status}.`;
					return { action: request.action, state: { ...goal }, runtime: currentRuntime(), error: text, isError: true };
				}
				const evidence = request.evidence as GoalEvidence[];
				const outcome = completeGoal(goal, request.summary!.trim(), now(), evidence);
				if (!outcome.ok) throw new Error("validated completion transition failed");
				applyTransition(host, outcome);
				host.updateWidget(widgetGoal());
				notifyTerminal(host, "completed", outcome.state.completionSummary ?? outcome.state.objective);
				return { action: request.action, state: outcome.state, runtime: currentRuntime(), evidence };
			}
			case "blocked": {
				const reason = request.reason?.trim() ?? "";
				const outcome = blockGoal(goal, reason, now());
				if (!outcome.ok) {
					const text = reason ? `Cannot block: goal is ${goal.status}.` : "Cannot block: a non-empty reason is required.";
					return { action: request.action, state: { ...goal }, runtime: currentRuntime(), error: text, isError: true };
				}
				applyTransition(host, outcome);
				host.updateWidget(widgetGoal());
				notifyTerminal(host, "blocked", reason);
				return { action: request.action, state: outcome.state, runtime: currentRuntime() };
			}
		}
	}

	function evidenceError(summary: unknown, evidence: unknown): string | null {
		if (typeof summary !== "string" || summary.trim().length === 0) return "Completion requires a non-empty summary.";
		if (!Array.isArray(evidence) || evidence.length === 0) return "Completion requires at least one evidence item.";
		for (const item of evidence) {
			if (!isRecord(item)) return "Every evidence item must be complete.";
			if (typeof item.requirement !== "string" || typeof item.verification !== "string" ||
				item.requirement.trim().length === 0 || item.verification.trim().length === 0) {
				return "Every evidence item needs a requirement and verification.";
			}
			if (item.result !== "passed") return "Every completion evidence result must be passed.";
		}
		return null;
	}

	async function commandRequested(host: GoalLifecycleHost, args: string, current: () => boolean): Promise<void> {
		const previousGoal = goal;
		const outcome = await runGoalCommand(goal, args, now(), host);
		if (!current()) return;
		if (outcome.transition) {
			applyTransition(host, outcome.transition);
			if (goal && (!runtime || runtime.goalId !== goal.goalId)) {
				runtime = reconstructGoalRuntime([], goal.goalId, now());
			}
			if (outcome.transition.action === "resume" && runtime) {
				runtime = resetGoalRuntime(runtime, now(), previousGoal?.status === "budget_limited");
				persistRuntime(host);
			}
		}
		if (outcome.notification) {
			let text = outcome.notification.text;
			if (!(args || "").trim() && goal) text += `\n${runtimeLines(runtime).join("\n")}`;
			host.notify(text, outcome.notification.severity);
		}
		if (outcome.transition) host.updateWidget(widgetGoal());
		if (outcome.kickoff) host.sendKickoff(outcome.kickoff, !host.isIdle());
	}

	async function handle<E extends GoalLifecycleEvent>(event: E, generation: number): Promise<GoalLifecycleResult<E>> {
		const preSession = event.type === "commandRequested" || event.type === "toolRequested" ? event.preSession === true : false;
		const host = event.host;
		const current = () => isCurrent(host, generation, preSession);
		if (!current()) return neutralResult(event);

		switch (event.type) {
			case "agentPromptConstruction": {
				const addendum = goalPromptAddendum(goal);
				return (addendum ? { systemPrompt: `${event.systemPrompt}\n\n${addendum}` } : undefined) as GoalLifecycleResult<E>;
			}
			case "messageStarted":
				if (event.role === "custom" && event.customType === GOAL_CONTINUATION_CUSTOM_TYPE &&
					typeof event.goalId === "string" && event.goalId === pendingAutomaticGoalId && goal?.goalId === event.goalId) {
					automaticRun = startAutomaticRun(event.goalId);
					pendingAutomaticGoalId = null;
				} else if (event.role === "user" || event.role === "custom") {
					pendingAutomaticGoalId = null;
				}
				return undefined as GoalLifecycleResult<E>;
			case "turnEnded":
				if (automaticRun) automaticRun = recordGoalTurn(automaticRun, event.observation);
				host.updateWidget(widgetGoal());
				return undefined as GoalLifecycleResult<E>;
			case "agentSettled": {
				let terminalStopReason: "error" | "length" | "aborted" | undefined;
				const settledGoalId = automaticRun?.goalId;
				if (automaticRun && runtime?.goalId === automaticRun.goalId) {
					const finalized = finalizeAutomaticRun(runtime, automaticRun, now());
					runtime = finalized.snapshot;
					terminalStopReason = finalized.terminalStopReason;
					persistRuntime(host);
				}
				automaticRun = null;
				if (extensionCompactionInProgress && extensionCompactionSource === "turn_end" && goal?.status === "active") {
					deferredCompactionGoalId = goal.goalId;
					return undefined as GoalLifecycleResult<E>;
				}
				if (settledGoalId && goal?.goalId === settledGoalId && goal.status === "active") {
					if (terminalStopReason === "aborted") {
						const outcome = pauseGoal(goal, now());
						if (outcome.ok) {
							applyTransition(host, outcome);
							host.updateWidget(widgetGoal());
							notifyTerminal(host, "paused", "automatic work was interrupted");
						}
						return undefined as GoalLifecycleResult<E>;
					}
					if (terminalStopReason === "error" || terminalStopReason === "length") {
						stopGoal(host, "blocked", terminalStopReason === "error" ? "The model run ended with an error." : "The model response ended at its length limit.");
						return undefined as GoalLifecycleResult<E>;
					}
				}
				scheduleContinuation(host);
				return undefined as GoalLifecycleResult<E>;
			}
			case "compactionStateChanged":
				compactionStateChanged(host, event.event);
				return undefined as GoalLifecycleResult<E>;
			case "commandRequested":
				await commandRequested(host, event.args, current);
				return undefined as GoalLifecycleResult<E>;
			case "toolRequested":
				return executeTool(host, event.request) as GoalLifecycleResult<E>;
			case "sessionStarted":
			case "branchChanged":
			case "sessionStopping":
				return undefined as GoalLifecycleResult<E>;
		}
	}

	function neutralResult<E extends GoalLifecycleEvent>(event: E): GoalLifecycleResult<E> {
		if (event.type === "toolRequested") return neutralToolOutcome(event.request) as GoalLifecycleResult<E>;
		return undefined as GoalLifecycleResult<E>;
	}

	function startSession(event: Extract<GoalLifecycleEvent, { type: "sessionStarted" | "branchChanged" }>): Promise<void> {
		lifecycleGeneration += 1;
		const generation = lifecycleGeneration;
		clearTransientRun();
		clearCompactionState();
		activeHost = event.host;
		activeSession = true;
		return enqueue(() => {
			if (!isCurrent(event.host, generation, false)) return;
			goal = reconstructGoalState(event.branch);
			runtime = goal && goal.status !== "cleared" ? reconstructGoalRuntime(event.branch, goal.goalId, now()) : null;
			if (!isCurrent(event.host, generation, false)) return;
			event.host.updateWidget(widgetGoal());
		});
	}

	function stopSession(event: Extract<GoalLifecycleEvent, { type: "sessionStopping" }>): Promise<void> {
		if (!activeSession || activeHost !== event.host) return Promise.resolve();
		lifecycleGeneration += 1;
		activeSession = false;
		activeHost = undefined;
		goal = null;
		runtime = null;
		clearTransientRun();
		clearCompactionState();
		return enqueue(() => undefined);
	}

	function dispatch<E extends GoalLifecycleEvent>(event: E): Promise<GoalLifecycleResult<E>> {
		if (event.type === "sessionStarted" || event.type === "branchChanged") {
			return startSession(event) as Promise<GoalLifecycleResult<E>>;
		}
		if (event.type === "sessionStopping") return stopSession(event) as Promise<GoalLifecycleResult<E>>;

		const preSession = event.type === "commandRequested" || event.type === "toolRequested" ? event.preSession === true : false;
		if (preSession ? activeSession : !activeSession || activeHost !== event.host) {
			return Promise.resolve(neutralResult(event));
		}
		const generation = lifecycleGeneration;
		return enqueue(() => handle(event, generation));
	}

	return { dispatch };
}

