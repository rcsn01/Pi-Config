import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSubagentChildExecution } from "./child-execution.ts";
import { agent, emitProcessResult, spawnHarness } from "./test-harness.ts";

const tempRoots: string[] = [];

function tempRoot(): string {
	const directory = mkdtempSync(path.join(os.tmpdir(), "subagent-child-execution-test-"));
	tempRoots.push(directory);
	return directory;
}

afterEach(() => {
	for (const directory of tempRoots.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Subagent child execution", () => {
	it("turns child events into one result through its interface", async () => {
		const spawn = spawnHarness();
		const execution = createSubagentChildExecution({ spawnProcess: spawn.spawnProcess, tempRoot: tempRoot() });
		const progress: string[] = [];
		const promise = execution.execute({
			agent: agent(),
			task: "Inspect code",
			cwd: "/workspace",
			launch: { model: "openai/test-model", thinkingLevel: "minimal" },
			cacheSessionId: "child-session",
			onProgress: (event) => { progress.push(event.type); },
		});
		await expect.poll(() => spawn.processes.length).toBe(1);
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
				message.slice(20),
			],
		});

		await expect(promise).resolves.toMatchObject({
			output: "Working\n```ts\nskip\n```\nFinished",
			exitCode: 0,
			model: "openai/actual",
			usage: { input: 10, output: 4, cacheRead: 2, cacheWrite: 1, cost: 0.25, turns: 1 },
			progress: { status: "completed", toolCount: 1, tokens: 14, lastMessage: "Working Finished" },
		});
		expect(progress).toEqual(["started", "tool_call", "tool_result", "message", "completed"]);
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
