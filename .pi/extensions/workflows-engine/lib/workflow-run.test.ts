import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defineWorkflow } from "./definition.ts";
import { runGit } from "../../_shared/git.ts";
import { FileRunPersistence } from "./run-store.ts";
import { applyWorkflowRunEvent, type WorkflowRunEventView } from "./workflow-run-events.ts";
import { initialState, type RunState } from "./workflow-run-state.ts";
import { InMemoryRunPersistence } from "./test-support.ts";
import { createWorkflowRun, RunAlreadyActiveError, workflowRunModule, type WorkflowSubagentRunner } from "./workflow-run.ts";

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

async function gitProject(): Promise<string> {
	const project = await cwd();
	await runGit(project, ["init", "-b", "main"]);
	await runGit(project, ["config", "user.email", "test@example.com"]);
	await runGit(project, ["config", "user.name", "Test User"]);
	await writeFile(path.join(project, "base.txt"), "base\n");
	await runGit(project, ["add", "base.txt"]);
	await runGit(project, ["commit", "-m", "initial"]);
	return project;
}

function completedSubagent(): Awaited<ReturnType<WorkflowSubagentRunner>> {
	return {
		agent: "worker",
		task: "task",
		output: "done",
		exitCode: 0,
		progress: { agent: "worker", status: "completed", task: "task", recentTools: [], toolCount: 0, tokens: 0, durationMs: 0, lastMessage: "done" },
		usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
	};
}

function filePersistence(project: string, runId: string): FileRunPersistence {
	const persistence = new FileRunPersistence(project, runId);
	cleanups.push(persistence.paths().root);
	return persistence;
}

async function fileHandleFor(project: string, runId: string, workflow: ReturnType<typeof defineWorkflow>, runSubagent: WorkflowSubagentRunner = async () => completedSubagent()) {
	return createWorkflowRun({
		entry,
		workflow,
		runId,
		resume: false,
		args: "test args",
		cwd: project,
		cacheAffinitySeed: "session-seed",
		persistence: filePersistence(project, runId),
		runSubagent,
		setStatus: () => undefined,
	});
}

async function addWorktree(project: string, branchId: string): Promise<string> {
	const target = path.join(project, ".pi", "worktrees", branchId);
	await runGit(project, ["worktree", "add", "-b", `fleet/${branchId}`, target, "HEAD"]);
	return target;
}

function worktreeRecord(worktreePath: string, branchId: string): Record<string, unknown> {
	return { path: worktreePath, branch: `fleet/${branchId}`, branchId, preserve: true, fileOwnership: [] };
}

async function seedWorktreeEvents(project: string, runId: string, agents: Array<[string, unknown]>): Promise<FileRunPersistence> {
	const persistence = filePersistence(project, runId);
	await persistence.appendEvent({
		type: "run_created", runId, workflowName: entry.name, trust: entry.trust,
		args: "", sourceHash: entry.sourceHash, description: entry.description, costShape: entry.cost, canEditFiles: true,
	});
	for (const [key, worktree] of agents) {
		await persistence.appendEvent({ type: "agent_started", key, agent: "worker", prompt: "task", worktree });
	}
	return persistence;
}

async function handleFor(
	cwdValue: string,
	runId: string,
	workflow: ReturnType<typeof defineWorkflow>,
	persistence = new InMemoryRunPersistence(cwdValue, runId),
	resume = false,
	requestSelection?: (title: string, options: string[], signal: AbortSignal) => Promise<string | undefined>,
) {
	return createWorkflowRun({
		entry,
		workflow,
		runId,
		resume,
		args: "test args",
		cwd: cwdValue,
		cacheAffinitySeed: "session-seed",
		persistence,
		requestSelection,
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

describe("WorkflowRunModule cleanup", () => {
	it("removes a clean default-preserved worktree", async () => {
		const project = await gitProject();
		const workflow = defineWorkflow({
			name: entry.name,
			description: entry.description,
			canEditFiles: true,
			run: (ctx) => ctx.agent({ key: "clean", agent: "worker", prompt: "task", worktree: true }),
		});
		const handle = await fileHandleFor(project, "run-cleanup-clean", workflow);
		await handle.execute();
		expect(await workflowRunModule.cleanupWorktrees(project, "run-cleanup-clean")).toEqual({ cleaned: ["clean"], skipped: [] });
		expect((await runGit(project, ["worktree", "list", "--porcelain"])).stdout).not.toContain("refs/heads/fleet/workflow-run-cleanup-clean-clean");
	});

	it("preserves dirty worktrees while removing clean siblings", async () => {
		const project = await gitProject();
		const workflow = defineWorkflow({
			name: entry.name,
			description: entry.description,
			canEditFiles: true,
			async run(ctx) {
				await ctx.agent({ key: "dirty", agent: "worker", prompt: "task", worktree: true });
				return ctx.agent({ key: "clean", agent: "worker", prompt: "task", worktree: true });
			},
		});
		const handle = await fileHandleFor(project, "run-cleanup-mixed", workflow);
		await handle.execute();
		const dirtyPath = path.join(project, ".pi", "worktrees", "workflow-run-cleanup-mixed-dirty");
		await writeFile(path.join(dirtyPath, "dirty.txt"), "dirty\n");

		expect(await workflowRunModule.cleanupWorktrees(project, "run-cleanup-mixed")).toEqual({
			cleaned: ["clean"],
			skipped: [{ key: "dirty", reason: "dirty" }],
		});
		const registered = (await runGit(project, ["worktree", "list", "--porcelain"])).stdout;
		expect(registered).toContain("refs/heads/fleet/workflow-run-cleanup-mixed-dirty");
		expect(registered).not.toContain("refs/heads/fleet/workflow-run-cleanup-mixed-clean");
	});

	it("discovers failed-agent worktrees hidden from the command projection", async () => {
		const project = await gitProject();
		const workflow = defineWorkflow({
			name: entry.name,
			description: entry.description,
			canEditFiles: true,
			run: (ctx) => ctx.agent({ key: "failed", agent: "worker", prompt: "task", worktree: true }),
		});
		const handle = await fileHandleFor(project, "run-cleanup-failed", workflow, async () => { throw new Error("preflight failed"); });
		await expect(handle.execute()).rejects.toThrow("preflight failed");
		expect((await workflowRunModule.inspect(project, "run-cleanup-failed")).agents.failed.worktree).toBeUndefined();
		expect(await workflowRunModule.cleanupWorktrees(project, "run-cleanup-failed")).toEqual({ cleaned: ["failed"], skipped: [] });
	});

	it("reports already-absent worktrees on repeated cleanup", async () => {
		const project = await gitProject();
		const workflow = defineWorkflow({
			name: entry.name,
			description: entry.description,
			canEditFiles: true,
			run: (ctx) => ctx.agent({ key: "repeat", agent: "worker", prompt: "task", worktree: true }),
		});
		const handle = await fileHandleFor(project, "run-cleanup-repeat", workflow);
		await handle.execute();
		expect(await workflowRunModule.cleanupWorktrees(project, "run-cleanup-repeat")).toEqual({ cleaned: ["repeat"], skipped: [] });
		expect(await workflowRunModule.cleanupWorktrees(project, "run-cleanup-repeat")).toEqual({
			cleaned: [],
			skipped: [{ key: "repeat", reason: "already-absent" }],
		});
	});

	it("ignores absent worktrees and rejects every malformed or escaped record class", async () => {
		const project = await gitProject();
		const managed = path.join(project, ".pi", "worktrees");
		const outside = await cwd();
		await writeFile(path.join(outside, "keep.txt"), "keep\n");
		await mkdir(managed, { recursive: true });
		const escapedLink = path.join(managed, "escape-link");
		await symlink(outside, escapedLink, process.platform === "win32" ? "junction" : "dir");
		const validBoundary = "a".repeat(80);
		await mkdir(path.join(managed, validBoundary), { recursive: true });
		const malformed: Array<[string, unknown]> = [
			["null", null], ["array", []], ["boolean", false], ["string", "bad"],
			["missing-path", { branch: "fleet/x", branchId: "x" }],
			["number-path", { path: 1, branch: "fleet/x", branchId: "x" }],
			["missing-branch", { path: path.join(managed, "x"), branchId: "x" }],
			["number-branch", { path: path.join(managed, "x"), branch: 1, branchId: "x" }],
			["missing-id", { path: path.join(managed, "x"), branch: "fleet/x" }],
			["number-id", { path: path.join(managed, "x"), branch: "fleet/x", branchId: 1 }],
			...["", "Upper", "bad!", "-bad-", "b".repeat(81), ".", "..", "bad.lock"].map((id, index) => [`bad-id-${index}`, worktreeRecord(path.join(managed, id), id)] as [string, unknown]),
			["mismatch", worktreeRecord(path.join(managed, "other"), "expected")],
			["outside", worktreeRecord(outside, "outside")],
			["symlink", worktreeRecord(escapedLink, "escape-link")],
			["valid-80", worktreeRecord(path.join(managed, validBoundary), validBoundary)],
		];
		await seedWorktreeEvents(project, "run-cleanup-invalid", [["none", undefined], ...malformed]);
		const result = await workflowRunModule.cleanupWorktrees(project, "run-cleanup-invalid");

		expect(result.cleaned).toEqual([]);
		expect(result.skipped.filter((item) => item.reason === "invalid-record").map((item) => item.key))
			.toEqual(malformed.slice(0, -1).map(([key]) => key));
		expect(result.skipped.at(-1)).toEqual(expect.objectContaining({ key: "valid-80" }));
		expect(result.skipped.at(-1)?.reason).not.toBe("invalid-record");
		expect(result.skipped.some((item) => item.key === "none")).toBe(false);
		expect(await readFile(path.join(outside, "keep.txt"), "utf8")).toBe("keep\n");
	});

	it("deduplicates shared physical targets and preserves object enumeration order", async () => {
		const project = await gitProject();
		const workflow = defineWorkflow({
			name: entry.name,
			description: entry.description,
			canEditFiles: true,
			async run(ctx) {
				await ctx.agent({ key: "10", agent: "worker", prompt: "task", worktree: { branchId: "shared" } });
				return ctx.agent({ key: "2", agent: "worker", prompt: "task", worktree: { branchId: "shared" } });
			},
		});
		const handle = await fileHandleFor(project, "run-cleanup-duplicate", workflow);
		await handle.execute();
		expect(await workflowRunModule.cleanupWorktrees(project, "run-cleanup-duplicate")).toEqual({ cleaned: ["2", "10"], skipped: [] });
	});

	it("isolates status and removal failures while continuing cleanup", async () => {
		const project = await gitProject();
		const locked = await addWorktree(project, "locked");
		const clean = await addWorktree(project, "removable");
		const notGit = path.join(project, ".pi", "worktrees", "not-git");
		await mkdir(notGit, { recursive: true });
		await writeFile(path.join(notGit, ".git"), "gitdir: missing\n");
		await runGit(project, ["worktree", "lock", locked]);
		await seedWorktreeEvents(project, "run-cleanup-git-failures", [
			["locked", worktreeRecord(locked, "locked")],
			["not-git", worktreeRecord(notGit, "not-git")],
			["clean", worktreeRecord(clean, "removable")],
		]);
		const result = await workflowRunModule.cleanupWorktrees(project, "run-cleanup-git-failures");
		expect(result.cleaned).toEqual(["clean"]);
		expect(result.skipped).toEqual([
			expect.objectContaining({ key: "locked", reason: "git-failed" }),
			expect.objectContaining({ key: "not-git", reason: "git-failed" }),
		]);
	});

	it("propagates an ordinary Error abort reason before recovery", async () => {
		const project = await cwd();
		const reason = new Error("cleanup cancelled");
		const controller = new AbortController();
		controller.abort(reason);
		await expect(workflowRunModule.cleanupWorktrees(project, "missing-run", { signal: controller.signal })).rejects.toBe(reason);
	});

	it("rejects cleanup while an agent operation owns the run", async () => {
		const project = await gitProject();
		let admit!: () => void;
		let release!: () => void;
		const admitted = new Promise<void>((resolve) => { admit = resolve; });
		const blocked = new Promise<void>((resolve) => { release = resolve; });
		const workflow = defineWorkflow({
			name: entry.name,
			description: entry.description,
			canEditFiles: true,
			run: (ctx) => ctx.agent({ key: "active", agent: "worker", prompt: "task", worktree: true }),
		});
		const handle = await fileHandleFor(project, "run-cleanup-active", workflow, async () => {
			admit();
			await blocked;
			return completedSubagent();
		});
		const running = handle.execute();
		await admitted;
		await expect(workflowRunModule.cleanupWorktrees(project, "run-cleanup-active")).rejects.toBeInstanceOf(RunAlreadyActiveError);
		release();
		await running;
		expect(await workflowRunModule.cleanupWorktrees(project, "run-cleanup-active")).toEqual({ cleaned: ["active"], skipped: [] });
	});

	it("cleans a worktree recovered from projection fallback", async () => {
		const project = await gitProject();
		const worktree = await addWorktree(project, "projection-only");
		const persistence = filePersistence(project, "run-cleanup-projection");
		let state: RunState = initialState("run-cleanup-projection", entry, "");
		state = applyWorkflowRunEvent(state, {
			type: "agent_started",
			ts: Date.now(),
			key: "projected",
			agent: "worker",
			worktree: { path: worktree, branch: "fleet/projection-only", branchId: "projection-only" },
		});
		await persistence.writeProjection(state);
		expect(await workflowRunModule.cleanupWorktrees(project, "run-cleanup-projection")).toEqual({ cleaned: ["projected"], skipped: [] });
	});
});

describe("WorkflowRun deep interface", () => {
	it("keeps append, reduction, and projection ordering for creation and ordinary events", async () => {
		const project = await cwd();
		const calls: Array<{ name: string; value?: unknown }> = [];
		class TracedPersistence extends InMemoryRunPersistence {
			override async appendEvent(event: WorkflowRunEventView): Promise<void> {
				calls.push({ name: "appendEvent", value: event });
				await super.appendEvent(event);
			}
			override async writeProjection(projection: unknown): Promise<void> {
				calls.push({ name: "writeProjection", value: structuredClone(projection) });
				await super.writeProjection(projection);
			}
		}
		const persistence = new TracedPersistence(project, "run-order");
		const workflow = defineWorkflow({ name: entry.name, description: entry.description, canEditFiles: false, run: () => "ok" });
		const handle = await handleFor(project, "run-order", workflow, persistence);
		expect(calls.map(({ name }) => name)).toEqual(["appendEvent", "writeProjection"]);
		expect(calls[1].value).toMatchObject({ status: "created" });

		await handle.execute();
		expect(calls.map(({ name }) => name)).toEqual([
			"appendEvent", "writeProjection",
			"appendEvent", "writeProjection",
			"appendEvent", "writeProjection",
		]);
		expect(calls[3].value).toMatchObject({ status: "running" });
		expect(calls[5].value).toMatchObject({ status: "completed", result: "ok" });
	});

	it("does not reduce or project an ordinary event whose append fails", async () => {
		const project = await cwd();
		const workflow = defineWorkflow({ name: entry.name, description: entry.description, canEditFiles: false, run: () => "never" });
		const persistence = new InMemoryRunPersistence(project, "run-ordinary-append-failure");
		const handle = await handleFor(project, "run-ordinary-append-failure", workflow, persistence);
		const projection = persistence.projection;
		persistence.failAppend = true;

		await expect(handle.execute()).rejects.toThrow("event append failure");

		expect(persistence.events.map((event) => event.type)).toEqual(["run_created"]);
		expect(persistence.projection).toEqual(projection);
		expect((handle as unknown as { state: RunState }).state.status).toBe("created");
	});

	it("preserves the production raw-read JSON clone semantics", async () => {
		const project = await cwd();
		const persistence = filePersistence(project, "run-raw-clone");
		await mkdir(persistence.paths().root, { recursive: true });
		await writeFile(persistence.paths().events, '{"type":"future","negative":-0,"overflow":1e400}\n', "utf8");

		expect(await workflowRunModule.readEvents(project, "run-raw-clone")).toEqual([
			{ type: "future", negative: 0, overflow: null },
		]);
	});

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

	it("persists a user selection and reuses it on resume without prompting again", async () => {
		const project = await cwd();
		const persistence = new InMemoryRunPersistence(project, "run-user-selection");
		const prompts: Array<{ title: string; options: string[] }> = [];
		const workflow = defineWorkflow({
			name: entry.name,
			description: entry.description,
			canEditFiles: false,
			run: (ctx) => ctx.select("choose-candidate", "Which architecture option?", ["Option A", "Option B"], {
				dependsOn: ["architecture-report"],
				metadata: { kind: "architecture-candidate" },
			}),
		});
		const first = await handleFor(project, "run-user-selection", workflow, persistence, false, async (title, options) => {
			prompts.push({ title, options });
			return "Option B";
		});

		expect(await first.execute()).toBe("Option B");
		expect(prompts).toEqual([{ title: "Which architecture option?", options: ["Option A", "Option B"] }]);
		expect(persistence.events).toContainEqual(expect.objectContaining({
			type: "step_started",
			key: "choose-candidate",
			dependsOn: ["architecture-report"],
			metadata: expect.objectContaining({ interaction: "select", options: ["Option A", "Option B"] }),
		}));
		expect(persistence.events).toContainEqual(expect.objectContaining({ type: "step_completed", key: "choose-candidate", result: "Option B" }));

		const resumed = await handleFor(project, "run-user-selection", workflow, persistence, true, async () => {
			throw new Error("completed selection must not prompt again");
		});
		expect(await resumed.execute()).toBe("Option B");
		expect(persistence.events.some((event) => event.type === "step_reused" && event.key === "choose-candidate")).toBe(true);
	});

	it("rejects a persisted choice that no longer exists in the available options", async () => {
		const project = await cwd();
		const persistence = new InMemoryRunPersistence(project, "run-user-selection-stale");
		const initialWorkflow = defineWorkflow({
			name: entry.name,
			description: entry.description,
			canEditFiles: false,
			run: (ctx) => ctx.select("choose-candidate", "Choose", ["Option A", "Option B"]),
		});
		const first = await handleFor(project, "run-user-selection-stale", initialWorkflow, persistence, false, async () => "Option B");
		expect(await first.execute()).toBe("Option B");

		const changedWorkflow = defineWorkflow({
			name: entry.name,
			description: entry.description,
			canEditFiles: false,
			run: (ctx) => ctx.select("choose-candidate", "Choose", ["Option C", "Option D"]),
		});
		const resumed = await handleFor(project, "run-user-selection-stale", changedWorkflow, persistence, true, async () => {
			throw new Error("a stale completed choice must not prompt implicitly");
		});
		await expect(resumed.execute()).rejects.toThrow(/reuses an unavailable option: Option B.*restart the workflow/i);
	});

	it("re-prompts after the selection key is explicitly restarted", async () => {
		const project = await cwd();
		const persistence = new InMemoryRunPersistence(project, "run-user-selection-restart");
		const choices = ["Option A", "Option B"];
		const workflow = defineWorkflow({
			name: entry.name,
			description: entry.description,
			canEditFiles: false,
			run: (ctx) => ctx.select("choose-candidate", "Which architecture option?", choices),
		});
		const first = await handleFor(project, "run-user-selection-restart", workflow, persistence, false, async () => "Option A");
		expect(await first.execute()).toBe("Option A");
		const resumed = await handleFor(project, "run-user-selection-restart", workflow, persistence, true, async () => "Option B");
		expect(await resumed.restart("choose-candidate")).toBe("Option B");
	});

	it("stops cleanly when the user cancels a selection and retries it on resume", async () => {
		const project = await cwd();
		const persistence = new InMemoryRunPersistence(project, "run-user-selection-cancel");
		const workflow = defineWorkflow({
			name: entry.name,
			description: entry.description,
			canEditFiles: false,
			run: (ctx) => ctx.select("choose-candidate", "Which architecture option?", ["Option A", "Option B"]),
		});
		const first = await handleFor(project, "run-user-selection-cancel", workflow, persistence, false, async () => undefined);
		await expect(first.execute()).rejects.toThrow("Workflow cancelled during user selection");
		expect((await first.inspect()).status).toBe("stopped");

		const resumed = await handleFor(project, "run-user-selection-cancel", workflow, persistence, true, async () => "Option A");
		expect(await resumed.execute()).toBe("Option A");
	});

	it("dismisses a pending user selection when the workflow is stopped", async () => {
		const project = await cwd();
		let announceSelection!: () => void;
		const selectionStarted = new Promise<void>((resolve) => { announceSelection = resolve; });
		const workflow = defineWorkflow({
			name: entry.name,
			description: entry.description,
			canEditFiles: false,
			run: (ctx) => ctx.select("choose-candidate", "Choose", ["Option A", "Option B"]),
		});
		const handle = await handleFor(project, "run-user-selection-stop", workflow, undefined, false, async (_title, _options, signal) => {
			announceSelection();
			return new Promise((resolve) => signal.addEventListener("abort", () => resolve(undefined), { once: true }));
		});
		const running = handle.execute();
		await selectionStarted;
		handle.requestStop("stop during selection");
		await expect(running).rejects.toThrow("Workflow cancelled during user selection");
		expect((await handle.inspect()).status).toBe("stopped");
	});

	it("rejects invalid or unavailable user-selection requests", async () => {
		const project = await cwd();
		const unavailable = defineWorkflow({
			name: entry.name,
			description: entry.description,
			canEditFiles: false,
			run: (ctx) => ctx.select("choose-candidate", "Choose", ["A", "B"]),
		});
		const noUi = await handleFor(project, "run-user-selection-no-ui", unavailable);
		await expect(noUi.execute()).rejects.toThrow("requires an interactive TUI");

		const invalid = defineWorkflow({
			name: entry.name,
			description: entry.description,
			canEditFiles: false,
			run: (ctx) => ctx.select("choose-candidate", "Choose", ["A", "B"]),
		});
		const badOption = await handleFor(project, "run-user-selection-invalid", invalid, undefined, false, async () => "C");
		await expect(badOption.execute()).rejects.toThrow("unknown option: C");
	});

	it("keeps durable append order and recovers after an ordinary projection failure", async () => {
		const project = await cwd();
		const persistence = new InMemoryRunPersistence(project, "run-projection");
		const workflow = defineWorkflow({
			name: entry.name,
			description: entry.description,
			canEditFiles: false,
			run() {
				persistence.failNextProjection = true;
				return "ok";
			},
		});
		const handle = await handleFor(project, "run-projection", workflow, persistence);
		expect(await handle.execute()).toBe("ok");
		expect((persistence.projection as RunState).status).toBe("running");
		expect(persistence.events.at(-1)?.type).toBe("run_completed");
		const reopened = await handleFor(project, "run-projection", workflow, persistence, true);
		expect((await reopened.inspect()).status).toBe("completed");
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
