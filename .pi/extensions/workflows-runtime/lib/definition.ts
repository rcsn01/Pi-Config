export type WorkflowCostShape = "quick" | "medium" | "heavy";

export interface WorkflowBudget {
	maxAgents?: number;
	maxConcurrent?: number;
	maxTokens?: number;
	estimatedCost?: WorkflowCostShape;
}

export interface WorkflowCapabilities {
	canEditFiles?: boolean;
	tools?: string[];
	network?: boolean;
	[key: string]: unknown;
}

export interface WorkflowPhaseDefinition {
	name: string;
	description?: string;
}

export type WorkflowPhaseInput = string | WorkflowPhaseDefinition;

export interface WorkflowDefinition<TArgs = string, TResult = unknown> {
	name: string;
	description: string;
	version?: string;
	inputs?: Record<string, string>;
	phases?: WorkflowPhaseInput[];
	budget?: WorkflowBudget;
	capabilities?: WorkflowCapabilities | string[];
	canEditFiles?: boolean;
	run(ctx: WorkflowContext<TArgs>): Promise<TResult> | TResult;
}

export interface NormalizedWorkflowDefinition<TArgs = string, TResult = unknown> extends Omit<WorkflowDefinition<TArgs, TResult>, "phases" | "capabilities" | "canEditFiles"> {
	phases: WorkflowPhaseDefinition[];
	budget: WorkflowBudget;
	capabilities: WorkflowCapabilities;
	canEditFiles: boolean;
}

export interface WorkflowStepOptions {
	dependsOn?: string[];
	metadata?: Record<string, unknown>;
}

export interface WorkflowWorktreeOptions {
	branchId?: string;
	baseRef?: string;
	preserve?: boolean;
	fileOwnership?: string[];
}

export interface WorkflowAgentOptions {
	key: string;
	agent: string;
	prompt: string;
	model?: string;
	output?: "text" | "json";
	cwd?: string;
	timeoutMs?: number;
	maxOutputBytes?: number;
	metadata?: Record<string, unknown>;
	dependsOn?: string[];
	worktree?: boolean | WorkflowWorktreeOptions;
}

export interface WorkflowParallelOptions {
	key: string;
	concurrency?: number;
	stopOnError?: boolean;
}

export interface WorkflowContext<TArgs = string> {
	readonly runId: string;
	readonly args: TArgs;
	readonly cwd: string;
	readonly signal: AbortSignal;
	phase<T>(name: string, fn: () => Promise<T> | T): Promise<T>;
	step<T>(key: string, fn: () => Promise<T> | T, options?: WorkflowStepOptions): Promise<T>;
	agent<T = string>(options: WorkflowAgentOptions): Promise<T>;
	parallel<T, R>(items: T[], worker: (item: T, index: number) => Promise<R> | R, options: WorkflowParallelOptions): Promise<R[]>;
	artifact(path: string, data: unknown): Promise<string>;
	log(message: string, details?: Record<string, unknown>): Promise<void>;
	fail(message: string): never;
}

export const RESERVED_WORKFLOW_NAMES = new Set(["resume", "restart", "stop", "cancel", "list"]);

function assertPositiveNumber(workflowName: string, budget: WorkflowBudget, key: keyof Pick<WorkflowBudget, "maxAgents" | "maxConcurrent" | "maxTokens">): void {
	const value = budget[key];
	if (value === undefined) return;
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		throw new Error(`Workflow ${workflowName} budget.${key} must be a positive number`);
	}
}

function normalizePhases(workflowName: string, phases: WorkflowPhaseInput[] | undefined): WorkflowPhaseDefinition[] {
	if (phases === undefined) return [];
	if (!Array.isArray(phases)) throw new Error(`Workflow ${workflowName} phases must be an array`);
	return phases.map((phase, index) => {
		if (typeof phase === "string") {
			const name = phase.trim();
			if (!name) throw new Error(`Workflow ${workflowName} phase ${index + 1} must have a non-empty name`);
			return { name };
		}
		if (!phase || typeof phase !== "object") throw new Error(`Workflow ${workflowName} phase ${index + 1} must be a string or object`);
		if (typeof phase.name !== "string" || !phase.name.trim()) throw new Error(`Workflow ${workflowName} phase ${index + 1} must have a non-empty name`);
		if (phase.description !== undefined && typeof phase.description !== "string") throw new Error(`Workflow ${workflowName} phase ${phase.name} description must be a string`);
		return { name: phase.name.trim(), description: phase.description };
	});
}

function normalizeCapabilities(definition: WorkflowDefinition): { capabilities: WorkflowCapabilities; canEditFiles: boolean } {
	const hasCanEditFiles = typeof definition.canEditFiles === "boolean";
	const hasCapabilities = definition.capabilities !== undefined;
	if (!hasCanEditFiles && !hasCapabilities) {
		throw new Error(`Workflow ${definition.name} must explicitly declare capabilities or canEditFiles`);
	}

	if (Array.isArray(definition.capabilities)) {
		for (const capability of definition.capabilities) {
			if (typeof capability !== "string" || !capability.trim()) throw new Error(`Workflow ${definition.name} capabilities must be non-empty strings`);
		}
		const set = new Set(definition.capabilities);
		const canEditFiles = hasCanEditFiles ? !!definition.canEditFiles : set.has("edit-files") || set.has("files:write");
		return { capabilities: { tools: [...set], canEditFiles }, canEditFiles };
	}

	if (definition.capabilities !== undefined) {
		if (!definition.capabilities || typeof definition.capabilities !== "object") throw new Error(`Workflow ${definition.name} capabilities must be an object or string array`);
		const capabilities = { ...(definition.capabilities as WorkflowCapabilities) };
		if (capabilities.tools !== undefined && (!Array.isArray(capabilities.tools) || capabilities.tools.some((tool) => typeof tool !== "string" || !tool.trim()))) {
			throw new Error(`Workflow ${definition.name} capabilities.tools must be an array of strings`);
		}
		if (capabilities.canEditFiles !== undefined && typeof capabilities.canEditFiles !== "boolean") {
			throw new Error(`Workflow ${definition.name} capabilities.canEditFiles must be boolean`);
		}
		const canEditFiles = hasCanEditFiles ? !!definition.canEditFiles : !!capabilities.canEditFiles;
		return { capabilities: { ...capabilities, canEditFiles }, canEditFiles };
	}

	return { capabilities: { canEditFiles: !!definition.canEditFiles }, canEditFiles: !!definition.canEditFiles };
}

export function defineWorkflow<TArgs = string, TResult = unknown>(definition: WorkflowDefinition<TArgs, TResult>): NormalizedWorkflowDefinition<TArgs, TResult> {
	if (!definition || typeof definition !== "object") throw new Error("Workflow definition must be an object");
	if (!definition.name || typeof definition.name !== "string") throw new Error("Workflow definition requires a string name");
	if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(definition.name)) {
		throw new Error(`Workflow name must be kebab-case: ${definition.name}`);
	}
	if (RESERVED_WORKFLOW_NAMES.has(definition.name)) throw new Error(`Workflow name is reserved: ${definition.name}`);
	if (!definition.description || typeof definition.description !== "string" || !definition.description.trim()) {
		throw new Error(`Workflow ${definition.name} requires a non-empty description`);
	}
	if (typeof definition.run !== "function") throw new Error(`Workflow ${definition.name} requires a run(ctx) function`);

	const phases = normalizePhases(definition.name, definition.phases);
	const budget = { ...(definition.budget || {}) };
	assertPositiveNumber(definition.name, budget, "maxAgents");
	assertPositiveNumber(definition.name, budget, "maxConcurrent");
	assertPositiveNumber(definition.name, budget, "maxTokens");
	if (budget.estimatedCost !== undefined && !["quick", "medium", "heavy"].includes(budget.estimatedCost)) {
		throw new Error(`Workflow ${definition.name} budget.estimatedCost must be quick, medium, or heavy`);
	}
	const { capabilities, canEditFiles } = normalizeCapabilities(definition);

	return {
		...definition,
		description: definition.description.trim(),
		phases,
		budget,
		capabilities,
		canEditFiles,
	};
}
