import type { AgentConfig, RunSubagentOptions } from "../_shared/subagent-service.ts";
import type { AgentRegistry } from "./agent-registry.ts";
import { deriveSubagentSessionId } from "./cache-affinity.ts";
import type { SubagentChildExecutionRequest } from "./child-execution.ts";
import type { SubagentConfigStore } from "./config.ts";

export function prepareSubagentLaunches(
	requests: readonly RunSubagentOptions[],
	dependencies: {
		registry: Pick<AgentRegistry, "load">;
		config: Pick<SubagentConfigStore, "resolveLaunch">;
	},
): readonly SubagentChildExecutionRequest[] {
	if (requests.length === 0) return [];

	const availableAgents = dependencies.registry.load();
	const agentsByName = new Map<string, AgentConfig>(
		availableAgents.map((agent) => [agent.name, agent]),
	);
	const available = availableAgents.map((agent) => agent.name).join(", ") || "none";
	const agents = requests.map((request) => {
		if (typeof request.agent !== "string") return request.agent;
		const resolved = agentsByName.get(request.agent);
		if (!resolved) {
			throw new Error(`Unknown agent: ${request.agent}. Available agents: ${available}`);
		}
		return resolved;
	});

	return requests.map((request, index) => {
		const agent = agents[index];
		const launch = dependencies.config.resolveLaunch(agent, request.model, request.thinkingLevel);
		return {
			agent,
			task: request.task ?? request.prompt ?? "",
			cwd: request.cwd,
			launch,
			...(request.cacheAffinitySeed
				? { cacheSessionId: deriveSubagentSessionId(request.cacheAffinitySeed, launch.model) }
				: {}),
			signal: request.signal,
			timeoutMs: request.timeoutMs,
			maxOutputBytes: request.maxOutputBytes,
			onUpdate: request.onUpdate,
			onProgress: request.onProgress,
		};
	});
}
