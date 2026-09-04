import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getObservabilityService, resetObservabilityServiceForTests } from "../_shared/observability.ts";
import { createSubagentChildExecution } from "./child-execution.ts";
import { agent, emitProcessResult, fakeProcess, spawnHarness } from "./test-harness.ts";

const tempRoots: string[] = [];

function tempRoot(): string {
	const directory = mkdtempSync(path.join(os.tmpdir(), "subagent-child-execution-test-"));
	tempRoots.push(directory);
	return directory;
}

async function waitForProcess(processes: unknown[]): Promise<void> {
	await vi.waitFor(() => expect(processes).toHaveLength(1));
}

beforeEach(() => resetObservabilityServiceForTests());

afterEach(() => {
	resetObservabilityServiceForTests();
	for (const directory of tempRoots.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Subagent child execution", () => {
	it("builds the child command and returns output from split stdout chunks", async () => {
		const spawn = spawnHarness();
		const execution = createSubagentChildExecution({ spawnProcess: spawn.spawnProcess, tempRoot: tempRoot() });
		const progress: any[] = [];
		const promise = execution.execute({
			agent: agent(),
			task: "Inspect code",
			cwd: "/workspace",
			launch: { model: "openai/test-model", thinkingLevel: "minimal" },
			cacheSessionId: "child-session",
			onProgress: (event) => { progress.push(event); },
		});
		await waitForProcess(spawn.processes);
		const message = JSON.stringify({ type: "message_end", message: { role: "assistant", content: "Finished" } });
		emitProcessResult(spawn.processes[0], { stdout: [message.slice(0, 20), `${message.slice(20)}\n`] });
		const result = await promise;

		const [command, args, options] = spawn.spawnProcess.mock.calls[0];
		expect(command).toBe(process.execPath);
		expect(args).toEqual(expect.arrayContaining([
			"--mode", "json", "--no-session", "--session-id", "child-session",
			"--no-skills", "--no-extensions", "--tools", "read,safe_bash",
			"--model", "openai/test-model", "--thinking", "minimal", "Task: Inspect code",
		]));
		expect(args.some((value) => value.endsWith("tools/safe-bash.ts"))).toBe(true);
		expect(options.cwd).toBe("/workspace");
		expect(result).toMatchObject({ output: "Finished", exitCode: 0, progress: { status: "completed" } });
		expect(progress[0]).toMatchObject({ type: "started" });
		expect(progress.at(-1)).toMatchObject({ type: "completed", result });
		expect(progress.filter((event) => event.type === "completed" || event.type === "failed")).toHaveLength(1);
	});

	it("delivers child events through observation while capture is active", async () => {
		const observed: any[] = [];
		const unsubscribe = getObservabilityService().activate((event) => observed.push(event));
		try {
			const spawn = spawnHarness();
			const execution = createSubagentChildExecution({ spawnProcess: spawn.spawnProcess, tempRoot: tempRoot() });
			const promise = execution.execute({
				agent: agent(),
				task: "observe",
				cwd: "/workspace",
				launch: { model: "openai/test-model" },
			});
			await waitForProcess(spawn.processes);
			const request = JSON.stringify({ type: "request", provider: "openai", api: "openai-responses", model: "gpt", payload: { exact: true } });
			spawn.processes[0].stdout.write(`${request}\n`);
			spawn.processes[0].stdio[3].write("not-json\n" + JSON.stringify({ type: "agent_start" }) + "\n" + JSON.stringify({ type: "turn_start", turnIndex: 0 }) + "\n" + request.slice(0, 17));
			spawn.processes[0].stdio[3].write(request.slice(17) + "\n" + JSON.stringify({ type: "response", status: 200 }) + "\n" + JSON.stringify({ type: "assistant", message: { role: "assistant", content: "done" } }) + "\n");
			spawn.processes[0].emit("close", 0);
			await promise;

			expect(observed.map((event) => event.type)).toEqual(["agent_start", "turn_start", "request", "response", "assistant"]);
			expect(observed[2]).toMatchObject({ source: { channel: "subagent", displayLabel: "worker" }, payload: { exact: true } });
			expect(new Set(observed.map((event) => event.source.invocationId)).size).toBe(1);
		} finally {
			unsubscribe();
		}
	});

	it("keeps standard I/O unchanged while capture is inactive", async () => {
		const spawn = spawnHarness();
		const execution = createSubagentChildExecution({ spawnProcess: spawn.spawnProcess, tempRoot: tempRoot() });
		const promise = execution.execute({
			agent: agent(),
			task: "plain",
			cwd: "/workspace",
			launch: { model: "openai/test-model" },
		});
		await waitForProcess(spawn.processes);
		const [, , options] = spawn.spawnProcess.mock.calls[0];
		expect(options).toEqual({ cwd: "/workspace", stdio: ["ignore", "pipe", "pipe"] });
		spawn.processes[0].emit("close", 0);
		await promise;
	});

	it("loads repo_query for explorers alongside built-in tools", async () => {
		const spawn = spawnHarness();
		const execution = createSubagentChildExecution({ spawnProcess: spawn.spawnProcess, tempRoot: tempRoot() });
		const promise = execution.execute({
			agent: agent({ name: "explorer", tools: ["read", "grep", "find", "ls", "repo_query"] }),
			task: "map the repository",
			cwd: "/workspace",
			launch: { model: "openai/test-model" },
		});
		await waitForProcess(spawn.processes);
		const [, args] = spawn.spawnProcess.mock.calls[0];
		expect(args[args.indexOf("--tools") + 1]).toBe("read,grep,find,ls,repo_query");
		expect(args.some((value) => value.endsWith("tools/repo-query.ts"))).toBe(true);
		spawn.processes[0].emit("close", 0);
		await promise;
	});

	it("loads only mapped custom tools for researchers", async () => {
		const spawn = spawnHarness();
		const execution = createSubagentChildExecution({ spawnProcess: spawn.spawnProcess, tempRoot: tempRoot() });
		const promise = execution.execute({
			agent: agent({ name: "researcher", tools: ["ddg_search", "ddg_fetch"] }),
			task: "research the topic",
			cwd: "/workspace",
			launch: { model: "openai/test-model" },
		});
		await waitForProcess(spawn.processes);
		const [, args] = spawn.spawnProcess.mock.calls[0];
		expect(args[args.indexOf("--tools") + 1]).toBe("ddg_search,ddg_fetch");
		expect(args).not.toContain("--no-tools");
		expect(args.filter((value) => value.endsWith("tools-web-search/index.ts"))).toHaveLength(1);
		expect(args.filter((value) => value.endsWith("tools-web-fetch/index.ts"))).toHaveLength(1);
		spawn.processes[0].emit("close", 0);
		await promise;
	});

	it("omits a cache session ID for ephemeral children", async () => {
		const spawn = spawnHarness();
		const execution = createSubagentChildExecution({ spawnProcess: spawn.spawnProcess, tempRoot: tempRoot() });
		const promise = execution.execute({
			agent: agent(),
			task: "inspect",
			cwd: "/workspace",
			launch: { model: "openai/test-model" },
		});
		await waitForProcess(spawn.processes);
		const [, args] = spawn.spawnProcess.mock.calls[0];
		expect(args).toContain("--no-session");
		expect(args).not.toContain("--session-id");
		spawn.processes[0].emit("close", 0);
		await promise;
	});

	it("writes long tasks to a temporary file and removes it after execution", async () => {
		const child = fakeProcess();
		let taskPath = "";
		let taskDocument = "";
		const spawnProcess = vi.fn((_command: string, args: string[]) => {
			taskPath = args.find((value) => value.startsWith("@"))!.slice(1);
			taskDocument = readFileSync(taskPath, "utf8");
			queueMicrotask(() => child.emit("close", 0));
			return child as any;
		});
		const execution = createSubagentChildExecution({ spawnProcess: spawnProcess as any, tempRoot: tempRoot() });
		await execution.execute({
			agent: agent(),
			task: "x".repeat(8001),
			cwd: "/workspace",
			launch: { model: "openai/test-model" },
		});
		expect(taskDocument).toBe(`Task: ${"x".repeat(8001)}`);
		expect(() => readFileSync(taskPath)).toThrow();
	});

	it("preserves streamed partial output when a child is killed", async () => {
		const spawn = spawnHarness();
		const execution = createSubagentChildExecution({ spawnProcess: spawn.spawnProcess, tempRoot: tempRoot() });
		const promise = execution.execute({
			agent: agent(),
			task: "killed",
			cwd: "/workspace",
			launch: { model: "openai/test-model" },
		});
		await waitForProcess(spawn.processes);
		emitProcessResult(spawn.processes[0], {
			stdout: [
				`${JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Partial " } })}\n`,
				`${JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "update" } })}\n`,
			],
			exitCode: 143,
		});
		await expect(promise).resolves.toMatchObject({ output: "Partial update", exitCode: 143, progress: { status: "failed" } });
	});

	it("preserves partial assistant output and standard error on a non-zero exit", async () => {
		const spawn = spawnHarness();
		const execution = createSubagentChildExecution({ spawnProcess: spawn.spawnProcess, tempRoot: tempRoot() });
		const promise = execution.execute({
			agent: agent(),
			task: "fail",
			cwd: "/workspace",
			launch: { model: "openai/test-model" },
		});
		await waitForProcess(spawn.processes);
		emitProcessResult(spawn.processes[0], {
			stdout: `${JSON.stringify({ type: "message_end", message: { role: "assistant", content: "Partial result" } })}\n`,
			stderr: "child failed",
			exitCode: 2,
		});
		const result = await promise;
		expect(result.output).toBe("Partial result");
		expect(result).toMatchObject({ exitCode: 2, progress: { status: "failed", error: "child failed" } });
	});

	it("terminates on caller abort and timeout", async () => {
		for (const mode of ["abort", "timeout"] as const) {
			const spawn = spawnHarness();
			const controller = new AbortController();
			const execution = createSubagentChildExecution({ spawnProcess: spawn.spawnProcess, tempRoot: tempRoot() });
			const promise = execution.execute({
				agent: agent(),
				task: mode,
				cwd: "/workspace",
				launch: { model: "openai/test-model" },
				signal: mode === "abort" ? controller.signal : undefined,
				timeoutMs: mode === "timeout" ? 5 : undefined,
			});
			await waitForProcess(spawn.processes);
			if (mode === "abort") controller.abort(new Error("cancelled"));
			await vi.waitFor(() => expect(spawn.processes[0].kill).toHaveBeenCalledWith("SIGTERM"));
			spawn.processes[0].emit("close", 143);
			await expect(promise).resolves.toMatchObject({ exitCode: 143, progress: { status: "failed" } });
		}
	});

	it("truncates oversized output", async () => {
		const spawn = spawnHarness();
		const execution = createSubagentChildExecution({ spawnProcess: spawn.spawnProcess, tempRoot: tempRoot() });
		const promise = execution.execute({
			agent: agent(),
			task: "large",
			cwd: "/workspace",
			launch: { model: "openai/test-model" },
			maxOutputBytes: 20,
		});
		await waitForProcess(spawn.processes);
		emitProcessResult(spawn.processes[0], {
			stdout: `${JSON.stringify({ type: "message_end", message: { role: "assistant", content: "a".repeat(100) } })}\n`,
		});
		const result = await promise;
		expect(result).toMatchObject({ truncated: true, originalOutputBytes: 100 });
		expect(result.output).toContain("[Output truncated]");
	});

	it("settles process error events as failed results", async () => {
		const spawn = spawnHarness();
		const execution = createSubagentChildExecution({ spawnProcess: spawn.spawnProcess, tempRoot: tempRoot() });
		const promise = execution.execute({
			agent: agent(),
			task: "error",
			cwd: "/workspace",
			launch: { model: "openai/test-model" },
		});
		await waitForProcess(spawn.processes);
		spawn.processes[0].emit("error", new Error("spawn failed"));
		await expect(promise).resolves.toMatchObject({ exitCode: 1, output: "Error: spawn failed", progress: { status: "failed", error: "spawn failed" } });
	});

	it("removes temporary resources when launch preparation fails", async () => {
		const root = tempRoot();
		const execution = createSubagentChildExecution({ tempRoot: root });

		await expect(execution.execute({
			agent: agent({ name: "missing/worker" }),
			task: "fail during setup",
			cwd: "/workspace",
			launch: { model: "openai/test-model" },
		})).rejects.toThrow();
		expect(readdirSync(root)).toEqual([]);
	});

	it("removes temporary resources when spawning throws synchronously", async () => {
		const root = tempRoot();
		let promptPath = "";
		const execution = createSubagentChildExecution({
			tempRoot: root,
			spawnProcess: (_command, args) => {
				promptPath = args[args.indexOf("--append-system-prompt") + 1];
				throw new Error("synchronous spawn failure");
			},
		});

		await expect(execution.execute({
			agent: agent(),
			task: "fail during spawn",
			cwd: "/workspace",
			launch: { model: "openai/test-model" },
		})).rejects.toThrow("synchronous spawn failure");
		expect(promptPath).not.toBe("");
		expect(existsSync(promptPath)).toBe(false);
		expect(readdirSync(root)).toEqual([]);
	});
});
