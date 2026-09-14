import type { PreparedWorkflowRun } from "./runner.ts";
import {
	RunAlreadyActiveError,
	workflowRunKey,
	type WorkflowPauseMode,
} from "./workflow-run.ts";

export type WorkflowRunOperation =
	| { readonly type: "execute" }
	| { readonly type: "restart"; readonly durableKey: string };

export type WorkflowRunSettlement =
	| { readonly status: "completed"; readonly result: unknown }
	| { readonly status: "already-active" }
	| { readonly status: "paused" }
	| { readonly status: "stopped" }
	| { readonly status: "failed"; readonly error: unknown };

export type WorkflowRunStartResult =
	| { readonly status: "already-active" }
	| {
		readonly status: "started";
		readonly completion: Promise<WorkflowRunSettlement>;
	};

export interface WorkflowRunShutdownResult {
	readonly runIds: readonly string[];
	readonly completion: Promise<void>;
}

export interface WorkflowRunControl {
	start(request: {
		readonly cwd: string;
		readonly prepared: PreparedWorkflowRun;
		readonly operation: WorkflowRunOperation;
	}): WorkflowRunStartResult;
	pause(request: {
		readonly cwd: string;
		readonly runId: string;
		readonly mode: WorkflowPauseMode;
	}): Promise<void> | undefined;
	stop(request: {
		readonly cwd: string;
		readonly runId: string;
		readonly reason?: string;
	}): boolean;
	shutdown(reason?: string): WorkflowRunShutdownResult;
}

interface ActiveRun {
	readonly handle: PreparedWorkflowRun["handle"];
	readonly completion: Promise<WorkflowRunSettlement>;
}

function isAlreadyActive(error: unknown): boolean {
	return error instanceof RunAlreadyActiveError
		|| (Boolean(error) && typeof error === "object" && (error as { code?: unknown }).code === "WORKFLOW_RUN_ALREADY_ACTIVE");
}

async function classifyFailure(handle: PreparedWorkflowRun["handle"], error: unknown): Promise<WorkflowRunSettlement> {
	if (isAlreadyActive(error)) return { status: "already-active" };
	try {
		const status = (await handle.inspect()).status;
		if (status === "paused") return { status: "paused" };
		if (status === "stopped") return { status: "stopped" };
	} catch {}
	return { status: "failed", error };
}

export function createWorkflowRunControl(): WorkflowRunControl {
	const activeRuns = new Map<string, ActiveRun>();

	return {
		start(request): WorkflowRunStartResult {
			const { cwd, prepared, operation } = request;
			const key = workflowRunKey(cwd, prepared.handle.runId);
			if (activeRuns.has(key)) return { status: "already-active" };

			const completion = Promise.resolve()
				.then(() => operation.type === "execute"
					? prepared.handle.execute()
					: prepared.handle.restart(operation.durableKey))
				.then<WorkflowRunSettlement, WorkflowRunSettlement>(
					(result) => ({ status: "completed", result }),
					(error: unknown) => classifyFailure(prepared.handle, error),
				)
				.finally(() => {
					activeRuns.delete(key);
				});
			activeRuns.set(key, { handle: prepared.handle, completion });
			return { status: "started", completion };
		},

		pause(request): Promise<void> | undefined {
			const active = activeRuns.get(workflowRunKey(request.cwd, request.runId));
			if (!active) return undefined;
			try {
				return Promise.resolve(active.handle.requestPause(request.mode));
			} catch (error) {
				return Promise.reject(error);
			}
		},

		stop(request): boolean {
			const active = activeRuns.get(workflowRunKey(request.cwd, request.runId));
			if (!active) return false;
			active.handle.requestStop(request.reason);
			return true;
		},

		shutdown(reason?: string): WorkflowRunShutdownResult {
			const snapshot = [...activeRuns.values()];
			for (const active of snapshot) active.handle.requestStop(reason);
			return {
				runIds: snapshot.map((active) => active.handle.runId),
				completion: Promise.allSettled(snapshot.map((active) => active.completion)).then(() => undefined),
			};
		},
	};
}

export const productionWorkflowRunControl: WorkflowRunControl = createWorkflowRunControl();
