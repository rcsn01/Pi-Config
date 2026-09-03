import type {
	AgentConfig,
	AgentProgress,
	AgentResult,
	RunSubagentOptions,
} from "../_shared/subagent-service.ts";
import { agentRegistry, type AgentRegistry } from "./agent-registry.ts";
import {
	createSubagentChildExecution,
	type SpawnSubagentProcess,
	type SubagentChildExecution,
} from "./child-execution.ts";
import { getDefaultSubagentConfig, type SubagentConfigStore } from "./config.ts";
import { prepareSubagentLaunches } from "./launch-preparation.ts";

export { BUILTIN_TOOLS, CUSTOM_TOOL_EXTENSIONS, EXT_BASE } from "./child-execution.ts";
export type { SpawnSubagentProcess } from "./child-execution.ts";

export interface SubagentRunnerDependencies {
	registry?: AgentRegistry;
	config?: SubagentConfigStore;
	childExecution?: SubagentChildExecution;
	/** Compatibility seam for existing callers. Prefer childExecution for new tests. */
	spawnProcess?: SpawnSubagentProcess;
}

function normalizeOptions(
	agentOrOptions: AgentConfig | RunSubagentOptions,
	taskArg?: string,
	cwdArg?: string,
	signalArg?: AbortSignal,
	onUpdateArg?: (progress: AgentProgress) => void,
): RunSubagentOptions {
	return "cwd" in (agentOrOptions as RunSubagentOptions)
		? agentOrOptions as RunSubagentOptions
		: {
			agent: agentOrOptions as AgentConfig,
			task: taskArg,
			cwd: cwdArg || process.cwd(),
			signal: signalArg,
			onUpdate: onUpdateArg,
		};
}

export function createSubagentRunner(dependencies: SubagentRunnerDependencies = {}) {
	const registry = dependencies.registry ?? agentRegistry;
	const config = dependencies.config ?? getDefaultSubagentConfig();
	const childExecution = dependencies.childExecution ?? createSubagentChildExecution({
		spawnProcess: dependencies.spawnProcess,
	});

	return async (options: RunSubagentOptions): Promise<AgentResult> => {
		const [request] = prepareSubagentLaunches([options], { registry, config });
		return childExecution.execute(request);
	};
}

export async function runSubagent(options: RunSubagentOptions): Promise<AgentResult>;
export async function runSubagent(
	agent: AgentConfig,
	task: string,
	cwd: string,
	signal?: AbortSignal,
	onUpdate?: (progress: AgentProgress) => void,
): Promise<AgentResult>;
export async function runSubagent(
	agentOrOptions: AgentConfig | RunSubagentOptions,
	taskArg?: string,
	cwdArg?: string,
	signalArg?: AbortSignal,
	onUpdateArg?: (progress: AgentProgress) => void,
): Promise<AgentResult> {
	return createSubagentRunner()(normalizeOptions(agentOrOptions, taskArg, cwdArg, signalArg, onUpdateArg));
}
