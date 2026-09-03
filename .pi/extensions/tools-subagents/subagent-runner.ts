import type { AgentResult, RunSubagentOptions } from "../_shared/subagent-service.ts";
import { agentRegistry, type AgentRegistry } from "./agent-registry.ts";
import {
	createSubagentChildExecution,
	type SubagentChildExecution,
} from "./child-execution.ts";
import { getDefaultSubagentConfig, type SubagentConfigStore } from "./config.ts";
import { prepareSubagentLaunches } from "./launch-preparation.ts";

interface SubagentRunnerDependencies {
	registry?: AgentRegistry;
	config?: SubagentConfigStore;
	childExecution?: SubagentChildExecution;
}

export function createSubagentRunner(dependencies: SubagentRunnerDependencies = {}) {
	const registry = dependencies.registry ?? agentRegistry;
	const config = dependencies.config ?? getDefaultSubagentConfig();
	const childExecution = dependencies.childExecution ?? createSubagentChildExecution();

	return async (options: RunSubagentOptions): Promise<AgentResult> => {
		const [request] = prepareSubagentLaunches([options], { registry, config });
		return childExecution.execute(request);
	};
}

export async function runSubagent(options: RunSubagentOptions): Promise<AgentResult> {
	return createSubagentRunner()(options);
}
