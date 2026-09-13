/**
 * Goal Extension - Persistent goal mode for pi
 *
 * Recreates Codex's `/goal` feature:
 * - Set a persistent objective that pi works toward across many turns
 * - pi keeps working independently until the goal is complete
 * - View, pause, resume, or clear the goal at any time
 * - LLM can report checkpoints and mark goal as done
 * - Goal status widget shown above the editor
 *
 * Commands:
 *   /goal                  - View current goal status
 *   /goal <objective>      - Set a new goal (starts working immediately)
 *   /goal pause            - Pause the active goal
 *   /goal resume           - Resume a paused goal
 *   /goal clear            - Clear/remove the goal
 *   /goal edit <objective> - Edit the active goal objective
 *   /goal checkpoint <txt> - Add a manual checkpoint
 *
 * LLM Tool: `goal` - Let the agent check status, report progress, mark done
 *
 * State transitions live in goal-state.ts; the /goal command surface lives in
 * goal-commands.ts and the prompt builders in goal-prompts.ts. This adapter
 * owns Pi wiring, notification delivery, persistence, and rendering.
 */

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { registerToolErrorHandler, renderToolSummary } from "../_shared/tool-result-ui.ts";
import { UI_GLYPHS } from "../_shared/ui-style.ts";
import { runGoalCommand } from "./goal-commands.ts";
import { goalPromptAddendum } from "./goal-prompts.ts";
import {
	checkpointGoal,
	completeGoal,
	GOAL_CUSTOM_TYPE,
	reconstructGoalState,
	type AppliedGoalTransition,
	type GoalEntryData,
	type GoalState,
} from "./goal-state.ts";

// ─── Parameters ──────────────────────────────────────────────────────────────

const GoalToolParams = Type.Object({
	action: StringEnum(["status", "checkpoint", "complete"] as const),
	/** For checkpoint: what was just verified/accomplished */
	summary: Type.Optional(Type.String({ description: "Progress summary (for checkpoint or complete)" })),
	/** For checkpoint: what remains to be done */
	remaining: Type.Optional(Type.String({ description: "What remains to be done (for checkpoint)" })),
});

/**
 * Tool result text that marks a failed goal transition. Live results classify
 * through `details.error`; this regex is only the render-time fallback for
 * historical entries persisted before `details.error` was always set (and for
 * the unknown-action branch, unreachable through schema validation).
 */
const isGoalFailureText = (text: string): boolean =>
	/^(Cannot checkpoint|Goal is already|Unknown action)/.test(text);

// ─── UI: Goal Status Widget ──────────────────────────────────────────────────

class GoalStatusWidget {
	private goal: GoalState | null;
	private theme: Theme;
	private onClose: () => void;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(goal: GoalState | null, theme: Theme, onClose: () => void) {
		this.goal = goal;
		this.theme = theme;
		this.onClose = onClose;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.onClose();
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}

		const th = this.theme;
		const lines: string[] = [];

		if (!this.goal || this.goal.status === "cleared") {
			lines.push(th.fg("dim", "  No active goal. Use /goal <objective> to set one."));
		} else {
			const statusIcon = this.goal.status === "active"
				? th.fg("accent", UI_GLYPHS.checked)
				: this.goal.status === "paused"
					? th.fg("warning", "⏸")
					: th.fg("success", UI_GLYPHS.confirm);

			const statusLabel = this.goal.status === "active"
				? th.fg("accent", "ACTIVE")
				: this.goal.status === "paused"
					? th.fg("warning", "PAUSED")
					: th.fg("success", "COMPLETED");

			// Title bar
			const titleText = ` ${statusIcon} Goal ${statusLabel} `;
			const remainingWidth = Math.max(0, width - titleText.length - 2);
			const bar = th.fg("borderMuted", "─".repeat(remainingWidth));
			lines.push(truncateToWidth(titleText + bar, width));

			// Objective
			const maxObjWidth = width - 4;
			const objective = this.goal.objective;
			if (objective.length > maxObjWidth) {
				lines.push(truncateToWidth(`  ${th.bold(th.fg("text", objective.slice(0, maxObjWidth - 1) + "…"))}`, width));
			} else {
				lines.push(truncateToWidth(`  ${th.bold(th.fg("text", objective))}`, width));
			}

			// Checkpoint progress
			if (this.goal.checkpointProgress) {
				const progLines = this.goal.checkpointProgress.split("\n");
				for (const line of progLines.slice(0, 3)) {
					lines.push(truncateToWidth(`  ${th.fg("muted", line)}`, width));
				}
				if (progLines.length > 3) {
					lines.push(th.fg("dim", `  ... ${progLines.length - 3} more lines`));
				}
			}

			// Completion summary
			if (this.goal.completionSummary) {
				lines.push("");
				lines.push(truncateToWidth(`  ${th.fg("success", `${UI_GLYPHS.confirm} `)}${th.fg("muted", this.goal.completionSummary)}`, width));
			}

			// Help hint
			lines.push("");
			lines.push(truncateToWidth(
				`  ${th.fg("dim", "/goal pause | resume | clear  ·  Press Esc to dismiss")}`,
				width,
			));
		}

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

// ─── Extension ───────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	registerToolErrorHandler(pi, ["goal"], (event) => {
		const details = event.details as { error?: string } | undefined;
		return Boolean(details?.error);
	});

	let goal: GoalState | null = null;

	// ── Goal Status Widget ────────────────────────────────────────────────

	let goalWidget: GoalStatusWidget | undefined;

	function updateGoalWidget(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		if (!goal || goal.status === "cleared") {
			ctx.ui.setWidget("goal-status", undefined);
			goalWidget = undefined;
			return;
		}
		ctx.ui.setWidget("goal-status", (_tui, theme) => {
			goalWidget = new GoalStatusWidget(goal, theme, () => {
				ctx.ui.setWidget("goal-status", undefined);
				goalWidget = undefined;
			});
			return goalWidget;
		});
	}

	// ── State Reconstruction ────────────────────────────────────────────

	const reconstructState = (ctx: ExtensionContext) => {
		goal = reconstructGoalState(ctx.sessionManager.getBranch());
	};

	// Apply a successful transition: swap the in-memory goal and persist the entry.
	const applyTransition = (outcome: AppliedGoalTransition) => {
		goal = outcome.goal;
		pi.appendEntry(GOAL_CUSTOM_TYPE, {
			action: outcome.action,
			state: outcome.state,
		} as GoalEntryData);
	};

	// ── Lifecycle Events ────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		reconstructState(ctx);
		updateGoalWidget(ctx);
	});
	pi.on("session_tree", async (_event, ctx) => {
		reconstructState(ctx);
		updateGoalWidget(ctx);
	});

	// Inject goal context into the system prompt
	pi.on("before_agent_start", async (event, _ctx) => {
		const addendum = goalPromptAddendum(goal);
		if (!addendum) return;

		return {
			systemPrompt: event.systemPrompt + "\n\n" + addendum,
		};
	});

	// Show goal status in a widget
	pi.on("turn_end", async (_event, ctx) => {
		updateGoalWidget(ctx);
		if (!goal || goal.status === "cleared") return;

		// If goal was just completed, notify
		if (goal.status === "completed") {
			ctx.ui.notify(
				`Goal completed: ${goal.completionSummary || goal.objective}`,
				"info",
			);
		}
	});

	// ── Goal Tool (for LLM) ─────────────────────────────────────────────

	pi.registerTool({
		name: "goal",
		label: "Goal",
		description: "Check or update a persistent goal's progress.",
		promptSnippet: "Track goal progress",
		parameters: GoalToolParams,

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			if (!goal) {
				if (params.action === "status") {
					return {
						content: [{ type: "text", text: "No active goal." }],
						details: { action: "status" },
					};
				}
				return {
					content: [{ type: "text", text: "No active goal." }],
					details: { action: params.action, error: "No active goal." },
					isError: true,
				};
			}

			switch (params.action) {
				case "status": {
					const lines = [
						`Goal: ${goal.objective}`,
						`Status: ${goal.status}`,
					];
					if (goal.checkpointProgress) {
						lines.push(`Last checkpoint: ${goal.checkpointProgress}`);
					}
					return {
						content: [{ type: "text", text: lines.join("\n") }],
						details: { action: "status", state: { ...goal } },
					};
				}

				case "checkpoint": {
					const outcome = checkpointGoal(goal, params.summary || "Progress reported", Date.now());
					if (!outcome.ok) {
						const text = `Cannot checkpoint: goal is ${goal.status}.`;
						return {
							content: [{ type: "text", text }],
							details: { action: "checkpoint", state: { ...goal }, error: text },
							isError: true,
						};
					}
					applyTransition(outcome);

					const msg = params.remaining
						? `Checkpoint: ${params.summary}\nRemaining: ${params.remaining}`
						: `Checkpoint: ${params.summary}`;

					return {
						content: [{ type: "text", text: msg }],
						details: { action: "checkpoint", state: { ...outcome.state } },
					};
				}

				case "complete": {
					const outcome = completeGoal(goal, params.summary || "Goal completed", Date.now());
					if (!outcome.ok) {
						const text = `Goal is already ${goal.status}.`;
						return {
							content: [{ type: "text", text }],
							details: { action: "complete", state: { ...goal }, error: text },
							isError: true,
						};
					}
					applyTransition(outcome);

					return {
						content: [
							{
								type: "text",
								text: `✓ Goal completed: ${outcome.state.completionSummary}`,
							},
						],
						details: { action: "complete", state: { ...outcome.state } },
					};
				}

				default:
					return {
						content: [{ type: "text", text: `Unknown action: ${(params as any).action}` }],
						details: {},
						isError: true,
					};
			}
		},

		renderCall(args, theme, _context) {
			const icon = args.action === "complete" ? UI_GLYPHS.confirm : args.action === "checkpoint" ? UI_GLYPHS.running : "i";
			let text = theme.fg("toolTitle", theme.bold(`goal ${icon} `)) + theme.fg("muted", args.action);
			if (args.summary) {
				text += ` ${theme.fg("dim", `"${args.summary.slice(0, 60)}${args.summary.length > 60 ? "…" : ""}"`)}`;
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, options, theme, context) {
			const text = result.content[0];
			const msg = text?.type === "text" ? text.text : "";
			const details = result.details as { action?: string; error?: string } | undefined;
			const isComplete = msg.startsWith("✓");
			// isGoalFailureText: fallback for historical entries persisted before
			// details.error was always set (see its doc comment).
			const isFailure = context.isError || Boolean(details?.error) || isGoalFailureText(msg);
			if (options.isPartial) return renderToolSummary(theme, "running", "Updating goal…");
			if (isFailure) return renderToolSummary(theme, "error", msg || "Goal update failed.");
			if (!options.expanded) {
				const action = (result.details as { action?: string } | undefined)?.action;
				const summary = action === "status"
					? "Goal status available"
					: isComplete
						? "Goal completed"
						: "Goal updated";
				return renderToolSummary(theme, "success", summary, true);
			}
			return new Text(isComplete ? theme.fg("success", msg) : theme.fg("toolOutput", msg), 0, 0);
		},
	});

	// ── Goal Command ────────────────────────────────────────────────────

	pi.registerCommand("goal", {
		description: "Set, view, pause, resume, or clear a task goal",
		handler: async (args, ctx) => {
			const outcome = await runGoalCommand(goal, args, Date.now(), {
				confirm: (title, body) =>
					ctx.hasUI ? ctx.ui.confirm(title, body) : Promise.resolve(true),
			});
			if (outcome.transition) applyTransition(outcome.transition);
			if (outcome.notification) {
				ctx.ui.notify(outcome.notification.text, outcome.notification.severity);
			}
			if (outcome.transition) updateGoalWidget(ctx);
			if (outcome.kickoff) pi.sendUserMessage(outcome.kickoff);
		},
	});
}

