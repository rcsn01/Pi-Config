import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { deriveSubagentSessionId } from "./cache-affinity.ts";
import { getObservabilityService, resetObservabilityServiceForTests } from "../_shared/observability.ts";
import { createSubagentRunner } from "./subagent-runner.ts";
import {
	agent,
	agentResult,
	emitProcessResult,
	fakeProcess,
	memoryConfigStore,
	memoryRegistry,
	spawnHarness,
} from "./test-harness.ts";

async function waitForProcess(processes: unknown[]): Promise<void> {
	await vi.waitFor(() => expect(processes).toHaveLength(1));
}

beforeEach(() => resetObservabilityServiceForTests());

describe("single subagent runner", () => {
	it("prepares a request before sending it to child execution", async () => {
		const worker = agent();
		const execute = vi.fn(async () => agentResult());
		const run = createSubagentRunner({
			registry: memoryRegistry([worker]),
			config: memoryConfigStore({ defaultThinkingLevel: "minimal" }),
			childExecution: { execute },
		});

		await run({
			agent: "worker",
			prompt: "legacy task",
			cwd: "/workspace",
			cacheAffinitySeed: "session",
		});

		expect(execute).toHaveBeenCalledWith(expect.objectContaining({
			agent: worker,
			task: "legacy task",
			cwd: "/workspace",
			launch: { model: "openai/test-model", thinkingLevel: "minimal" },
			cacheSessionId: deriveSubagentSessionId("session", "openai/test-model"),
		}));
	});

	it("builds child arguments and parses chunked, malformed, and unterminated stream lines", async () => {
		const spawn = spawnHarness();
		const config = memoryConfigStore({ defaultThinkingLevel: "minimal" });
		const run = createSubagentRunner({ registry: memoryRegistry(), config, spawnProcess: spawn.spawnProcess });
		const progress: any[] = [];
		const updates: any[] = [];
		const promise = run({
			agent: "worker",
			task: "Inspect code",
			cwd: "/workspace",
			cacheAffinitySeed: "main-session-123",
			onProgress: (event) => { progress.push(event); },
			onUpdate: (update) => updates.push({ ...update }),
		});
		await waitForProcess(spawn.processes);
		const message = JSON.stringify({
			type: "message_end",
			message: {
				role: "assistant",
				model: "openai/actual",
				content: [{ type: "text", text: "Working\n```ts\nskip\n```\nFinished" }],
				usage: { input: 10, output: 4, cacheRead: 2, cacheWrite: 1, cost: { total: 0.25 } },
			},
		});
		emitProcessResult(spawn.processes[0], {
			stdout: [
				'{"type":"agent_start"}\n{"type":"turn_start"}\n',
				'{"type":"tool_execution_start","toolCallId":"read-1","toolName":"read","args":{"path":"src/a.ts"}}\nnot-json\n',
				'{"type":"tool_execution_end","toolCallId":"read-1"}\n',
				message.slice(0, 20),
				message.slice(20) + '\n{"type":"agent_end"}\n',
			],
		});
		const result = await promise;

		const [command, args, options] = spawn.spawnProcess.mock.calls[0];
		expect(command).toBe(process.execPath);
		expect(args).toEqual(expect.arrayContaining([
			"--mode", "json", "--no-session", "--session-id",
			deriveSubagentSessionId("main-session-123", "openai/test-model"),
			"--no-skills", "--no-extensions", "--tools", "read,safe_bash",
			"--model", "openai/test-model", "--thinking", "minimal", "Task: Inspect code",
		]));
		expect(args.some((value) => value.endsWith("tools/safe-bash.ts"))).toBe(true);
		expect(options.cwd).toBe("/workspace");
		expect(result).toMatchObject({
			output: "Working\n```ts\nskip\n```\nFinished",
			exitCode: 0,
			model: "openai/actual",
			usage: { input: 10, output: 4, cacheRead: 2, cacheWrite: 1, cost: 0.25, turns: 1 },
			progress: { status: "completed", toolCount: 1, tokens: 14, lastMessage: "Working Finished" },
			timing: { partial: false, anomalyCount: 0 },
		});
		expect(progress.map((event) => event.type)).toEqual(["started", "tool_call", "tool_result", "message", "completed"]);
		expect(updates.length).toBeGreaterThan(0);
	});

	it("delivers child events through the observation seam when capture is active", async () => {
		const observed: any[] = [];
		const unsubscribe = getObservabilityService().activate((event) => observed.push(event));
		const spawn = spawnHarness();
		const run = createSubagentRunner({ registry: memoryRegistry(), config: memoryConfigStore(), spawnProcess: spawn.spawnProcess });
		const promise = run({ agent: "worker", task: "observe", cwd: "/workspace" });
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
		unsubscribe();
	});

	it("keeps child launch unchanged while capture is inactive", async () => {
		const spawn = spawnHarness();
		const run = createSubagentRunner({ registry: memoryRegistry(), config: memoryConfigStore(), spawnProcess: spawn.spawnProcess });
		const promise = run({ agent: "worker", task: "plain", cwd: "/workspace" });
		await waitForProcess(spawn.processes);
		const [, , options] = spawn.spawnProcess.mock.calls[0];
		expect(options).toEqual({ cwd: "/workspace", stdio: ["ignore", "pipe", "pipe"] });
		spawn.processes[0].emit("close", 0);
		await promise;
	});

	it("loads repo_query for explorers alongside built-in tools", async () => {
		const spawn = spawnHarness();
		const explorer = agent({ name: "explorer", tools: ["read", "grep", "find", "ls", "repo_query"] });
		const run = createSubagentRunner({
			registry: memoryRegistry([explorer]),
			config: memoryConfigStore(),
			spawnProcess: spawn.spawnProcess,
		});
		const promise = run({ agent: "explorer", task: "map the repository", cwd: "/workspace" });
		await waitForProcess(spawn.processes);
		const [, args] = spawn.spawnProcess.mock.calls[0];
		expect(args).toContain("--tools");
		expect(args[args.indexOf("--tools") + 1]).toBe("read,grep,find,ls,repo_query");
		expect(args.some((value) => value.endsWith("tools/repo-query.ts"))).toBe(true);
		spawn.processes[0].emit("close", 0);
		await promise;
	});

	it("allows custom-only agents to use their mapped tools", async () => {
		const spawn = spawnHarness();
		const researcher = agent({ name: "researcher", tools: ["ddg_search", "ddg_fetch"] });
		const run = createSubagentRunner({
			registry: memoryRegistry([researcher]),
			config: memoryConfigStore(),
			spawnProcess: spawn.spawnProcess,
		});
		const promise = run({ agent: "researcher", task: "research the topic", cwd: "/workspace" });
		await waitForProcess(spawn.processes);
		const [, args] = spawn.spawnProcess.mock.calls[0];
		expect(args).toContain("--tools");
		expect(args[args.indexOf("--tools") + 1]).toBe("ddg_search,ddg_fetch");
		expect(args).not.toContain("--no-tools");
		expect(args.filter((value) => value.endsWith("tools-web-search/index.ts"))).toHaveLength(1);
		expect(args.filter((value) => value.endsWith("tools-web-fetch/index.ts"))).toHaveLength(1);
		spawn.processes[0].emit("close", 0);
		await promise;
	});

	it("keeps legacy ephemeral behavior when no cache-affinity seed is supplied", async () => {
		const child = fakeProcess();
		const spawnProcess = vi.fn((_command: string, args: string[]) => {
			expect(args).toContain("--no-session");
			expect(args).not.toContain("--session-id");
			queueMicrotask(() => child.emit("close", 0));
			return child as any;
		});
		const run = createSubagentRunner({ registry: memoryRegistry(), config: memoryConfigStore(), spawnProcess: spawnProcess as any });
		await run({ agent: "worker", task: "inspect", cwd: process.cwd() });
	});

	it("writes long tasks to a private temporary file and cleans it after execution", async () => {
		const child = fakeProcess();
		let taskPath = "";
		let taskDocument = "";
		const spawnProcess = vi.fn((_command: string, args: string[]) => {
			taskPath = args.find((value) => value.startsWith("@"))!.slice(1);
			taskDocument = readFileSync(taskPath, "utf8");
			queueMicrotask(() => child.emit("close", 0));
			return child as any;
		});
		const run = createSubagentRunner({ registry: memoryRegistry(), config: memoryConfigStore(), spawnProcess: spawnProcess as any });
		await run({ agent: "worker", task: "x".repeat(8001), cwd: process.cwd() });
		expect(taskDocument).toBe(`Task: ${"x".repeat(8001)}`);
		expect(() => readFileSync(taskPath)).toThrow();
	});

	it("preserves message-update output when a child is killed", async () => {
		const spawn = spawnHarness();
		const run = createSubagentRunner({ registry: memoryRegistry(), config: memoryConfigStore(), spawnProcess: spawn.spawnProcess });
		const promise = run({ agent: "worker", task: "killed", cwd: process.cwd() });
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

	it("preserves partial assistant output and records stderr on non-zero exit", async () => {
		const spawn = spawnHarness();
		const run = createSubagentRunner({ registry: memoryRegistry(), config: memoryConfigStore(), spawnProcess: spawn.spawnProcess });
		const promise = run({ agent: "worker", task: "fail", cwd: process.cwd() });
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
			const run = createSubagentRunner({ registry: memoryRegistry(), config: memoryConfigStore(), spawnProcess: spawn.spawnProcess });
			const promise = run({
				agent: "worker",
				task: mode,
				cwd: process.cwd(),
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

	it("truncates oversized output and handles process error events", async () => {
		const spawn = spawnHarness();
		const run = createSubagentRunner({ registry: memoryRegistry(), config: memoryConfigStore(), spawnProcess: spawn.spawnProcess });
		const promise = run({ agent: "worker", task: "large", cwd: process.cwd(), maxOutputBytes: 20 });
		await waitForProcess(spawn.processes);
		emitProcessResult(spawn.processes[0], {
			stdout: `${JSON.stringify({ type: "message_end", message: { role: "assistant", content: "a".repeat(100) } })}\n`,
		});
		const result = await promise;
		expect(result).toMatchObject({ truncated: true, originalOutputBytes: 100 });
		expect(result.output).toContain("[Output truncated]");

		const failedSpawn = spawnHarness();
		const failedRun = createSubagentRunner({ registry: memoryRegistry(), config: memoryConfigStore(), spawnProcess: failedSpawn.spawnProcess });
		const failedPromise = failedRun({ agent: "worker", task: "error", cwd: process.cwd() });
		await waitForProcess(failedSpawn.processes);
		failedSpawn.processes[0].emit("error", new Error("spawn failed"));
		await expect(failedPromise).resolves.toMatchObject({ exitCode: 1, output: "Error: spawn failed", progress: { status: "failed", error: "spawn failed" } });
	});
});
