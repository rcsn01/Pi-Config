import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createChildTrialRunner } from "./child-runner.ts";
import type { TrialSpec } from "./experiment.ts";
import { fingerprintPayload, serializeProbeEvent } from "./probe-protocol.ts";

const spec: TrialSpec = {
	id: "cacheeffort-child-test",
	transport: "sse",
	orientation: "aabb",
	efforts: ["medium", "medium", "max", "max"],
	prompts: ["warm", "two", "three", "four"],
};

class FakeChild extends EventEmitter {
	stdout = new PassThrough();
	stderr = new PassThrough();
	stdin: Writable;
	pid = 12345;
	exitCode: number | null = null;
	signalCode: NodeJS.Signals | null = null;
	kill = vi.fn((_signal?: NodeJS.Signals | number) => {
		if (this.exitCode === null) {
			this.exitCode = 0;
			queueMicrotask(() => this.emit("exit", 0, null));
		}
		return true;
	});
	private effort = "medium";
	private turn = 0;

	constructor(private readonly hangPrompt = false) {
		super();
		this.stdin = new Writable({
			write: (chunk, _encoding, callback) => {
				for (const line of chunk.toString().trim().split("\n")) this.handle(JSON.parse(line));
				callback();
			},
		});
		this.stderr.write(serializeProbeEvent({
			type: "runtime",
			observation: { piVersion: "test", piAiVersion: "test", websocketDebugAvailable: true },
		}));
	}

	private response(command: any, data?: unknown): void {
		this.stdout.write(`${JSON.stringify({ id: command.id, type: "response", command: command.type, success: true, data })}\n`);
	}

	private handle(command: any): void {
		if (command.type === "get_state") {
			this.response(command, {
				sessionId: spec.id,
				model: { provider: "openai-codex", id: "gpt-test" },
			});
			return;
		}
		if (command.type === "set_thinking_level") this.effort = command.level;
		this.response(command);
		if (command.type !== "prompt" || this.hangPrompt) return;

		const requestIndex = ++this.turn;
		const input = Array.from({ length: requestIndex }, (_, index) => ({ index }));
		this.stderr.write(serializeProbeEvent({
			type: "request",
			observation: fingerprintPayload({
				prompt_cache_key: spec.id,
				input,
				reasoning: { effort: this.effort },
			}, requestIndex),
		}));
		queueMicrotask(() => {
			this.stdout.write(`${JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "OK" } })}\n`);
			this.stdout.write(`${JSON.stringify({
				type: "message_end",
				message: {
					role: "assistant",
					provider: "openai-codex",
					model: "gpt-test",
					stopReason: "stop",
					usage: {
						input: requestIndex === 1 ? 4000 : 500,
						output: 1,
						cacheRead: requestIndex === 1 ? 0 : 3500,
						cacheWrite: 0,
						totalTokens: 4001,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				},
			})}\n`);
			this.stdout.write(`${JSON.stringify({ type: "agent_settled" })}\n`);
			// Deliberately arrive after agent_settled to exercise the cross-pipe probe barrier.
			setTimeout(() => this.stderr.write(serializeProbeEvent({
				type: "turn",
				requestIndex,
				wireMode: "unknown",
			})), 2);
		});
	}
}

describe("isolated child Pi runner", () => {
	it("uses controlled flags, waits for stderr instrumentation, and strips prompts from results", async () => {
		const root = mkdtempSync(join(tmpdir(), "cache-effort-test-"));
		const child = new FakeChild();
		const spawnProcess = vi.fn(() => child as any);
		const removeDirectory = vi.fn(async (directory: string) => rmSync(directory, { recursive: true, force: true }));
		const run = createChildTrialRunner(
			{ provider: "openai-codex", modelId: "gpt-test" },
			{ spawnProcess: spawnProcess as any, makeTempDirectory: async () => root, removeDirectory, turnTimeoutMs: 1000 },
		);
		const result = await run(spec, {});
		const [, args] = (spawnProcess.mock.calls as unknown as Array<[string, string[]]>)[0]!;
		expect(args).toEqual(expect.arrayContaining([
			"--mode", "rpc", "--no-session", "--session-id", spec.id,
			"--no-tools", "--no-extensions", "--no-skills", "--no-context-files", "--offline",
		]));
		expect(result).toMatchObject({ payloadValid: true, turns: { length: 4 } });
		expect(result.spec).not.toHaveProperty("prompts");
		expect(removeDirectory).toHaveBeenCalledWith(root);
	});

	it("kills the active child and removes its temporary directory on cancellation", async () => {
		const root = mkdtempSync(join(tmpdir(), "cache-effort-cancel-"));
		const child = new FakeChild(true);
		const removeDirectory = vi.fn(async (directory: string) => rmSync(directory, { recursive: true, force: true }));
		const run = createChildTrialRunner(
			{ provider: "openai-codex", modelId: "gpt-test" },
			{ spawnProcess: (() => child) as any, makeTempDirectory: async () => root, removeDirectory, turnTimeoutMs: 1000 },
		);
		const controller = new AbortController();
		const promise = run(spec, { signal: controller.signal });
		await new Promise((resolve) => setTimeout(resolve, 5));
		controller.abort();
		const result = await promise;
		expect(result.error).toBe("Experiment cancelled.");
		expect(child.kill).toHaveBeenCalledWith("SIGTERM");
		expect(removeDirectory).toHaveBeenCalledWith(root);
	});
});
