import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { deriveSubagentSessionId } from "./cache-affinity.ts";
import { createSubagentRunner } from "./subagent-runner.ts";
import {
	agent,
	emitProcessResult,
	fakeProcess,
	memoryConfigStore,
	memoryRegistry,
	spawnHarness,
} from "./test-harness.ts";

async function waitForProcess(processes: unknown[]): Promise<void> {
	await vi.waitFor(() => expect(processes).toHaveLength(1));
}

describe("single subagent runner", () => {
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
				'{"type":"tool_execution_start","toolName":"read","args":{"path":"src/a.ts"}}\nnot-json\n',
				'{"type":"tool_execution_end"}\n',
				message.slice(0, 20),
				message.slice(20),
			],
		});
		const result = await promise;

		const [command, args, options] = spawn.spawnProcess.mock.calls[0];
		expect(command).toBe(process.execPath);
		expect(args).toEqual(expect.arrayContaining([
			"--mode", "json", "--no-session", "--session-id",
			deriveSubagentSessionId("main-session-123", "openai/test-model"),
			"--no-skills", "--no-extensions", "--tools", "read",
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
		});
		expect(progress.map((event) => event.type)).toEqual(["started", "tool_call", "tool_result", "message", "completed"]);
		expect(updates.length).toBeGreaterThan(0);
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
		await expect(failedPromise).resolves.toMatchObject({ exitCode: 1, output: "", progress: { status: "failed" } });
	});
});
