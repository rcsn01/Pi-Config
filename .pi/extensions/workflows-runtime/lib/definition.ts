export type WorkflowCostShape = "quick" | "medium" | "heavy";

export interface WorkflowBudget {
	maxAgents?: number;
	maxConcurrent?: number;
	maxTokens?: number;
	estimatedCost?: WorkflowCostShape;
}

export interface WorkflowPhaseDefinition {
	name: string;
	description?: string;
}

export interface WorkflowDefinition<TArgs = string, TResult = unknown> {
	name: string;
	description: string;
	version?: string;
	inputs?: Record<string, string>;
	phases?: WorkflowPhaseDefinition[];
	budget?: WorkflowBudget;
	canEditFiles?: boolean;
	run(ctx: WorkflowContext<TArgs>): Promise<TResult> | TResult;
}

export interface WorkflowStepOptions {
	key: string;
}

export interface WorkflowAgentOptions {
	key: string;
	agent: string;
	prompt: string;
	output?: "text" | "json";
	cwd?: string;
	dependsOn?: string[];
	worktree?: boolean | Record<string, unknown>;
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
	step<T>(key: string, fn: () => Promise<T> | T): Promise<T>;
	agent<T = string>(options: WorkflowAgentOptions): Promise<T>;
	parallel<T, R>(items: T[], worker: (item: T, index: number) => Promise<R> | R, options: WorkflowParallelOptions): Promise<R[]>;
	artifact(path: string, data: unknown): Promise<string>;
	log(message: string, details?: Record<string, unknown>): Promise<void>;
	fail(message: string): never;
}

export function defineWorkflow<TArgs = string, TResult = unknown>(definition: WorkflowDefinition<TArgs, TResult>): WorkflowDefinition<TArgs, TResult> {
	if (!definition || typeof definition !== "object") throw new Error("Workflow definition must be an object");
	if (!definition.name || typeof definition.name !== "string") throw new Error("Workflow definition requires a string name");
	if (!/^[a-z][a-z0-9-]*$/.test(definition.name)) {
		throw new Error(`Workflow name must be kebab-case: ${definition.name}`);
	}
	if (!definition.description || typeof definition.description !== "string") {
		throw new Error(`Workflow ${definition.name} requires a description`);
	}
	if (typeof definition.run !== "function") throw new Error(`Workflow ${definition.name} requires a run(ctx) function`);
	if (definition.phases && !Array.isArray(definition.phases)) throw new Error(`Workflow ${definition.name} phases must be an array`);
	if (definition.budget?.maxAgents !== undefined && definition.budget.maxAgents <= 0) {
		throw new Error(`Workflow ${definition.name} budget.maxAgents must be positive`);
	}
	if (definition.budget?.maxConcurrent !== undefined && definition.budget.maxConcurrent <= 0) {
		throw new Error(`Workflow ${definition.name} budget.maxConcurrent must be positive`);
	}
	return definition;
}
