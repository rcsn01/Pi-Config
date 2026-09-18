/** Pi adapter for persistent goal state and bounded automatic continuation. */

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { matchesKey, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { registerToolErrorHandler, renderToolSummary } from "../_shared/tool-result-ui.ts";
import { UI_GLYPHS } from "../_shared/ui-style.ts";
import { runGoalCommand } from "./goal-commands.ts";
import { goalPromptAddendum } from "./goal-prompts.ts";
import {
	DEFAULT_GOAL_RUNTIME_CONFIG,
	decideGoalContinuation,
	finalizeAutomaticRun,
	GOAL_RUNTIME_CUSTOM_TYPE,
	reconstructGoalRuntime,
	recordContinuationRequested,
	recordGoalTurn,
	resetGoalRuntime,
	startAutomaticRun,
	type AutomaticGoalRun,
	type GoalRuntimeSnapshot,
} from "./goal-runtime.ts";
import {
	blockGoal,
	checkpointGoal,
	completeGoal,
	GOAL_CUSTOM_TYPE,
	limitGoal,
	pauseGoal,
	reconstructGoalState,
	type AppliedGoalTransition,
	type GoalEntryData,
	type GoalEvidence,
	type GoalState,
} from "./goal-state.ts";

const GOAL_CONTINUATION_CUSTOM_TYPE = "goal-continuation";
const COMPACTION_STATE_EVENT = "session-compaction:state";

const continuationMessage = `The persistent goal is still active. Continue with the next concrete action.

Inspect current state instead of repeating the previous summary. Perform useful
work or gather new evidence. A prose-only plan or status recap is not progress.
After meaningful progress, call goal with action=checkpoint. If every requirement
is verified, call goal with action=complete and provide structured evidence. If
work cannot continue without user input or an external state change, call goal
with action=blocked and give the specific reason.`;

const GoalEvidenceSchema = Type.Object({
	requirement: Type.String(),
	verification: Type.String(),
	result: StringEnum(["passed", "failed"] as const),
});

const GoalToolParams = Type.Object({
	action: StringEnum(["status", "checkpoint", "complete", "blocked"] as const),
	summary: Type.Optional(Type.String({ description: "Progress or completion summary" })),
	remaining: Type.Optional(Type.String({ description: "What remains after a checkpoint" })),
	reason: Type.Optional(Type.String({ description: "Specific blocker for action=blocked" })),
	evidence: Type.Optional(Type.Array(GoalEvidenceSchema)),
});

const isGoalFailureText = (text: string): boolean =>
	/^(Cannot checkpoint|Cannot complete|Cannot block|Unknown action|No active goal)/.test(text);

function evidenceError(summary: unknown, evidence: unknown): string | null {
	if (typeof summary !== "string" || summary.trim().length === 0) return "Completion requires a non-empty summary.";
	if (!Array.isArray(evidence) || evidence.length === 0) return "Completion requires at least one evidence item.";
	for (const item of evidence) {
		if (!item || typeof item !== "object") return "Every evidence item must be complete.";
		const candidate = item as Partial<GoalEvidence>;
		if (!candidate.requirement?.trim() || !candidate.verification?.trim()) {
			return "Every evidence item needs a requirement and verification.";
		}
		if (candidate.result !== "passed") return "Every completion evidence result must be passed.";
	}
	return null;
}

function runtimeLines(runtime: GoalRuntimeSnapshot | null): string[] {
	if (!runtime) return [];
	const lines = [`Continuation runs: ${runtime.continuationRuns}/${DEFAULT_GOAL_RUNTIME_CONFIG.maxContinuationRuns}`];
	if (runtime.consecutiveNoProgressRuns > 0) lines.push(`Consecutive no-progress runs: ${runtime.consecutiveNoProgressRuns}`);
	if (runtime.consecutiveFailureRuns > 0) lines.push(`Consecutive failure runs: ${runtime.consecutiveFailureRuns}`);
	return lines;
}

class GoalStatusWidget {
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(
		private readonly goal: GoalState,
		private readonly theme: Theme,
		private readonly onClose: () => void,
	) {}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) this.onClose();
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		const th = this.theme;
		const styles: Record<GoalState["status"], { label: string; color: "accent" | "warning" | "error" | "success"; icon: string }> = {
			active: { label: "ACTIVE", color: "accent", icon: UI_GLYPHS.checked },
			paused: { label: "PAUSED", color: "warning", icon: "⏸" },
			blocked: { label: "BLOCKED", color: "error", icon: UI_GLYPHS.error },
			budget_limited: { label: "BUDGET LIMITED", color: "warning", icon: UI_GLYPHS.warning },
			completed: { label: "COMPLETED", color: "success", icon: UI_GLYPHS.confirm },
			cleared: { label: "CLEARED", color: "warning", icon: UI_GLYPHS.warning },
		};
		const style = styles[this.goal.status];
		const title = ` ${th.fg(style.color, style.icon)} Goal ${th.fg(style.color, style.label)} `;
		const lines = [truncateToWidth(title + th.fg("borderMuted", "─".repeat(Math.max(0, width - title.length - 2))), width)];
		lines.push(truncateToWidth(`  ${th.bold(th.fg("text", this.goal.objective))}`, width));
		if (this.goal.checkpointProgress) {
			const progress = this.goal.checkpointProgress.split("\n");
			for (const line of progress.slice(0, 3)) lines.push(truncateToWidth(`  ${th.fg("muted", line)}`, width));
			if (progress.length > 3) lines.push(truncateToWidth(th.fg("dim", `  ... ${progress.length - 3} more lines`), width));
		}
		const reason = this.goal.blockedReason ?? this.goal.limitReason;
		if (reason) lines.push(truncateToWidth(`  ${th.fg(style.color, reason)}`, width));
		if (this.goal.completionSummary) lines.push(truncateToWidth(`  ${th.fg("success", `${UI_GLYPHS.confirm} ${this.goal.completionSummary}`)}`, width));
		const help = this.goal.status === "active"
			? "/goal pause | checkpoint | clear"
			: this.goal.status === "blocked" || this.goal.status === "budget_limited" || this.goal.status === "paused"
				? "/goal resume | clear"
				: "/goal clear";
		lines.push("", truncateToWidth(`  ${th.fg("dim", `${help} · Press Esc to dismiss`)}`, width));
		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

type CompactionStateEvent = {
	inProgress: boolean;
	source: "turn_end" | "before_agent_start";
	resumesRun: boolean;
	succeeded?: boolean;
	error?: string;
};

function isCompactionStateEvent(value: unknown): value is CompactionStateEvent {
	if (!value || typeof value !== "object") return false;
	const event = value as Partial<CompactionStateEvent>;
	return typeof event.inProgress === "boolean" &&
		(event.source === "turn_end" || event.source === "before_agent_start") &&
		typeof event.resumesRun === "boolean";
}

export default function goalExtension(pi: ExtensionAPI): void {
	registerToolErrorHandler(pi, ["goal"], (event) => {
		const details = event.details as { error?: string } | undefined;
		return Boolean(details?.error);
	});

	let goal: GoalState | null = null;
	let runtime: GoalRuntimeSnapshot | null = null;
	let pendingAutomaticGoalId: string | null = null;
	let automaticRun: AutomaticGoalRun | null = null;
	let extensionCompactionInProgress = false;
	let extensionCompactionSource: CompactionStateEvent["source"] | null = null;
	let deferredCompactionGoalId: string | null = null;
	let runtimeContext: ExtensionContext | null = null;
	let goalWidget: GoalStatusWidget | undefined;

	function updateGoalWidget(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		if (!goal || goal.status === "cleared") {
			ctx.ui.setWidget("goal-status", undefined);
			goalWidget = undefined;
			return;
		}
		const widgetGoal = goal;
		ctx.ui.setWidget("goal-status", (_tui, theme) => {
			goalWidget = new GoalStatusWidget(widgetGoal, theme, () => {
				ctx.ui.setWidget("goal-status", undefined);
				goalWidget = undefined;
			});
			return goalWidget;
		});
	}

	function clearTransientRun(): void {
		pendingAutomaticGoalId = null;
		automaticRun = null;
		deferredCompactionGoalId = null;
	}

	function reconstructState(ctx: ExtensionContext): void {
		const branch = ctx.sessionManager.getBranch();
		goal = reconstructGoalState(branch);
		runtime = goal && goal.status !== "cleared"
			? reconstructGoalRuntime(branch, goal.goalId, Date.now())
			: null;
	}

	function persistRuntime(): void {
		if (runtime) pi.appendEntry(GOAL_RUNTIME_CUSTOM_TYPE, { ...runtime });
	}

	function applyTransition(outcome: AppliedGoalTransition): void {
		const previousId = goal?.goalId;
		goal = outcome.goal;
		pi.appendEntry(GOAL_CUSTOM_TYPE, { action: outcome.action, state: outcome.state } as GoalEntryData);
		const terminal = outcome.action === "pause" || outcome.action === "clear" || outcome.action === "block" ||
			outcome.action === "complete" || outcome.action === "limit";
		if (terminal || (goal?.goalId !== previousId)) clearTransientRun();
	}

	function notifyTerminal(ctx: ExtensionContext, status: "blocked" | "budget_limited" | "paused" | "completed", reason: string): void {
		const labels = {
			blocked: "Goal blocked",
			budget_limited: "Goal budget limited",
			paused: "Goal paused",
			completed: "Goal completed",
		};
		ctx.ui.notify(`${labels[status]}: ${reason}`, status === "completed" ? "info" : "warning");
	}

	function stopGoal(ctx: ExtensionContext, status: "blocked" | "budget_limited", reason: string): void {
		if (!goal || goal.status !== "active") return;
		const outcome = status === "blocked" ? blockGoal(goal, reason, Date.now()) : limitGoal(goal, reason, Date.now());
		if (!outcome.ok) return;
		applyTransition(outcome);
		persistRuntime();
		updateGoalWidget(ctx);
		notifyTerminal(ctx, status, reason);
	}

	function scheduleContinuation(ctx: ExtensionContext): void {
		if (!goal || goal.status !== "active" || !runtime || runtime.goalId !== goal.goalId) return;
		if (extensionCompactionInProgress || !ctx.isIdle() || ctx.hasPendingMessages() || pendingAutomaticGoalId) return;
		const decision = decideGoalContinuation(goal, runtime);
		if (decision.action === "skip") return;
		if (decision.action === "stop") {
			stopGoal(ctx, decision.status, decision.reason);
			return;
		}
		const goalId = goal.goalId;
		runtime = recordContinuationRequested(runtime, Date.now());
		persistRuntime();
		pendingAutomaticGoalId = goalId;
		try {
			pi.sendMessage(
				{ customType: GOAL_CONTINUATION_CUSTOM_TYPE, content: continuationMessage, display: false, details: { goalId } },
				{ deliverAs: "followUp", triggerTurn: true },
			);
		} catch (error) {
			pendingAutomaticGoalId = null;
			ctx.ui.notify(`Goal continuation failed: ${error instanceof Error ? error.message : String(error)}`, "error");
		}
	}

	const removeCompactionListener = pi.events.on(COMPACTION_STATE_EVENT, (value) => {
		if (!isCompactionStateEvent(value)) return;
		if (value.inProgress) {
			extensionCompactionInProgress = true;
			extensionCompactionSource = value.source;
			return;
		}
		extensionCompactionInProgress = false;
		extensionCompactionSource = null;
		const deferredId = deferredCompactionGoalId;
		deferredCompactionGoalId = null;
		if (!deferredId || !runtimeContext || !goal || goal.goalId !== deferredId || goal.status !== "active") return;
		if (value.succeeded) {
			if (!value.resumesRun) scheduleContinuation(runtimeContext);
			return;
		}
		stopGoal(runtimeContext, "blocked", value.error?.trim() || "Session compaction failed.");
	});

	pi.on("session_start", async (_event, ctx) => {
		clearTransientRun();
		extensionCompactionInProgress = false;
		extensionCompactionSource = null;
		runtimeContext = ctx;
		reconstructState(ctx);
		updateGoalWidget(ctx);
	});
	pi.on("session_tree", async (_event, ctx) => {
		clearTransientRun();
		extensionCompactionInProgress = false;
		extensionCompactionSource = null;
		runtimeContext = ctx;
		reconstructState(ctx);
		updateGoalWidget(ctx);
	});
	pi.on("session_shutdown", () => {
		clearTransientRun();
		extensionCompactionInProgress = false;
		extensionCompactionSource = null;
		runtimeContext = null;
		removeCompactionListener();
	});

	pi.on("before_agent_start", async (event, ctx) => {
		runtimeContext = ctx;
		const addendum = goalPromptAddendum(goal);
		if (addendum) return { systemPrompt: `${event.systemPrompt}\n\n${addendum}` };
	});

	pi.on("message_start", (event, ctx) => {
		runtimeContext = ctx;
		const message = event.message as { role?: string; customType?: string; details?: { goalId?: string } };
		if (message.role === "custom" && message.customType === GOAL_CONTINUATION_CUSTOM_TYPE) {
			const goalId = message.details?.goalId;
			if (goalId && goalId === pendingAutomaticGoalId && goal?.goalId === goalId) {
				automaticRun = startAutomaticRun(goalId);
				pendingAutomaticGoalId = null;
				return;
			}
		}
		if (message.role === "user" || message.role === "custom") pendingAutomaticGoalId = null;
	});

	pi.on("turn_end", async (event, ctx) => {
		runtimeContext = ctx;
		if (automaticRun) automaticRun = recordGoalTurn(automaticRun, event);
		updateGoalWidget(ctx);
	});

	pi.on("agent_settled", async (_event, ctx) => {
		runtimeContext = ctx;
		let terminalStopReason: "error" | "length" | "aborted" | undefined;
		const settledGoalId = automaticRun?.goalId;
		if (automaticRun && runtime?.goalId === automaticRun.goalId) {
			const finalized = finalizeAutomaticRun(runtime, automaticRun, Date.now());
			runtime = finalized.snapshot;
			terminalStopReason = finalized.terminalStopReason;
			persistRuntime();
		}
		automaticRun = null;

		if (extensionCompactionInProgress && extensionCompactionSource === "turn_end" && goal?.status === "active") {
			deferredCompactionGoalId = goal.goalId;
			return;
		}
		if (settledGoalId && goal?.goalId === settledGoalId && goal.status === "active") {
			if (terminalStopReason === "aborted") {
				const outcome = pauseGoal(goal, Date.now());
				if (outcome.ok) {
					applyTransition(outcome);
					updateGoalWidget(ctx);
					notifyTerminal(ctx, "paused", "automatic work was interrupted");
				}
				return;
			}
			if (terminalStopReason === "error" || terminalStopReason === "length") {
				stopGoal(ctx, "blocked", terminalStopReason === "error" ? "The model run ended with an error." : "The model response ended at its length limit.");
				return;
			}
		}
		scheduleContinuation(ctx);
	});

	pi.registerTool({
		name: "goal",
		label: "Goal",
		description: "Check or update a persistent goal's progress.",
		promptSnippet: "Track goal progress",
		parameters: GoalToolParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			runtimeContext = ctx;
			if (!goal) {
				const error = params.action === "status" ? undefined : "No active goal.";
				return {
					content: [{ type: "text" as const, text: "No active goal." }],
					details: { action: params.action, ...(error ? { error } : {}) },
					...(error ? { isError: true } : {}),
				};
			}
			switch (params.action) {
				case "status": {
					const lines = [`Goal: ${goal.objective}`, `Status: ${goal.status}`, ...runtimeLines(runtime)];
					if (goal.checkpointProgress) lines.push(`Last checkpoint: ${goal.checkpointProgress}`);
					if (goal.blockedReason) lines.push(`Blocked: ${goal.blockedReason}`);
					if (goal.limitReason) lines.push(`Limit: ${goal.limitReason}`);
					if (goal.completionEvidence?.length) {
						lines.push("Evidence:");
						for (const item of goal.completionEvidence) {
							lines.push(`- [${item.result}] ${item.requirement}: ${item.verification}`);
						}
					}
					return { content: [{ type: "text" as const, text: lines.join("\n") }], details: { action: "status", state: { ...goal }, runtime } };
				}
				case "checkpoint": {
					const summary = params.summary?.trim() ?? "";
					if (!summary) {
						const text = "Cannot checkpoint: a non-empty summary is required.";
						return { content: [{ type: "text" as const, text }], details: { action: "checkpoint", error: text }, isError: true };
					}
					const outcome = checkpointGoal(goal, summary, Date.now());
					if (!outcome.ok) {
						const text = `Cannot checkpoint: goal is ${goal.status}.`;
						return { content: [{ type: "text" as const, text }], details: { action: "checkpoint", state: { ...goal }, error: text }, isError: true };
					}
					applyTransition(outcome);
					updateGoalWidget(ctx);
					const text = params.remaining ? `Checkpoint: ${summary}\nRemaining: ${params.remaining}` : `Checkpoint: ${summary}`;
					return { content: [{ type: "text" as const, text }], details: { action: "checkpoint", state: { ...outcome.state } } };
				}
				case "complete": {
					const error = evidenceError(params.summary, params.evidence);
					if (error || goal.status !== "active") {
						const text = error ?? `Cannot complete: goal is ${goal.status}.`;
						return { content: [{ type: "text" as const, text }], details: { action: "complete", state: { ...goal }, error: text }, isError: true };
					}
					const evidence = params.evidence as GoalEvidence[];
					const outcome = completeGoal(goal, params.summary!.trim(), Date.now(), evidence);
					if (!outcome.ok) throw new Error("validated completion transition failed");
					applyTransition(outcome);
					updateGoalWidget(ctx);
					notifyTerminal(ctx, "completed", outcome.state.completionSummary ?? outcome.state.objective);
					const evidenceText = evidence.map((item) => `- ${item.requirement}: ${item.verification}`).join("\n");
					return {
						content: [{ type: "text" as const, text: `${UI_GLYPHS.confirm} Goal completed: ${outcome.state.completionSummary}\n${evidenceText}` }],
						details: { action: "complete", state: { ...outcome.state }, evidence },
					};
				}
				case "blocked": {
					const reason = params.reason?.trim() ?? "";
					const outcome = blockGoal(goal, reason, Date.now());
					if (!outcome.ok) {
						const text = reason ? `Cannot block: goal is ${goal.status}.` : "Cannot block: a non-empty reason is required.";
						return { content: [{ type: "text" as const, text }], details: { action: "blocked", state: { ...goal }, error: text }, isError: true };
					}
					applyTransition(outcome);
					updateGoalWidget(ctx);
					notifyTerminal(ctx, "blocked", reason);
					return { content: [{ type: "text" as const, text: `Goal blocked: ${reason}` }], details: { action: "blocked", state: { ...outcome.state } } };
				}
				default:
					return { content: [{ type: "text" as const, text: `Unknown action: ${(params as { action: string }).action}` }], details: { error: "Unknown action" }, isError: true };
			}
		},

		renderCall(args, theme) {
			const icon = args.action === "complete" ? UI_GLYPHS.confirm : args.action === "checkpoint" ? UI_GLYPHS.running : "i";
			const detail = args.summary ?? args.reason;
			let text = theme.fg("toolTitle", theme.bold(`goal ${icon} `)) + theme.fg("muted", args.action);
			if (detail) text += ` ${theme.fg("dim", `"${detail.slice(0, 60)}${detail.length > 60 ? "…" : ""}"`)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, options, theme, context) {
			const first = result.content[0];
			const message = first?.type === "text" ? first.text : "";
			const details = result.details as { action?: string; error?: string } | undefined;
			const failure = context.isError || Boolean(details?.error) || isGoalFailureText(message);
			if (options.isPartial) return renderToolSummary(theme, "running", "Updating goal…");
			if (failure) return renderToolSummary(theme, "error", message || "Goal update failed.");
			if (!options.expanded) {
				const summary = details?.action === "status" ? "Goal status available" : details?.action === "complete" ? "Goal completed" : "Goal updated";
				return renderToolSummary(theme, "success", summary, true);
			}
			return new Text(details?.action === "complete" ? theme.fg("success", message) : theme.fg("toolOutput", message), 0, 0);
		},
	});

	pi.registerCommand("goal", {
		description: "Set, view, pause, resume, block, or clear a task goal",
		handler: async (args, ctx) => {
			runtimeContext = ctx;
			const previousGoal = goal;
			const outcome = await runGoalCommand(goal, args, Date.now(), {
				confirm: (title, body) => ctx.hasUI ? ctx.ui.confirm(title, body) : Promise.resolve(true),
			});
			if (outcome.transition) {
				applyTransition(outcome.transition);
				if (goal && (!runtime || runtime.goalId !== goal.goalId)) {
					runtime = reconstructGoalRuntime([], goal.goalId, Date.now());
				}
				if (outcome.transition.action === "resume" && runtime) {
					runtime = resetGoalRuntime(runtime, Date.now(), previousGoal?.status === "budget_limited");
					persistRuntime();
				}
			}
			if (outcome.notification) {
				let text = outcome.notification.text;
				if (!(args || "").trim() && goal) text += `\n${runtimeLines(runtime).join("\n")}`;
				ctx.ui.notify(text, outcome.notification.severity);
			}
			if (outcome.transition) updateGoalWidget(ctx);
			if (outcome.kickoff) {
				if (ctx.isIdle()) pi.sendUserMessage(outcome.kickoff);
				else pi.sendUserMessage(outcome.kickoff, { deliverAs: "followUp" });
			}
		},
	});
}
