import type { AgentResult, SubagentProgressEvent } from "../../_shared/subagent-service.ts";
import type { RegistryEntry, WorkflowTrust } from "./registry.ts";
import {
	initialState,
	type RunAgentState,
	type RunParallelState,
	type RunState,
	type RunStepState,
	type RunUsage,
} from "./workflow-run-state.ts";
import type { WorktreeInfo } from "./worktree-artifacts.ts";

/** Parsed durable JSONL data. Unknown event names and fields remain valid. */
export interface WorkflowRunEventView {
	ts?: number;
	type: string;
	[key: string]: unknown;
}

interface WorkflowRunEventPayloads {
	run_created: {
		runId: string;
		workflowName: string;
		trust: WorkflowTrust;
		args: string;
		sourceHash: string;
		sourceSnapshotPath?: string;
		description: string;
		costShape: RegistryEntry["cost"];
		canEditFiles?: boolean;
	};
	run_started: Record<never, never>;
	run_pausing: { mode: "after-current" | "now" };
	run_paused: { error?: string };
	run_resumed: Record<never, never>;
	run_completed: { result: unknown };
	run_failed: { error: string };
	run_stopped: { error: string };
	phase_started: { name: string };
	phase_completed: { name: string };
	phase_failed: { name: string; error: string };
	step_started: { key: string; dependsOn?: string[]; metadata?: Record<string, unknown> };
	step_completed: { key: string; result: unknown };
	step_failed: { key: string; error: string };
	step_reused: { key: string };
	agent_started: {
		key: string;
		agent: string;
		prompt: string;
		dependsOn?: string[];
		metadata?: Record<string, unknown>;
		worktree?: WorktreeInfo;
	};
	agent_progress: { key: string; event: SubagentProgressEvent };
	agent_tool: {
		key: string;
		event: Extract<SubagentProgressEvent, { type: "tool_call" }>;
		tool: string;
		args?: string;
	};
	agent_completed: {
		key: string;
		agent: string;
		result: unknown;
		raw: AgentResult;
		usage: AgentResult["usage"];
	};
	agent_failed: { key: string; agent: string; error: string; stopped: boolean };
	agent_reused: { key: string; agent: string };
	parallel_started: { key: string; count: number; concurrency: number };
	parallel_completed: { key: string; count: number };
	parallel_failed: { key: string; error: string };
	artifact_written: { path: string };
	log: { message: string; details?: Record<string, unknown> };
	invalidated: { key: string; root: string };
	dependency_invalidated: { key: string; root: string };
}

/** Closed vocabulary for events emitted by the current Workflow lifecycle. */
export type KnownWorkflowRunEvent = {
	[K in keyof WorkflowRunEventPayloads]:
		{ type: K; ts?: number } & WorkflowRunEventPayloads[K]
}[keyof WorkflowRunEventPayloads];

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

/** Apply one durable event. Unknown event types retain forward-compatible behavior. */
export function applyWorkflowRunEvent(state: RunState | undefined, event: WorkflowRunEventView): RunState {
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

export function rebuildWorkflowRunState(events: readonly WorkflowRunEventView[]): RunState {
	let state: RunState | undefined;
	for (const event of events) state = applyWorkflowRunEvent(state, event);
	if (!state) throw new Error("Workflow event log is empty");
	return state;
}
