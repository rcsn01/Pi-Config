import { describe, expect, it, vi } from "vitest";
import {
	createGoalLifecycle,
	isCompactionStateEvent,
	type GoalLifecycleHost,
} from "./goal-lifecycle.ts";
import type { GoalRuntimeSnapshot, GoalTurnObservation } from "./goal-runtime.ts";
import type { AppliedGoalTransition, GoalEvidence, GoalState } from "./goal-state.ts";

function activeGoalEntry(goalId = "goal-1", status: GoalState["status"] = "active") {
	return {
		type: "custom",
		id: "goal-entry",
		customType: "goal-state",
		data: {
			action: "set",
			state: {
				goalId,
				objective: "Ship the release",
				status,
				createdAt: 1,
				updatedAt: 1,
				...(status === "budget_limited" ? { limitReason: "Limit" } : {}),
			},
		},
	};
}

function runtimeEntry(goalId = "goal-1", overrides: Record<string, unknown> = {}) {
	return {
		type: "custom",
		id: "runtime-entry",
		customType: "goal-runtime",
		data: {
			goalId,
			continuationRuns: 2,
			consecutiveNoProgressRuns: 1,
			consecutiveFailureRuns: 0,
			updatedAt: 2,
			...overrides,
		},
	};
}

function createHost(options: {
	idle?: boolean;
	pending?: boolean;
	confirm?: () => boolean | Promise<boolean>;
	sendContinuation?: (goalId: string) => void;
	updateWidget?: (goal: GoalState | null) => void;
} = {}) {
	const effects: Array<{ type: string; value?: unknown }> = [];
	let idle = options.idle ?? true;
	let pending = options.pending ?? false;
	const host: GoalLifecycleHost = {
		confirm: vi.fn(async () => options.confirm ? options.confirm() : true),
		appendGoalTransition(outcome: AppliedGoalTransition) {
			effects.push({ type: "goal", value: outcome });
		},
		appendRuntime(snapshot: GoalRuntimeSnapshot) {
			effects.push({ type: "runtime", value: snapshot });
		},
		updateWidget(goal: GoalState | null) {
			effects.push({ type: "widget", value: goal });
			options.updateWidget?.(goal);
		},
		notify(message, severity) {
			effects.push({ type: "notify", value: { message, severity } });
		},
		sendContinuation(goalId) {
			effects.push({ type: "continuation", value: goalId });
			options.sendContinuation?.(goalId);
		},
		sendKickoff(message, queued) {
			effects.push({ type: "kickoff", value: { message, queued } });
		},
		isIdle: () => idle,
		hasPendingMessages: () => pending,
	};
	return {
		host,
		effects,
		setIdle(value: boolean) { idle = value; },
		setPending(value: boolean) { pending = value; },
	};
}

describe("Goal lifecycle", () => {
	it("reconstructs Goal/runtime and updates the widget without persisting runtime", async () => {
		const { host, effects } = createHost();
		const lifecycle = createGoalLifecycle({ now: () => 10 });

		await lifecycle.dispatch({
			type: "sessionStarted",
			branch: [activeGoalEntry(), runtimeEntry()],
			host,
		});

		expect(effects).toEqual([
			{
				type: "widget",
				value: expect.objectContaining({ goalId: "goal-1", status: "active" }),
			},
		]);
	});

	it("returns the Goal prompt addendum and leaves an unchanged prompt undefined", async () => {
		const { host } = createHost();
		const lifecycle = createGoalLifecycle({ now: () => 10 });
		await lifecycle.dispatch({ type: "sessionStarted", branch: [activeGoalEntry()], host });

		const changed = await lifecycle.dispatch({
			type: "agentPromptConstruction",
			systemPrompt: "BASE",
			host,
		});
		expect(changed?.systemPrompt).toContain("BASE\n\n## Active Goal");

		await lifecycle.dispatch({
			type: "sessionStarted",
			branch: [],
			host,
		});
		expect(await lifecycle.dispatch({ type: "agentPromptConstruction", systemPrompt: "BASE", host })).toBeUndefined();
	});

	it("accepts the semantic turn observation shape", async () => {
		const { host } = createHost();
		const lifecycle = createGoalLifecycle({ now: () => 10 });
		await lifecycle.dispatch({ type: "sessionStarted", branch: [activeGoalEntry()], host });
		const observation: GoalTurnObservation = { message: { role: "assistant", stopReason: "stop" }, toolResults: [] };
		await lifecycle.dispatch({ type: "turnEnded", observation, host });
	});

	it("resets branch currency and ignores the old compaction completion", async () => {
		const old = createHost();
		const next = createHost();
		const lifecycle = createGoalLifecycle({ now: () => 10 });
		await lifecycle.dispatch({ type: "sessionStarted", branch: [activeGoalEntry(), runtimeEntry()], host: old.host });
		await lifecycle.dispatch({ type: "agentSettled", host: old.host });
		await lifecycle.dispatch({ type: "messageStarted", role: "custom", customType: "goal-continuation", goalId: "goal-1", host: old.host });
		await lifecycle.dispatch({ type: "compactionStateChanged", event: { inProgress: true, source: "turn_end", resumesRun: false }, host: old.host });
		await lifecycle.dispatch({ type: "agentSettled", host: old.host });
		next.effects.splice(0);
		await lifecycle.dispatch({ type: "branchChanged", branch: [activeGoalEntry(), runtimeEntry()], host: next.host });
		expect(next.effects).toEqual([expect.objectContaining({ type: "widget" })]);
		await lifecycle.dispatch({ type: "compactionStateChanged", event: { inProgress: false, source: "turn_end", resumesRun: false, succeeded: true }, host: old.host });
		expect(next.effects).toHaveLength(1);
		await lifecycle.dispatch({ type: "agentSettled", host: next.host });
		expect(next.effects.filter((effect) => effect.type === "continuation")).toHaveLength(1);
	});

	it("keeps a reconstructed cleared tombstone distinct from a successful clear", async () => {
		const { host, effects } = createHost();
		const lifecycle = createGoalLifecycle({ now: () => 10 });
		const tombstone = { ...activeGoalEntry(), data: {
			action: "clear",
			state: { goalId: "goal-1", objective: "", status: "cleared", createdAt: 0, updatedAt: 9 },
		} };
		await lifecycle.dispatch({ type: "sessionStarted", branch: [tombstone], host });
		expect(effects[0]).toEqual({ type: "widget", value: null });
		const status = await lifecycle.dispatch({ type: "toolRequested", request: { action: "status" }, host });
		expect(status).toMatchObject({ state: { status: "cleared" }, runtime: null });
		const mutation = await lifecycle.dispatch({ type: "toolRequested", request: { action: "checkpoint", summary: "x" }, host });
		expect(mutation).toMatchObject({ isError: true, error: "Cannot checkpoint: goal is cleared." });

		await lifecycle.dispatch({ type: "sessionStarted", branch: [activeGoalEntry()], host });
		await lifecycle.dispatch({ type: "commandRequested", args: "clear", host });
		expect(await lifecycle.dispatch({ type: "toolRequested", request: { action: "status" }, host })).toMatchObject({ state: null, runtime: null });
	});

	it("recognizes one hidden continuation and preserves runtime write ordering", async () => {
		const { host, effects } = createHost();
		const lifecycle = createGoalLifecycle({ now: () => 10 });
		await lifecycle.dispatch({ type: "sessionStarted", branch: [activeGoalEntry(), runtimeEntry()], host });
		await lifecycle.dispatch({ type: "agentSettled", host });
		await lifecycle.dispatch({ type: "messageStarted", role: "custom", customType: "goal-continuation", goalId: "goal-1", host });
		await lifecycle.dispatch({
			type: "turnEnded",
			observation: { message: { role: "assistant", stopReason: "toolUse" }, toolResults: [{ toolName: "bash", isError: true }] },
			host,
		});
		await lifecycle.dispatch({
			type: "turnEnded",
			observation: { message: { role: "assistant", stopReason: "stop" }, toolResults: [{ toolName: "read", isError: false }] },
			host,
		});
		await lifecycle.dispatch({ type: "agentSettled", host });

		expect(effects.filter((effect) => effect.type === "continuation")).toHaveLength(2);
		expect(effects.filter((effect) => effect.type === "runtime").map((effect) => (effect.value as GoalRuntimeSnapshot).continuationRuns))
			.toEqual([3, 3, 4]);
	});

	it("clears a stranded pending marker only for user or custom messages", async () => {
		const { host, effects } = createHost();
		const lifecycle = createGoalLifecycle({ now: () => 10 });
		await lifecycle.dispatch({ type: "sessionStarted", branch: [activeGoalEntry(), runtimeEntry()], host });
		await lifecycle.dispatch({ type: "agentSettled", host });
		await lifecycle.dispatch({ type: "messageStarted", role: "assistant", host });
		await lifecycle.dispatch({ type: "agentSettled", host });
		expect(effects.filter((effect) => effect.type === "continuation")).toHaveLength(1);
		await lifecycle.dispatch({ type: "messageStarted", role: "custom", customType: "goal-continuation", goalId: "wrong", host });
		await lifecycle.dispatch({ type: "agentSettled", host });
		expect(effects.filter((effect) => effect.type === "continuation")).toHaveLength(2);
	});

	it("pauses aborted work and blocks error work with exact effect order", async () => {
		const aborted = createHost();
		const lifecycle = createGoalLifecycle({ now: () => 10 });
		await lifecycle.dispatch({ type: "sessionStarted", branch: [activeGoalEntry(), runtimeEntry()], host: aborted.host });
		await lifecycle.dispatch({ type: "agentSettled", host: aborted.host });
		await lifecycle.dispatch({ type: "messageStarted", role: "custom", customType: "goal-continuation", goalId: "goal-1", host: aborted.host });
		await lifecycle.dispatch({ type: "turnEnded", observation: { message: { role: "assistant", stopReason: "aborted" }, toolResults: [] }, host: aborted.host });
		aborted.effects.splice(0);
		await lifecycle.dispatch({ type: "agentSettled", host: aborted.host });
		expect(aborted.effects.map((effect) => effect.type)).toEqual(["runtime", "goal", "widget", "notify"]);
		expect(aborted.effects.find((effect) => effect.type === "goal")).toMatchObject({ value: { action: "pause" } });

		const blocked = createHost();
		const blockedLifecycle = createGoalLifecycle({ now: () => 10 });
		await blockedLifecycle.dispatch({ type: "sessionStarted", branch: [activeGoalEntry(), runtimeEntry()], host: blocked.host });
		await blockedLifecycle.dispatch({ type: "agentSettled", host: blocked.host });
		await blockedLifecycle.dispatch({ type: "messageStarted", role: "custom", customType: "goal-continuation", goalId: "goal-1", host: blocked.host });
		await blockedLifecycle.dispatch({ type: "turnEnded", observation: { message: { role: "assistant", stopReason: "error" }, toolResults: [] }, host: blocked.host });
		blocked.effects.splice(0);
		await blockedLifecycle.dispatch({ type: "agentSettled", host: blocked.host });
		expect(blocked.effects.map((effect) => effect.type)).toEqual(["runtime", "goal", "runtime", "widget", "notify"]);
		expect(blocked.effects.find((effect) => effect.type === "goal")).toMatchObject({ value: { action: "block" } });
	});

	it("defers turn-end compaction and resumes only when it does not resume the run", async () => {
		const { host, effects } = createHost();
		const lifecycle = createGoalLifecycle({ now: () => 10 });
		await lifecycle.dispatch({ type: "sessionStarted", branch: [activeGoalEntry(), runtimeEntry()], host });
		await lifecycle.dispatch({ type: "agentSettled", host });
		await lifecycle.dispatch({ type: "messageStarted", role: "custom", customType: "goal-continuation", goalId: "goal-1", host });
		await lifecycle.dispatch({ type: "compactionStateChanged", event: { inProgress: true, source: "turn_end", resumesRun: true }, host });
		await lifecycle.dispatch({ type: "turnEnded", observation: { message: { role: "assistant", stopReason: "length" }, toolResults: [] }, host });
		effects.splice(0);
		await lifecycle.dispatch({ type: "agentSettled", host });
		expect(effects.filter((effect) => effect.type === "continuation")).toHaveLength(0);
		await lifecycle.dispatch({ type: "compactionStateChanged", event: { inProgress: false, source: "turn_end", resumesRun: true, succeeded: true }, host });
		expect(effects.filter((effect) => effect.type === "continuation")).toHaveLength(0);

		const nonResuming = createHost();
		const nonResumingLifecycle = createGoalLifecycle({ now: () => 10 });
		await nonResumingLifecycle.dispatch({ type: "sessionStarted", branch: [activeGoalEntry(), runtimeEntry()], host: nonResuming.host });
		await nonResumingLifecycle.dispatch({ type: "agentSettled", host: nonResuming.host });
		await nonResumingLifecycle.dispatch({ type: "messageStarted", role: "custom", customType: "goal-continuation", goalId: "goal-1", host: nonResuming.host });
		await nonResumingLifecycle.dispatch({ type: "compactionStateChanged", event: { inProgress: true, source: "turn_end", resumesRun: false }, host: nonResuming.host });
		await nonResumingLifecycle.dispatch({ type: "agentSettled", host: nonResuming.host });
		await nonResumingLifecycle.dispatch({ type: "compactionStateChanged", event: { inProgress: false, source: "turn_end", resumesRun: false, succeeded: true }, host: nonResuming.host });
		expect(nonResuming.effects.filter((effect) => effect.type === "continuation")).toHaveLength(2);
	});

	it("blocks on failed compaction and uses the fallback error for omitted success", async () => {
		const { host, effects } = createHost();
		const lifecycle = createGoalLifecycle({ now: () => 10 });
		await lifecycle.dispatch({ type: "sessionStarted", branch: [activeGoalEntry(), runtimeEntry()], host });
		await lifecycle.dispatch({ type: "agentSettled", host });
		await lifecycle.dispatch({ type: "messageStarted", role: "custom", customType: "goal-continuation", goalId: "goal-1", host });
		await lifecycle.dispatch({ type: "compactionStateChanged", event: { inProgress: true, source: "turn_end", resumesRun: true }, host });
		await lifecycle.dispatch({ type: "agentSettled", host });
		effects.splice(0);
		await lifecycle.dispatch({ type: "compactionStateChanged", event: { inProgress: false, source: "turn_end", resumesRun: true }, host });
		expect(effects).toContainEqual(expect.objectContaining({ type: "goal", value: expect.objectContaining({ action: "block", state: expect.objectContaining({ blockedReason: "Session compaction failed." }) }) }));
		expect(effects).toContainEqual({ type: "notify", value: { message: "Goal blocked: Session compaction failed.", severity: "warning" } });
	});

	it("rejects malformed compaction optional fields at the raw boundary", () => {
		expect(isCompactionStateEvent({ inProgress: true, source: "turn_end", resumesRun: true })).toBe(true);
		expect(isCompactionStateEvent({ inProgress: true, source: "turn_end", resumesRun: true, succeeded: undefined })).toBe(false);
		expect(isCompactionStateEvent({ inProgress: false, source: "turn_end", resumesRun: false, error: 3 })).toBe(false);
	});

	it("preserves the blank command suffix for a reconstructed tombstone", async () => {
		const { host, effects } = createHost();
		const lifecycle = createGoalLifecycle({ now: () => 10 });
		const tombstone = { ...activeGoalEntry(), data: {
			action: "clear",
			state: { goalId: "goal-1", objective: "", status: "cleared", createdAt: 0, updatedAt: 9 },
		} };
		await lifecycle.dispatch({ type: "sessionStarted", branch: [tombstone], host });
		effects.splice(0);
		await lifecycle.dispatch({ type: "commandRequested", args: "", host });
		expect(effects).toContainEqual({ type: "notify", value: { message: "No active goal. Use /goal <objective> to set one.\n", severity: "info" } });
	});

	it("applies command transitions in effect order and queues busy kickoff", async () => {
		const { host, effects } = createHost({ idle: false });
		const lifecycle = createGoalLifecycle({ now: () => 10 });
		await lifecycle.dispatch({ type: "commandRequested", args: "Ship the release", host, preSession: true });
		expect(effects.map((effect) => effect.type)).toEqual(["goal", "notify", "widget", "kickoff"]);
		expect(effects.at(-1)).toEqual(expect.objectContaining({ type: "kickoff", value: expect.objectContaining({ queued: true }) }));

		effects.splice(0);
		await lifecycle.dispatch({ type: "commandRequested", args: "", host, preSession: true });
		expect(effects.find((effect) => effect.type === "notify")).toMatchObject({ value: { message: expect.stringContaining("Continuation runs:") } });
	});

	it("applies every Goal command transition through the lifecycle host", async () => {
		const cases = [
			{ args: "pause", status: "active", action: "pause" },
			{ args: "resume", status: "paused", action: "resume" },
			{ args: "resume", status: "budget_limited", action: "resume" },
			{ args: "edit New wording", status: "active", action: "set" },
			{ args: "checkpoint Useful evidence", status: "active", action: "checkpoint" },
			{ args: "blocked Needs access", status: "active", action: "block" },
			{ args: "clear", status: "active", action: "clear" },
		] as const;
		for (const testCase of cases) {
			const { host, effects } = createHost();
			const lifecycle = createGoalLifecycle({ now: () => 10 });
			await lifecycle.dispatch({ type: "sessionStarted", branch: [activeGoalEntry("goal-1", testCase.status), runtimeEntry()], host });
			effects.splice(0);
			await lifecycle.dispatch({ type: "commandRequested", args: testCase.args, host });
			expect(effects.filter((effect) => effect.type === "goal")).toHaveLength(1);
			expect(effects).toContainEqual(expect.objectContaining({ type: "goal", value: expect.objectContaining({ action: testCase.action }) }));
			expect(effects.filter((effect) => effect.type === "widget")).toHaveLength(1);
			if (testCase.status === "budget_limited") {
				expect(effects).toContainEqual(expect.objectContaining({ type: "runtime", value: expect.objectContaining({ continuationRuns: 0 }) }));
			}
		}
	});

	it("applies checkpoint and blocked tool mutations once", async () => {
		const checkpoint = createHost();
		const checkpointLifecycle = createGoalLifecycle({ now: () => 10 });
		await checkpointLifecycle.dispatch({ type: "sessionStarted", branch: [activeGoalEntry()], host: checkpoint.host });
		checkpoint.effects.splice(0);
		const checkpointResult = await checkpointLifecycle.dispatch({ type: "toolRequested", request: { action: "checkpoint", summary: " Useful " }, host: checkpoint.host });
		expect(checkpointResult).toMatchObject({ state: { checkpointProgress: "Useful" } });
		expect(checkpoint.effects.map((effect) => effect.type)).toEqual(["goal", "widget"]);

		const blocked = createHost();
		const blockedLifecycle = createGoalLifecycle({ now: () => 10 });
		await blockedLifecycle.dispatch({ type: "sessionStarted", branch: [activeGoalEntry()], host: blocked.host });
		blocked.effects.splice(0);
		const blockedResult = await blockedLifecycle.dispatch({ type: "toolRequested", request: { action: "blocked", reason: " Need access " }, host: blocked.host });
		expect(blockedResult).toMatchObject({ state: { status: "blocked", blockedReason: "Need access" } });
		expect(blocked.effects.map((effect) => effect.type)).toEqual(["goal", "widget", "notify"]);
	});

	it("keeps an awaited replacement confirmation from committing after Session reset", async () => {
		let resolveConfirmation!: (accepted: boolean) => void;
		const oldHost = createHost({ confirm: () => new Promise<boolean>((resolve) => { resolveConfirmation = resolve; }) });
		const nextHost = createHost();
		const lifecycle = createGoalLifecycle({ now: () => 10 });
		await lifecycle.dispatch({ type: "sessionStarted", branch: [activeGoalEntry()], host: oldHost.host });
		const command = lifecycle.dispatch({ type: "commandRequested", args: "New objective", host: oldHost.host });
		await vi.waitFor(() => expect(oldHost.host.confirm).toHaveBeenCalledOnce());
		const reset = lifecycle.dispatch({ type: "sessionStarted", branch: [], host: nextHost.host });
		resolveConfirmation(true);
		await Promise.all([command, reset]);
		expect(oldHost.effects.filter((effect) => effect.type === "goal")).toHaveLength(0);
		expect(nextHost.effects).toContainEqual({ type: "widget", value: null });
	});

	it("validates complete evidence without throwing on malformed fields", async () => {
		const { host, effects } = createHost();
		const lifecycle = createGoalLifecycle({ now: () => 10 });
		await lifecycle.dispatch({ type: "sessionStarted", branch: [activeGoalEntry()], host });
		const malformedEvidence = [{ requirement: 3, verification: "ok", result: "passed" }] as unknown as GoalEvidence[];
		const malformed = await lifecycle.dispatch({
			type: "toolRequested",
			request: { action: "complete", summary: "Done", evidence: malformedEvidence },
			host,
		});
		expect(malformed).toMatchObject({ isError: true, error: "Every evidence item needs a requirement and verification." });
		effects.splice(0);
		const complete = await lifecycle.dispatch({
			type: "toolRequested",
			request: { action: "complete", summary: " Done ", evidence: [{ requirement: "Tests", verification: "passed", result: "passed" }] },
			host,
		});
		expect(complete).toMatchObject({ state: { status: "completed", completionSummary: "Done" }, evidence: [{ requirement: "Tests" }] });
		expect(effects.map((effect) => effect.type)).toEqual(["goal", "widget", "notify"]);
	});

	it("shuts down the aggregate and makes queued old events neutral", async () => {
		const { host, effects } = createHost();
		const lifecycle = createGoalLifecycle({ now: () => 10 });
		await lifecycle.dispatch({ type: "sessionStarted", branch: [activeGoalEntry(), runtimeEntry()], host });
		await lifecycle.dispatch({ type: "agentSettled", host });
		effects.splice(0);
		await lifecycle.dispatch({ type: "sessionStopping", host });
		const stale = await lifecycle.dispatch({ type: "toolRequested", request: { action: "status" }, host });
		expect(stale).toMatchObject({ state: null, runtime: null });
		expect(effects).toEqual([]);
	});

	it("does not defer a settlement for pre-agent compaction", async () => {
		const { host, effects } = createHost();
		const lifecycle = createGoalLifecycle({ now: () => 10 });
		await lifecycle.dispatch({ type: "sessionStarted", branch: [activeGoalEntry(), runtimeEntry()], host });
		await lifecycle.dispatch({ type: "compactionStateChanged", event: { inProgress: true, source: "before_agent_start", resumesRun: false }, host });
		effects.splice(0);
		await lifecycle.dispatch({ type: "agentSettled", host });
		await lifecycle.dispatch({ type: "compactionStateChanged", event: { inProgress: false, source: "before_agent_start", resumesRun: false, succeeded: true }, host });
		expect(effects.filter((effect) => effect.type === "continuation")).toHaveLength(0);
	});

	it("applies the continuation guards and persists the limit stop", async () => {
		const pending = createHost({ pending: true });
		const pendingLifecycle = createGoalLifecycle({ now: () => 10 });
		await pendingLifecycle.dispatch({ type: "sessionStarted", branch: [activeGoalEntry(), runtimeEntry()], host: pending.host });
		await pendingLifecycle.dispatch({ type: "agentSettled", host: pending.host });
		expect(pending.effects.filter((effect) => effect.type === "continuation")).toHaveLength(0);

		const busy = createHost({ idle: false });
		const busyLifecycle = createGoalLifecycle({ now: () => 10 });
		await busyLifecycle.dispatch({ type: "sessionStarted", branch: [activeGoalEntry(), runtimeEntry()], host: busy.host });
		await busyLifecycle.dispatch({ type: "agentSettled", host: busy.host });
		expect(busy.effects.filter((effect) => effect.type === "continuation")).toHaveLength(0);

		const limited = createHost();
		const limitedLifecycle = createGoalLifecycle({ now: () => 10 });
		await limitedLifecycle.dispatch({ type: "sessionStarted", branch: [activeGoalEntry(), runtimeEntry("goal-1", { continuationRuns: 30 })], host: limited.host });
		await limitedLifecycle.dispatch({ type: "agentSettled", host: limited.host });
		expect(limited.effects).toContainEqual(expect.objectContaining({ type: "goal", value: expect.objectContaining({ action: "limit" }) }));
		expect(limited.effects).toContainEqual(expect.objectContaining({ type: "notify", value: { message: "Goal budget limited: Continuation limit reached (30 runs).", severity: "warning" } }));
	});

	it("recovers after a synchronous send failure and a rejected queued task", async () => {
		let failSend = true;
		const failedSend = createHost({ sendContinuation: () => {
			if (failSend) throw new Error("send failed");
		} });
		const failedSendLifecycle = createGoalLifecycle({ now: () => 10 });
		await failedSendLifecycle.dispatch({ type: "sessionStarted", branch: [activeGoalEntry(), runtimeEntry()], host: failedSend.host });
		await failedSendLifecycle.dispatch({ type: "agentSettled", host: failedSend.host });
		expect(failedSend.effects).toContainEqual({ type: "notify", value: { message: "Goal continuation failed: send failed", severity: "error" } });
		failSend = false;
		await failedSendLifecycle.dispatch({ type: "agentSettled", host: failedSend.host });
		expect(failedSend.effects.filter((effect) => effect.type === "continuation")).toHaveLength(2);

		let throwWidget = false;
		const rejected = createHost({ updateWidget: () => {
			if (throwWidget) throw new Error("widget failed");
		} });
		const rejectedLifecycle = createGoalLifecycle({ now: () => 10 });
		await rejectedLifecycle.dispatch({ type: "sessionStarted", branch: [activeGoalEntry()], host: rejected.host });
		throwWidget = true;
		await expect(rejectedLifecycle.dispatch({ type: "turnEnded", observation: { message: { role: "assistant", stopReason: "stop" }, toolResults: [] }, host: rejected.host })).rejects.toThrow("widget failed");
		throwWidget = false;
		expect(await rejectedLifecycle.dispatch({ type: "toolRequested", request: { action: "status" }, host: rejected.host })).toMatchObject({ state: { status: "active" } });
	});

	it("blocks after the third consecutive failure run", async () => {
		const { host, effects } = createHost();
		const lifecycle = createGoalLifecycle({ now: () => 10 });
		await lifecycle.dispatch({ type: "sessionStarted", branch: [activeGoalEntry(), runtimeEntry("goal-1", { consecutiveFailureRuns: 2 })], host });
		await lifecycle.dispatch({ type: "agentSettled", host });
		await lifecycle.dispatch({ type: "messageStarted", role: "custom", customType: "goal-continuation", goalId: "goal-1", host });
		await lifecycle.dispatch({ type: "turnEnded", observation: { message: { role: "assistant", stopReason: "stop" }, toolResults: [{ toolName: "bash", isError: true }] }, host });
		effects.splice(0);
		await lifecycle.dispatch({ type: "agentSettled", host });
		expect(effects).toContainEqual(expect.objectContaining({ type: "goal", value: expect.objectContaining({ action: "block", state: expect.objectContaining({ blockedReason: "Execution failed in three consecutive automatic runs." }) }) }));
	});

	it("suppresses continuation after the third no-progress run and preserves stale completion currency", async () => {
		const old = createHost();
		const next = createHost();
		const lifecycle = createGoalLifecycle({ now: () => 10 });
		await lifecycle.dispatch({ type: "sessionStarted", branch: [activeGoalEntry(), runtimeEntry("goal-1", { consecutiveNoProgressRuns: 2 })], host: old.host });
		await lifecycle.dispatch({ type: "agentSettled", host: old.host });
		await lifecycle.dispatch({ type: "messageStarted", role: "custom", customType: "goal-continuation", goalId: "goal-1", host: old.host });
		await lifecycle.dispatch({ type: "turnEnded", observation: { message: { role: "assistant", stopReason: "stop" }, toolResults: [] }, host: old.host });
		await lifecycle.dispatch({ type: "agentSettled", host: old.host });
		expect(old.effects).toContainEqual(expect.objectContaining({ type: "goal", value: expect.objectContaining({ action: "block" }) }));

		await lifecycle.dispatch({ type: "compactionStateChanged", event: { inProgress: true, source: "turn_end", resumesRun: true }, host: old.host });
		await lifecycle.dispatch({ type: "sessionStarted", branch: [activeGoalEntry()], host: next.host });
		await lifecycle.dispatch({ type: "compactionStateChanged", event: { inProgress: false, source: "turn_end", resumesRun: true, succeeded: false, error: "stale" }, host: old.host });
		expect(next.effects).not.toContainEqual(expect.objectContaining({ type: "goal", value: expect.objectContaining({ action: "block" }) }));
	});
});
