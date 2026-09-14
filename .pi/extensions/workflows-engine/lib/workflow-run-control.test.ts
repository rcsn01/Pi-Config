import { mkdtemp, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkflowRunControl } from "./workflow-run-control.ts";
import type { PreparedWorkflowRun } from "./runner.ts";
import { RunAlreadyActiveError, type WorkflowRunDetail, type WorkflowRunHandle } from "./workflow-run.ts";

const temporary: string[] = [];

afterEach(async () => {
	await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryCwd(): Promise<string> {
	const directory = await mkdtemp(path.join(os.tmpdir(), "workflow-run-control-"));
	temporary.push(directory);
	return directory;
}

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
	return { promise, resolve, reject };
}

function detail(runId: string, status: WorkflowRunDetail["status"] = "running"): WorkflowRunDetail {
	return {
		runId, workflowName: "deep-research", trust: "bundled", args: "", sourceHash: "hash", eventLogPath: `/tmp/${runId}/events.jsonl`,
		status, startedAt: 1, updatedAt: 2, agentsStarted: 0, agentsCompleted: 0, agentsFailed: 0, tokens: 0, cost: 0,
		usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, turns: 0, cost: 0 },
		phases: {}, steps: {}, agents: {}, parallel: {}, artifacts: [], sourceSnapshotPath: undefined,
	};
}

function prepared(runId: string, overrides: Partial<WorkflowRunHandle> = {}): PreparedWorkflowRun {
	const handle: WorkflowRunHandle = {
		runId,
		execute: async () => "executed",
		restart: async () => "restarted",
		requestPause: async () => undefined,
		requestStop() {},
		inspect: async () => detail(runId),
		...overrides,
	};
	return {
		entry: { name: "deep-research", description: "test", trust: "bundled", cost: "quick", canEditFiles: false, source: "source", sourceHash: "hash" },
		handle,
	};
}

function started(result: ReturnType<ReturnType<typeof createWorkflowRunControl>["start"]>) {
	if (result.status !== "started") throw new Error("expected admission");
	return result;
}

describe("WorkflowRunControl", () => {
	it("dispatches execute and restart exactly once and preserves results", async () => {
		const cwd = await temporaryCwd();
		const calls: string[] = [];
		const control = createWorkflowRunControl();
		const execute = started(control.start({
			cwd,
			prepared: prepared("run-execute", {
				execute: async () => { calls.push("execute"); return { answer: 42 }; },
				restart: async () => { calls.push("wrong-restart"); return undefined; },
			}),
			operation: { type: "execute" },
		}));
		expect(calls).toEqual([]);
		const restart = started(control.start({
			cwd,
			prepared: prepared("run-restart", {
				execute: async () => { calls.push("wrong-execute"); return undefined; },
				restart: async (key) => { calls.push(`restart:${key}`); return null; },
			}),
			operation: { type: "restart", durableKey: "exact:key" },
		}));

		await expect(execute.completion).resolves.toEqual({ status: "completed", result: { answer: 42 } });
		await expect(restart.completion).resolves.toEqual({ status: "completed", result: null });
		expect(calls).toEqual(["execute", "restart:exact:key"]);
	});

	it("registers before invocation and rejects only matching canonical keys", async () => {
		const cwd = await temporaryCwd();
		const otherCwd = await temporaryCwd();
		const pending = deferred<unknown>();
		const pauseCalls: string[] = [];
		const control = createWorkflowRunControl();
		const firstPrepared = prepared("run-1", {
			execute: () => {
				void control.pause({ cwd, runId: "run-1", mode: "now" });
				return pending.promise;
			},
			requestPause: async (mode) => { if (mode) pauseCalls.push(mode); },
		});
		const first = started(control.start({ cwd, prepared: firstPrepared, operation: { type: "execute" } }));
		const duplicate = control.start({ cwd: path.join(cwd, ".", "child", ".."), prepared: prepared("run-1"), operation: { type: "execute" } });
		const otherRun = started(control.start({ cwd, prepared: prepared("run-2"), operation: { type: "execute" } }));
		const otherProject = started(control.start({ cwd: otherCwd, prepared: prepared("run-1"), operation: { type: "execute" } }));

		expect(duplicate).toEqual({ status: "already-active" });
		await Promise.resolve();
		expect(pauseCalls).toEqual(["now"]);
		pending.resolve("done");
		await Promise.all([first.completion, otherRun.completion, otherProject.completion]);
	});

	it("turns synchronous and asynchronous failures into settlements and releases admission", async () => {
		const cwd = await temporaryCwd();
		const syncError = new Error("sync");
		const asyncError = new Error("async");
		const control = createWorkflowRunControl();
		const sync = started(control.start({
			cwd,
			prepared: prepared("run-sync", { execute: () => { throw syncError; } }),
			operation: { type: "execute" },
		}));
		const asynchronous = started(control.start({
			cwd,
			prepared: prepared("run-async", { execute: async () => { throw asyncError; } }),
			operation: { type: "execute" },
		}));

		await expect(sync.completion).resolves.toEqual({ status: "failed", error: syncError });
		await expect(asynchronous.completion).resolves.toEqual({ status: "failed", error: asyncError });
		const readmitted = started(control.start({ cwd, prepared: prepared("run-sync"), operation: { type: "execute" } }));
		await expect(readmitted.completion).resolves.toEqual({ status: "completed", result: "executed" });
	});

	it("keeps completion pending and preserves string, null, and undefined values", async () => {
		const cwd = await temporaryCwd();
		const waiting = deferred<unknown>();
		const control = createWorkflowRunControl();
		const pending = started(control.start({ cwd, prepared: prepared("pending", { execute: () => waiting.promise }), operation: { type: "execute" } }));
		let settled = false;
		void pending.completion.then(() => { settled = true; });
		await Promise.resolve();
		expect(settled).toBe(false);
		waiting.resolve(undefined);
		await expect(pending.completion).resolves.toEqual({ status: "completed", result: undefined });

		for (const [runId, value] of [["string", ""], ["null", null]] as const) {
			const result = started(control.start({ cwd, prepared: prepared(runId, { execute: async () => value }), operation: { type: "execute" } }));
			await expect(result.completion).resolves.toEqual({ status: "completed", result: value });
		}
	});

	it("classifies duplicate errors without inspection", async () => {
		const cwd = await temporaryCwd();
		const errors: unknown[] = [new RunAlreadyActiveError("one"), { code: "WORKFLOW_RUN_ALREADY_ACTIVE" }];
		for (const [index, error] of errors.entries()) {
			let inspections = 0;
			const control = createWorkflowRunControl();
			const result = started(control.start({
				cwd,
				prepared: prepared(`duplicate-${index}`, {
					execute: async () => { throw error; },
					inspect: async () => { inspections += 1; return detail(`duplicate-${index}`); },
				}),
				operation: { type: "execute" },
			}));
			await expect(result.completion).resolves.toEqual({ status: "already-active" });
			expect(inspections).toBe(0);
		}
	});

	it("classifies paused and stopped failures from inspection", async () => {
		const cwd = await temporaryCwd();
		for (const status of ["paused", "stopped"] as const) {
			const control = createWorkflowRunControl();
			const result = started(control.start({
				cwd,
				prepared: prepared(status, { execute: async () => { throw new Error(status); }, inspect: async () => detail(status, status) }),
				operation: { type: "execute" },
			}));
			await expect(result.completion).resolves.toEqual({ status });
		}
	});

	it("preserves the operation error for every other status and inspection failure", async () => {
		const cwd = await temporaryCwd();
		const statuses: WorkflowRunDetail["status"][] = ["created", "running", "pausing", "completed", "failed"];
		for (const status of statuses) {
			const error = { status };
			const control = createWorkflowRunControl();
			const result = started(control.start({
				cwd,
				prepared: prepared(`status-${status}`, { execute: async () => { throw error; }, inspect: async () => detail(`status-${status}`, status) }),
				operation: { type: "execute" },
			}));
			await expect(result.completion).resolves.toEqual({ status: "failed", error });
		}

		const operationError = new Error("operation");
		const control = createWorkflowRunControl();
		const inspectFailure = started(control.start({
			cwd,
			prepared: prepared("inspect-failure", { execute: async () => { throw operationError; }, inspect: async () => { throw new Error("inspect"); } }),
			operation: { type: "execute" },
		}));
		await expect(inspectFailure.completion).resolves.toEqual({ status: "failed", error: operationError });
	});

	it("routes pause modes and preserves pause request errors while active", async () => {
		const cwd = await temporaryCwd();
		const execution = deferred<unknown>();
		const modes: string[] = [];
		const syncError = new Error("pause sync");
		const control = createWorkflowRunControl();
		started(control.start({
			cwd,
			prepared: prepared("pause", {
				execute: () => execution.promise,
				requestPause: (mode) => {
					if (mode) modes.push(mode);
					if (mode === "now") throw syncError;
					return Promise.resolve();
				},
			}),
			operation: { type: "execute" },
		}));

		await expect(control.pause({ cwd, runId: "pause", mode: "after-current" })).resolves.toBeUndefined();
		await expect(control.pause({ cwd, runId: "pause", mode: "now" })).rejects.toBe(syncError);
		expect(modes).toEqual(["after-current", "now"]);

		const asyncExecution = deferred<unknown>();
		let asyncPauseCalls = 0;
		started(control.start({
			cwd,
			prepared: prepared("pause-async", {
				execute: () => asyncExecution.promise,
				requestPause: async () => { asyncPauseCalls += 1; throw new Error("pause async"); },
			}),
			operation: { type: "execute" },
		}));
		await expect(control.pause({ cwd, runId: "pause-async", mode: "after-current" })).rejects.toThrow("pause async");
		await expect(control.pause({ cwd, runId: "pause-async", mode: "now" })).rejects.toThrow("pause async");
		expect(asyncPauseCalls).toBe(2);
		expect(control.pause({ cwd, runId: "missing", mode: "now" })).toBeUndefined();
		expect(() => control.pause({ cwd, runId: "../bad", mode: "now" })).toThrow("Invalid workflow run id");
		execution.resolve("done");
		asyncExecution.resolve("done");
	});

	it("routes stop, reports missing targets, and preserves stop errors while active", async () => {
		const cwd = await temporaryCwd();
		const execution = deferred<unknown>();
		const reasons: Array<string | undefined> = [];
		const stopError = new Error("stop");
		const control = createWorkflowRunControl();
		started(control.start({
			cwd,
			prepared: prepared("stop", { execute: () => execution.promise, requestStop: (reason) => { reasons.push(reason); throw stopError; } }),
			operation: { type: "execute" },
		}));

		expect(() => control.stop({ cwd, runId: "stop", reason: "exact reason" })).toThrow(stopError);
		expect(reasons).toEqual(["exact reason"]);

		const successfulExecution = deferred<unknown>();
		const successfulReasons: Array<string | undefined> = [];
		started(control.start({
			cwd,
			prepared: prepared("stop-success", { execute: () => successfulExecution.promise, requestStop: (reason) => { successfulReasons.push(reason); } }),
			operation: { type: "execute" },
		}));
		expect(control.stop({ cwd, runId: "stop-success", reason: "successful stop" })).toBe(true);
		expect(successfulReasons).toEqual(["successful stop"]);
		expect(control.stop({ cwd, runId: "stop-success", reason: "still active" })).toBe(true);
		expect(successfulReasons).toEqual(["successful stop", "still active"]);
		expect(control.stop({ cwd, runId: "missing" })).toBe(false);
		expect(() => control.stop({ cwd, runId: "../bad" })).toThrow("Invalid workflow run id");
		execution.resolve("done");
		successfulExecution.resolve("done");
	});

	it("signals a shutdown snapshot before draining every settlement", async () => {
		const cwd = await temporaryCwd();
		const first = deferred<unknown>();
		const second = deferred<unknown>();
		const calls: string[] = [];
		const control = createWorkflowRunControl();
		started(control.start({ cwd, prepared: prepared("first", { execute: () => first.promise, requestStop: (reason) => { calls.push(`first:${reason}`); } }), operation: { type: "execute" } }));
		started(control.start({ cwd, prepared: prepared("second", { execute: () => second.promise, requestStop: (reason) => { calls.push(`second:${reason}`); } }), operation: { type: "execute" } }));
		await Promise.resolve();
		const shutdown = control.shutdown("shutdown");
		expect(shutdown.runIds).toEqual(["first", "second"]);
		expect(calls).toEqual(["first:shutdown", "second:shutdown"]);
		let drained = false;
		void shutdown.completion.then(() => { drained = true; });
		first.reject(new Error("failed"));
		await Promise.resolve();
		expect(drained).toBe(false);
		second.resolve("done");
		await expect(shutdown.completion).resolves.toBeUndefined();
	});

	it("does not close or coalesce shutdown and propagates a stop throw", async () => {
		const cwd = await temporaryCwd();
		const control = createWorkflowRunControl();
		await expect(control.shutdown().completion).resolves.toBeUndefined();

		const later = deferred<unknown>();
		started(control.start({ cwd, prepared: prepared("later", { execute: () => later.promise }), operation: { type: "execute" } }));
		await Promise.resolve();
		const secondShutdown = control.shutdown("later shutdown");
		expect(secondShutdown.runIds).toEqual(["later"]);
		later.resolve("done");
		await secondShutdown.completion;

		const pending = deferred<unknown>();
		const calls: string[] = [];
		started(control.start({ cwd, prepared: prepared("first", { execute: () => pending.promise, requestStop: () => { calls.push("first"); } }), operation: { type: "execute" } }));
		started(control.start({ cwd, prepared: prepared("second", { execute: () => pending.promise, requestStop: () => { calls.push("second"); throw new Error("stop failed"); } }), operation: { type: "execute" } }));
		await Promise.resolve();
		expect(() => control.shutdown("again")).toThrow("stop failed");
		expect(calls).toEqual(["first", "second"]);
		pending.resolve("done");
	});
});
