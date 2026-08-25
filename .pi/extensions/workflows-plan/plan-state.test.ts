import { describe, expect, it } from "vitest";
import {
	advancePlanStateRevision,
	createCommittedPlanState,
	createInitialPlanState,
	normalizePersistedPlanState,
	reconstructPlanState,
} from "./plan-state.ts";

const changedAt = "2026-01-01T00:00:00.000Z";
const entry = (data: Record<string, unknown>) => ({
	type: "custom",
	customType: "plan-mode-state",
	data,
});

function reconstruct(entries: any[], options: { previousRevision?: number; counter?: number; repeated?: boolean } = {}) {
	return reconstructPlanState({
		entries,
		previousState: createInitialPlanState("default", options.previousRevision ?? 0),
		revisionCounter: options.counter ?? 0,
		hasReconstructedState: options.repeated ?? false,
	});
}

describe("Plan Mode state", () => {
	it("migrates legacy active and setAt fields", () => {
		expect(normalizePersistedPlanState({ active: true, setAt: 0 })).toEqual({
			mode: "plan",
			revision: 0,
			changedAt: new Date(0).toISOString(),
		});
	});

	it("selects the highest persisted revision independent of branch order", () => {
		const result = reconstruct([
			entry({ mode: "plan", revision: 8, changedAt }),
			entry({ mode: "default", revision: 7, changedAt }),
		]);
		expect(result.state).toMatchObject({ mode: "plan", revision: 8 });
	});

	it("advances revisions monotonically after the first branch reconstruction", () => {
		const result = reconstruct(
			[entry({ mode: "default", revision: 3, changedAt })],
			{ previousRevision: 8, counter: 8, repeated: true },
		);
		expect(result.state).toMatchObject({ mode: "default", revision: 9 });
		expect(result.revisionCounter).toBe(9);
		expect(advancePlanStateRevision(result.state, 9).state.revision).toBe(10);
	});

	it("clears plan content when a newer state omits it", () => {
		const result = reconstruct([
			entry({
				mode: "plan", revision: 1, changedAt, phase: "awaiting_review",
				latestPlan: "obsolete", latestPlanSignature: "old",
			}),
			entry({ mode: "plan", revision: 2, changedAt, phase: "planning" }),
		]);
		expect(result.latestPlan).toBeUndefined();
		expect(result.latestPlanKey).toBeUndefined();
	});

	it("restores durable legacy plans and their prompted signatures", () => {
		const result = reconstruct([
			entry({ active: true, phase: "awaiting_review", setAt: 1 }),
			{
				type: "custom_message",
				customType: "proposed-plan",
				content: [{ type: "text", text: "# Legacy" }],
				details: { signature: "legacy-key" },
			},
		]);
		expect(result.latestPlan).toBe("# Legacy");
		expect(result.state).toMatchObject({
			mode: "plan",
			phase: "awaiting_review",
			latestPlanSignature: "legacy-key",
			promptedPlanSignature: "legacy-key",
		});
	});

	it("restores an explicitly persisted prompted signature", () => {
		const result = reconstruct([entry({
			mode: "plan",
			revision: 4,
			changedAt,
			phase: "awaiting_review",
			latestPlan: "# Durable",
			latestPlanSignature: "durable",
			promptedPlanSignature: "durable",
		})]);
		expect(result.state.promptedPlanSignature).toBe("durable");
	});

	it("constructs active and committed inactive snapshots without leaking mode-only state", () => {
		const active = createCommittedPlanState({
			state: { ...createInitialPlanState("default", 2), promptedPlanSignature: "old" },
			mode: "plan",
			prompt: "task",
			latestPlan: "plan",
			latestPlanKey: "key",
			normalTools: ["read"],
		});
		expect(active).toMatchObject({ mode: "plan", phase: "planning", latestPlan: "plan" });
		expect(createCommittedPlanState({ state: active, mode: "default" })).toEqual({
			mode: "default",
			revision: 2,
			changedAt: active.changedAt,
			prompt: undefined,
			phase: undefined,
			latestPlanSignature: undefined,
			latestPlan: undefined,
			promptedPlanSignature: undefined,
			normalProfile: undefined,
			normalTools: undefined,
		});
	});
});
