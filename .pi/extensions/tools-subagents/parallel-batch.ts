import type {
	AgentResult,
	RunSubagentOptions,
	RunSubagentsParallelOptions,
	SubagentProgressEvent,
} from "../_shared/subagent-service.ts";
import { agentRegistry, type AgentRegistry } from "./agent-registry.ts";
import {
	createSubagentChildExecution,
	type SubagentChildExecution,
} from "./child-execution.ts";
import { getDefaultSubagentConfig, type SubagentConfigStore } from "./config.ts";
import { prepareSubagentLaunches } from "./launch-preparation.ts";

export const DEFAULT_MAX_CONCURRENCY = 4;

export type ParallelBatchTask = RunSubagentsParallelOptions["tasks"][number];
export type ParallelBatchPhase = "started" | "progress" | "completed";

export interface ParallelBatchSnapshot {
	readonly results: readonly AgentResult[];
	readonly changedIndex: number;
	readonly phase: ParallelBatchPhase;
	readonly event?: SubagentProgressEvent;
}

export interface RunParallelBatchOptions {
	cwd: string;
	maxConcurrency?: number;
	signal?: AbortSignal;
	timeoutMs?: number;
	maxOutputBytes?: number;
	cacheAffinitySeed?: string;
	onSnapshot?: (snapshot: ParallelBatchSnapshot) => void;
}

export interface ParallelSubagentBatch {
	runBatch(tasks: readonly ParallelBatchTask[], options: RunParallelBatchOptions): Promise<AgentResult[]>;
	runSubagentsParallel(options: RunSubagentsParallelOptions): Promise<AgentResult[]>;
}

interface ParallelBatchDependencies {
	registry?: AgentRegistry;
	config?: SubagentConfigStore;
	childExecution?: SubagentChildExecution;
}

interface CompatibilityCallbacks {
	onProgress?: RunSubagentsParallelOptions["onProgress"];
	onUpdate?: RunSubagentsParallelOptions["onUpdate"];
}

function pendingResult(task: ParallelBatchTask): AgentResult {
	const taskText = task.task ?? task.prompt ?? "";
	return {
		agent: task.agent,
		task: taskText,
		output: "",
		exitCode: -1,
		model: undefined,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
		progress: {
			agent: task.agent,
			status: "pending",
			task: taskText,
			recentTools: [],
			toolCount: 0,
			tokens: 0,
			durationMs: 0,
			lastMessage: "",
		},
	};
}

function cloneResult(result: AgentResult): AgentResult {
	return {
		...result,
		usage: { ...result.usage },
		progress: {
			...result.progress,
			recentTools: result.progress.recentTools.map((tool) => ({ ...tool })),
		},
		...(result.timing ? { timing: { ...result.timing } } : {}),
	};
}

function snapshotResults(results: readonly AgentResult[]): readonly AgentResult[] {
	return results.map(cloneResult);
}

async function runOrdered<T, R>(
	items: readonly T[],
	concurrency: number,
	run: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let nextIndex = 0;

	async function worker(): Promise<void> {
		while (nextIndex < items.length) {
			const index = nextIndex++;
			results[index] = await run(items[index], index);
		}
	}

	const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
	await Promise.all(workers);
	return results;
}

export function createParallelSubagentBatch(dependencies: ParallelBatchDependencies = {}): ParallelSubagentBatch {
	const registry = dependencies.registry ?? agentRegistry;
	const getConfig = () => dependencies.config ?? getDefaultSubagentConfig();
	const childExecution = dependencies.childExecution ?? createSubagentChildExecution();

	async function execute(
		tasks: readonly ParallelBatchTask[],
		options: RunParallelBatchOptions,
		compatibility: CompatibilityCallbacks = {},
	): Promise<AgentResult[]> {
		const config = getConfig();
		const concurrency = Math.max(
			1,
			options.maxConcurrency ?? config.load().maxConcurrency ?? DEFAULT_MAX_CONCURRENCY,
		);
		const liveResults = tasks.map(pendingResult);
		const latestEvents: Array<SubagentProgressEvent | undefined> = new Array(tasks.length);
		const publish = (changedIndex: number, phase: ParallelBatchPhase, event?: SubagentProgressEvent) => {
			options.onSnapshot?.({
				results: snapshotResults(liveResults),
				changedIndex,
				phase,
				...(event ? { event } : {}),
			});
		};
		const requests: RunSubagentOptions[] = tasks.map((task, index) => ({
			agent: task.agent,
			task: task.task,
			prompt: task.prompt,
			cwd: task.cwd ?? options.cwd,
			model: task.model,
			thinkingLevel: task.thinkingLevel,
			signal: options.signal,
			timeoutMs: options.timeoutMs,
			maxOutputBytes: options.maxOutputBytes,
			cacheAffinitySeed: options.cacheAffinitySeed,
			onUpdate: (progress) => {
				liveResults[index] = { ...liveResults[index], progress: { ...progress } };
				publish(index, "progress", latestEvents[index]);
				latestEvents[index] = undefined;
			},
			onProgress: async (event, progress) => {
				latestEvents[index] = event;
				if (progress) {
					liveResults[index] = { ...liveResults[index], progress: { ...progress } };
				}
				await compatibility.onProgress?.(index, event, progress);
			},
		}));
		const preparedRequests = prepareSubagentLaunches(requests, { registry, config });

		return runOrdered(preparedRequests, concurrency, async (request, index) => {
			liveResults[index] = {
				...liveResults[index],
				model: request.launch.model,
				thinkingLevel: request.launch.thinkingLevel,
				progress: { ...liveResults[index].progress, status: "running" },
			};
			publish(index, "started");

			const result = await childExecution.execute(request);

			liveResults[index] = result;
			publish(index, "completed", latestEvents[index]);
			latestEvents[index] = undefined;
			compatibility.onUpdate?.(index, result);
			return result;
		});
	}

	return {
		runBatch: (tasks, options) => execute(tasks, options),
		runSubagentsParallel: (options) => execute(options.tasks, options, {
			onProgress: options.onProgress,
			onUpdate: options.onUpdate,
		}),
	};
}

const defaultParallelBatch = createParallelSubagentBatch();

export function runSubagentsParallel(options: RunSubagentsParallelOptions): Promise<AgentResult[]> {
	return defaultParallelBatch.runSubagentsParallel(options);
}
