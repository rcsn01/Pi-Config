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
 * State transitions live in goal-state.ts; this adapter owns command parsing,
 * confirmation, notifications, persistence, and rendering.
 */

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { registerToolErrorHandler, renderToolSummary } from "../_shared/tool-result-ui.ts";
import { UI_GLYPHS } from "../_shared/ui-style.ts";
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

/** Tool result text that marks a failed goal transition (shared by the error handler and rendering). */
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
		const text = event.content.find((content) => content.type === "text")?.text ?? "";
		return Boolean(details?.error) || isGoalFailureText(text);
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
		if (!goal || goal.status === "cleared" || goal.status === "completed") {
			return;
		}

		const isPaused = goal.status === "paused";
		const goalInstructions = isPaused
			? buildPausedGoalPrompt(goal)
			: buildActiveGoalPrompt(goal);

		return {
			systemPrompt: event.systemPrompt + "\n\n" + goalInstructions,
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
						return {
							content: [{ type: "text", text: `Cannot checkpoint: goal is ${goal.status}.` }],
							details: { action: "checkpoint", state: { ...goal } },
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
						return {
							content: [{ type: "text", text: `Goal is already ${goal.status}.` }],
							details: { action: "complete", state: { ...goal } },
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
			const trimmedArgs = (args || "").trim();

			// /goal - view current goal
			if (!trimmedArgs) {
				if (!goal || goal.status === "cleared") {
					ctx.ui.notify(
						"No active goal. Use /goal <objective> to set one.",
						"info",
					);
				} else {
					ctx.ui.notify(formatGoalStatus(goal), "info");
				}
				return;
			}

			// /goal pause
			if (trimmedArgs === "pause") {
				const outcome = pauseGoal(goal, Date.now());
				if (!outcome.ok) {
					if (outcome.reason === "already-paused") {
						ctx.ui.notify("Goal is already paused.", "warning");
					} else if (outcome.reason === "completed") {
						ctx.ui.notify("Goal is already completed. Use /goal <objective> to set a new one.", "warning");
					} else {
						ctx.ui.notify("No active goal to pause.", "warning");
					}
					return;
				}
				applyTransition(outcome);
				ctx.ui.notify(`Goal paused: "${outcome.state.objective}"`, "info");
				updateGoalWidget(ctx);
				return;
			}

			// /goal resume
			if (trimmedArgs === "resume") {
				const outcome = resumeGoal(goal, Date.now());
				if (!outcome.ok) {
					if (outcome.reason === "already-active") {
						ctx.ui.notify("Goal is already active.", "warning");
					} else if (outcome.reason === "completed") {
						ctx.ui.notify("Goal is already completed. Use /goal <objective> to set a new one.", "warning");
					} else {
						ctx.ui.notify("No goal to resume.", "warning");
					}
					return;
				}
				applyTransition(outcome);
				ctx.ui.notify(`Goal resumed: "${outcome.state.objective}"`, "info");
				updateGoalWidget(ctx);
				return;
			}

			// /goal edit <objective>
			if (trimmedArgs.startsWith("edit ")) {
				const nextObjective = trimmedArgs.slice(5).trim();
				const outcome = editGoal(goal, nextObjective, Date.now());
				if (!outcome.ok) {
					if (outcome.reason === "empty-objective") {
						ctx.ui.notify("Usage: /goal edit <new objective>", "warning");
					} else {
						ctx.ui.notify("No active goal to edit.", "warning");
					}
					return;
				}
				applyTransition(outcome);
				ctx.ui.notify(`Goal updated: ${nextObjective}`, "info");
				updateGoalWidget(ctx);
				return;
			}

			// /goal checkpoint <summary>
			if (trimmedArgs.startsWith("checkpoint ")) {
				const summary = trimmedArgs.slice("checkpoint ".length).trim();
				const outcome = checkpointGoal(goal, summary, Date.now());
				if (!outcome.ok) {
					ctx.ui.notify("No active goal to checkpoint.", "warning");
					return;
				}
				applyTransition(outcome);
				ctx.ui.notify(`Checkpoint saved: ${outcome.state.checkpointProgress}`, "info");
				updateGoalWidget(ctx);
				return;
			}

			// /goal clear
			if (trimmedArgs === "clear") {
				const wasCompleted = goal?.status === "completed";
				const outcome = clearGoal(goal, Date.now());
				if (!outcome.ok) {
					ctx.ui.notify("No goal to clear.", "warning");
					return;
				}
				applyTransition(outcome);
				ctx.ui.notify(
					wasCompleted ? "Completed goal cleared." : "Goal cleared.",
					"info",
				);
				updateGoalWidget(ctx);
				return;
			}

			// /goal <objective> - set a new goal and start working immediately
			if (trimmedArgs.length > MAX_OBJECTIVE_LENGTH) {
				ctx.ui.notify(
					`Goal objective too long (max ${MAX_OBJECTIVE_LENGTH} characters). Put details in a file and reference it.`,
					"error",
				);
				return;
			}

			// If there's an existing active/paused goal, confirm replacement
			if (goal && (goal.status === "active" || goal.status === "paused")) {
				if (ctx.hasUI) {
					const replace = await ctx.ui.confirm(
						"Replace goal?",
						`An active goal already exists: "${goal.objective}". Replace it?`,
					);
					if (!replace) return;
				}
			}

			const outcome = setGoal(trimmedArgs, Date.now());
			if (!outcome.ok) return;
			applyTransition(outcome);

			ctx.ui.notify(`Goal set: "${trimmedArgs}"`, "info");
			updateGoalWidget(ctx);

			// Kick off the agent to start working on the goal immediately.
			// sendUserMessage triggers a turn, and the goal prompt injected
			// via before_agent_start will give detailed instructions.
			pi.sendUserMessage(
				`Goal: ${trimmedArgs}\n\nStart working on this goal now. Plan your approach, then begin implementing. ` +
				`Use the goal tool to report checkpoints as you make progress. ` +
				`Work independently and keep going until the goal is fully achieved.`,
			);
		},
	});
}

// ─── Prompt builders ─────────────────────────────────────────────────────────

function buildActiveGoalPrompt(goal: GoalState): string {
	let instructions = `## Active Goal

You are working toward a persistent goal. Focus on this objective and continue
making progress without asking for permission to proceed. Work independently
and keep going until the goal is achieved.

**Goal Objective:** ${goal.objective}

### How to Work on This Goal

1. **Plan first.** Before implementing, understand what needs to be done.
2. **Work in checkpoints.** After each meaningful step, use the goal tool with
   action=checkpoint to report your progress. Name what you verified and what remains.
3. **Validate your work.** Run tests, builds, or checks after each checkpoint.
4. **Know when you're done.** Only mark the goal complete when you're confident
   the objective is fully achieved.

### Rules

- Do NOT stop after one turn — keep working until the goal is complete.
- Do NOT ask the user for permission to proceed on routine steps within scope.
- If you encounter a blocker you cannot resolve, explain it clearly.
- Stay focused on the goal. Don't do unrelated work.`;

	if (goal.checkpointProgress) {
		instructions += `\n\n**Last Checkpoint:** ${goal.checkpointProgress}`;
	}

	return instructions;
}

function buildPausedGoalPrompt(goal: GoalState): string {
	let instructions = `## Paused Goal

The following goal is paused. Do NOT work on it unless the user explicitly
asks you to resume it with /goal resume or gives you a direct instruction
related to this goal.

**Goal Objective:** ${goal.objective}

If the user asks about this goal, remind them it's paused and ask if they
want to resume it.`;

	if (goal.checkpointProgress) {
		instructions += `\n\n**Last Checkpoint:** ${goal.checkpointProgress}`;
	}

	return instructions;
}

function formatGoalStatus(g: GoalState): string {
	const lines = [
		`Goal: ${g.objective}`,
		`Status: ${g.status}`,
		`Created: ${new Date(g.createdAt).toLocaleString()}`,
		`Updated: ${new Date(g.updatedAt).toLocaleString()}`,
	];
	if (g.checkpointProgress) {
		lines.push(`Last checkpoint: ${g.checkpointProgress}`);
	}
	if (g.completionSummary && g.status === "completed") {
		lines.push(`Completed: ${g.completionSummary}`);
	}
	return lines.join("\n");
}