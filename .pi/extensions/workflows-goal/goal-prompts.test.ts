import { describe, expect, it } from "vitest";
import type { GoalState } from "./goal-state.ts";
import { goalPromptAddendum } from "./goal-prompts.ts";

function goal(overrides: Partial<GoalState> = {}): GoalState {
	return {
		goalId: "goal-1",
		objective: "Ship the release",
		status: "active",
		createdAt: 1,
		updatedAt: 1,
		...overrides,
	};
}

describe("goalPromptAddendum", () => {
	it("returns null when there is nothing to inject", () => {
		expect(goalPromptAddendum(null)).toBeNull();
		expect(goalPromptAddendum(goal({ status: "cleared", objective: "", createdAt: 0 }))).toBeNull();
		expect(goalPromptAddendum(goal({ status: "completed", completionSummary: "Done" }))).toBeNull();
		expect(goalPromptAddendum(goal({ status: "budget_limited", limitReason: "Limit" }))).toBeNull();
	});

	it("returns the active-goal prompt with the objective and last checkpoint", () => {
		const plain = goalPromptAddendum(goal());
		expect(plain?.startsWith("## Active Goal")).toBe(true);
		expect(plain).toContain("Ship the release");
		expect(plain).not.toContain("**Last Checkpoint:**");
		expect(plain).toContain("structured passing evidence");
		expect(plain).toContain("prose summary");

		const withCheckpoint = goalPromptAddendum(goal({ checkpointProgress: "Tests pass" }));
		expect(withCheckpoint?.startsWith("## Active Goal")).toBe(true);
		expect(withCheckpoint).toContain("**Last Checkpoint:** Tests pass");
	});

	it("returns a blocked prompt that names the blocker and requires resume", () => {
		const blocked = goalPromptAddendum(goal({ status: "blocked", blockedReason: "Needs credentials" }));
		expect(blocked?.startsWith("## Blocked Goal")).toBe(true);
		expect(blocked).toContain("Needs credentials");
		expect(blocked).toContain("/goal resume");
	});

	it("returns the paused-goal prompt with the same checkpoint suffix", () => {
		const paused = goalPromptAddendum(goal({ status: "paused", checkpointProgress: "Half done" }));
		expect(paused?.startsWith("## Paused Goal")).toBe(true);
		expect(paused).toContain("Ship the release");
		expect(paused).toContain("**Last Checkpoint:** Half done");
	});
});