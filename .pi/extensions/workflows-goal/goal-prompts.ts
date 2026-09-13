/**
 * Pure goal prompt builders: own the status→prompt injection decision.
 *
 * `goalPromptAddendum` returns the system-prompt addendum for a live goal and
 * null when nothing should be injected (no goal, cleared, or completed). The
 * "\n\n" joiner and the `{ systemPrompt }` return stay in the adapter
 * (index.ts) as Pi assembly mechanics.
 */

import type { GoalState } from "./goal-state.ts";

/** System-prompt addendum for a live goal; null when nothing should be injected. */
export function goalPromptAddendum(goal: GoalState | null): string | null {
	if (!goal || goal.status === "cleared" || goal.status === "completed") {
		return null;
	}
	return goal.status === "paused" ? buildPausedGoalPrompt(goal) : buildActiveGoalPrompt(goal);
}

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