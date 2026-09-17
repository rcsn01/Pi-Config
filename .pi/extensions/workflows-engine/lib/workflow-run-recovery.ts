import type { RunPersistence } from "./run-store.ts";
import { rebuildWorkflowRunState } from "./workflow-run-events.ts";
import { cloneJson, validateProjection, type RunState } from "./workflow-run-state.ts";

type WorkflowRunRecoveryPersistence = Pick<
	RunPersistence,
	"readEventLog" | "readProjection" | "writeProjection" | "paths"
>;

export class WorkflowRunNotFoundError extends Error {
	readonly code = "WORKFLOW_RUN_NOT_FOUND";
	constructor(runId: string) {
		super(`Workflow run not found: ${runId}`);
		this.name = "WorkflowRunNotFoundError";
	}
}

export class WorkflowEventLogEmptyError extends Error {
	readonly code = "WORKFLOW_EVENT_LOG_EMPTY";
	constructor(file: string) {
		super(`Workflow event log is empty: ${file}`);
		this.name = "WorkflowEventLogEmptyError";
	}
}

export function isWorkflowRunNotFound(error: unknown): error is WorkflowRunNotFoundError {
	return error instanceof WorkflowRunNotFoundError
		|| (Boolean(error) && typeof error === "object" && (error as { code?: unknown }).code === "WORKFLOW_RUN_NOT_FOUND");
}

/**
 * Recover validated run state while the caller provides coordinator
 * serialization when required. An existing event log is authoritative.
 * Projection fallback is allowed only when the event log is missing, and
 * projection repair after event recovery is best-effort.
 */
export async function recoverWorkflowRunState(
	persistence: WorkflowRunRecoveryPersistence,
	expectedRunId: string,
): Promise<RunState> {
	const log = await persistence.readEventLog();
	if (log.exists) {
		if (!log.events.length) throw new WorkflowEventLogEmptyError(persistence.paths().events);
		const state = validateProjection(rebuildWorkflowRunState(log.events), expectedRunId);
		try { await persistence.writeProjection(cloneJson(state)); } catch {}
		return state;
	}
	const projection = await persistence.readProjection();
	if (projection === undefined) throw new WorkflowRunNotFoundError(expectedRunId);
	return validateProjection(projection, expectedRunId);
}
