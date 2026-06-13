import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { RegistryEntry, WorkflowTrust } from "./registry.ts";
import { ensureDir, RUNS_DIR } from "./registry.ts";

export type RunStatus = "created" | "running" | "pausing" | "paused" | "completed" | "failed" | "stopped";

export interface RunUsage {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	turns: number;
	cost: number;
}

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
	phases: Record<string, { status: "running" | "completed" | "failed"; error?: string; updatedAt: number }>;
	steps: Record<string, { status: "running" | "completed" | "failed" | "stopped" | "reused" | "invalidated"; result?: unknown; error?: string; updatedAt: number; dependsOn?: string[]; metadata?: Record<string, unknown> }>;
	agents: Record<string, { status: "running" | "completed" | "failed" | "stopped" | "reused" | "invalidated"; agent: string; prompt?: string; result?: unknown; raw?: unknown; error?: string; updatedAt: number; dependsOn?: string[]; metadata?: Record<string, unknown>; progress?: unknown[]; worktree?: unknown }>;
	parallel: Record<string, { status: "running" | "completed" | "failed"; count?: number; concurrency?: number; error?: string; updatedAt: number }>;
	artifacts: string[];
	dependencies: Record<string, string[]>;
	logs: Array<{ message: string; details?: Record<string, unknown>; ts: number }>;
	invalidatedKeys: string[];
}

export interface RunPaths {
	root: string;
	events: string;
	state: string;
	input: string;
	artifacts: string;
}

export interface RunEvent {
	ts?: number;
	type: string;
	[key: string]: unknown;
}

export class AsyncQueue {
	private tail = Promise.resolve();

	run<T>(fn: () => Promise<T>): Promise<T> {
		const next = this.tail.then(fn, fn);
		this.tail = next.then(() => undefined, () => undefined);
		return next;
	}
}

export function runPaths(cwd: string, runId: string): RunPaths {
	const root = path.join(cwd, RUNS_DIR, runId);
	return {
		root,
		events: path.join(root, "events.jsonl"),
		state: path.join(root, "state.json"),
		input: path.join(root, "input.json"),
		artifacts: path.join(root, "artifacts"),
	};
}

export function initialState(runId: string, entry: RegistryEntry, args: string, sourceSnapshotPath?: string): RunState {
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

export async function writeJson(file: string, data: unknown): Promise<void> {
	await ensureDir(path.dirname(file));
	const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
	await fsp.writeFile(tmp, JSON.stringify(data, null, 2), "utf-8");
	await fsp.rename(tmp, file);
}

async function appendJsonl(file: string, event: RunEvent): Promise<void> {
	await ensureDir(path.dirname(file));
	await fsp.appendFile(file, JSON.stringify({ ts: Date.now(), ...event }) + "\n", "utf-8");
}

function usageFromEvent(event: RunEvent): RunUsage {
	const usage = (event.usage || {}) as any;
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

export function applyEvent(state: RunState | undefined, event: RunEvent): RunState {
	const ts = Number(event.ts || Date.now());
	if (event.type === "run_created") {
		state = initialState(
			String(event.runId),
			{
				name: String(event.workflowName || event.workflow),
				trust: (event.trust as WorkflowTrust) || "project",
				description: String(event.description || ""),
				cost: (event.costShape as any) || "unknown",
				canEditFiles: event.canEditFiles as boolean | undefined,
				source: "",
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
			for (const dep of (event.dependsOn as string[] | undefined) || []) {
				state.dependencies[dep] = [...new Set([...(state.dependencies[dep] || []), key])];
			}
			break;
		}
		case "step_completed": {
			const key = String(event.key);
			state.steps[key] = { status: "completed", result: event.result, updatedAt: ts };
			state.invalidatedKeys = state.invalidatedKeys.filter((k) => k !== key);
			break;
		}
		case "step_failed":
			state.steps[String(event.key)] = { ...(state.steps[String(event.key)] || {}), status: "failed", error: String(event.error || "Step failed"), updatedAt: ts } as any;
			break;
		case "step_reused":
			if (state.steps[String(event.key)]) state.steps[String(event.key)].updatedAt = ts;
			break;
		case "agent_started": {
			const key = String(event.key);
			state.agentsStarted++;
			state.agentsRunning++;
			state.agents[key] = { status: "running", agent: String(event.agent), prompt: event.prompt as string | undefined, updatedAt: ts, dependsOn: event.dependsOn as string[] | undefined, metadata: event.metadata as Record<string, unknown> | undefined, worktree: event.worktree };
			for (const dep of (event.dependsOn as string[] | undefined) || []) {
				state.dependencies[dep] = [...new Set([...(state.dependencies[dep] || []), key])];
			}
			break;
		}
		case "agent_progress": {
			const key = String(event.key);
			if (state.agents[key]) {
				const progress = [...((state.agents[key].progress as unknown[]) || []), event.event].slice(-50);
				state.agents[key] = { ...state.agents[key], progress, updatedAt: ts };
			}
			break;
		}
		case "agent_tool": {
			const key = String(event.key);
			if (state.agents[key]) {
				const progress = [...((state.agents[key].progress as unknown[]) || []), { type: "tool", tool: event.tool, args: event.args }].slice(-50);
				state.agents[key] = { ...state.agents[key], progress, updatedAt: ts };
			}
			break;
		}
		case "agent_completed": {
			const key = String(event.key);
			state.agentsCompleted++;
			state.agentsRunning = Math.max(0, state.agentsRunning - 1);
			state.agents[key] = { ...(state.agents[key] || {}), status: "completed", agent: String(event.agent), result: event.result, raw: event.raw, updatedAt: ts } as any;
			state.invalidatedKeys = state.invalidatedKeys.filter((k) => k !== key);
			addUsage(state, usageFromEvent(event));
			break;
		}
		case "agent_failed":
			state.agentsFailed++;
			state.agentsRunning = Math.max(0, state.agentsRunning - 1);
			state.agents[String(event.key)] = { ...(state.agents[String(event.key)] || {}), status: event.stopped ? "stopped" : "failed", agent: String(event.agent), error: String(event.error || "Agent failed"), updatedAt: ts } as any;
			break;
		case "agent_reused":
			if (state.agents[String(event.key)]) state.agents[String(event.key)].updatedAt = ts;
			break;
		case "parallel_started":
			state.parallel[String(event.key)] = { status: "running", count: Number(event.count || 0), concurrency: Number(event.concurrency || 0), updatedAt: ts };
			break;
		case "parallel_completed":
			state.parallel[String(event.key)] = { ...(state.parallel[String(event.key)] || {}), status: "completed", count: Number(event.count || 0), updatedAt: ts } as any;
			break;
		case "parallel_failed":
			state.parallel[String(event.key)] = { ...(state.parallel[String(event.key)] || {}), status: "failed", error: String(event.error || "Parallel block failed"), updatedAt: ts } as any;
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

export async function readEvents(eventsPath: string): Promise<RunEvent[]> {
	if (!fs.existsSync(eventsPath)) return [];
	const text = await fsp.readFile(eventsPath, "utf-8");
	const events: RunEvent[] = [];
	for (const [index, line] of text.split(/\r?\n/).entries()) {
		if (!line.trim()) continue;
		try { events.push(JSON.parse(line) as RunEvent); } catch (error: any) {
			throw new Error(`Invalid workflow event JSONL at ${eventsPath}:${index + 1}: ${error?.message || String(error)}`);
		}
	}
	return events;
}

export async function rebuildStateFromEvents(eventsPath: string): Promise<RunState> {
	let state: RunState | undefined;
	for (const event of await readEvents(eventsPath)) state = applyEvent(state, event);
	if (!state) throw new Error(`Workflow event log is empty: ${eventsPath}`);
	return state;
}

export async function appendRunEvent(cwd: string, runId: string, event: RunEvent): Promise<RunState> {
	const paths = runPaths(cwd, runId);
	await appendJsonl(paths.events, event);
	const state = await rebuildStateFromEvents(paths.events);
	await writeJson(paths.state, state);
	return state;
}

export async function readRunState(cwd: string, runId: string): Promise<RunState> {
	const paths = runPaths(cwd, runId);
	if (fs.existsSync(paths.events)) {
		const state = await rebuildStateFromEvents(paths.events);
		await writeJson(paths.state, state);
		return state;
	}
	return JSON.parse(await fsp.readFile(paths.state, "utf-8")) as RunState;
}

export async function listRunStates(cwd: string): Promise<RunState[]> {
	const base = path.join(cwd, RUNS_DIR);
	if (!fs.existsSync(base)) return [];
	const states: RunState[] = [];
	for (const entry of await fsp.readdir(base)) {
		try { states.push(await readRunState(cwd, entry)); } catch {}
	}
	return states.sort((a, b) => b.updatedAt - a.updatedAt);
}

export function safeArtifactPath(base: string, requested: string): string {
	const clean = requested.replace(/^[/\\]+/, "");
	const target = path.resolve(base, clean);
	const rel = path.relative(base, target);
	if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
		throw new Error(`Artifact path escapes run directory: ${requested}`);
	}
	return target;
}

export class RunStore {
	private queue = new AsyncQueue();
	public readonly cwd: string;
	public readonly runId: string;

	constructor(cwd: string, runId: string) {
		this.cwd = cwd;
		this.runId = runId;
	}

	get paths(): RunPaths { return runPaths(this.cwd, this.runId); }

	async initialize(entry: RegistryEntry, args: string, sourceSnapshotPath: string | undefined): Promise<RunState> {
		await ensureDir(this.paths.artifacts);
		await writeJson(this.paths.input, { args, workflowName: entry.name, sourceHash: entry.sourceHash, createdAt: Date.now() });
		return this.append({
			type: "run_created",
			runId: this.runId,
			workflowName: entry.name,
			trust: entry.trust,
			args,
			sourceHash: entry.sourceHash,
			sourceSnapshotPath,
			description: entry.description,
			costShape: entry.cost,
			canEditFiles: entry.canEditFiles,
		});
	}

	async append(event: RunEvent): Promise<RunState> {
		return this.queue.run(() => appendRunEvent(this.cwd, this.runId, event));
	}

	async read(): Promise<RunState> {
		return readRunState(this.cwd, this.runId);
	}
}
