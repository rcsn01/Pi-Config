import { describe, expect, it, vi } from "vitest";
import { runGoalCommand } from "./goal-commands.ts";
import type { GoalState } from "./goal-state.ts";

const NOW = 1_700_000_000_000;

function goal(overrides: Partial<GoalState> = {}): GoalState {
	return {
		objective: "Ship the release",
		status: "active",
		createdAt: 1,
		updatedAt: 1,
		...overrides,
	};
}

function cleared(): GoalState {
	return { objective: "", status: "cleared", createdAt: 0, updatedAt: 1 };
}

function host(confirm: (title: string, body: string) => Promise<boolean> = vi.fn(async () => true)) {
	return { confirm };
}

describe("runGoalCommand arms", () => {
	it("views: no goal and cleared tombstones show the set-one hint; active and completed goals render status", async () => {
		const h = host();

		const empty = await runGoalCommand(null, "", NOW, h);
		expect(empty).toEqual({
			notification: { text: "No active goal. Use /goal <objective> to set one.", severity: "info" },
			transition: null,
			kickoff: null,
		});

		const tombstone = await runGoalCommand(cleared(), "", NOW, h);
		expect(tombstone.notification).toEqual({
			text: "No active goal. Use /goal <objective> to set one.",
			severity: "info",
		});

		const active = await runGoalCommand(goal({ checkpointProgress: "Tests pass" }), "", NOW, h);
		expect(active.notification?.text).toContain("Goal: Ship the release");
		expect(active.notification?.text).toContain("Status: active");
		expect(active.notification?.text).toContain("Last checkpoint: Tests pass");
		expect(active.transition).toBeNull();
		expect(active.kickoff).toBeNull();

		const completed = await runGoalCommand(goal({ status: "completed", completionSummary: "Done" }), "", NOW, h);
		expect(completed.notification?.text).toContain("Completed: Done");
		expect(h.confirm).not.toHaveBeenCalled();
	});

	it("pauses an active goal with the injected timestamp and maps every rejection", async () => {
		const h = host();

		const paused = await runGoalCommand(goal(), "pause", NOW, h);
		expect(paused.notification).toEqual({ text: 'Goal paused: "Ship the release"', severity: "info" });
		expect(paused.transition).toMatchObject({ action: "pause", state: { status: "paused", updatedAt: NOW } });
		expect(paused.kickoff).toBeNull();

		const already = await runGoalCommand(goal({ status: "paused" }), "pause", NOW, h);
		expect(already.notification).toEqual({ text: "Goal is already paused.", severity: "warning" });
		expect(already.transition).toBeNull();

		const completed = await runGoalCommand(goal({ status: "completed" }), "pause", NOW, h);
		expect(completed.notification).toEqual({
			text: "Goal is already completed. Use /goal <objective> to set a new one.",
			severity: "warning",
		});

		const missing = await runGoalCommand(null, "pause", NOW, h);
		expect(missing.notification).toEqual({ text: "No active goal to pause.", severity: "warning" });

		const tombstone = await runGoalCommand(cleared(), "pause", NOW, h);
		expect(tombstone.notification).toEqual({ text: "No active goal to pause.", severity: "warning" });
	});

	it("resumes a paused goal and maps every rejection (mirror of pause)", async () => {
		const h = host();

		const resumed = await runGoalCommand(goal({ status: "paused" }), "resume", NOW, h);
		expect(resumed.notification).toEqual({ text: 'Goal resumed: "Ship the release"', severity: "info" });
		expect(resumed.transition).toMatchObject({ action: "resume", state: { status: "active", updatedAt: NOW } });

		const already = await runGoalCommand(goal(), "resume", NOW, h);
		expect(already.notification).toEqual({ text: "Goal is already active.", severity: "warning" });

		const completed = await runGoalCommand(goal({ status: "completed" }), "resume", NOW, h);
		expect(completed.notification).toEqual({
			text: "Goal is already completed. Use /goal <objective> to set a new one.",
			severity: "warning",
		});

		const missing = await runGoalCommand(null, "resume", NOW, h);
		expect(missing.notification).toEqual({ text: "No goal to resume.", severity: "warning" });
	});

	it("edits a live goal and pins the dispatch quirks", async () => {
		const h = host();

		const edited = await runGoalCommand(goal(), "edit New objective", NOW, h);
		expect(edited.notification).toEqual({ text: "Goal updated: New objective", severity: "info" });
		expect(edited.transition).toMatchObject({ action: "set", state: { objective: "New objective", updatedAt: NOW } });

		const missing = await runGoalCommand(null, "edit Next", NOW, h);
		expect(missing.notification).toEqual({ text: "No active goal to edit.", severity: "warning" });

		const tombstone = await runGoalCommand(cleared(), "edit Next", NOW, h);
		expect(tombstone.notification).toEqual({ text: "No active goal to edit.", severity: "warning" });

		// Quirk pin: "edit" and "edit " (trailing space) both trim to "edit" and fall through to set.
		for (const args of ["edit", "edit "]) {
			const quirk = await runGoalCommand(null, args, NOW, h);
			expect(quirk.notification).toEqual({ text: 'Goal set: "edit"', severity: "info" });
			expect(quirk.transition).toMatchObject({ action: "set", state: { objective: "edit" } });
		}

		// Quirk pin: edit has no length limit.
		const long = await runGoalCommand(goal(), `edit ${"x".repeat(4001)}`, NOW, h);
		expect(long.notification).toEqual({ text: `Goal updated: ${"x".repeat(4001)}`, severity: "info" });
		expect(long.transition).toMatchObject({ action: "set", state: { objective: "x".repeat(4001) } });
	});

	it("checkpoints an active goal and maps every rejection", async () => {
		const h = host();

		const saved = await runGoalCommand(goal(), "checkpoint Tests pass", NOW, h);
		expect(saved.notification).toEqual({ text: "Checkpoint saved: Tests pass", severity: "info" });
		expect(saved.transition).toMatchObject({
			action: "checkpoint",
			state: { checkpointProgress: "Tests pass", updatedAt: NOW },
		});

		for (const state of [
			goal({ status: "paused" }),
			goal({ status: "completed", completionSummary: "Done" }),
			cleared(),
			null,
		]) {
			const rejected = await runGoalCommand(state, "checkpoint No", NOW, h);
			expect(rejected.notification).toEqual({ text: "No active goal to checkpoint.", severity: "warning" });
			expect(rejected.transition).toBeNull();
		}

		// Quirk pin: "checkpoint" and "checkpoint " (trailing space) both set a goal named "checkpoint".
		for (const args of ["checkpoint", "checkpoint "]) {
			const quirk = await runGoalCommand(null, args, NOW, h);
			expect(quirk.notification).toEqual({ text: 'Goal set: "checkpoint"', severity: "info" });
			expect(quirk.transition).toMatchObject({ action: "set", state: { objective: "checkpoint" } });
		}
	});

	it("clears live goals with the tombstone transition and maps rejections", async () => {
		const h = host();

		const done = await runGoalCommand(goal(), "clear", NOW, h);
		expect(done.notification).toEqual({ text: "Goal cleared.", severity: "info" });
		expect(done.transition).toMatchObject({
			goal: null,
			action: "clear",
			state: { objective: "", status: "cleared", createdAt: 0, updatedAt: NOW },
		});

		const completedCleared = await runGoalCommand(
			goal({ status: "completed", completionSummary: "Done" }),
			"clear",
			NOW,
			h,
		);
		expect(completedCleared.notification).toEqual({ text: "Completed goal cleared.", severity: "info" });

		const missing = await runGoalCommand(null, "clear", NOW, h);
		expect(missing.notification).toEqual({ text: "No goal to clear.", severity: "warning" });

		const tombstone = await runGoalCommand(cleared(), "clear", NOW, h);
		expect(tombstone.notification).toEqual({ text: "No goal to clear.", severity: "warning" });
	});

	it("sets a goal with the kickoff message and injected timestamps", async () => {
		const h = host();

		const set = await runGoalCommand(null, "Write the docs", NOW, h);
		expect(set.notification).toEqual({ text: 'Goal set: "Write the docs"', severity: "info" });
		expect(set.transition).toMatchObject({
			action: "set",
			state: { objective: "Write the docs", status: "active", createdAt: NOW, updatedAt: NOW },
		});
		expect(set.kickoff).toBe(
			"Goal: Write the docs\n\n" +
				"Start working on this goal now. Plan your approach, then begin implementing. " +
				"Use the goal tool to report checkpoints as you make progress. " +
				"Work independently and keep going until the goal is fully achieved.",
		);
		expect(h.confirm).not.toHaveBeenCalled();
	});

	it("rejects oversized objectives with the exact error text before any confirmation", async () => {
		const h = host();

		const tooLong = await runGoalCommand(goal(), "x".repeat(4001), NOW, h);
		expect(tooLong.notification).toEqual({
			text: "Goal objective too long (max 4000 characters). Put details in a file and reference it.",
			severity: "error",
		});
		expect(tooLong.transition).toBeNull();
		expect(tooLong.kickoff).toBeNull();
		expect(h.confirm).not.toHaveBeenCalled();
	});
});

describe("runGoalCommand confirmation", () => {
	it("asks once with the exact question for live goals", async () => {
		const h = host();
		await runGoalCommand(goal(), "Replacement goal", NOW, h);
		expect(h.confirm).toHaveBeenCalledTimes(1);
		expect(h.confirm).toHaveBeenCalledWith("Replace goal?", 'An active goal already exists: "Ship the release". Replace it?');

		const pausedHost = host();
		await runGoalCommand(goal({ status: "paused" }), "Replacement goal", NOW, pausedHost);
		expect(pausedHost.confirm).toHaveBeenCalledTimes(1);
		expect(pausedHost.confirm).toHaveBeenCalledWith("Replace goal?", 'An active goal already exists: "Ship the release". Replace it?');
	});

	it("stays completely silent when replacement is declined", async () => {
		const h = host(vi.fn(async () => false));

		const declined = await runGoalCommand(goal(), "Replacement goal", NOW, h);
		expect(declined).toEqual({ notification: null, transition: null, kickoff: null });
		expect(h.confirm).toHaveBeenCalledTimes(1);
	});

	it("returns the full success outcome when replacement is accepted", async () => {
		const h = host();

		const accepted = await runGoalCommand(goal(), "Replacement goal", NOW, h);
		expect(accepted.notification).toEqual({ text: 'Goal set: "Replacement goal"', severity: "info" });
		expect(accepted.transition).toMatchObject({ action: "set", state: { objective: "Replacement goal", status: "active" } });
		expect(accepted.kickoff).toContain("Goal: Replacement goal");
	});

	it("never asks when the existing goal is not live", async () => {
		const h = host();

		await runGoalCommand(null, "Fresh goal", NOW, h);
		await runGoalCommand(cleared(), "Fresh goal", NOW, h);
		await runGoalCommand(goal({ status: "completed", completionSummary: "Done" }), "Fresh goal", NOW, h);
		expect(h.confirm).not.toHaveBeenCalled();
	});
});