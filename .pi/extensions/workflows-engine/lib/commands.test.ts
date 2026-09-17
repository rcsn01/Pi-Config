import { describe, expect, it } from "vitest";
import { registerWorkflowCommands, type WorkflowCommandService } from "./commands.ts";
import type {
	WorkflowRunControl,
	WorkflowRunShutdownResult,
	WorkflowRunStartResult,
} from "./workflow-run-control.ts";
import type { PreparedWorkflowRun } from "./runner.ts";
import type { WorkflowRunDetail } from "./workflow-run-state.ts";

function entry() {
	return { name: "deep-research", description: "test", trust: "bundled" as const, cost: "quick" as const, canEditFiles: false, source: "source", sourceHash: "hash" };
}

function context(cwd = "/tmp/workflow-command-test", notify?: (message: string, level: string) => void) {
	const notifications: Array<{ message: string; level: string }> = [];
	const ctx = {
		cwd,
		signal: new AbortController().signal,
		hasUI: false,
		ui: {
			notify(message: string, level: string) {
				notifications.push({ message, level });
				notify?.(message, level);
			},
			setStatus() {},
			select: async () => undefined,
			editor: async () => "",
			confirm: async () => true,
		},
	};
	return { ctx: ctx as any, notifications };
}

function detail(runId: string, status: WorkflowRunDetail["status"] = "running"): WorkflowRunDetail {
	return {
		runId, workflowName: "deep-research", trust: "bundled", args: "", sourceHash: "hash", eventLogPath: `/tmp/${runId}/events.jsonl`,
		status, startedAt: 1, updatedAt: 2, agentsStarted: 0, agentsCompleted: 0, agentsFailed: 0, tokens: 0, cost: 0,
		usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, turns: 0, cost: 0 },
		phases: {}, steps: {}, agents: {}, parallel: {}, artifacts: [], sourceSnapshotPath: undefined,
	};
}

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
	return { promise, resolve, reject };
}

function prepared(runId = "run-1"): PreparedWorkflowRun {
	return {
		entry: entry(),
		handle: {
			runId,
			execute: async () => undefined,
			restart: async () => undefined,
			requestPause: async () => undefined,
			requestStop() {},
			inspect: async () => detail(runId),
		},
	};
}

function service(runId = "run-1"): WorkflowCommandService {
	const run = prepared(runId);
	return {
		prepareNew: async () => run,
		prepareExisting: async () => run,
		inspect: async () => detail(runId, "completed"),
		list: async () => [],
		readEvents: async () => [],
		cleanupWorktrees: async () => ({ cleaned: [], skipped: [] }),
	};
}

class FakeRunControl implements WorkflowRunControl {
	readonly starts: Array<Parameters<WorkflowRunControl["start"]>[0]> = [];
	readonly pauses: Array<Parameters<WorkflowRunControl["pause"]>[0]> = [];
	readonly stops: Array<Parameters<WorkflowRunControl["stop"]>[0]> = [];
	readonly shutdownReasons: Array<string | undefined> = [];
	startResult: WorkflowRunStartResult = { status: "started", completion: Promise.resolve({ status: "completed", result: "done" }) };
	pauseResult: Promise<void> | undefined = Promise.resolve();
	stopResult = true;
	shutdownResult: WorkflowRunShutdownResult = { runIds: [], completion: Promise.resolve() };
	pauseError?: unknown;
	stopError?: unknown;
	shutdownError?: unknown;

	start(request: Parameters<WorkflowRunControl["start"]>[0]): WorkflowRunStartResult {
		this.starts.push(request);
		return this.startResult;
	}
	pause(request: Parameters<WorkflowRunControl["pause"]>[0]): Promise<void> | undefined {
		this.pauses.push(request);
		if (this.pauseError) throw this.pauseError;
		return this.pauseResult;
	}
	stop(request: Parameters<WorkflowRunControl["stop"]>[0]): boolean {
		this.stops.push(request);
		if (this.stopError) throw this.stopError;
		return this.stopResult;
	}
	shutdown(reason?: string): WorkflowRunShutdownResult {
		this.shutdownReasons.push(reason);
		if (this.shutdownError) throw this.shutdownError;
		return this.shutdownResult;
	}
}

function register(control = new FakeRunControl(), commandService = service(), sendMessage?: (message: any) => void) {
	let shutdown!: (event: unknown, ctx: any) => Promise<void>;
	const commands = new Map<string, any>();
	const messages: any[] = [];
	const pi = {
		on(name: string, listener: any) { if (name === "session_shutdown") shutdown = listener; },
		registerCommand(name: string, definition: any) { commands.set(name, definition.handler); },
		sendMessage(message: any) { messages.push(message); sendMessage?.(message); },
	} as any;
	registerWorkflowCommands(pi, commandService, control);
	return { commands, control, messages, shutdown };
}

describe("workflow command adapter", () => {
	it("starts background execution before returning and renders deferred completion", async () => {
		const completion = deferred<any>();
		const control = new FakeRunControl();
		control.startResult = { status: "started", completion: completion.promise };
		const current = context();
		const currentRegistration = register(control);

		await currentRegistration.commands.get("workflow")("background deep-research task", current.ctx);
		expect(control.starts).toHaveLength(1);
		expect(control.starts[0].operation).toEqual({ type: "execute" });
		expect(current.notifications).toEqual([{ message: "Started background workflow deep-research (run-1)", level: "info" }]);
		expect(currentRegistration.messages).toEqual([]);

		completion.resolve({ status: "completed", result: "answer" });
		await completion.promise;
		await Promise.resolve();
		expect(currentRegistration.messages).toEqual([{
			customType: "workflow-result", content: "answer", display: true,
			details: { workflow: "deep-research", runId: "run-1", background: true },
		}]);
		expect(current.notifications.at(-1)).toEqual({ message: "Workflow completed: deep-research", level: "info" });
	});

	it("shares the production controller across registrations and notifies before invocation", async () => {
		const execution = deferred<unknown>();
		const order: string[] = [];
		const firstRun = prepared("shared-run");
		firstRun.handle.execute = () => { order.push("execute"); return execution.promise; };
		const secondRun = prepared("shared-run");
		secondRun.handle.execute = async () => { order.push("second execute"); return "wrong"; };
		const firstService = { ...service("shared-run"), prepareNew: async () => firstRun };
		const secondService = { ...service("shared-run"), prepareNew: async () => secondRun };
		const firstCommands = new Map<string, any>();
		const secondCommands = new Map<string, any>();
		registerWorkflowCommands({ on() {}, registerCommand(name: string, definition: any) { firstCommands.set(name, definition.handler); }, sendMessage() {} } as any, firstService);
		registerWorkflowCommands({ on() {}, registerCommand(name: string, definition: any) { secondCommands.set(name, definition.handler); }, sendMessage() {} } as any, secondService);
		const cwd = `/tmp/workflow-command-shared-${Date.now()}`;
		const first = context(cwd, (message) => { if (message.startsWith("Started background")) order.push("notify"); });
		const second = context(cwd);

		await firstCommands.get("workflow")("background deep-research task", first.ctx);
		expect(order).toEqual(["notify", "execute"]);
		await secondCommands.get("workflow")("background deep-research task", second.ctx);
		expect(second.notifications.at(-1)).toEqual({ message: "Workflow deep-research (shared-run) is already running in this session.", level: "warning" });
		expect(order).toEqual(["notify", "execute"]);
		execution.resolve("done");
		await execution.promise;
		await Promise.resolve();
	});

	it("waits for foreground completion and preserves serialization", async () => {
		const completion = deferred<any>();
		const control = new FakeRunControl();
		control.startResult = { status: "started", completion: completion.promise };
		const currentRegistration = register(control);
		const current = context();
		let finished = false;
		const handling = currentRegistration.commands.get("workflow")("deep-research task", current.ctx).then(() => { finished = true; });
		await Promise.resolve();
		expect(finished).toBe(false);
		completion.resolve({ status: "completed", result: { answer: 42 } });
		await handling;
		expect(currentRegistration.messages[0]).toEqual({
			customType: "workflow-result", content: "{\n  \"answer\": 42\n}", display: true,
			details: { workflow: "deep-research", runId: "run-1", background: false },
		});

		control.startResult = { status: "started", completion: Promise.resolve({ status: "completed", result: undefined }) };
		await currentRegistration.commands.get("workflow")("deep-research task", current.ctx);
		expect(currentRegistration.messages.at(-1)?.content).toBe("undefined");
		control.startResult = { status: "started", completion: Promise.resolve({ status: "completed", result: null }) };
		await currentRegistration.commands.get("workflow")("deep-research task", current.ctx);
		expect(currentRegistration.messages.at(-1)?.content).toBe("null");
		control.startResult = { status: "started", completion: Promise.resolve({ status: "completed", result: "" }) };
		await currentRegistration.commands.get("workflow")("deep-research task", current.ctx);
		expect(currentRegistration.messages.at(-1)?.content).toBe("");
	});

	it("passes the exact restart key through prepared existing state", async () => {
		const control = new FakeRunControl();
		const currentRegistration = register(control, service("run-restart"));
		const current = context("/tmp/workflow-command-restart");
		await currentRegistration.commands.get("workflow")("restart run-restart durable:key", current.ctx);
		expect(control.starts[0].operation).toEqual({ type: "restart", durableKey: "durable:key" });
		expect(control.starts[0].prepared.handle.runId).toBe("run-restart");
	});

	it("renders every admission and settlement class with exact severity", async () => {
		const control = new FakeRunControl();
		const currentRegistration = register(control);
		const cases = [
			[{ status: "already-active" }, "Workflow deep-research (run-1) is already running in this session.", "warning"],
			[{ status: "paused" }, "Workflow paused: deep-research", "warning"],
			[{ status: "stopped" }, "Workflow stopped: deep-research", "warning"],
			[{ status: "failed", error: "plain failure" }, "Workflow failed: plain failure", "error"],
		] as const;
		for (const [result, message, level] of cases) {
			control.startResult = result.status === "already-active" && !("result" in result) && Object.keys(result).length === 1
				? result
				: { status: "started", completion: Promise.resolve(result as any) };
			const current = context();
			await currentRegistration.commands.get("workflow")("deep-research task", current.ctx);
			expect(current.notifications.at(-1)).toEqual({ message, level });
		}

		control.startResult = { status: "started", completion: Promise.resolve({ status: "already-active" }) };
		const lower = context();
		await currentRegistration.commands.get("workflow")("deep-research task", lower.ctx);
		expect(lower.notifications.at(-1)).toEqual({ message: cases[0][1], level: "warning" });
	});

	it("reports unserializable completion without publishing a result", async () => {
		const circular: any = {};
		circular.self = circular;
		const control = new FakeRunControl();
		control.startResult = { status: "started", completion: Promise.resolve({ status: "completed", result: circular }) };
		const currentRegistration = register(control);
		const current = context();
		await currentRegistration.commands.get("workflow")("deep-research task", current.ctx);
		expect(currentRegistration.messages).toEqual([]);
		expect(current.notifications.at(-1)).toEqual(expect.objectContaining({ level: "error" }));
		expect(current.notifications.at(-1)?.message).toMatch(/^Workflow failed: /);
	});

	it("routes pause, pause-now, stop, and cancel with their distinct outcomes", async () => {
		const control = new FakeRunControl();
		const currentRegistration = register(control);
		const current = context();
		await currentRegistration.commands.get("workflow")("pause run-1", current.ctx);
		await currentRegistration.commands.get("workflow")("pause-now run-1", current.ctx);
		await currentRegistration.commands.get("workflow")("stop run-1", current.ctx);
		await currentRegistration.commands.get("workflow")("cancel run-1", current.ctx);
		expect(control.pauses.map(({ mode }) => mode)).toEqual(["after-current", "now"]);
		expect(control.stops.map(({ reason }) => reason)).toEqual(["Workflow stopped by user", "Workflow stopped by user"]);

		control.pauseResult = undefined;
		control.stopResult = false;
		await currentRegistration.commands.get("workflow")("pause missing", current.ctx);
		expect(current.notifications.at(-1)?.message).toBe("No active in-process workflow found for missing.");
		await currentRegistration.commands.get("workflow")("stop missing", current.ctx);
		expect(current.notifications.at(-1)?.message).toBe("No active in-process workflow found for missing. Resume/replay remains available for persisted runs.");

		control.pauseResult = Promise.reject(new Error("pause rejected"));
		await currentRegistration.commands.get("workflow")("pause run-1", current.ctx);
		expect(current.notifications.at(-1)).toEqual({ message: "Unable to request pause for run-1: pause rejected", level: "error" });
		control.stopError = new Error("stop rejected");
		await currentRegistration.commands.get("workflow")("stop run-1", current.ctx);
		expect(current.notifications.at(-1)).toEqual({ message: "Workflow command failed: stop rejected", level: "error" });
	});

	it("routes synchronous control lookup failures to the outer command error", async () => {
		const control = new FakeRunControl();
		control.pauseError = new Error("bad pause id");
		control.stopError = new Error("bad stop id");
		const currentRegistration = register(control);
		const current = context();
		await currentRegistration.commands.get("workflow")("pause ../bad", current.ctx);
		expect(current.notifications.at(-1)).toEqual({ message: "Workflow command failed: bad pause id", level: "error" });
		await currentRegistration.commands.get("workflow")("stop ../bad", current.ctx);
		expect(current.notifications.at(-1)).toEqual({ message: "Workflow command failed: bad stop id", level: "error" });
	});

	it("reports shutdown runs best-effort and waits for the drain", async () => {
		const drain = deferred<void>();
		const control = new FakeRunControl();
		control.shutdownResult = { runIds: ["one", "two"], completion: drain.promise };
		const currentRegistration = register(control);
		const current = context(undefined, (message) => { if (message.endsWith("one")) throw new Error("ui unavailable"); });
		let finished = false;
		const shuttingDown = currentRegistration.shutdown({}, current.ctx).then(() => { finished = true; });
		expect(control.shutdownReasons).toEqual(["Pi session shut down"]);
		expect(current.notifications.map(({ message }) => message)).toEqual([
			"Stopped background workflow on shutdown: one",
			"Stopped background workflow on shutdown: two",
		]);
		expect(finished).toBe(false);
		drain.resolve();
		await shuttingDown;

		control.shutdownError = new Error("stop failed");
		const before = current.notifications.length;
		await expect(currentRegistration.shutdown({}, current.ctx)).rejects.toThrow("stop failed");
		expect(current.notifications).toHaveLength(before);
	});

	it("consumes detached background presentation failures", async () => {
		const control = new FakeRunControl();
		control.startResult = { status: "started", completion: Promise.resolve({ status: "completed", result: "done" }) };
		const currentRegistration = register(control, service(), () => { throw new Error("send failed"); });
		const current = context(undefined, (message) => { if (message.startsWith("Workflow failed:")) throw new Error("notify failed"); });
		await currentRegistration.commands.get("workflow")("background deep-research task", current.ctx);
		await new Promise((resolve) => setTimeout(resolve, 0));
	});

	it("routes missing cleanup run IDs to usage without calling the module", async () => {
		let calls = 0;
		const commandService = { ...service(), cleanupWorktrees: async () => { calls++; return { cleaned: [], skipped: [] }; } };
		const currentRegistration = register(new FakeRunControl(), commandService);
		const current = context();
		await currentRegistration.commands.get("workflow")("cleanup-worktrees", current.ctx);
		expect(calls).toBe(0);
		expect(current.notifications.at(-1)).toEqual({ message: "Usage: /workflow cleanup-worktrees <run-id>", level: "warning" });
	});

	it("delegates cleanup with the exact cwd, run ID, and signal", async () => {
		const calls: unknown[][] = [];
		const commandService = {
			...service(),
			cleanupWorktrees: async (...args: unknown[]) => { calls.push(args); return { cleaned: ["worker"], skipped: [] }; },
		};
		const currentRegistration = register(new FakeRunControl(), commandService);
		const current = context("/tmp/workflow-cleanup");
		await currentRegistration.commands.get("workflow")("cleanup-worktrees run-clean", current.ctx);
		expect(calls).toEqual([[current.ctx.cwd, "run-clean", { signal: current.ctx.signal }]]);
		expect(current.notifications.at(-1)).toEqual({
			message: "Workflow worktree cleanup\nCleaned: worker\nSkipped: none",
			level: "info",
		});
	});

	it("renders empty cleanup and every structured skip reason", async () => {
		const empty = context();
		await register(new FakeRunControl(), service()).commands.get("workflow")("cleanup-worktrees run-empty", empty.ctx);
		expect(empty.notifications.at(-1)).toEqual({
			message: "Workflow worktree cleanup\nCleaned: none\nSkipped: none",
			level: "info",
		});

		const commandService: WorkflowCommandService = {
			...service(),
			cleanupWorktrees: async () => ({
				cleaned: [],
				skipped: [
					{ key: "dirty", reason: "dirty" },
					{ key: "absent", reason: "already-absent" },
					{ key: "invalid-detail", reason: "invalid-record", detail: "recorded path does not match branch ID" },
					{ key: "invalid-fallback", reason: "invalid-record" },
					{ key: "git-detail", reason: "git-failed", detail: "worktree is locked" },
					{ key: "git-fallback", reason: "git-failed" },
				],
			}),
		};
		const currentRegistration = register(new FakeRunControl(), commandService);
		const current = context();
		await currentRegistration.commands.get("workflow")("cleanup-worktrees run-skips", current.ctx);
		expect(current.notifications.at(-1)).toEqual({
			message: "Workflow worktree cleanup\nCleaned: none\nSkipped: dirty (dirty worktree preserved), absent (worktree already absent), invalid-detail (recorded path does not match branch ID), invalid-fallback (invalid recorded worktree), git-detail (worktree is locked), git-fallback (Git cleanup failed)",
			level: "warning",
		});
	});

	it("routes cleanup rejection through the command error path", async () => {
		const commandService = { ...service(), cleanupWorktrees: async () => { throw new Error("cleanup stopped"); } };
		const currentRegistration = register(new FakeRunControl(), commandService);
		const current = context();
		await currentRegistration.commands.get("workflow")("cleanup-worktrees run-fail", current.ctx);
		expect(current.notifications.at(-1)).toEqual({ message: "Workflow command failed: cleanup stopped", level: "error" });
	});

	it("does not fall back to live source when an existing snapshot is unreadable", async () => {
		const commandService: WorkflowCommandService = {
			prepareNew: async () => undefined,
			prepareExisting: async () => { throw new Error("unused"); },
			inspect: async () => ({ ...detail("run-source", "completed"), sourceSnapshotPath: "/definitely/missing/workflow.ts" }),
			list: async () => [],
			readEvents: async () => [],
			cleanupWorktrees: async () => ({ cleaned: [], skipped: [] }),
		};
		const currentRegistration = register(new FakeRunControl(), commandService);
		const current = context("/tmp/workflow-command-source");
		await currentRegistration.commands.get("workflow")("source run-source", current.ctx);
		expect(current.notifications.at(-1)?.message).toMatch(/^Workflow command failed:/);
	});

	it("renders raw records in order without discarding unknown fields", async () => {
		const events = [
			{ type: "run_created", ts: 1, runId: "run-raw" },
			{ type: "future_event", ts: 2, future: { nested: true }, tail: "last" },
		];
		const commandService = { ...service(), readEvents: async () => events };
		const currentRegistration = register(new FakeRunControl(), commandService);
		const current = context();

		await currentRegistration.commands.get("workflows")("raw run-raw", current.ctx);

		expect(current.notifications.at(-1)).toEqual({
			message: events.map((event) => JSON.stringify(event)).join("\n"),
			level: "info",
		});
	});

	it("renders an existing empty raw log as an empty info notification", async () => {
		const currentRegistration = register(new FakeRunControl(), service());
		const current = context();
		await currentRegistration.commands.get("workflows")("raw run-empty", current.ctx);
		expect(current.notifications.at(-1)).toEqual({ message: "", level: "info" });
	});

	it("reports a missing raw log through the not-found message", async () => {
		const commandService: WorkflowCommandService = {
			prepareNew: async () => undefined,
			prepareExisting: async () => { throw new Error("unused"); },
			inspect: async () => { throw Object.assign(new Error("missing"), { code: "WORKFLOW_RUN_NOT_FOUND" }); },
			list: async () => [],
			readEvents: async () => { throw Object.assign(new Error("missing"), { code: "WORKFLOW_RUN_NOT_FOUND" }); },
			cleanupWorktrees: async () => ({ cleaned: [], skipped: [] }),
		};
		const currentRegistration = register(new FakeRunControl(), commandService);
		const current = context();
		await currentRegistration.commands.get("workflows")("raw missing", current.ctx);
		expect(current.notifications.at(-1)?.message).toContain("Run raw log not found: missing");
	});
});
