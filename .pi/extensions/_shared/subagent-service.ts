export type AgentThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface AgentConfig {
	name: string;
	description: string;
	tools: string[];
	model: string;
	systemPrompt: string;
	filePath: string;
}

export interface AgentProgress {
	agent: string;
	status: "pending" | "running" | "completed" | "failed";
	task: string;
	currentTool?: string;
	currentToolArgs?: string;
	recentTools: Array<{ tool: string; args: string }>;
	toolCount: number;
	tokens: number;
	durationMs: number;
	lastMessage: string;
	error?: string;
}

export interface AgentResult {
	agent: string;
	task: string;
	output: string;
	exitCode: number;
	progress: AgentProgress;
	model?: string;
	thinkingLevel?: AgentThinkingLevel;
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		turns: number;
	};
	truncated?: boolean;
	originalOutputBytes?: number;
}

export type SubagentProgressEvent =
	| { type: "started"; agent: string; task: string }
	| { type: "tool_call"; agent: string; tool: string; args?: string }
	| { type: "tool_result"; agent: string; tool: string; args?: string }
	| { type: "message"; agent: string; message: string; tokens: number }
	| { type: "completed"; agent: string; result: AgentResult }
	| { type: "failed"; agent: string; result?: AgentResult; error: string };

export interface RunSubagentOptions {
	agent: string | AgentConfig;
	task?: string;
	prompt?: string;
	cwd: string;
	signal?: AbortSignal;
	timeoutMs?: number;
	maxOutputBytes?: number;
	model?: string;
	thinkingLevel?: AgentThinkingLevel;
	onUpdate?: (progress: AgentProgress) => void;
	onProgress?: (event: SubagentProgressEvent, progress?: AgentProgress) => void | Promise<void>;
}

export interface RunSubagentsParallelOptions {
	tasks: Array<{ agent: string; task?: string; prompt?: string; cwd?: string; model?: string; thinkingLevel?: AgentThinkingLevel }>;
	cwd: string;
	maxConcurrency?: number;
	signal?: AbortSignal;
	timeoutMs?: number;
	maxOutputBytes?: number;
	onUpdate?: (index: number, result: AgentResult) => void;
	onProgress?: (index: number, event: SubagentProgressEvent, progress?: AgentProgress) => void | Promise<void>;
}

export interface SubagentService {
	id: string;
	registerAgent(config: AgentConfig): void;
	unregisterAgent(name: string): void;
	loadAgents(): AgentConfig[];
	runSubagent(options: RunSubagentOptions): Promise<AgentResult>;
	runSubagentsParallel(options: RunSubagentsParallelOptions): Promise<AgentResult[]>;
}

const SERVICE_KEY = Symbol.for("pi-config.subagent-service.v1");

interface ServiceRegistry {
	service?: SubagentService;
}

const registry = getRegistry();

export function registerSubagentService(service: SubagentService): () => void {
	if (!/^[a-z0-9][a-z0-9-]*$/.test(service.id)) {
		throw new Error(`Invalid subagent service id: ${service.id}`);
	}
	if (registry.service && registry.service.id !== service.id) {
		throw new Error(`Subagent service "${registry.service.id}" is already registered.`);
	}
	registry.service = service;
	return () => {
		if (registry.service === service) registry.service = undefined;
	};
}

export function getSubagentService(): SubagentService | undefined {
	return registry.service;
}

export function requireSubagentService(): SubagentService {
	const service = getSubagentService();
	if (!service) {
		throw new Error("Subagent service is unavailable. Enable and reload the tools-subagents extension.");
	}
	return service;
}

export function clearSubagentService(): void {
	registry.service = undefined;
}

function getRegistry(): ServiceRegistry {
	const globalRegistry = globalThis as typeof globalThis & { [SERVICE_KEY]?: ServiceRegistry };
	return globalRegistry[SERVICE_KEY] ??= {};
}