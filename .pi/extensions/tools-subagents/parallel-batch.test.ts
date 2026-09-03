import { describe, expect, it, vi } from "vitest";
import * as config from "./config.ts";
import { deriveSubagentSessionId } from "./cache-affinity.ts";
import { createParallelSubagentBatch } from "./parallel-batch.ts";
import { agent, agentResult, memoryConfigStore, memoryRegistry } from "./test-harness.ts";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}

describe("parallel subagent batch", () => {
	it("defers standalone configuration resolution until batch execution", () => {
		const getDefaultSubagentConfig = vi.spyOn(config, "getDefaultSubagentConfig");

		createParallelSubagentBatch();

		expect(getDefaultSubagentConfig).not.toHaveBeenCalled();
		getDefaultSubagentConfig.mockRestore();
	});

	it("owns bounded execution, ordered results, task options, and stable snapshots", async () => {
		const registry = memoryRegistry([agent({ name: "slow" }), agent({ name: "fast" })]);
		const gates = { slow: deferred<void>(), fast: deferred<void>() };
		const calls: any[] = [];
		const snapshots: any[] = [];
		let active = 0;
		let peak = 0;
		const execute = vi.fn(async (request: any) => {
			calls.push(request);
			active++;
			peak = Math.max(peak, active);
			const progress = {
				...agentResult({ agent: request.agent.name, task: request.task }).progress,
				status: "running",
				lastMessage: `running ${request.agent.name}`,
			};
			await request.onProgress?.({
				type: "message",
				agent: request.agent.name,
				message: progress.lastMessage,
				tokens: progress.tokens,
			}, progress);
			request.onUpdate?.(progress);
			await gates[request.agent.name as "slow" | "fast"].promise;
			active--;
			const result = request.agent.name === "slow"
				? agentResult({ agent: "slow", task: request.task, output: "slow result" })
				: agentResult({ agent: "fast", task: request.task, output: "fast result" });
			await request.onProgress?.({ type: "completed", agent: request.agent.name, result }, result.progress);
			return result;
		});
		const batch = createParallelSubagentBatch({
			registry,
			config: memoryConfigStore({ maxConcurrency: 1 }),
			childExecution: { execute },
		});

		const promise = batch.runBatch([
			{ agent: "slow", prompt: "first", cwd: "/one", model: "openai/one", thinkingLevel: "high" },
			{ agent: "fast", task: "second" },
		], {
			cwd: "/root",
			maxConcurrency: 2,
			timeoutMs: 50,
			maxOutputBytes: 100,
			cacheAffinitySeed: "main-session-123",
			onSnapshot: (snapshot) => snapshots.push(snapshot),
		});

		await vi.waitFor(() => expect(peak).toBe(2));
		const firstSnapshot = snapshots[0];
		expect(firstSnapshot).toMatchObject({ changedIndex: 0, phase: "started" });
		expect(firstSnapshot.results.map((result: any) => result.progress.status)).toEqual(["running", "pending"]);
		expect(firstSnapshot.results[0]).toMatchObject({
			model: calls[0].launch.model,
			thinkingLevel: calls[0].launch.thinkingLevel,
		});
		gates.fast.resolve();
		gates.slow.resolve();

		const results = await promise;
		expect(results.map((result) => [result.agent, result.output])).toEqual([
			["slow", "slow result"],
			["fast", "fast result"],
		]);
		expect(calls).toEqual([
			expect.objectContaining({
				task: "first",
				cwd: "/one",
				timeoutMs: 50,
				maxOutputBytes: 100,
				launch: { model: "openai/one", thinkingLevel: "high" },
				cacheSessionId: deriveSubagentSessionId("main-session-123", "openai/one"),
			}),
			expect.objectContaining({
				task: "second",
				cwd: "/root",
				timeoutMs: 50,
				maxOutputBytes: 100,
				cacheSessionId: deriveSubagentSessionId("main-session-123", "openai/test-model"),
			}),
		]);
		expect(snapshots.map((snapshot) => snapshot.phase)).toEqual(expect.arrayContaining(["started", "progress", "completed"]));
		expect(snapshots.find((snapshot) => snapshot.phase === "progress")?.event?.type).toBe("message");
		expect(snapshots.find((snapshot) => snapshot.phase === "completed")?.event?.type).toBe("completed");
		expect(firstSnapshot.results.map((result: any) => result.progress.status)).toEqual(["running", "pending"]);
	});

	it("validates the whole batch before starting a child", async () => {
		const execute = vi.fn();
		const batch = createParallelSubagentBatch({
			registry: memoryRegistry(),
			config: memoryConfigStore(),
			childExecution: { execute },
		});

		await expect(batch.runBatch([
			{ agent: "worker", task: "valid" },
			{ agent: "missing", task: "invalid" },
		], { cwd: "/root" })).rejects.toThrow("Unknown agent: missing. Available agents: worker");
		expect(execute).not.toHaveBeenCalled();
	});

	it("resolves the whole batch before starting a child", async () => {
		const configStore = memoryConfigStore();
		vi.spyOn(configStore, "resolveLaunch")
			.mockReturnValueOnce({ model: "openai/first" })
			.mockImplementationOnce(() => { throw new Error("bad launch"); });
		const execute = vi.fn();
		const batch = createParallelSubagentBatch({
			registry: memoryRegistry(),
			config: configStore,
			childExecution: { execute },
		});

		await expect(batch.runBatch([
			{ agent: "worker", task: "one" },
			{ agent: "worker", task: "two" },
		], { cwd: "/root" })).rejects.toThrow("bad launch");
		expect(execute).not.toHaveBeenCalled();
	});

	it("uses configured concurrency when the caller does not override it", async () => {
		const release = deferred<void>();
		let active = 0;
		let peak = 0;
		const batch = createParallelSubagentBatch({
			registry: memoryRegistry(),
			config: memoryConfigStore({ maxConcurrency: 2 }),
			childExecution: {
				execute: async (request) => {
					active++;
					peak = Math.max(peak, active);
					await release.promise;
					active--;
					return agentResult({ task: request.task });
				},
			},
		});
		const promise = batch.runBatch([
			{ agent: "worker", task: "one" },
			{ agent: "worker", task: "two" },
			{ agent: "worker", task: "three" },
		], { cwd: "/root" });

		await vi.waitFor(() => expect(peak).toBe(2));
		release.resolve();
		await promise;
		expect(peak).toBe(2);
	});

	it("preserves indexed progress and completion callbacks through the compatibility adapter", async () => {
		const progress: any[] = [];
		const updates: any[] = [];
		const batch = createParallelSubagentBatch({
			registry: memoryRegistry(),
			config: memoryConfigStore(),
			childExecution: {
				execute: async (request) => {
					await request.onProgress?.(
						{ type: "message", agent: "worker", message: "working", tokens: 1 },
						agentResult().progress,
					);
					return agentResult({ task: request.task });
				},
			},
		});

		const results = await batch.runSubagentsParallel({
			cwd: "/root",
			tasks: [{ agent: "worker", prompt: "first" }],
			onProgress: (index, event) => { progress.push([index, event.type]); },
			onUpdate: (index, result) => { updates.push([index, result.task]); },
		});

		expect(results[0].task).toBe("first");
		expect(progress).toEqual([[0, "message"]]);
		expect(updates).toEqual([[0, "first"]]);
	});
});
