import type {
	AgentConfig,
	AgentResult,
	RunSubagentOptions,
	RunSubagentsParallelOptions,
} from "../_shared/subagent-service.ts";
import { agentRegistry, type AgentRegistry } from "./agent-registry.ts";
import { subagentConfig, type SubagentConfigStore } from "./config.ts";
import { runSubagent } from "./subagent-runner.ts";

export const DEFAULT_MAX_CONCURRENCY = 4;

export async function runOrderedConcurrently<T, R>(
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

export interface ParallelRunnerDependencies {
	registry?: AgentRegistry;
	config?: SubagentConfigStore;
	runSingle?: (options: RunSubagentOptions) => Promise<AgentResult>;
}

export function createParallelRunner(dependencies: ParallelRunnerDependencies = {}) {
	return async (options: RunSubagentsParallelOptions): Promise<AgentResult[]> => {
		const registry = dependencies.registry ?? agentRegistry;
		const config = dependencies.config ?? subagentConfig;
		const runSingle = dependencies.runSingle ?? ((runOptions: RunSubagentOptions) => runSubagent(runOptions));
		const availableAgents = registry.load();
		const available = availableAgents.map((agent) => agent.name).join(", ") || "none";
		const concurrency = Math.max(1, options.maxConcurrency ?? config.load().maxConcurrency ?? DEFAULT_MAX_CONCURRENCY);
		return runOrderedConcurrently(options.tasks, concurrency, async (task, index) => {
			const agent = availableAgents.find((candidate) => candidate.name === task.agent);
			if (!agent) throw new Error(`Unknown agent: ${task.agent}. Available agents: ${available}`);
			const result = await runSingle({
				agent,
				task: task.task ?? task.prompt ?? "",
				cwd: task.cwd ?? options.cwd,
				signal: options.signal,
				timeoutMs: options.timeoutMs,
				maxOutputBytes: options.maxOutputBytes,
				model: task.model,
				thinkingLevel: task.thinkingLevel,
				onProgress: (event, progress) => options.onProgress?.(index, event, progress),
			});
			options.onUpdate?.(index, result);
			return result;
		});
	};
}

const defaultParallelRunner = createParallelRunner();

export async function runSubagentsParallel(options: RunSubagentsParallelOptions): Promise<AgentResult[]> {
	return defaultParallelRunner(options);
}
