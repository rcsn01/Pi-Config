import { describe, expect, it, vi } from "vitest";
import { createParallelRunner, runOrderedConcurrently } from "./parallel-runner.ts";
import { agent, agentResult, memoryConfigStore, memoryRegistry } from "./test-harness.ts";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}

describe("ordered concurrency", () => {
	it("limits active work and preserves input order", async () => {
		let active = 0;
		let peak = 0;
		const gates = [deferred<number>(), deferred<number>(), deferred<number>()];
		const promise = runOrderedConcurrently([0, 1, 2], 2, async (item) => {
			active++;
			peak = Math.max(peak, active);
			const value = await gates[item].promise;
			active--;
			return value;
		});
		await vi.waitFor(() => expect(peak).toBe(2));
		gates[1].resolve(20);
		await vi.waitFor(() => expect(active).toBe(2));
		gates[2].resolve(30);
		gates[0].resolve(10);
		expect(await promise).toEqual([10, 20, 30]);
		expect(peak).toBe(2);
	});
});

describe("parallel subagent runner", () => {
	it("propagates task options, progress indexes, failures, and ordered results", async () => {
		const workers = memoryRegistry([agent({ name: "slow" }), agent({ name: "fast" })]);
		const calls: any[] = [];
		const updates: any[] = [];
		const progress: any[] = [];
		const gates = { slow: deferred<void>(), fast: deferred<void>() };
		let active = 0;
		let peak = 0;
		const runSingle = vi.fn(async (options: any) => {
			calls.push(options);
			active++;
			peak = Math.max(peak, active);
			await options.onProgress?.({ type: "message", agent: options.agent.name, message: "working", tokens: 1 }, agentResult({ agent: options.agent.name }).progress);
			await gates[options.agent.name as "slow" | "fast"].promise;
			active--;
			return options.agent.name === "slow"
				? agentResult({ agent: "slow", task: options.task, exitCode: 2, output: "partial", progress: { ...agentResult().progress, agent: "slow", status: "failed", task: options.task } })
				: agentResult({ agent: "fast", task: options.task });
		});
		const run = createParallelRunner({ registry: workers, config: memoryConfigStore({ maxConcurrency: 1 }), runSingle });
		const promise = run({
			cwd: "/root",
			maxConcurrency: 2,
			timeoutMs: 50,
			maxOutputBytes: 100,
			cacheAffinitySeed: "main-session-123",
			tasks: [
				{ agent: "slow", prompt: "first", cwd: "/one", model: "openai/one", thinkingLevel: "high" },
				{ agent: "fast", task: "second" },
			],
			onProgress: (index, event) => { progress.push([index, event.type]); },
			onUpdate: (index, result) => { updates.push([index, result.agent]); },
		});
		await vi.waitFor(() => expect(peak).toBe(2));
		gates.fast.resolve();
		gates.slow.resolve();
		const results = await promise;
		expect(results.map((result) => [result.agent, result.exitCode, result.output])).toEqual([
			["slow", 2, "partial"],
			["fast", 0, "Done"],
		]);
		expect(calls).toEqual([
			expect.objectContaining({ task: "first", cwd: "/one", timeoutMs: 50, maxOutputBytes: 100, model: "openai/one", thinkingLevel: "high", cacheAffinitySeed: "main-session-123" }),
			expect.objectContaining({ task: "second", cwd: "/root", timeoutMs: 50, maxOutputBytes: 100, cacheAffinitySeed: "main-session-123" }),
		]);
		expect(progress).toEqual([[0, "message"], [1, "message"]]);
		expect(updates).toEqual(expect.arrayContaining([[0, "slow"], [1, "fast"]]));
	});

	it("rejects unknown agents with the existing available-agent message", async () => {
		const run = createParallelRunner({ registry: memoryRegistry(), config: memoryConfigStore(), runSingle: vi.fn() });
		await expect(run({ cwd: "/root", tasks: [{ agent: "missing", task: "x" }] }))
			.rejects.toThrow("Unknown agent: missing. Available agents: worker");
	});
});
