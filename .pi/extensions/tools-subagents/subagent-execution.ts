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

export type SubagentExecutionTask = RunSubagentsParallelOptions["tasks"][number];
export type SubagentExecutionPhase = "started" | "progress" | "completed";

export interface SubagentExecutionSnapshot {
	readonly results: readonly AgentResult[];
	readonly changedIndex: number;
	readonly phase: SubagentExecutionPhase;
	readonly event?: SubagentProgressEvent;
}

export interface RunSubagentBatchOptions {
	cwd: string;
	maxConcurrency?: number;
	signal?: AbortSignal;
	timeoutMs?: number;
	maxOutputBytes?: number;
	cacheAffinitySeed?: string;
	onSnapshot?: (snapshot: SubagentExecutionSnapshot) => void;
}

export interface SubagentExecution {
	runSubagent(options: RunSubagentOptions): Promise<AgentResult>;
	runBatch(
		tasks: readonly SubagentExecutionTask[],
		options: RunSubagentBatchOptions,
	): Promise<AgentResult[]>;
	runSubagentsParallel(options: RunSubagentsParallelOptions): Promise<AgentResult[]>;
}

interface SubagentExecutionDependencies {
	registry?: AgentRegistry;
	config?: SubagentConfigStore;
	childExecution?: SubagentChildExecution;
}

interface CompatibilityCallbacks {
	onProgress?: RunSubagentsParallelOptions["onProgress"];
	onUpdate?: RunSubagentsParallelOptions["onUpdate"];
}

function pendingResult(task: SubagentExecutionTask): AgentResult {
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

function cloneProgressEvent(event: SubagentProgressEvent): SubagentProgressEvent {
	if (event.type === "completed") return { ...event, result: cloneResult(event.result) };
	if (event.type === "failed" && event.result) return { ...event, result: cloneResult(event.result) };
	return { ...event };
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

export function createSubagentExecution(
	dependencies: SubagentExecutionDependencies = {},
): SubagentExecution {
	const registry = dependencies.registry ?? agentRegistry;
	const getConfig = () => dependencies.config ?? getDefaultSubagentConfig();
	const childExecution = dependencies.childExecution ?? createSubagentChildExecution();
	const prepare = (
		requests: readonly RunSubagentOptions[],
		config = getConfig(),
	) => prepareSubagentLaunches(requests, { registry, config });

	async function runSubagent(options: RunSubagentOptions): Promise<AgentResult> {
		const [request] = prepare([options]);
		return childExecution.execute(request);
	}

	async function executeBatch(
		tasks: readonly SubagentExecutionTask[],
		options: RunSubagentBatchOptions,
		compatibility: CompatibilityCallbacks = {},
	): Promise<AgentResult[]> {
		const config = getConfig();
		const concurrency = Math.max(
			1,
			options.maxConcurrency ?? config.load().maxConcurrency ?? DEFAULT_MAX_CONCURRENCY,
		);
		const liveResults = tasks.map(pendingResult);
		const latestEvents: Array<SubagentProgressEvent | undefined> = new Array(tasks.length);
		const publish = (changedIndex: number, phase: SubagentExecutionPhase, event?: SubagentProgressEvent) => {
			options.onSnapshot?.({
				results: snapshotResults(liveResults),
				changedIndex,
				phase,
				...(event ? { event: cloneProgressEvent(event) } : {}),
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
		const preparedRequests = prepare(requests, config);

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
		runSubagent,
		runBatch: (tasks, options) => executeBatch(tasks, options),
		runSubagentsParallel: (options) => executeBatch(options.tasks, options, {
			onProgress: options.onProgress,
			onUpdate: options.onUpdate,
		}),
	};
}

const defaultSubagentExecution = createSubagentExecution();

export function runSubagent(options: RunSubagentOptions): Promise<AgentResult> {
	return defaultSubagentExecution.runSubagent(options);
}

export function runSubagentsParallel(options: RunSubagentsParallelOptions): Promise<AgentResult[]> {
	return defaultSubagentExecution.runSubagentsParallel(options);
}
