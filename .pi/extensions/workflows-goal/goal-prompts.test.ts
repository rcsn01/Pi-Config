import { describe, expect, it } from "vitest";
import type { GoalState } from "./goal-state.ts";
import { goalPromptAddendum } from "./goal-prompts.ts";

function goal(overrides: Partial<GoalState> = {}): GoalState {
	return {
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
	});

	it("returns the active-goal prompt with the objective and last checkpoint", () => {
		const plain = goalPromptAddendum(goal());
		expect(plain?.startsWith("## Active Goal")).toBe(true);
		expect(plain).toContain("Ship the release");
		expect(plain).not.toContain("**Last Checkpoint:**");

		const withCheckpoint = goalPromptAddendum(goal({ checkpointProgress: "Tests pass" }));
		expect(withCheckpoint?.startsWith("## Active Goal")).toBe(true);
		expect(withCheckpoint).toContain("**Last Checkpoint:** Tests pass");
	});

	it("returns the paused-goal prompt with the same checkpoint suffix", () => {
		const paused = goalPromptAddendum(goal({ status: "paused", checkpointProgress: "Half done" }));
		expect(paused?.startsWith("## Paused Goal")).toBe(true);
		expect(paused).toContain("Ship the release");
		expect(paused).toContain("**Last Checkpoint:** Half done");
	});
});