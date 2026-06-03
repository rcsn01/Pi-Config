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
 */

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";

// ─── Types ───────────────────────────────────────────────────────────────────

interface GoalState {
	objective: string;
	status: "active" | "paused" | "completed" | "cleared";
	createdAt: number;
	updatedAt: number;
	/** Checkpoint progress reported by the agent */
	checkpointProgress?: string;
	/** Summary of what was accomplished (set when completed) */
	completionSummary?: string;
}

interface GoalEntryData {
	action: "set" | "pause" | "resume" | "clear" | "complete" | "checkpoint";
	state: GoalState;
}

const GOAL_CUSTOM_TYPE = "goal-state";

// ─── Parameters ──────────────────────────────────────────────────────────────

const GoalToolParams = Type.Object({
	action: StringEnum(["status", "checkpoint", "complete"] as const),
	/** For checkpoint: what was just verified/accomplished */
	summary: Type.Optional(Type.String({ description: "Progress summary (for checkpoint or complete)" })),
	/** For checkpoint: what remains to be done */
	remaining: Type.Optional(Type.String({ description: "What remains to be done (for checkpoint)" })),
});

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
				? th.fg("info", "●")
				: this.goal.status === "paused"
					? th.fg("warning", "⏸")
					: th.fg("success", "✓");

			const statusLabel = this.goal.status === "active"
				? th.fg("info", "ACTIVE")
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
				lines.push(truncateToWidth(`  ${th.fg("success", "✓ ")}${th.fg("muted", this.goal.completionSummary)}`, width));
			}

			// Help hint
			lines.push("");
			lines.push(truncateToWidth(
				`  ${th.fg("dim", "/goal pause | resume | clear  •  Press Esc to dismiss")}`,
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
	let goal: GoalState | null = null;

	// ── State Reconstruction ────────────────────────────────────────────

	const reconstructState = (ctx: ExtensionContext) => {
		goal = null;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === GOAL_CUSTOM_TYPE) {
				const data = entry.data as GoalEntryData | undefined;
				if (data && data.state) {
					goal = data.state;
				}
			}
		}
	};

	// Persist goal state as a session entry
	const persistGoal = (action: GoalEntryData["action"]) => {
		if (!goal) return;
		const updated: GoalState = { ...goal, updatedAt: Date.now() };
		goal = updated;

		pi.appendEntry(GOAL_CUSTOM_TYPE, {
			action,
			state: updated,
		} as GoalEntryData);
	};

	// ── Lifecycle Events ────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => reconstructState(ctx));
	pi.on("session_tree", async (_event, ctx) => reconstructState(ctx));

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
		description:
			"Check goal status, report a checkpoint with progress, or mark the goal as complete. " +
			"Use checkpoints to track progress through multi-step goals. " +
			"Only mark complete when the objective is fully achieved.",
		promptSnippet: "Check or update goal status (status, checkpoint, complete)",
		promptGuidelines: [
			"Use the goal tool to report checkpoints as you make progress toward the current goal. Each checkpoint should name what was verified and what remains.",
			"Use the goal tool with action=complete ONLY when you are confident the goal objective is fully achieved. Include a summary of what was accomplished.",
		],
		parameters: GoalToolParams,

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			if (!goal) {
				return {
					content: [{ type: "text", text: "No active goal." }],
					details: {},
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
					if (goal.status !== "active") {
						return {
							content: [{ type: "text", text: `Cannot checkpoint: goal is ${goal.status}.` }],
							details: { action: "checkpoint", state: { ...goal } },
						};
					}

					goal.checkpointProgress = params.summary || "Progress reported";
					persistGoal("checkpoint");

					const msg = params.remaining
						? `Checkpoint: ${params.summary}\nRemaining: ${params.remaining}`
						: `Checkpoint: ${params.summary}`;

					return {
						content: [{ type: "text", text: msg }],
						details: { action: "checkpoint", state: { ...goal } },
					};
				}

				case "complete": {
					if (goal.status !== "active") {
						return {
							content: [{ type: "text", text: `Goal is already ${goal.status}.` }],
							details: { action: "complete", state: { ...goal } },
						};
					}

					goal.status = "completed";
					goal.completionSummary = params.summary || "Goal completed";
					persistGoal("complete");

					return {
						content: [
							{
								type: "text",
								text: `✓ Goal completed: ${goal.completionSummary}`,
							},
						],
						details: { action: "complete", state: { ...goal } },
					};
				}

				default:
					return {
						content: [{ type: "text", text: `Unknown action: ${(params as any).action}` }],
						details: {},
					};
			}
		},

		renderCall(args, theme, _context) {
			const icon = args.action === "complete" ? "✓" : args.action === "checkpoint" ? "▶" : "ℹ";
			let text = theme.fg("toolTitle", theme.bold(`goal ${icon} `)) + theme.fg("muted", args.action);
			if (args.summary) {
				text += ` ${theme.fg("dim", `"${args.summary.slice(0, 60)}${args.summary.length > 60 ? "…" : ""}"`)}`;
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme, _context) {
			const text = result.content[0];
			const msg = text?.type === "text" ? text.text : "";
			const isComplete = msg.startsWith("✓");
			return new Text(
				(isComplete ? theme.fg("success", msg) : theme.fg("muted", msg)),
				0,
				0,
			);
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
				if (!goal || goal.status === "cleared") {
					ctx.ui.notify("No active goal to pause.", "warning");
					return;
				}
				if (goal.status === "paused") {
					ctx.ui.notify("Goal is already paused.", "warning");
					return;
				}
				if (goal.status === "completed") {
					ctx.ui.notify("Goal is already completed. Use /goal <objective> to set a new one.", "warning");
					return;
				}

				goal.status = "paused";
				persistGoal("pause");
				ctx.ui.notify(`Goal paused: "${goal.objective}"`, "info");
				return;
			}

			// /goal resume
			if (trimmedArgs === "resume") {
				if (!goal || goal.status === "cleared") {
					ctx.ui.notify("No goal to resume.", "warning");
					return;
				}
				if (goal.status === "active") {
					ctx.ui.notify("Goal is already active.", "warning");
					return;
				}
				if (goal.status === "completed") {
					ctx.ui.notify("Goal is already completed. Use /goal <objective> to set a new one.", "warning");
					return;
				}

				goal.status = "active";
				persistGoal("resume");
				ctx.ui.notify(`Goal resumed: "${goal.objective}"`, "info");
				return;
			}

			// /goal edit <objective>
			if (trimmedArgs.startsWith("edit ")) {
				if (!goal || goal.status === "cleared") {
					ctx.ui.notify("No active goal to edit.", "warning");
					return;
				}
				const nextObjective = trimmedArgs.slice(5).trim();
				if (!nextObjective) {
					ctx.ui.notify("Usage: /goal edit <new objective>", "warning");
					return;
				}
				goal.objective = nextObjective;
				persistGoal("set");
				ctx.ui.notify(`Goal updated: ${nextObjective}`, "info");
				return;
			}

			// /goal checkpoint <summary>
			if (trimmedArgs.startsWith("checkpoint ")) {
				if (!goal || goal.status !== "active") {
					ctx.ui.notify("No active goal to checkpoint.", "warning");
					return;
				}
				goal.checkpointProgress = trimmedArgs.slice("checkpoint ".length).trim();
				persistGoal("checkpoint");
				ctx.ui.notify(`Checkpoint saved: ${goal.checkpointProgress}`, "info");
				return;
			}

			// /goal clear
			if (trimmedArgs === "clear") {
				if (!goal || goal.status === "cleared") {
					ctx.ui.notify("No goal to clear.", "warning");
					return;
				}

				const wasCompleted = goal.status === "completed";
				goal = null;
				// Persist a cleared entry so state is properly cleared
				pi.appendEntry(GOAL_CUSTOM_TYPE, {
					action: "clear",
					state: {
						objective: "",
						status: "cleared" as const,
						createdAt: 0,
						updatedAt: Date.now(),
					},
				} as GoalEntryData);

				ctx.ui.notify(
					wasCompleted ? "Completed goal cleared." : "Goal cleared.",
					"info",
				);
				return;
			}

			// /goal <objective> - set a new goal and start working immediately
			if (trimmedArgs.length > 4000) {
				ctx.ui.notify("Goal objective too long (max 4000 characters). Put details in a file and reference it.", "error");
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

			goal = {
				objective: trimmedArgs,
				status: "active",
				createdAt: Date.now(),
				updatedAt: Date.now(),
			};
			persistGoal("set");

			ctx.ui.notify(`Goal set: "${trimmedArgs}"`, "info");

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
