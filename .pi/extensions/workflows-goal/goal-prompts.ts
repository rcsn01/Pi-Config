import type { GoalState } from "./goal-state.ts";

/** System-prompt addendum for a goal that should affect the next ordinary run. */
export function goalPromptAddendum(goal: GoalState | null): string | null {
	if (!goal || goal.status === "cleared" || goal.status === "completed" || goal.status === "budget_limited") {
		return null;
	}
	if (goal.status === "paused") return buildPausedGoalPrompt(goal);
	if (goal.status === "blocked") return buildBlockedGoalPrompt(goal);
	return buildActiveGoalPrompt(goal);
}

function checkpointSuffix(goal: GoalState): string {
	return goal.checkpointProgress ? `\n\n**Last Checkpoint:** ${goal.checkpointProgress}` : "";
}

function buildActiveGoalPrompt(goal: GoalState): string {
	return `## Active Goal

You are working toward a persistent goal. Continue independently until the
objective is achieved or a concrete blocker requires user input or external state.

**Goal Objective:** ${goal.objective}

### Goal protocol

1. Inspect authoritative current state before implementing or claiming completion.
2. After meaningful work, call the goal tool with action=checkpoint and name what
   you verified. A status call or prose summary is not progress.
3. Run the relevant tests, builds, checks, or other verification.
4. Call action=complete only when every claimed requirement has structured passing evidence.
5. Call action=blocked only when no meaningful action remains without user input
   or an external state change, and give the specific reason.

### Rules

- Do not stop at a prose summary while the goal remains active.
- Do not ask permission for routine work within scope.
- Stay focused on the goal and avoid unrelated work.${checkpointSuffix(goal)}`;
}

function buildPausedGoalPrompt(goal: GoalState): string {
	return `## Paused Goal

The following goal is paused. Do not work on it unless the user explicitly
resumes it with /goal resume or gives a direct instruction related to it.

**Goal Objective:** ${goal.objective}

If the user asks about this goal, state that it is paused and ask whether they
want to resume it.${checkpointSuffix(goal)}`;
}

function buildBlockedGoalPrompt(goal: GoalState): string {
	return `## Blocked Goal

The following goal is blocked. Do not continue it until the user resolves the
blocker and runs /goal resume.

**Goal Objective:** ${goal.objective}
**Blocker:** ${goal.blockedReason ?? "User input or external state is required."}${checkpointSuffix(goal)}`;
}
