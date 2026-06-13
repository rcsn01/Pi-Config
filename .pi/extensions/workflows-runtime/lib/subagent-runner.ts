import {
	loadAgents as baseLoadAgents,
	runSubagent as baseRunSubagent,
	runSubagentsParallel as baseRunSubagentsParallel,
	type AgentConfig,
	type AgentProgress,
	type AgentResult,
} from "../../tools-subagents/index.ts";

export type { AgentConfig, AgentProgress, AgentResult };

export type WorkflowSubagentProgressEvent =
	| { type: "started"; agent: string; task: string }
	| { type: "tool_call"; agent: string; tool: string; args?: string }
	| { type: "tool_result"; agent: string; tool: string; args?: string }
	| { type: "message"; agent: string; message: string; tokens: number }
	| { type: "completed"; agent: string; result: AgentResult }
	| { type: "failed"; agent: string; result?: AgentResult; error: string };

export interface RunSubagentOptions {
	agent: string | AgentConfig;
	prompt: string;
	cwd: string;
	signal?: AbortSignal;
	model?: string;
	timeoutMs?: number;
	maxOutputBytes?: number;
	onProgress?: (event: WorkflowSubagentProgressEvent, progress?: AgentProgress) => void | Promise<void>;
}

export interface RunSubagentsParallelOptions {
	tasks: Array<{ agent: string; prompt: string; cwd?: string }>;
	cwd: string;
	maxConcurrency?: number;
	signal?: AbortSignal;
	timeoutMs?: number;
	maxOutputBytes?: number;
	onProgress?: (index: number, event: WorkflowSubagentProgressEvent, progress?: AgentProgress) => void | Promise<void>;
}

export function loadAgents(): AgentConfig[] {
	return baseLoadAgents();
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
	await options.onProgress?.({ type: "started", agent: agent.name, task: options.prompt });
	let lastTool: string | undefined;
	let lastToolArgs: string | undefined;
	let recentToolCount = 0;
	let lastMessage = "";
	try {
		const result = await baseRunSubagent({ agent, task: options.prompt, cwd: options.cwd, signal: options.signal, model: options.model, timeoutMs: options.timeoutMs, maxOutputBytes: options.maxOutputBytes, onUpdate: (progress) => {
			if (progress.currentTool && (progress.currentTool !== lastTool || progress.currentToolArgs !== lastToolArgs)) {
				lastTool = progress.currentTool;
				lastToolArgs = progress.currentToolArgs;
				void options.onProgress?.({ type: "tool_call", agent: agent.name, tool: lastTool, args: lastToolArgs }, progress);
			}
			if (progress.recentTools.length > recentToolCount) {
				for (const tool of progress.recentTools.slice(recentToolCount)) {
					void options.onProgress?.({ type: "tool_result", agent: agent.name, tool: tool.tool, args: tool.args }, progress);
				}
				recentToolCount = progress.recentTools.length;
			}
			if (progress.lastMessage && progress.lastMessage !== lastMessage) {
				lastMessage = progress.lastMessage;
				void options.onProgress?.({ type: "message", agent: agent.name, message: lastMessage, tokens: progress.tokens }, progress);
			}
		} });
		if (result.exitCode === 0 && !result.progress?.error) {
			await options.onProgress?.({ type: "completed", agent: agent.name, result }, result.progress);
		} else {
			await options.onProgress?.({ type: "failed", agent: agent.name, result, error: result.progress?.error || result.output || `Subagent ${agent.name} failed` }, result.progress);
		}
		return result;
	} catch (error: any) {
		await options.onProgress?.({ type: "failed", agent: agent.name, error: error?.message || String(error) });
		throw error;
	}
}

export async function runSubagentsParallel(options: RunSubagentsParallelOptions): Promise<AgentResult[]> {
	return baseRunSubagentsParallel({
		tasks: options.tasks.map((task) => ({ agent: task.agent, task: task.prompt, cwd: task.cwd })),
		cwd: options.cwd,
		maxConcurrency: options.maxConcurrency,
		signal: options.signal,
		timeoutMs: options.timeoutMs,
		maxOutputBytes: options.maxOutputBytes,
		onUpdate: (index, result) => {
			void options.onProgress?.(index, { type: result.exitCode === 0 ? "completed" : "failed", agent: result.agent, result, error: result.progress?.error || result.output } as any, result.progress);
		},
	});
}
