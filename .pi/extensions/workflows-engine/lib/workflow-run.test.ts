import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defineWorkflow } from "./definition.ts";
import { InMemoryRunPersistence } from "./test-support.ts";
import { createWorkflowRun, RunAlreadyActiveError } from "./workflow-run.ts";

const cleanups: string[] = [];

afterEach(async () => {
	await Promise.all(cleanups.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const entry = {
	name: "deep-test",
	trust: "bundled" as const,
	description: "deep test",
	cost: "quick" as const,
	canEditFiles: false,
	source: "test source",
	sourceHash: "test-hash",
};

async function cwd(): Promise<string> {
	const value = await mkdtemp(path.join(os.tmpdir(), "workflow-run-test-"));
	cleanups.push(value);
	return value;
}

async function handleFor(cwdValue: string, runId: string, workflow: ReturnType<typeof defineWorkflow>, persistence = new InMemoryRunPersistence(cwdValue, runId), resume = false) {
	return createWorkflowRun({
		entry,
		workflow,
		runId,
		resume,
		args: "test args",
		cwd: cwdValue,
		cacheAffinitySeed: "session-seed",
		persistence,
		runSubagent: async () => ({
			agent: "worker",
			task: "task",
			output: "done",
			exitCode: 0,
			progress: { agent: "worker", status: "completed", task: "task", recentTools: [], toolCount: 0, tokens: 0, durationMs: 0, lastMessage: "done" },
			usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
		}),
		setStatus: () => undefined,
	});
}

describe("WorkflowRun deep interface", () => {
	it("owns lifecycle events, durable reuse, and immutable detail views", async () => {
		const project = await cwd();
		let executions = 0;
		const workflow = defineWorkflow({
			name: entry.name,
			description: entry.description,
			canEditFiles: false,
			async run(ctx) {
				const value = await ctx.step("one", () => ({ value: ++executions }));
				await ctx.log("finished", { value });
				return value;
			},
		});
		const persistence = new InMemoryRunPersistence(project, "run-1");
		const first = await handleFor(project, "run-1", workflow, persistence);
		expect(await first.execute()).toEqual({ value: 1 });
		expect(await first.execute()).toEqual({ value: 1 });
		const detail = await first.inspect();
		detail.steps.one.status = "failed";
		expect((await first.inspect()).steps.one.status).toBe("completed");
		expect(persistence.events.map((event) => event.type)).toEqual(["run_created", "run_started", "step_started", "step_completed", "log", "run_completed"]);

		const resumed = await handleFor(project, "run-1", workflow, persistence, true);
		expect(await resumed.execute()).toEqual({ value: 1 });
		expect(executions).toBe(1);
		expect(persistence.events.some((event) => event.type === "step_reused")).toBe(true);
	});

	it("keeps durable append order and recovers after projection failure", async () => {
		const project = await cwd();
		const workflow = defineWorkflow({ name: entry.name, description: entry.description, canEditFiles: false, run: () => "ok" });
		const persistence = new InMemoryRunPersistence(project, "run-projection", { failNextProjection: true });
		const handle = await handleFor(project, "run-projection", workflow, persistence);
		expect(await handle.execute()).toBe("ok");
		const reopened = await handleFor(project, "run-projection", workflow, persistence, true);
		expect((await reopened.inspect()).status).toBe("completed");
		expect(persistence.events.at(-1)?.type).toBe("run_completed");
	});

	it("reloads resumed state after acquiring the run lease", async () => {
		const project = await cwd();
		let executions = 0;
		const initialWorkflow = defineWorkflow({
			name: entry.name,
			description: entry.description,
			canEditFiles: false,
			run: (ctx) => ctx.step("initial", () => ++executions),
		});
		const persistence = new InMemoryRunPersistence(project, "run-reload");
		const initial = await handleFor(project, "run-reload", initialWorkflow, persistence);
		expect(await initial.execute()).toBe(1);
		const nextWorkflow = defineWorkflow({
			name: entry.name,
			description: entry.description,
			canEditFiles: false,
			run: (ctx) => ctx.step("next", () => ++executions),
		});
		const stale = await handleFor(project, "run-reload", nextWorkflow, persistence, true);
		const writer = await handleFor(project, "run-reload", nextWorkflow, persistence, true);
		expect(await writer.execute()).toBe(2);
		expect(await stale.execute()).toBe(2);
		expect(executions).toBe(2);
	});

	it("rejects a competing active operation for the same canonical run root", async () => {
		const project = await cwd();
		let release!: () => void;
		const blocked = new Promise<void>((resolve) => { release = resolve; });
		const workflow = defineWorkflow({
			name: entry.name,
			description: entry.description,
			canEditFiles: false,
			async run() { await blocked; return "done"; },
		});
		const persistence = new InMemoryRunPersistence(project, "run-lease");
		const first = await handleFor(project, "run-lease", workflow, persistence);
		const second = await handleFor(project, "run-lease", workflow, persistence, true);
		const running = first.execute();
		await expect(second.execute()).rejects.toBeInstanceOf(RunAlreadyActiveError);
		release();
		expect(await running).toBe("done");
	});

	it("maps tool progress and keeps the authoritative child failure status", async () => {
		const project = await cwd();
		const workflow = defineWorkflow({ name: entry.name, description: entry.description, canEditFiles: false, run: (ctx) => ctx.agent({ key: "worker", agent: "worker", prompt: "task" }) });
		const persistence = new InMemoryRunPersistence(project, "run-agent");
		let progress!: (event: { type: "tool_call"; agent: string; tool: string; args?: string }) => Promise<void>;
		const handle = await createWorkflowRun({
			entry, workflow, runId: "run-agent", resume: false, args: "", cwd: project, cacheAffinitySeed: "seed", persistence,
			runSubagent: async (options) => {
				progress = options.onProgress as typeof progress;
				await options.onProgress({ type: "tool_call", agent: "worker", tool: "read", args: "file" });
				return { agent: "worker", task: "task", output: "bad", exitCode: 0, progress: { agent: "worker", status: "failed", task: "task", recentTools: [], toolCount: 1, tokens: 0, durationMs: 1, lastMessage: "bad", error: "bad" }, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 } };
			},
		});
		await expect(handle.execute()).rejects.toThrow("bad");
		const detail = await handle.inspect();
		expect(detail.agents.worker.status).toBe("failed");
		expect(progress).toBeTypeOf("function");
	});

	it("keeps pause requests made before an atomic restart", async () => {
		const project = await cwd();
		let executions = 0;
		const workflow = defineWorkflow({
			name: entry.name,
			description: entry.description,
			canEditFiles: false,
			run: (ctx) => ctx.step("root", () => ++executions),
		});
		const persistence = new InMemoryRunPersistence(project, "run-restart-pause");
		const first = await handleFor(project, "run-restart-pause", workflow, persistence);
		expect(await first.execute()).toBe(1);
		const resumed = await handleFor(project, "run-restart-pause", workflow, persistence, true);
		await resumed.requestPause("now");
		await expect(resumed.restart("root")).rejects.toThrow("Workflow paused by user");
		expect((await resumed.inspect()).status).toBe("paused");
		expect(persistence.events.slice(-4).map((event) => event.type)).toEqual(["run_pausing", "invalidated", "run_resumed", "run_paused"]);
		expect(executions).toBe(1);
	});

	it("serializes maxAgents admission under parallel load", async () => {
		const project = await cwd();
		const workflow = defineWorkflow({
			name: entry.name,
			description: entry.description,
			canEditFiles: false,
			budget: { maxAgents: 2, maxConcurrent: 3 },
			run: (ctx) => ctx.parallel([1, 2, 3], (_, index) => ctx.agent({ key: `agent-${index}`, agent: "worker", prompt: "task" }), { key: "agents", concurrency: 3 }),
		});
		const persistence = new InMemoryRunPersistence(project, "run-budget");
		const handle = await handleFor(project, "run-budget", workflow, persistence);
		await expect(handle.execute()).rejects.toThrow("Workflow budget exceeded: maxAgents=2");
		expect(persistence.events.filter((event) => event.type === "agent_started")).toHaveLength(2);
		expect((await handle.inspect()).agentsStarted).toBe(2);
	});

	it("drops writes from an attempt after its terminal event", async () => {
		const project = await cwd();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		let lateWrite!: Promise<void>;
		const workflow = defineWorkflow({
			name: entry.name,
			description: entry.description,
			canEditFiles: false,
			run(ctx) {
				lateWrite = gate.then(() => ctx.log("too late"));
				return "done";
			},
		});
		const persistence = new InMemoryRunPersistence(project, "run-late-write");
		const handle = await handleFor(project, "run-late-write", workflow, persistence);
		expect(await handle.execute()).toBe("done");
		release();
		await lateWrite;
		expect(persistence.events.at(-1)?.type).toBe("run_completed");
		expect(persistence.events.some((event) => event.type === "log")).toBe(false);
	});

	it("does not advance state when creation append fails", async () => {
		const project = await cwd();
		const workflow = defineWorkflow({ name: entry.name, description: entry.description, canEditFiles: false, run: () => "never" });
		const persistence = new InMemoryRunPersistence(project, "run-append-failure", { failNextAppend: true });
		await expect(handleFor(project, "run-append-failure", workflow, persistence)).rejects.toThrow("event append failure");
		expect(persistence.events).toEqual([]);
		expect(persistence.projection).toBeUndefined();
	});
});
