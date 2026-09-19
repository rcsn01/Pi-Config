/** Pi adapter for persistent goal state and bounded automatic continuation. */

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { matchesKey, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { registerToolErrorHandler, renderToolSummary } from "../_shared/tool-result-ui.ts";
import { UI_GLYPHS } from "../_shared/ui-style.ts";
import {
	COMPACTION_STATE_EVENT,
	createGoalLifecycle,
	GOAL_CONTINUATION_CUSTOM_TYPE,
	GOAL_CONTINUATION_MESSAGE,
	isCompactionStateEvent,
	type GoalLifecycleHost,
	type GoalToolOutcome,
	type GoalToolRequest,
} from "./goal-lifecycle.ts";
import { GOAL_RUNTIME_CUSTOM_TYPE, runtimeLines } from "./goal-runtime.ts";
import {
	GOAL_CUSTOM_TYPE,
	type GoalEntryData,
	type GoalEvidence,
	type GoalState,
} from "./goal-state.ts";

const isGoalFailureText = (text: string): boolean =>
	/^(Cannot checkpoint|Cannot complete|Cannot block|Unknown action|No active goal)/.test(text);

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

function adaptToolOutcome(request: GoalToolRequest, outcome: GoalToolOutcome) {
	if (request.action === "status") {
		if (!outcome.state) {
			return { content: [{ type: "text" as const, text: "No active goal." }], details: { action: "status" } };
		}
		const lines = [`Goal: ${outcome.state.objective}`, `Status: ${outcome.state.status}`, ...runtimeLines(outcome.runtime)];
		if (outcome.state.checkpointProgress) lines.push(`Last checkpoint: ${outcome.state.checkpointProgress}`);
		if (outcome.state.blockedReason) lines.push(`Blocked: ${outcome.state.blockedReason}`);
		if (outcome.state.limitReason) lines.push(`Limit: ${outcome.state.limitReason}`);
		if (outcome.state.completionEvidence?.length) {
			lines.push("Evidence:");
			for (const item of outcome.state.completionEvidence) {
				lines.push(`- [${item.result}] ${item.requirement}: ${item.verification}`);
			}
		}
		return {
			content: [{ type: "text" as const, text: lines.join("\n") }],
			details: { action: "status", state: { ...outcome.state }, runtime: outcome.runtime },
		};
	}

	if (outcome.error) {
		return {
			content: [{ type: "text" as const, text: outcome.error }],
			details: {
				action: request.action,
				...(outcome.state && !(request.action === "checkpoint" && outcome.error === "Cannot checkpoint: a non-empty summary is required.")
					? { state: { ...outcome.state } } : {}),
				error: outcome.error,
			},
			isError: true,
		};
	}

	if (request.action === "checkpoint") {
		const summary = request.summary?.trim() ?? "";
		const text = request.remaining ? `Checkpoint: ${summary}\nRemaining: ${request.remaining}` : `Checkpoint: ${summary}`;
		return {
			content: [{ type: "text" as const, text }],
			details: { action: "checkpoint", state: { ...outcome.state! } },
		};
	}

	if (request.action === "complete") {
		const evidence = outcome.evidence ?? request.evidence ?? [];
		const evidenceText = evidence.map((item) => `- ${item.requirement}: ${item.verification}`).join("\n");
		return {
			content: [{ type: "text" as const, text: `${UI_GLYPHS.confirm} Goal completed: ${outcome.state!.completionSummary}\n${evidenceText}` }],
			details: { action: "complete", state: { ...outcome.state! }, evidence },
		};
	}

	return {
		content: [{ type: "text" as const, text: `Goal blocked: ${request.reason?.trim() ?? ""}` }],
		details: { action: "blocked", state: { ...outcome.state! } },
	};
}

export default function goalExtension(pi: ExtensionAPI): void {
	registerToolErrorHandler(pi, ["goal"], (event) => {
		const details = event.details as { error?: string } | undefined;
		return Boolean(details?.error);
	});

	const lifecycle = createGoalLifecycle({ now: Date.now });
	let currentHost: GoalLifecycleHost | undefined;

	function createHost(ctx: ExtensionContext): GoalLifecycleHost {
		const host: GoalLifecycleHost = {
			confirm: (title, body) => ctx.hasUI ? ctx.ui.confirm(title, body) : Promise.resolve(true),
			appendGoalTransition(outcome) {
				pi.appendEntry(GOAL_CUSTOM_TYPE, { action: outcome.action, state: outcome.state } as GoalEntryData);
			},
			appendRuntime(snapshot) {
				pi.appendEntry(GOAL_RUNTIME_CUSTOM_TYPE, { ...snapshot });
			},
			updateWidget(goal) {
				if (!ctx.hasUI) return;
				const ownsWidget = () => currentHost === host || currentHost === undefined;
				if (!goal || goal.status === "cleared") {
					ctx.ui.setWidget("goal-status", undefined);
					return;
				}
				const widgetGoal = goal;
				ctx.ui.setWidget("goal-status", (_tui, theme) => {
					const widget = new GoalStatusWidget(widgetGoal, theme, () => {
						if (!ownsWidget()) return;
						ctx.ui.setWidget("goal-status", undefined);
					});
					return widget;
				});
			},
			notify(message, severity) {
				ctx.ui.notify(message, severity);
			},
			sendContinuation(goalId) {
				pi.sendMessage(
					{ customType: GOAL_CONTINUATION_CUSTOM_TYPE, content: GOAL_CONTINUATION_MESSAGE, display: false, details: { goalId } },
					{ deliverAs: "followUp", triggerTurn: true },
				);
			},
			sendKickoff(message, queued) {
				if (queued) pi.sendUserMessage(message, { deliverAs: "followUp" });
				else pi.sendUserMessage(message);
			},
			isIdle: () => ctx.isIdle(),
			hasPendingMessages: () => ctx.hasPendingMessages(),
		};
		return host;
	}

	let removeCompactionListener: (() => void) | undefined;
	const installCompactionListener = () => {
		if (removeCompactionListener) return;
		removeCompactionListener = pi.events.on(COMPACTION_STATE_EVENT, (value) => {
			if (!isCompactionStateEvent(value)) return;
			const host = currentHost;
			if (!host) return;
			void lifecycle.dispatch({ type: "compactionStateChanged", event: value, host }).catch(() => {});
		});
	};
	installCompactionListener();

	pi.on("session_start", async (_event, ctx) => {
		installCompactionListener();
		const host = createHost(ctx);
		currentHost = host;
		await lifecycle.dispatch({ type: "sessionStarted", branch: ctx.sessionManager.getBranch(), host });
	});

	pi.on("session_tree", async (_event, ctx) => {
		installCompactionListener();
		const host = createHost(ctx);
		currentHost = host;
		await lifecycle.dispatch({ type: "branchChanged", branch: ctx.sessionManager.getBranch(), host });
	});

	pi.on("session_shutdown", async () => {
		const host = currentHost;
		try {
			if (host) await lifecycle.dispatch({ type: "sessionStopping", host });
		} finally {
			if (currentHost === host) {
				currentHost = undefined;
				removeCompactionListener?.();
				removeCompactionListener = undefined;
			}
		}
	});

	pi.on("before_agent_start", async (event, _ctx) => {
		const host = currentHost;
		if (!host) return undefined;
		return lifecycle.dispatch({ type: "agentPromptConstruction", systemPrompt: event.systemPrompt, host });
	});

	pi.on("message_start", (event, _ctx) => {
		const host = currentHost;
		if (!host) return undefined;
		const message = event.message as { role?: string; customType?: string; details?: { goalId?: unknown } };
		const goalId = typeof message.details?.goalId === "string" ? message.details.goalId : undefined;
		return lifecycle.dispatch({ type: "messageStarted", role: message.role, customType: message.customType, goalId, host });
	});

	pi.on("turn_end", async (event, _ctx) => {
		const host = currentHost;
		if (!host) return;
		await lifecycle.dispatch({ type: "turnEnded", observation: event, host });
	});

	pi.on("agent_settled", async (_event, _ctx) => {
		const host = currentHost;
		if (!host) return;
		await lifecycle.dispatch({ type: "agentSettled", host });
	});

	pi.registerTool({
		name: "goal",
		label: "Goal",
		description: "Check or update a persistent goal's progress.",
		promptSnippet: "Track goal progress",
		parameters: GoalToolParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const host = currentHost ?? createHost(ctx);
			const request: GoalToolRequest = {
				action: params.action,
				summary: params.summary,
				remaining: params.remaining,
				reason: params.reason,
				evidence: params.evidence as GoalEvidence[] | undefined,
			};
			const outcome = await lifecycle.dispatch({
				type: "toolRequested",
				request,
				host,
				...(currentHost ? {} : { preSession: true as const }),
			});
			return adaptToolOutcome(request, outcome);
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
			const host = currentHost ?? createHost(ctx);
			await lifecycle.dispatch({
				type: "commandRequested",
				args,
				host,
				...(currentHost ? {} : { preSession: true as const }),
			});
		},
	});
}
