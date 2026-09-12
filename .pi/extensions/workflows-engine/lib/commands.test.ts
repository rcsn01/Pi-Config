import { describe, expect, it } from "vitest";
import { registerWorkflowCommands, type WorkflowCommandService } from "./commands.ts";
import type { WorkflowRunDetail } from "./workflow-run-state.ts";

function entry() {
	return { name: "deep-research", description: "test", trust: "bundled" as const, cost: "quick" as const, canEditFiles: false, source: "source", sourceHash: "hash" };
}

function context(cwd = "/tmp/workflow-command-test") {
	const notifications: Array<{ message: string; level: string }> = [];
	const ctx = {
		cwd,
		signal: new AbortController().signal,
		hasUI: false,
		ui: {
			notify(message: string, level: string) { notifications.push({ message, level }); },
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

describe("workflow command adapter", () => {
	it("routes pause and stop through the active handle and waits on shutdown", async () => {
		let resolve!: (value: unknown) => void;
		const execution = new Promise((value) => { resolve = value; });
		const calls: string[] = [];
		const handle = {
			runId: "run-1",
			execute: () => execution,
			restart: async () => "restarted",
			requestPause: async (mode: string) => { calls.push(`pause:${mode}`); },
			requestStop: (reason?: string) => { calls.push(`stop:${reason}`); },
			inspect: async () => detail("run-1", "stopped"),
		};
		const prepared = { entry: entry(), handle } as any;
		const service: WorkflowCommandService = {
			prepareNew: async () => prepared,
			prepareExisting: async () => prepared,
			inspect: async () => detail("run-1"),
			list: async () => [],
			readEvents: async () => [],
		};
		let shutdown!: (event: unknown, ctx: any) => Promise<void>;
		const commands = new Map<string, any>();
		const pi = {
			on(name: string, listener: any) { if (name === "session_shutdown") shutdown = listener; },
			registerCommand(name: string, definition: any) { commands.set(name, definition.handler); },
			sendMessage() {},
		} as any;
		registerWorkflowCommands(pi, service);
		const first = context();
		await commands.get("workflow")("background deep-research", first.ctx);
		await commands.get("workflow")("pause-now run-1", first.ctx);
		await commands.get("workflow")("stop run-1", first.ctx);
		const shutdownPromise = shutdown({}, first.ctx);
		expect(calls).toContain("pause:now");
		expect(calls).toContain("stop:Workflow stopped by user");
		expect(first.notifications.some((item) => item.message.includes("Stopped background workflow on shutdown"))).toBe(true);
		resolve("done");
		await shutdownPromise;
	});

	it("passes restart to the prepared handle as one operation", async () => {
		const calls: string[] = [];
		const handle = {
			runId: "run-restart",
			execute: async () => { throw new Error("execute must not be used"); },
			restart: async (key: string) => { calls.push(key); return "replayed"; },
			requestPause: async () => undefined,
			requestStop() {},
			inspect: async () => detail("run-restart", "completed"),
		};
		const service: WorkflowCommandService = {
			prepareNew: async () => undefined,
			prepareExisting: async () => ({ entry: entry(), handle }),
			inspect: async () => detail("run-restart", "completed"),
			list: async () => [],
			readEvents: async () => [],
		};
		const commands = new Map<string, any>();
		const pi = { on() {}, registerCommand(name: string, definition: any) { commands.set(name, definition.handler); }, sendMessage() {} } as any;
		registerWorkflowCommands(pi, service);
		const current = context("/tmp/workflow-command-restart");
		await commands.get("workflow")("restart run-restart durable-key", current.ctx);
		expect(calls).toEqual(["durable-key"]);
		expect(current.notifications.some((item) => item.message === "Workflow completed: deep-research")).toBe(true);
	});

	it("does not fall back to live source when an existing snapshot is unreadable", async () => {
		const service: WorkflowCommandService = {
			prepareNew: async () => undefined,
			prepareExisting: async () => { throw new Error("unused"); },
			inspect: async () => ({ ...detail("run-source", "completed"), sourceSnapshotPath: "/definitely/missing/workflow.ts" }),
			list: async () => [],
			readEvents: async () => [],
		};
		const commands = new Map<string, any>();
		const pi = { on() {}, registerCommand(name: string, definition: any) { commands.set(name, definition.handler); }, sendMessage() {} } as any;
		registerWorkflowCommands(pi, service);
		const current = context("/tmp/workflow-command-source");
		await commands.get("workflow")("source run-source", current.ctx);
		expect(current.notifications.at(-1)?.message).toMatch(/^Workflow command failed:/);
	});

	it("reports a missing raw log through the not-found message", async () => {
		const service: WorkflowCommandService = {
			prepareNew: async () => undefined,
			prepareExisting: async () => { throw new Error("unused"); },
			inspect: async () => { throw Object.assign(new Error("missing"), { code: "WORKFLOW_RUN_NOT_FOUND" }); },
			list: async () => [],
			readEvents: async () => { throw Object.assign(new Error("missing"), { code: "WORKFLOW_RUN_NOT_FOUND" }); },
		};
		const commands = new Map<string, any>();
		const pi = { on() {}, registerCommand(name: string, definition: any) { commands.set(name, definition.handler); }, sendMessage() {} } as any;
		registerWorkflowCommands(pi, service);
		const current = context();
		await commands.get("workflows")("raw missing", current.ctx);
		expect(current.notifications.at(-1)?.message).toContain("Run raw log not found: missing");
	});
});
