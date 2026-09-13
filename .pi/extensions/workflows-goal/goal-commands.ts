/**
 * Pure Goal command module: owns the /goal command surface.
 *
 * One entry, `runGoalCommand`, hides every subcommand arm: parsing, the
 * transition→message policy, the replacement-confirmation requirement and its
 * text, the kickoff message, and status formatting. The module decides; the
 * adapter (index.ts) wraps the outcome in Pi calls (notify, applyTransition,
 * widget update, sendUserMessage). The only effect the module itself can have
 * is the injected `host.confirm` — no I/O, no ctx.*, no pi.*.
 */

import {
	checkpointGoal,
	clearGoal,
	editGoal,
	MAX_OBJECTIVE_LENGTH,
	pauseGoal,
	resumeGoal,
	setGoal,
	type AppliedGoalTransition,
	type GoalState,
} from "./goal-state.ts";

/** One user-facing message: text plus the notify severity. */
export interface GoalNotification {
	text: string;
	severity: "info" | "warning" | "error";
}

/** What the adapter must do after one /goal invocation. */
export interface GoalCommandOutcome {
	/** Show via ctx.ui.notify; null means stay silent (declined confirmation). */
	notification: GoalNotification | null;
	/** Apply via applyTransition: adopt outcome.goal and append the entry. */
	transition: AppliedGoalTransition | null;
	/** Send via pi.sendUserMessage after applying a set transition. */
	kickoff: string | null;
}

/** Mechanics the module cannot own: asking the user. */
export interface GoalCommandHost {
	confirm(title: string, body: string): Promise<boolean>;
}

/** The explicit "stay silent, do nothing" outcome (declined confirmation and
 * the unreachable setGoal rejections). */
const silent: GoalCommandOutcome = { notification: null, transition: null, kickoff: null };

function said(text: string, severity: GoalNotification["severity"]): GoalCommandOutcome {
	return { notification: { text, severity }, transition: null, kickoff: null };
}

function applied(
	transition: AppliedGoalTransition,
	text: string,
	kickoff: string | null = null,
): GoalCommandOutcome {
	return { notification: { text, severity: "info" }, transition, kickoff };
}

/** Run one /goal invocation. `now` flows into every transition; the module
 * never calls Date.now(). */
export async function runGoalCommand(
	goal: GoalState | null,
	args: string,
	now: number,
	host: GoalCommandHost,
): Promise<GoalCommandOutcome> {
	const trimmedArgs = (args || "").trim();

	// /goal - view current goal
	if (!trimmedArgs) {
		if (!goal || goal.status === "cleared") {
			return said("No active goal. Use /goal <objective> to set one.", "info");
		}
		return said(formatGoalStatus(goal), "info");
	}

	// /goal pause
	if (trimmedArgs === "pause") {
		const outcome = pauseGoal(goal, now);
		if (!outcome.ok) {
			if (outcome.reason === "already-paused") {
				return said("Goal is already paused.", "warning");
			}
			if (outcome.reason === "completed") {
				return said("Goal is already completed. Use /goal <objective> to set a new one.", "warning");
			}
			return said("No active goal to pause.", "warning");
		}
		return applied(outcome, `Goal paused: "${outcome.state.objective}"`);
	}

	// /goal resume
	if (trimmedArgs === "resume") {
		const outcome = resumeGoal(goal, now);
		if (!outcome.ok) {
			if (outcome.reason === "already-active") {
				return said("Goal is already active.", "warning");
			}
			if (outcome.reason === "completed") {
				return said("Goal is already completed. Use /goal <objective> to set a new one.", "warning");
			}
			return said("No goal to resume.", "warning");
		}
		return applied(outcome, `Goal resumed: "${outcome.state.objective}"`);
	}

	// /goal edit <objective>
	if (trimmedArgs.startsWith("edit ")) {
		const nextObjective = trimmedArgs.slice(5).trim();
		const outcome = editGoal(goal, nextObjective, now);
		if (!outcome.ok) {
			// Unreachable through the command: trimmedArgs never ends in
			// whitespace, so the sliced objective is never blank. Kept verbatim
			// as defense; editGoal still returns empty-objective.
			if (outcome.reason === "empty-objective") {
				return said("Usage: /goal edit <new objective>", "warning");
			}
			return said("No active goal to edit.", "warning");
		}
		return applied(outcome, `Goal updated: ${nextObjective}`);
	}

	// /goal checkpoint <summary>
	if (trimmedArgs.startsWith("checkpoint ")) {
		const summary = trimmedArgs.slice("checkpoint ".length).trim();
		const outcome = checkpointGoal(goal, summary, now);
		if (!outcome.ok) {
			return said("No active goal to checkpoint.", "warning");
		}
		return applied(outcome, `Checkpoint saved: ${outcome.state.checkpointProgress}`);
	}

	// /goal clear
	if (trimmedArgs === "clear") {
		const wasCompleted = goal?.status === "completed";
		const outcome = clearGoal(goal, now);
		if (!outcome.ok) {
			return said("No goal to clear.", "warning");
		}
		return applied(outcome, wasCompleted ? "Completed goal cleared." : "Goal cleared.");
	}

	// /goal <objective> - set a new goal and start working immediately
	if (trimmedArgs.length > MAX_OBJECTIVE_LENGTH) {
		return said(
			`Goal objective too long (max ${MAX_OBJECTIVE_LENGTH} characters). Put details in a file and reference it.`,
			"error",
		);
	}

	// If there's an existing active/paused goal, confirm replacement
	if (goal && (goal.status === "active" || goal.status === "paused")) {
		const replace = await host.confirm(
			"Replace goal?",
			`An active goal already exists: "${goal.objective}". Replace it?`,
		);
		if (!replace) return silent;
	}

	const outcome = setGoal(trimmedArgs, now);
	if (!outcome.ok) return silent; // Unreachable: the guard and trim exclude too-long and empty-objective.
	return applied(
		outcome,
		`Goal set: "${trimmedArgs}"`,
		`Goal: ${trimmedArgs}\n\nStart working on this goal now. Plan your approach, then begin implementing. ` +
			`Use the goal tool to report checkpoints as you make progress. ` +
			`Work independently and keep going until the goal is fully achieved.`,
	);
}

/** Render the current goal for the view arm. */
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