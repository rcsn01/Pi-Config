import {
	requireSubagentService,
	type AgentConfig,
	type AgentProgress,
	type AgentResult,
	type AgentThinkingLevel,
	type SubagentProgressEvent,
} from "../../_shared/subagent-service.ts";

export type { AgentConfig, AgentProgress, AgentResult, AgentThinkingLevel };

export type WorkflowSubagentProgressEvent = SubagentProgressEvent;

export interface RunSubagentOptions {
	agent: string | AgentConfig;
	prompt: string;
	cwd: string;
	signal?: AbortSignal;
	model?: string;
	thinkingLevel?: AgentThinkingLevel;
	timeoutMs?: number;
	maxOutputBytes?: number;
	cacheAffinitySeed?: string;
	onProgress?: (event: WorkflowSubagentProgressEvent, progress?: AgentProgress) => void | Promise<void>;
}

export interface RunSubagentsParallelOptions {
	tasks: Array<{ agent: string; prompt: string; cwd?: string; model?: string; thinkingLevel?: AgentThinkingLevel }>;
	cwd: string;
	maxConcurrency?: number;
	signal?: AbortSignal;
	timeoutMs?: number;
	maxOutputBytes?: number;
	cacheAffinitySeed?: string;
	onProgress?: (index: number, event: WorkflowSubagentProgressEvent, progress?: AgentProgress) => void | Promise<void>;
}

export function loadAgents(): AgentConfig[] {
	return requireSubagentService().loadAgents();
}

function resolveAgent(agent: string | AgentConfig): AgentConfig {
	if (typeof agent !== "string") return agent;
	const agents = loadAgents();
	const found = agents.find((a) => a.name === agent);
	if (!found) throw new Error(`Unknown subagent '${agent}'. Available: ${agents.map((a) => a.name).join(", ") || "none"}`);
	return found;
}

export async function runSubagent(options: RunSubagentOptions): Promise<AgentResult> {
	const agent = resolveAgent(options.agent);
	let terminalObserved = false;
	let progressConsumerRejected = false;
	try {
		return await requireSubagentService().runSubagent({
			agent,
			task: options.prompt,
			cwd: options.cwd,
			signal: options.signal,
			model: options.model,
			thinkingLevel: options.thinkingLevel,
			timeoutMs: options.timeoutMs,
			maxOutputBytes: options.maxOutputBytes,
			cacheAffinitySeed: options.cacheAffinitySeed,
			onProgress: async (event, progress) => {
				if (event.type === "completed" || event.type === "failed") terminalObserved = true;
				try {
					await options.onProgress?.(event, progress);
				} catch (error) {
					progressConsumerRejected = true;
					throw error;
				}
			},
		});
	} catch (error) {
		if (terminalObserved || progressConsumerRejected) throw error;
		await options.onProgress?.({
			type: "failed",
			agent: agent.name,
			error: error instanceof Error ? error.message : String(error),
		});
		throw error;
	}
}

export async function runSubagentsParallel(options: RunSubagentsParallelOptions): Promise<AgentResult[]> {
	return requireSubagentService().runSubagentsParallel({
		tasks: options.tasks.map((task) => ({ agent: task.agent, task: task.prompt, cwd: task.cwd, model: task.model, thinkingLevel: task.thinkingLevel })),
		cwd: options.cwd,
		maxConcurrency: options.maxConcurrency,
		signal: options.signal,
		timeoutMs: options.timeoutMs,
		maxOutputBytes: options.maxOutputBytes,
		cacheAffinitySeed: options.cacheAffinitySeed,
		onProgress: async (index, event, progress) => {
			await options.onProgress?.(index, event, progress);
		},
	});
}
