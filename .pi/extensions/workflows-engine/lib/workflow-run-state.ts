import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { RegistryEntry, WorkflowTrust } from "./registry.ts";

export type RunStatus = "created" | "running" | "pausing" | "paused" | "completed" | "failed" | "stopped";

export interface RunUsage {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	turns: number;
	cost: number;
}

export interface RunPhaseState {
	status: "running" | "completed" | "failed";
	error?: string;
	updatedAt: number;
}

export interface RunStepState {
	status: "running" | "completed" | "failed" | "stopped" | "reused" | "invalidated";
	result?: unknown;
	error?: string;
	updatedAt: number;
	dependsOn?: string[];
	metadata?: Record<string, unknown>;
}

export interface RunAgentState {
	status: "running" | "completed" | "failed" | "stopped" | "reused" | "invalidated";
	agent: string;
	prompt?: string;
	result?: unknown;
	raw?: unknown;
	error?: string;
	updatedAt: number;
	dependsOn?: string[];
	metadata?: Record<string, unknown>;
	progress?: unknown[];
	worktree?: unknown;
}

export interface RunParallelState {
	status: "running" | "completed" | "failed";
	count?: number;
	concurrency?: number;
	error?: string;
	updatedAt: number;
}

/** The private materialized state used by the run facade. */
export interface RunState {
	runId: string;
	workflowName: string;
	trust: WorkflowTrust;
	args: string;
	status: RunStatus;
	currentPhase?: string;
	startedAt: number;
	updatedAt: number;
	completedAt?: number;
	error?: string;
	result?: unknown;
	sourceHash: string;
	sourceSnapshotPath?: string;
	description?: string;
	costShape?: string;
	canEditFiles?: boolean;
	agentsStarted: number;
	agentsCompleted: number;
	agentsFailed: number;
	agentsRunning: number;
	tokens: number;
	cost: number;
	usage: RunUsage;
	phases: Record<string, RunPhaseState>;
	steps: Record<string, RunStepState>;
	agents: Record<string, RunAgentState>;
	parallel: Record<string, RunParallelState>;
	artifacts: string[];
	dependencies: Record<string, string[]>;
	logs: Array<{ message: string; details?: Record<string, unknown>; ts: number }>;
	invalidatedKeys: string[];
}

/** Parsed JSONL data. This is not an append API. */
export interface WorkflowRunEventView {
	ts?: number;
	type: string;
	[key: string]: unknown;
}

export type WorkflowRunEventToPersist = WorkflowRunEventView;

export interface WorkflowRunSummary {
	runId: string;
	workflowName: string;
	status: RunStatus;
	currentPhase?: string;
	error?: string;
	startedAt: number;
	completedAt?: number;
	agentsStarted: number;
	agentsCompleted: number;
	agentsFailed: number;
	tokens: number;
	cost: number;
}

export interface WorkflowPhaseView {
	status: RunPhaseState["status"];
	error?: string;
	updatedAt: number;
}

export interface WorkflowStepView {
	status: RunStepState["status"];
	error?: string;
	updatedAt: number;
}

export interface WorkflowParallelView {
	status: RunParallelState["status"];
	count?: number;
	concurrency?: number;
	error?: string;
	updatedAt: number;
}

export interface WorkflowWorktreeView {
	path: string;
	branch: string;
	branchId: string;
	preserve?: boolean;
	fileOwnership?: string[];
	changedFiles: string[];
	status: string;
	/** Absolute, containment-checked artifact path for integration. */
	patchPath?: string;
	/** Run-root-relative path suitable for display. */
	patchPathRelative?: string;
}

export interface WorkflowAgentView {
	status: RunAgentState["status"];
	name: string;
	error?: string;
	worktree?: WorkflowWorktreeView;
}

export interface WorkflowRunDetail {
	runId: string;
	workflowName: string;
	trust: WorkflowTrust;
	args: string;
	description?: string;
	costShape?: string;
	canEditFiles?: boolean;
	sourceHash: string;
	sourceSnapshotPath?: string;
	eventLogPath: string;
	status: RunStatus;
	currentPhase?: string;
	startedAt: number;
	updatedAt: number;
	completedAt?: number;
	error?: string;
	result?: unknown;
	agentsStarted: number;
	agentsCompleted: number;
	agentsFailed: number;
	tokens: number;
	cost: number;
	usage: RunUsage;
	phases: Record<string, WorkflowPhaseView>;
	steps: Record<string, WorkflowStepView>;
	agents: Record<string, WorkflowAgentView>;
	parallel: Record<string, WorkflowParallelView>;
	artifacts: string[];
}

export interface RunReadPaths {
	root: string;
	events: string;
	sourceSnapshotPath?: string;
	managedWorktreeRoot?: string;
}

const RUN_STATUSES = new Set<RunStatus>(["created", "running", "pausing", "paused", "completed", "failed", "stopped"]);
const STEP_STATUSES = new Set<RunStepState["status"]>(["running", "completed", "failed", "stopped", "reused", "invalidated"]);
const AGENT_STATUSES = new Set<RunAgentState["status"]>(["running", "completed", "failed", "stopped", "reused", "invalidated"]);
const PHASE_STATUSES = new Set<RunPhaseState["status"]>(["running", "completed", "failed"]);
const PARALLEL_STATUSES = new Set<RunParallelState["status"]>(["running", "completed", "failed"]);

export function cloneJson<T>(value: T): T {
	if (value === undefined || value === null || typeof value !== "object") return value;
	return JSON.parse(JSON.stringify(value)) as T;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid workflow projection: ${label} must be an object`);
	return value as Record<string, unknown>;
}

function asNumber(value: unknown, label: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Invalid workflow projection: ${label} must be a number`);
	return value;
}

function asString(value: unknown, label: string): string {
	if (typeof value !== "string") throw new Error(`Invalid workflow projection: ${label} must be a string`);
	return value;
}

function validateUsage(value: unknown): RunUsage {
	const usage = asRecord(value, "usage");
	return {
		inputTokens: asNumber(usage.inputTokens, "usage.inputTokens"),
		outputTokens: asNumber(usage.outputTokens, "usage.outputTokens"),
		cacheReadTokens: asNumber(usage.cacheReadTokens, "usage.cacheReadTokens"),
		cacheWriteTokens: asNumber(usage.cacheWriteTokens, "usage.cacheWriteTokens"),
		turns: asNumber(usage.turns, "usage.turns"),
		cost: asNumber(usage.cost, "usage.cost"),
	};
}

function validateRecordMap(value: unknown, label: string): Record<string, Record<string, unknown>> {
	const map = asRecord(value, label);
	for (const [key, item] of Object.entries(map)) asRecord(item, `${label}.${key}`);
	return map as Record<string, Record<string, unknown>>;
}

/** Validate and clone a materialized projection before it enters private state. */
export function validateProjection(value: unknown, expectedRunId?: string): RunState {
	const source = asRecord(value, "root");
	const runId = asString(source.runId, "runId");
	if (expectedRunId !== undefined && runId !== expectedRunId) throw new Error(`Workflow projection run id mismatch: expected ${expectedRunId}, got ${runId}`);
	const trust = source.trust;
	if (trust !== "bundled" && trust !== "project") throw new Error("Invalid workflow projection: trust must be bundled or project");
	const status = source.status;
	if (!RUN_STATUSES.has(status as RunStatus)) throw new Error(`Invalid workflow projection: unknown status ${String(status)}`);
	const phases = validateRecordMap(source.phases, "phases");
	for (const [key, item] of Object.entries(phases)) {
		if (!PHASE_STATUSES.has(item.status as RunPhaseState["status"])) throw new Error(`Invalid workflow projection: phases.${key}.status`);
		asNumber(item.updatedAt, `phases.${key}.updatedAt`);
	}
	const steps = validateRecordMap(source.steps, "steps");
	for (const [key, item] of Object.entries(steps)) {
		if (!STEP_STATUSES.has(item.status as RunStepState["status"])) throw new Error(`Invalid workflow projection: steps.${key}.status`);
		asNumber(item.updatedAt, `steps.${key}.updatedAt`);
	}
	const agents = validateRecordMap(source.agents, "agents");
	for (const [key, item] of Object.entries(agents)) {
		if (!AGENT_STATUSES.has(item.status as RunAgentState["status"])) throw new Error(`Invalid workflow projection: agents.${key}.status`);
		asString(item.agent, `agents.${key}.agent`);
		asNumber(item.updatedAt, `agents.${key}.updatedAt`);
	}
	const parallel = validateRecordMap(source.parallel, "parallel");
	for (const [key, item] of Object.entries(parallel)) {
		if (!PARALLEL_STATUSES.has(item.status as RunParallelState["status"])) throw new Error(`Invalid workflow projection: parallel.${key}.status`);
		asNumber(item.updatedAt, `parallel.${key}.updatedAt`);
	}
	if (!Array.isArray(source.artifacts) || !source.artifacts.every((item) => typeof item === "string")) throw new Error("Invalid workflow projection: artifacts must be string[]");
	if (!Array.isArray(source.invalidatedKeys) || !source.invalidatedKeys.every((item) => typeof item === "string")) throw new Error("Invalid workflow projection: invalidatedKeys must be string[]");
	if (!Array.isArray(source.logs)) throw new Error("Invalid workflow projection: logs must be an array");
	const dependencies = asRecord(source.dependencies, "dependencies");
	for (const [key, value] of Object.entries(dependencies)) {
		if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) throw new Error(`Invalid workflow projection: dependencies.${key}`);
	}
	const state = cloneJson(source) as unknown as RunState;
	asString(state.workflowName, "workflowName");
	asString(state.args, "args");
	asString(state.sourceHash, "sourceHash");
	asNumber(state.startedAt, "startedAt");
	asNumber(state.updatedAt, "updatedAt");
	for (const key of ["agentsStarted", "agentsCompleted", "agentsFailed", "agentsRunning", "tokens", "cost"] as const) asNumber(state[key], key);
	state.usage = validateUsage(source.usage);
	return state;
}

export function initialState(runId: string, entry: Pick<RegistryEntry, "name" | "trust" | "sourceHash" | "description" | "cost" | "canEditFiles">, args: string, sourceSnapshotPath?: string): RunState {
	const now = Date.now();
	return {
		runId,
		workflowName: entry.name,
		trust: entry.trust,
		args,
		status: "created",
		startedAt: now,
		updatedAt: now,
		sourceHash: entry.sourceHash,
		sourceSnapshotPath,
		description: entry.description,
		costShape: entry.cost,
		canEditFiles: entry.canEditFiles,
		agentsStarted: 0,
		agentsCompleted: 0,
		agentsFailed: 0,
		agentsRunning: 0,
		tokens: 0,
		cost: 0,
		usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, turns: 0, cost: 0 },
		phases: {},
		steps: {},
		agents: {},
		parallel: {},
		artifacts: [],
		dependencies: {},
		logs: [],
		invalidatedKeys: [],
	};
}

function usageFromEvent(event: WorkflowRunEventView): RunUsage {
	const usage = (event.usage || {}) as Record<string, unknown>;
	return {
		inputTokens: Number(usage.input || usage.inputTokens || 0),
		outputTokens: Number(usage.output || usage.outputTokens || 0),
		cacheReadTokens: Number(usage.cacheRead || usage.cacheReadTokens || 0),
		cacheWriteTokens: Number(usage.cacheWrite || usage.cacheWriteTokens || 0),
		turns: Number(usage.turns || 0),
		cost: Number(usage.cost || 0),
	};
}

function addUsage(state: RunState, usage: RunUsage): void {
	state.usage.inputTokens += usage.inputTokens;
	state.usage.outputTokens += usage.outputTokens;
	state.usage.cacheReadTokens += usage.cacheReadTokens;
	state.usage.cacheWriteTokens += usage.cacheWriteTokens;
	state.usage.turns += usage.turns;
	state.usage.cost += usage.cost;
	state.tokens = state.usage.inputTokens + state.usage.outputTokens;
	state.cost = state.usage.cost;
}

function dependencyEdges(state: RunState, dependsOn: unknown, key: string): void {
	for (const dep of (dependsOn as string[] | undefined) || []) {
		state.dependencies[dep] = [...new Set([...(state.dependencies[dep] || []), key])];
	}
}

/** Apply one persisted event. Unknown event types retain forward-compatible behavior. */
export function applyEvent(state: RunState | undefined, event: WorkflowRunEventView): RunState {
	const ts = Number(event.ts || Date.now());
	if (event.type === "run_created") {
		state = initialState(
			String(event.runId),
			{
				name: String(event.workflowName || event.workflow),
				trust: (event.trust as WorkflowTrust) || "project",
				description: String(event.description || ""),
				cost: (event.costShape as RegistryEntry["cost"]) || "unknown",
				canEditFiles: event.canEditFiles as boolean | undefined,
				sourceHash: String(event.sourceHash || ""),
			},
			String(event.args || ""),
			event.sourceSnapshotPath as string | undefined,
		);
		state.startedAt = ts;
	}
	if (!state) throw new Error(`Cannot apply ${event.type} before run_created`);
	state.updatedAt = ts;

	switch (event.type) {
		case "run_started":
			state.status = "running";
			state.error = undefined;
			state.completedAt = undefined;
			break;
		case "run_completed":
			state.status = "completed";
			state.completedAt = ts;
			state.result = event.result;
			break;
		case "run_pausing":
			state.status = "pausing";
			break;
		case "run_paused":
			state.status = "paused";
			state.completedAt = ts;
			state.error = event.error ? String(event.error) : undefined;
			break;
		case "run_resumed":
			state.status = "running";
			state.error = undefined;
			state.completedAt = undefined;
			break;
		case "run_failed":
			state.status = "failed";
			state.completedAt = ts;
			state.error = String(event.error || "Workflow failed");
			break;
		case "run_stopped":
			state.status = "stopped";
			state.completedAt = ts;
			state.error = String(event.error || "Workflow stopped");
			break;
		case "phase_started":
			state.currentPhase = String(event.name);
			state.phases[String(event.name)] = { status: "running", updatedAt: ts };
			break;
		case "phase_completed":
			state.phases[String(event.name)] = { status: "completed", updatedAt: ts };
			break;
		case "phase_failed":
			state.phases[String(event.name)] = { status: "failed", error: String(event.error || "Phase failed"), updatedAt: ts };
			break;
		case "step_started": {
			const key = String(event.key);
			state.steps[key] = { status: "running", updatedAt: ts, dependsOn: event.dependsOn as string[] | undefined, metadata: event.metadata as Record<string, unknown> | undefined };
			dependencyEdges(state, event.dependsOn, key);
			break;
		}
		case "step_completed": {
			const key = String(event.key);
			state.steps[key] = { status: "completed", result: event.result, updatedAt: ts };
			state.invalidatedKeys = state.invalidatedKeys.filter((item) => item !== key);
			break;
		}
		case "step_failed": {
			const key = String(event.key);
			state.steps[key] = { ...(state.steps[key] || {}), status: "failed", error: String(event.error || "Step failed"), updatedAt: ts } as RunStepState;
			break;
		}
		case "step_reused":
			if (state.steps[String(event.key)]) state.steps[String(event.key)].updatedAt = ts;
			break;
		case "agent_started": {
			const key = String(event.key);
			state.agentsStarted++;
			state.agentsRunning++;
			state.agents[key] = {
				status: "running",
				agent: String(event.agent),
				prompt: event.prompt as string | undefined,
				updatedAt: ts,
				dependsOn: event.dependsOn as string[] | undefined,
				metadata: event.metadata as Record<string, unknown> | undefined,
				worktree: event.worktree,
			};
			dependencyEdges(state, event.dependsOn, key);
			break;
		}
		case "agent_progress": {
			const key = String(event.key);
			if (state.agents[key]) {
				const progress = [...(state.agents[key].progress || []), event.event].slice(-50);
				state.agents[key] = { ...state.agents[key], progress, updatedAt: ts };
			}
			break;
		}
		case "agent_tool": {
			const key = String(event.key);
			if (state.agents[key]) {
				const progress = [...(state.agents[key].progress || []), { type: "tool", tool: event.tool, args: event.args }].slice(-50);
				state.agents[key] = { ...state.agents[key], progress, updatedAt: ts };
			}
			break;
		}
		case "agent_completed": {
			const key = String(event.key);
			state.agentsCompleted++;
			state.agentsRunning = Math.max(0, state.agentsRunning - 1);
			state.agents[key] = { ...(state.agents[key] || {}), status: "completed", agent: String(event.agent), result: event.result, raw: event.raw, updatedAt: ts } as RunAgentState;
			state.invalidatedKeys = state.invalidatedKeys.filter((item) => item !== key);
			addUsage(state, usageFromEvent(event));
			break;
		}
		case "agent_failed": {
			const key = String(event.key);
			state.agentsFailed++;
			state.agentsRunning = Math.max(0, state.agentsRunning - 1);
			state.agents[key] = { ...(state.agents[key] || {}), status: event.stopped ? "stopped" : "failed", agent: String(event.agent), error: String(event.error || "Agent failed"), updatedAt: ts } as RunAgentState;
			break;
		}
		case "agent_reused":
			if (state.agents[String(event.key)]) state.agents[String(event.key)].updatedAt = ts;
			break;
		case "parallel_started":
			state.parallel[String(event.key)] = { status: "running", count: Number(event.count || 0), concurrency: Number(event.concurrency || 0), updatedAt: ts };
			break;
		case "parallel_completed":
			state.parallel[String(event.key)] = { ...(state.parallel[String(event.key)] || {}), status: "completed", count: Number(event.count || 0), updatedAt: ts } as RunParallelState;
			break;
		case "parallel_failed":
			state.parallel[String(event.key)] = { ...(state.parallel[String(event.key)] || {}), status: "failed", error: String(event.error || "Parallel block failed"), updatedAt: ts } as RunParallelState;
			break;
		case "artifact_written":
			if (!state.artifacts.includes(String(event.path))) state.artifacts.push(String(event.path));
			break;
		case "log":
			state.logs.push({ message: String(event.message || ""), details: event.details as Record<string, unknown> | undefined, ts });
			break;
		case "invalidated":
		case "dependency_invalidated": {
			const key = String(event.key);
			if (!state.invalidatedKeys.includes(key)) state.invalidatedKeys.push(key);
			if (state.steps[key]) state.steps[key].status = "invalidated";
			if (state.agents[key]) state.agents[key].status = "invalidated";
			break;
		}
	}
	return state;
}

export function rebuildState(events: readonly WorkflowRunEventView[]): RunState {
	let state: RunState | undefined;
	for (const event of events) state = applyEvent(state, event);
	if (!state) throw new Error("Workflow event log is empty");
	return state;
}

function isWithinRoot(target: string, root: string): boolean {
	const relative = path.relative(root, target);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function resolvedForContainment(target: string): Promise<string> {
	const suffix: string[] = [];
	let current = path.resolve(target);
	while (true) {
		try {
			const resolved = await fs.realpath(current);
			return path.join(resolved, ...suffix);
		} catch (error) {
			if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
			const parent = path.dirname(current);
			if (parent === current) return path.resolve(target);
			suffix.unshift(path.basename(current));
			current = parent;
		}
	}
}

async function validateContainedPath(target: string, root: string, label: string, mustBeFile: boolean): Promise<string> {
	const resolvedRoot = await resolvedForContainment(root);
	const resolvedTarget = await resolvedForContainment(target);
	if (!isWithinRoot(resolvedTarget, resolvedRoot) || resolvedTarget === resolvedRoot) throw new Error(`Invalid workflow ${label}: path escapes its root`);
	try {
		const stat = await fs.stat(target);
		if (mustBeFile && !stat.isFile()) throw new Error(`Invalid workflow ${label}: expected a regular file`);
		if (!mustBeFile && (label === "worktree" || label === "event log") && !stat.isDirectory() && !stat.isFile()) throw new Error(`Invalid workflow ${label}: expected a regular file`);
		if (!mustBeFile && label === "worktree" && !stat.isDirectory()) throw new Error(`Invalid workflow ${label}: expected a directory`);
		if (!mustBeFile && label === "event log" && !stat.isFile()) throw new Error(`Invalid workflow ${label}: expected a regular file`);
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
		if (mustBeFile) throw new Error(`Invalid workflow ${label}: file does not exist: ${target}`);
	}
	return path.resolve(target);
}

function safeRelativeArtifact(requested: string, runRoot: string): string {
	if (!requested || typeof requested !== "string") throw new Error("Invalid workflow artifact path");
	const clean = requested.replace(/^[/\\]+/, "").replace(/\\/g, path.sep);
	const target = path.resolve(runRoot, clean);
	const relative = path.relative(runRoot, target);
	if (!relative || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) throw new Error(`Invalid workflow artifact path: ${requested}`);
	return relative.split(path.sep).join(path.sep);
}

function safeRecordedArtifactPath(requested: string, runRoot: string): string {
	const relative = safeRelativeArtifact(requested, runRoot);
	if (!isWithinRoot(path.resolve(runRoot, relative), path.resolve(runRoot, "artifacts"))) throw new Error(`Invalid workflow artifact path: ${requested}`);
	return relative;
}

async function worktreeView(
	agent: RunAgentState,
	runRoot: string,
	managedWorktreeRoot: string,
): Promise<WorkflowWorktreeView | undefined> {
	const recorded = agent.worktree && typeof agent.worktree === "object" ? agent.worktree as Record<string, unknown> : undefined;
	if (!recorded || typeof recorded.path !== "string" || typeof recorded.branch !== "string" || typeof recorded.branchId !== "string") return undefined;
	let worktreePath: string;
	try {
		worktreePath = await validateContainedPath(recorded.path, managedWorktreeRoot, "worktree", false);
	} catch {
		return undefined;
	}
	const result = agent.result && typeof agent.result === "object" ? agent.result as Record<string, unknown> : undefined;
	const summary = result?.worktree && typeof result.worktree === "object" ? result.worktree as Record<string, unknown> : undefined;
	if (!summary || typeof summary.path !== "string" || typeof summary.branchId !== "string" || summary.path !== recorded.path || summary.branchId !== recorded.branchId) return undefined;
	if (typeof summary.branch === "string" && summary.branch !== recorded.branch) return undefined;
	if (!Array.isArray(summary.changedFiles) || !summary.changedFiles.every((item) => typeof item === "string")) return undefined;
	if (typeof summary.status !== "string") return undefined;

	const view: WorkflowWorktreeView = {
		path: worktreePath,
		branch: recorded.branch,
		branchId: recorded.branchId,
		preserve: typeof recorded.preserve === "boolean" ? recorded.preserve : undefined,
		fileOwnership: Array.isArray(recorded.fileOwnership) && recorded.fileOwnership.every((item) => typeof item === "string") ? [...recorded.fileOwnership] as string[] : undefined,
		changedFiles: [...summary.changedFiles] as string[],
		status: summary.status,
	};
	if (typeof summary.patchPath === "string") {
		try {
			if (path.isAbsolute(summary.patchPath) || /^[A-Za-z]:[\\/]/.test(summary.patchPath)) return view;
			const relative = safeRelativeArtifact(summary.patchPath, runRoot);
			const artifactRoot = path.resolve(runRoot, "artifacts");
			const absolute = path.resolve(runRoot, relative);
			if (!isWithinRoot(absolute, artifactRoot)) return view;
			const validated = await validateContainedPath(absolute, path.resolve(runRoot, "artifacts"), "patch artifact", true);
			view.patchPath = validated;
			view.patchPathRelative = relative;
		} catch {
			// A bad persisted artifact is never exposed to a command.
		}
	}
	return view;
}

/** Build an immutable command read model and validate all paths that it exposes. */
export async function projectDetail(stateValue: RunState, paths: RunReadPaths): Promise<WorkflowRunDetail> {
	const state = validateProjection(stateValue, stateValue.runId);
	const sourceSnapshotPath = state.sourceSnapshotPath
		? await validateContainedPath(state.sourceSnapshotPath, paths.root, "source snapshot", true)
		: undefined;
	const eventLogPath = await validateContainedPath(paths.events, paths.root, "event log", false);
	const artifacts = state.artifacts.map((item) => safeRecordedArtifactPath(item, paths.root));
	const managedWorktreeRoot = paths.managedWorktreeRoot || path.resolve(path.dirname(path.dirname(paths.root)), ".pi", "worktrees");
	const agents: Record<string, WorkflowAgentView> = {};
	for (const [key, agent] of Object.entries(state.agents)) {
		agents[key] = {
			status: agent.status,
			name: agent.agent,
			error: agent.error,
			worktree: await worktreeView(agent, paths.root, managedWorktreeRoot),
		};
	}
	return cloneJson({
		runId: state.runId,
		workflowName: state.workflowName,
		trust: state.trust,
		args: state.args,
		description: state.description,
		costShape: state.costShape,
		canEditFiles: state.canEditFiles,
		sourceHash: state.sourceHash,
		sourceSnapshotPath,
		eventLogPath,
		status: state.status,
		currentPhase: state.currentPhase,
		startedAt: state.startedAt,
		updatedAt: state.updatedAt,
		completedAt: state.completedAt,
		error: state.error,
		result: state.result,
		agentsStarted: state.agentsStarted,
		agentsCompleted: state.agentsCompleted,
		agentsFailed: state.agentsFailed,
		tokens: state.tokens,
		cost: state.cost,
		usage: state.usage,
		phases: state.phases,
		steps: Object.fromEntries(Object.entries(state.steps).map(([key, value]) => [key, { status: value.status, error: value.error, updatedAt: value.updatedAt }])),
		agents,
		parallel: state.parallel,
		artifacts,
	});
}

export function projectSummary(stateValue: RunState): WorkflowRunSummary {
	const state = validateProjection(stateValue, stateValue.runId);
	return cloneJson({
		runId: state.runId,
		workflowName: state.workflowName,
		status: state.status,
		currentPhase: state.currentPhase,
		error: state.error,
		startedAt: state.startedAt,
		completedAt: state.completedAt,
		agentsStarted: state.agentsStarted,
		agentsCompleted: state.agentsCompleted,
		agentsFailed: state.agentsFailed,
		tokens: state.tokens,
		cost: state.cost,
	});
}