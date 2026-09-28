import { describe, expect, it, vi } from "vitest";
import * as config from "./config.ts";
import { deriveSubagentSessionId } from "./cache-affinity.ts";
import { createSubagentExecution } from "./subagent-execution.ts";
import { agent, agentResult, memoryConfigStore, memoryRegistry } from "./test-harness.ts";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}

describe("Subagent execution", () => {
	it("defers standalone configuration resolution until batch execution", () => {
		const getDefaultSubagentConfig = vi.spyOn(config, "getDefaultSubagentConfig");

		createSubagentExecution();

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
		const execution = createSubagentExecution({
			registry,
			config: memoryConfigStore({ maxConcurrency: 1 }),
			childExecution: { execute },
		});

		const promise = execution.runBatch([
			{ agent: "slow", task: "first", cwd: "/one", model: "openai/one", thinkingLevel: "high" },
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

	it("keeps completed snapshot events immutable after publication", async () => {
		const snapshots: any[] = [];
		const childResult = agentResult({
			output: "original",
			progress: { ...agentResult().progress, lastMessage: "original progress" },
		});
		const execution = createSubagentExecution({
			registry: memoryRegistry(),
			config: memoryConfigStore(),
			childExecution: {
				execute: async (request) => {
					await request.onProgress?.(
						{ type: "completed", agent: "worker", result: childResult },
						childResult.progress,
					);
					return childResult;
				},
			},
		});

		const [result] = await execution.runBatch(
			[{ agent: "worker", task: "inspect" }],
			{ cwd: "/root", onSnapshot: (snapshot) => snapshots.push(snapshot) },
		);
		const completed = snapshots.find((snapshot) => snapshot.phase === "completed");
		result.output = "mutated";
		result.progress.lastMessage = "mutated progress";

		expect(completed.results[0].output).toBe("original");
		expect(completed.results[0].progress.lastMessage).toBe("original progress");
		expect(completed.event.result.output).toBe("original");
		expect(completed.event.result.progress.lastMessage).toBe("original progress");
	});

	it("validates the whole batch before starting a child", async () => {
		const execute = vi.fn();
		const execution = createSubagentExecution({
			registry: memoryRegistry(),
			config: memoryConfigStore(),
			childExecution: { execute },
		});

		await expect(execution.runBatch([
			{ agent: "worker", task: "valid" },
			{ agent: "missing", task: "invalid" },
		], { cwd: "/root" })).rejects.toThrow("Unknown subagent: missing. Available: worker");
		expect(execute).not.toHaveBeenCalled();
	});

	it("resolves the whole batch before starting a child", async () => {
		const configStore = memoryConfigStore();
		vi.spyOn(configStore, "resolveLaunchBatch")
			.mockImplementation(() => { throw new Error("bad launch"); });
		const execute = vi.fn();
		const execution = createSubagentExecution({
			registry: memoryRegistry(),
			config: configStore,
			childExecution: { execute },
		});

		await expect(execution.runBatch([
			{ agent: "worker", task: "one" },
			{ agent: "worker", task: "two" },
		], { cwd: "/root" })).rejects.toThrow("bad launch");
		expect(execute).not.toHaveBeenCalled();
	});

	it("uses assignments without loading invalid configured concurrency when overridden", async () => {
		const configStore = memoryConfigStore({ maxConcurrency: 0, defaultModel: "openai/assignment" });
		const load = vi.spyOn(configStore, "load");
		const resolveLaunchBatch = vi.spyOn(configStore, "resolveLaunchBatch");
		const execute = vi.fn(async (request: any) => agentResult({ agent: request.agent.name, task: request.task }));
		const execution = createSubagentExecution({
			registry: memoryRegistry(),
			config: configStore,
			childExecution: { execute },
		});

		const [result] = await execution.runBatch(
			[{ agent: "worker", task: "inspect" }],
			{ cwd: "/root", maxConcurrency: 2 },
		);

		expect(result.agent).toBe("worker");
		expect(execute).toHaveBeenCalledWith(expect.objectContaining({
			launch: { model: "openai/assignment", thinkingLevel: undefined, contextWindow: undefined },
		}));
		expect(load).not.toHaveBeenCalled();
		expect(resolveLaunchBatch).toHaveBeenCalledTimes(1);
		expect(resolveLaunchBatch.mock.calls[0]?.[1]).toBeUndefined();
	});

	it("uses configured concurrency when the caller does not override it", async () => {
		const release = deferred<void>();
		let active = 0;
		let peak = 0;
		const execution = createSubagentExecution({
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
		const promise = execution.runBatch([
			{ agent: "worker", task: "one" },
			{ agent: "worker", task: "two" },
			{ agent: "worker", task: "three" },
		], { cwd: "/root" });

		await vi.waitFor(() => expect(peak).toBe(2));
		release.resolve();
		await promise;
		expect(peak).toBe(2);
	});

	it("uses one loaded config snapshot for concurrency and every assignment in a batch", async () => {
		const configStore = memoryConfigStore({ maxConcurrency: 1, defaultModel: "openai/old" });
		const loadConfig = configStore.load.bind(configStore);
		let changeAfterLoad = true;
		vi.spyOn(configStore, "load").mockImplementation(() => {
			const snapshot = loadConfig();
			if (changeAfterLoad) {
				configStore.document = { maxConcurrency: 3, defaultModel: "openai/new" };
				changeAfterLoad = false;
			}
			return snapshot;
		});

		const gates = { first: deferred<void>(), second: deferred<void>() };
		const active = { first: 0, second: 0 };
		const peak = { first: 0, second: 0 };
		const models: Record<"first" | "second", string[]> = { first: [], second: [] };
		let phase: "first" | "second" = "first";
		const execute = vi.fn(async (request: any) => {
			active[phase]++;
			peak[phase] = Math.max(peak[phase], active[phase]);
			models[phase].push(request.launch.model);
			await gates[phase].promise;
			active[phase]--;
			return agentResult({ agent: request.agent.name, task: request.task });
		});
		const execution = createSubagentExecution({
			registry: memoryRegistry(),
			config: configStore,
			childExecution: { execute },
		});
		const tasks = Array.from({ length: 4 }, (_, index) => ({ agent: "worker", task: `task ${index}` }));

		try {
			const first = execution.runBatch(tasks, { cwd: "/root" });
			expect(peak.first).toBe(1);
			gates.first.resolve();
			await first;
			expect(models.first).toEqual(Array(4).fill("openai/old"));

			phase = "second";
			const second = execution.runBatch(tasks, { cwd: "/root" });
			expect(peak.second).toBe(3);
			gates.second.resolve();
			await second;
			expect(models.second).toEqual(Array(4).fill("openai/new"));
		} finally {
			gates.first.resolve();
			gates.second.resolve();
		}
	});

	it("preserves empty-batch reads for omitted, null, and explicit concurrency", async () => {
		const registry = memoryRegistry();
		const loadAgents = vi.spyOn(registry, "load");
		const configStore = memoryConfigStore();
		const load = vi.spyOn(configStore, "load");
		const resolveLaunchBatch = vi.spyOn(configStore, "resolveLaunchBatch");
		const execute = vi.fn();
		const execution = createSubagentExecution({
			registry,
			config: configStore,
			childExecution: { execute },
		});

		expect(await execution.runBatch([], { cwd: "/root" })).toEqual([]);
		expect(await execution.runBatch([], { cwd: "/root", maxConcurrency: null as unknown as number })).toEqual([]);
		expect(load).toHaveBeenCalledTimes(2);

		configStore.document = { maxConcurrency: 0, defaultModel: "" };
		expect(await execution.runBatch([], { cwd: "/root", maxConcurrency: 2 })).toEqual([]);
		expect(load).toHaveBeenCalledTimes(2);
		expect(loadAgents).not.toHaveBeenCalled();
		expect(resolveLaunchBatch).not.toHaveBeenCalled();
		expect(execute).not.toHaveBeenCalled();
	});

	it("keeps config-load and Agent-validation error order", async () => {
		const calls: string[] = [];
		const registry = memoryRegistry();
		vi.spyOn(registry, "load").mockImplementation(() => {
			calls.push("registry");
			return [];
		});
		const configStore = memoryConfigStore();
		vi.spyOn(configStore, "load").mockImplementation(() => {
			calls.push("config");
			throw new Error("invalid full config");
		});
		const resolveLaunchBatch = vi.spyOn(configStore, "resolveLaunchBatch");
		const execute = vi.fn();
		const execution = createSubagentExecution({
			registry,
			config: configStore,
			childExecution: { execute },
		});

		await expect(execution.runBatch([{ agent: "missing" }], { cwd: "/root" }))
			.rejects.toThrow("invalid full config");
		expect(calls).toEqual(["config"]);

		calls.length = 0;
		await expect(execution.runBatch([{ agent: "missing" }], { cwd: "/root", maxConcurrency: 1 }))
			.rejects.toThrow("Unknown subagent: missing. Available: none");
		expect(calls).toEqual(["registry"]);
		expect(resolveLaunchBatch).not.toHaveBeenCalled();
		expect(execute).not.toHaveBeenCalled();
	});

	it("reuses loaded assignments when stored concurrency falls back to the default", async () => {
		const configStore = memoryConfigStore({ defaultModel: "openai/old" });
		const loadConfig = configStore.load.bind(configStore);
		vi.spyOn(configStore, "load").mockImplementation(() => {
			const snapshot = loadConfig();
			configStore.document = { maxConcurrency: 3, defaultModel: "openai/new" };
			return snapshot;
		});
		const execute = vi.fn(async (request: any) => agentResult({ agent: request.agent.name, task: request.task }));
		const execution = createSubagentExecution({
			registry: memoryRegistry(),
			config: configStore,
			childExecution: { execute },
		});

		await execution.runBatch([{ agent: "worker", task: "inspect" }], { cwd: "/root" });

		expect(execute).toHaveBeenCalledWith(expect.objectContaining({
			launch: { model: "openai/old", thinkingLevel: undefined, contextWindow: undefined },
		}));
	});

	it("preserves indexed progress and completion callbacks through the compatibility adapter", async () => {
		const progress: any[] = [];
		const updates: any[] = [];
		const execution = createSubagentExecution({
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

		const results = await execution.runSubagentsParallel({
			cwd: "/root",
			tasks: [{ agent: "worker", task: "first" }],
			onProgress: (index, event) => { progress.push([index, event.type]); },
			onUpdate: (index, result) => { updates.push([index, result.task]); },
		});

		expect(results[0].task).toBe("first");
		expect(progress).toEqual([[0, "message"]]);
		expect(updates).toEqual([[0, "first"]]);
	});

	it("prepares a direct request before sending it to child execution, keeping prompt-only compatibility", async () => {
		const worker = agent();
		const expectedResult = agentResult();
		const execute = vi.fn(async () => expectedResult);
		const configStore = memoryConfigStore({ defaultThinkingLevel: "minimal" });
		const load = vi.spyOn(configStore, "load");
		const resolveLaunchBatch = vi.spyOn(configStore, "resolveLaunchBatch");
		const execution = createSubagentExecution({
			registry: memoryRegistry([worker]),
			config: configStore,
			childExecution: { execute },
		});

		const result = await execution.runSubagent({
			agent: "worker",
			prompt: "legacy task",
			cwd: "/workspace",
			cacheAffinitySeed: "session",
		});

		expect(execute).toHaveBeenCalledTimes(1);
		expect(load).not.toHaveBeenCalled();
		expect(resolveLaunchBatch).toHaveBeenCalledTimes(1);
		expect(execute).toHaveBeenCalledWith(expect.objectContaining({
			agent: worker,
			task: "legacy task",
			cwd: "/workspace",
			launch: { model: "openai/test-model", thinkingLevel: "minimal" },
			cacheSessionId: "subagent-0ddf41435c428ceb02f68c37425d9861",
		}));
		expect(result).toBe(expectedResult);
	});

	it("preserves native callbacks for direct execution", async () => {
		const onProgress = vi.fn();
		const onUpdate = vi.fn();
		const event = { type: "message", agent: "worker", message: "working", tokens: 1 } as const;
		const progress = agentResult().progress;
		const execute = vi.fn(async (request: any) => {
			await request.onProgress?.(event, progress);
			request.onUpdate?.(progress);
			return agentResult();
		});
		const execution = createSubagentExecution({
			registry: memoryRegistry(),
			config: memoryConfigStore(),
			childExecution: { execute },
		});

		await execution.runSubagent({
			agent: "worker",
			task: "inspect",
			cwd: "/workspace",
			onProgress,
			onUpdate,
		});

		// The repair layer wraps `onProgress`, but the original consumer still
		// receives the event and `onUpdate` passes through unchanged.
		expect(execute).toHaveBeenCalledWith(expect.objectContaining({ onUpdate }));
		expect(onProgress).toHaveBeenCalledOnce();
		expect(onProgress).toHaveBeenCalledWith(event, progress);
		expect(onUpdate).toHaveBeenCalledOnce();
		expect(onUpdate).toHaveBeenCalledWith(progress);
	});

	it("emits one synthetic failed event when child execution rejects before a terminal event", async () => {
		const sentinel = "not-an-error";
		const onProgress = vi.fn();
		const execution = createSubagentExecution({
			registry: memoryRegistry([agent({ name: "flaky" })]),
			config: memoryConfigStore(),
			childExecution: {
				execute: async (request) => {
					await request.onProgress?.({ type: "started", agent: "flaky", task: request.task });
					throw sentinel;
				},
			},
		});

		await expect(execution.runSubagent({
			agent: "flaky",
			task: "inspect",
			cwd: "/workspace",
			onProgress,
		})).rejects.toBe(sentinel);

		expect(onProgress).toHaveBeenCalledTimes(2);
		expect(onProgress).toHaveBeenLastCalledWith({
			type: "failed",
			agent: "flaky",
			error: "not-an-error",
		});
	});

	it("does not synthesize a failure after a terminal event was observed", async () => {
		const executionError = new Error("late rejection");
		const consumerError = new Error("consumer rejected after terminal");
		const onProgress = vi.fn(async (event: any) => {
			if (event.type === "completed") throw consumerError;
		});
		const execution = createSubagentExecution({
			registry: memoryRegistry(),
			config: memoryConfigStore(),
			childExecution: {
				execute: async (request) => {
					await request.onProgress?.({ type: "completed", agent: "worker", result: agentResult() }, agentResult().progress);
					throw executionError;
				},
			},
		});

		// The consumer rejection settles child execution first and keeps its identity.
		await expect(execution.runSubagent({
			agent: "worker",
			task: "inspect",
			cwd: "/workspace",
			onProgress,
		})).rejects.toBe(consumerError);

		expect(onProgress).toHaveBeenCalledTimes(1);
	});

	it("does not synthesize a failure after a failed terminal event was observed", async () => {
		const failedResult = agentResult({ progress: { ...agentResult().progress, status: "failed", error: "boom" } });
		const executionError = new Error("late rejection");
		const onProgress = vi.fn();
		const execution = createSubagentExecution({
			registry: memoryRegistry(),
			config: memoryConfigStore(),
			childExecution: {
				execute: async (request) => {
					await request.onProgress?.({ type: "failed", agent: "worker", result: failedResult, error: "boom" }, failedResult.progress);
					throw executionError;
				},
			},
		});

		await expect(execution.runSubagent({
			agent: "worker",
			task: "inspect",
			cwd: "/workspace",
			onProgress,
		})).rejects.toBe(executionError);

		expect(onProgress).toHaveBeenCalledOnce();
	});

	it("rethrows a progress-consumer rejection by identity without a synthetic failure", async () => {
		const consumerError = new Error("store append failed");
		const onProgress = vi.fn(async () => {
			throw consumerError;
		});
		const execute = vi.fn(async (request: any) => {
			await request.onProgress?.({ type: "started", agent: "worker", task: "inspect" });
			return agentResult();
		});
		const execution = createSubagentExecution({
			registry: memoryRegistry(),
			config: memoryConfigStore(),
			childExecution: { execute },
		});

		await expect(execution.runSubagent({
			agent: "worker",
			task: "inspect",
			cwd: "/workspace",
			onProgress,
		})).rejects.toBe(consumerError);

		expect(onProgress).toHaveBeenCalledOnce();
	});

	it("keeps the original rejection when the synthetic failure consumer rejects", async () => {
		const executionError = new Error("launch exploded");
		const observationError = new Error("event store unavailable");
		const observed: any[] = [];
		const execution = createSubagentExecution({
			registry: memoryRegistry(),
			config: memoryConfigStore(),
			childExecution: {
				execute: async () => {
					throw executionError;
				},
			},
		});

		await expect(execution.runSubagent({
			agent: "worker",
			task: "inspect",
			cwd: "/workspace",
			onProgress: (event) => {
				observed.push(event);
				throw observationError;
			},
		})).rejects.toBe(executionError);

		expect(observed).toEqual([{
			type: "failed",
			agent: "worker",
			error: "launch exploded",
		}]);
	});

	it("repairs missing terminal events through parallel execution too", async () => {
		const sentinel = "parallel-child-sentinel";
		const onProgress = vi.fn(async (_index: number, event: any) => {
			if (event.type === "failed") throw new Error("synthetic consumer rejected");
		});
		const execution = createSubagentExecution({
			registry: memoryRegistry(),
			config: memoryConfigStore(),
			childExecution: {
				execute: async () => {
					throw sentinel;
				},
			},
		});

		await expect(execution.runSubagentsParallel({
			cwd: "/root",
			tasks: [{ agent: "worker", task: "inspect" }],
			onProgress,
		})).rejects.toBe(sentinel);

		const failure = onProgress.mock.calls.find(([, event]) => event.type === "failed");
		expect(failure).toBeTruthy();
		expect(failure![1]).toMatchObject({ type: "failed", agent: "worker", error: "parallel-child-sentinel" });
		expect(onProgress.mock.calls.filter(([, event]) => event.type === "failed")).toHaveLength(1);
	});
});
