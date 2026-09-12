import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { NormalizedWorkflowDefinition } from "./definition.ts";
import type { RegistryEntry } from "./registry.ts";
import { enrichEntryWithWorkflow, entrySource, loadWorkflowFromEntry, nowId, writeWorkflowSnapshot } from "./registry.ts";
import { approve, removeApproval } from "./approval.ts";
import { FileRunPersistence } from "./run-store.ts";
import {
	createWorkflowRun,
	workflowRunModule,
	type PreparedWorkflowRunOptions,
	type WorkflowRunDetail,
	type WorkflowRunHandle,
	type WorkflowSubagentRequest,
} from "./workflow-run.ts";
import { requireSubagentService, type AgentResult } from "../../_shared/subagent-service.ts";

export interface PreparedWorkflowRun {
	entry: RegistryEntry;
	handle: WorkflowRunHandle;
}

function cacheAffinitySeed(ctx: ExtensionContext): string {
	const manager = (ctx as ExtensionContext & { sessionManager?: { getSessionId?: () => string } }).sessionManager;
	return manager?.getSessionId?.() || "";
}

function statusCallback(ctx: ExtensionContext): (status: string | undefined) => void {
	return (status) => {
		try { ctx.ui.setStatus?.("workflow", status); } catch {}
	};
}

function productionSubagent(): (options: WorkflowSubagentRequest) => Promise<AgentResult> {
	// The explicit callback is the composition seam. The deep module never
	// reaches into the process-wide service registry itself.
	return (options) => requireSubagentService().runSubagent(options);
}

function handleOptions(
	ctx: ExtensionContext,
	entry: RegistryEntry,
	workflow: NormalizedWorkflowDefinition,
	persistence: FileRunPersistence,
	args: string,
	runId: string,
	resume: boolean,
	sourceSnapshotPath: string | undefined,
): PreparedWorkflowRunOptions {
	return {
		entry,
		workflow,
		runId,
		resume,
		args,
		sourceSnapshotPath,
		cwd: ctx.cwd,
		parentSignal: ctx.signal,
		cacheAffinitySeed: cacheAffinitySeed(ctx),
		persistence,
		runSubagent: productionSubagent(),
		setStatus: statusCallback(ctx),
	};
}

export async function prepareNewWorkflowRun(ctx: ExtensionContext, entry: RegistryEntry, args: string): Promise<PreparedWorkflowRun | undefined> {
	const approved = await approve(ctx, entry, args);
	if (!approved) return undefined;

	const runId = nowId(entry.name);
	const persistence = new FileRunPersistence(ctx.cwd, runId);
	const sourceSnapshotPath = await writeWorkflowSnapshot(persistence.paths().root, entry);
	let workflow: NormalizedWorkflowDefinition;
	try {
		workflow = await loadWorkflowFromEntry(entry, entry.trust === "project" ? sourceSnapshotPath : undefined);
	} catch (error) {
		if (entry.trust === "project") await removeApproval(ctx.cwd, entry);
		throw error;
	}
	const enriched = enrichEntryWithWorkflow(entry, workflow);
	const handle = await createWorkflowRun(handleOptions(ctx, enriched, workflow, persistence, args, runId, false, sourceSnapshotPath));
	return { entry: enriched, handle };
}

export async function prepareExistingWorkflowRun(ctx: ExtensionContext, entry: RegistryEntry, detail: WorkflowRunDetail): Promise<PreparedWorkflowRun> {
	if (!detail.sourceSnapshotPath) throw new Error(`Run ${detail.runId} cannot be replayed: missing workflow source snapshot`);
	const workflow = await loadWorkflowFromEntry(
		{ ...entry, sourceHash: detail.sourceHash, source: entrySource(entry) },
		detail.trust === "project" ? detail.sourceSnapshotPath : undefined,
	);
	const enriched = enrichEntryWithWorkflow({ ...entry, sourceHash: detail.sourceHash }, workflow);
	const persistence = new FileRunPersistence(ctx.cwd, detail.runId);
	const handle = await createWorkflowRun(handleOptions(ctx, enriched, workflow, persistence, detail.args, detail.runId, true, detail.sourceSnapshotPath));
	return { entry: enriched, handle };
}

export async function prepareStateEntry(cwd: string, detail: WorkflowRunDetail, fallback?: RegistryEntry): Promise<RegistryEntry> {
	if (detail.trust === "project") {
		if (!detail.sourceSnapshotPath) throw new Error(`Run ${detail.runId} cannot be replayed: missing source snapshot`);
		const source = await fsp.readFile(detail.sourceSnapshotPath, "utf-8").catch((error: unknown) => {
			throw new Error(`Run ${detail.runId} cannot be replayed: cannot read source snapshot ${detail.sourceSnapshotPath}: ${error instanceof Error ? error.message : String(error)}`);
		});
		return {
			name: detail.workflowName,
			description: detail.description || fallback?.description || "Project workflow snapshot",
			trust: "project",
			cost: (detail.costShape as RegistryEntry["cost"]) || fallback?.cost || "unknown",
			canEditFiles: detail.canEditFiles ?? fallback?.canEditFiles,
			extension: path.extname(detail.sourceSnapshotPath) || ".js",
			source,
			sourceHash: detail.sourceHash,
		};
	}
	if (!fallback) throw new Error(`Bundled workflow definition not found for ${detail.workflowName}`);
	return fallback;
}

export const productionWorkflowRunModule = workflowRunModule;