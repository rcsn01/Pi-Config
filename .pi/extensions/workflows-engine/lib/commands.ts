import * as fs from "node:fs/promises";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { runGit } from "../../_shared/git.ts";
import { discoverWorkflows, entrySource, type RegistryEntry } from "./registry.ts";
import {
	isWorkflowRunNotFound,
	workflowRunModule,
	type WorkflowRunDetail,
	type WorkflowRunEventView,
	type WorkflowRunSummary,
	type WorkflowWorktreeCleanupResult,
	type WorkflowWorktreeCleanupSkip,
} from "./workflow-run.ts";
import { prepareExistingWorkflowRun, prepareNewWorkflowRun, prepareStateEntry, type PreparedWorkflowRun } from "./runner.ts";
import {
	productionWorkflowRunControl,
	type WorkflowRunControl,
	type WorkflowRunOperation,
	type WorkflowRunSettlement,
} from "./workflow-run-control.ts";
import { formatRunDetail, formatRunList, formatWorkflowList } from "./ui.ts";

const CUSTOM_TYPE = "workflow-result";

export interface WorkflowCommandService {
	prepareNew(ctx: ExtensionContext, entry: RegistryEntry, args: string): Promise<PreparedWorkflowRun | undefined>;
	prepareExisting(ctx: ExtensionContext, entry: RegistryEntry, detail: WorkflowRunDetail): Promise<PreparedWorkflowRun>;
	inspect(cwd: string, runId: string): Promise<WorkflowRunDetail>;
	list(cwd: string): Promise<readonly WorkflowRunSummary[]>;
	readEvents(cwd: string, runId: string): Promise<readonly WorkflowRunEventView[]>;
	cleanupWorktrees(cwd: string, runId: string, options?: { signal?: AbortSignal }): Promise<WorkflowWorktreeCleanupResult>;
}

export const productionWorkflowCommandService: WorkflowCommandService = {
	prepareNew: prepareNewWorkflowRun,
	prepareExisting: prepareExistingWorkflowRun,
	inspect: workflowRunModule.inspect,
	list: workflowRunModule.list,
	readEvents: workflowRunModule.readEvents,
	cleanupWorktrees: workflowRunModule.cleanupWorktrees,
};

async function findEntryForDetail(cwd: string, detail: WorkflowRunDetail): Promise<RegistryEntry> {
	const entries = await discoverWorkflows(cwd);
	const fallback = entries.find((entry) => entry.name === detail.workflowName && entry.trust === detail.trust) || entries.find((entry) => entry.name === detail.workflowName);
	return prepareStateEntry(cwd, detail, fallback);
}

async function chooseWorkflow(ctx: ExtensionContext, entries: RegistryEntry[]): Promise<RegistryEntry | undefined> {
	if (!ctx.hasUI || !entries.length) return undefined;
	const choices = entries.map((entry) => `${entry.name} — ${entry.description} (${entry.trust}, ${entry.cost}, ${entry.canEditFiles ? "may edit" : entry.canEditFiles === false ? "read-only" : "unknown files"})`);
	const picked = await ctx.ui.select("Choose workflow", [...choices, "Cancel"]);
	if (!picked || picked === "Cancel") return undefined;
	const name = picked.split(" — ")[0];
	return entries.find((entry) => entry.name === name);
}

async function promptForArgs(ctx: ExtensionContext, entry: RegistryEntry): Promise<string | undefined> {
	if (!ctx.hasUI) return "";
	const inputs = entry.workflow?.inputs;
	const inputName = inputs ? Object.keys(inputs)[0] : undefined;
	const title = inputName ? `Enter ${inputName} for ${entry.name}` : `Enter the prompt for ${entry.name}`;
	return ctx.ui.editor(title, "");
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function renderSettlement(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	prepared: PreparedWorkflowRun,
	background: boolean,
	settlement: WorkflowRunSettlement,
): Promise<void> {
	if (settlement.status === "completed") {
		try {
			const text = typeof settlement.result === "string" ? settlement.result : JSON.stringify(settlement.result, null, 2) ?? "undefined";
			pi.sendMessage({ customType: CUSTOM_TYPE, content: text, display: true, details: { workflow: prepared.entry.name, runId: prepared.handle.runId, background } });
			ctx.ui.notify(`Workflow completed: ${prepared.entry.name}`, "info");
		} catch (error: unknown) {
			ctx.ui.notify(`Workflow failed: ${errorText(error)}`, "error");
		}
		return;
	}
	if (settlement.status === "already-active") {
		ctx.ui.notify(`Workflow ${prepared.entry.name} (${prepared.handle.runId}) is already running in this session.`, "warning");
	} else if (settlement.status === "paused") {
		ctx.ui.notify(`Workflow paused: ${prepared.entry.name}`, "warning");
	} else if (settlement.status === "stopped") {
		ctx.ui.notify(`Workflow stopped: ${prepared.entry.name}`, "warning");
	} else {
		ctx.ui.notify(`Workflow failed: ${errorText(settlement.error)}`, "error");
	}
}

async function runAndReport(
	runControl: WorkflowRunControl,
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	prepared: PreparedWorkflowRun | undefined,
	background = false,
	operation: WorkflowRunOperation = { type: "execute" },
): Promise<void> {
	if (!prepared) return;
	const started = runControl.start({ cwd: ctx.cwd, prepared, operation });
	if (started.status === "already-active") {
		ctx.ui.notify(`Workflow ${prepared.entry.name} (${prepared.handle.runId}) is already running in this session.`, "warning");
		return;
	}
	ctx.ui.notify(`${background ? "Started background" : "Started"} workflow ${prepared.entry.name} (${prepared.handle.runId})`, "info");
	const rendering = started.completion.then((settlement) => renderSettlement(pi, ctx, prepared, background, settlement));
	if (background) {
		void rendering.catch(() => undefined);
		return;
	}
	await rendering;
}

async function handleRestart(service: WorkflowCommandService, runControl: WorkflowRunControl, pi: ExtensionAPI, ctx: ExtensionContext, runId: string, key: string): Promise<void> {
	if (!key) { ctx.ui.notify("Usage: /workflow restart <run-id> <durable-key>", "warning"); return; }
	const detail = await service.inspect(ctx.cwd, runId);
	const entry = await findEntryForDetail(ctx.cwd, detail);
	const prepared = await service.prepareExisting(ctx, entry, detail);
	await runAndReport(runControl, pi, ctx, prepared, false, { type: "restart", durableKey: key });
}

async function handleStop(runControl: WorkflowRunControl, ctx: ExtensionContext, runId: string): Promise<void> {
	if (!runControl.stop({ cwd: ctx.cwd, runId, reason: "Workflow stopped by user" })) {
		ctx.ui.notify(`No active in-process workflow found for ${runId}. Resume/replay remains available for persisted runs.`, "warning");
		return;
	}
	ctx.ui.notify(`Stop signal sent to workflow ${runId}`, "warning");
}

async function handlePause(runControl: WorkflowRunControl, ctx: ExtensionContext, runId: string, mode: "after-current" | "now"): Promise<void> {
	const request = runControl.pause({ cwd: ctx.cwd, runId, mode });
	if (!request) {
		ctx.ui.notify(`No active in-process workflow found for ${runId}.`, "warning");
		return;
	}
	try {
		await request;
		ctx.ui.notify(`Pause requested for ${runId} (${mode})`, "warning");
	} catch (error: unknown) {
		ctx.ui.notify(`Unable to request pause for ${runId}: ${errorText(error)}`, "error");
	}
}

async function handleSource(service: WorkflowCommandService, ctx: ExtensionContext, target: string): Promise<void> {
	if (!target) { ctx.ui.notify("Usage: /workflow source <workflow-name|run-id>", "warning"); return; }
	let detail: WorkflowRunDetail;
	try {
		detail = await service.inspect(ctx.cwd, target);
	} catch (error) {
		if (!isWorkflowRunNotFound(error)) throw error;
		const entry = (await discoverWorkflows(ctx.cwd)).find((candidate) => candidate.name === target);
		if (!entry) { ctx.ui.notify(`No workflow or run found: ${target}`, "error"); return; }
		ctx.ui.notify(entrySource(entry).slice(0, 20000), "info");
		return;
	}
	if (!detail.sourceSnapshotPath) {
		ctx.ui.notify(`Run ${target} has no source snapshot.`, "warning");
		return;
	}
	ctx.ui.notify(await fs.readFile(detail.sourceSnapshotPath, "utf-8"), "info");
}

async function handleIntegrate(service: WorkflowCommandService, ctx: ExtensionContext, runId: string, key: string): Promise<void> {
	if (!runId || !key) { ctx.ui.notify("Usage: /workflow integrate <run-id> <agent-key>", "warning"); return; }
	const detail = await service.inspect(ctx.cwd, runId);
	const info = detail.agents[key]?.worktree;
	if (!info?.patchPath) { ctx.ui.notify(`No diff artifact found for ${key}.`, "error"); return; }
	const patch = await fs.readFile(info.patchPath, "utf-8");
	if (!patch.trim()) { ctx.ui.notify(`Diff artifact for ${key} is empty.`, "warning"); return; }
	await runGit(ctx.cwd, ["apply", "--check", info.patchPath], { signal: ctx.signal });
	if (ctx.hasUI) {
		const displayPath = info.patchPathRelative || info.patchPath;
		const ok = await ctx.ui.confirm("Integrate workflow patch?", `Apply ${displayPath} from ${key} into the main checkout? This will modify files but will not commit.`);
		if (!ok) return;
	}
	await runGit(ctx.cwd, ["apply", info.patchPath], { signal: ctx.signal });
	ctx.ui.notify(`Applied workflow patch ${info.patchPathRelative || info.patchPath}. Review, test, and commit manually.`, "info");
}

function cleanupSkipText(skip: WorkflowWorktreeCleanupSkip): string {
	let reason: string;
	switch (skip.reason) {
		case "dirty": reason = "dirty worktree preserved"; break;
		case "already-absent": reason = "worktree already absent"; break;
		case "invalid-record": reason = skip.detail || "invalid recorded worktree"; break;
		case "git-failed": reason = skip.detail || "Git cleanup failed"; break;
	}
	return `${skip.key} (${reason})`;
}

async function handleCleanupWorktrees(service: WorkflowCommandService, ctx: ExtensionContext, runId: string): Promise<void> {
	if (!runId) { ctx.ui.notify("Usage: /workflow cleanup-worktrees <run-id>", "warning"); return; }
	const result = await service.cleanupWorktrees(ctx.cwd, runId, { signal: ctx.signal });
	const skipped = result.skipped.map(cleanupSkipText);
	ctx.ui.notify(`Workflow worktree cleanup\nCleaned: ${result.cleaned.join(", ") || "none"}\nSkipped: ${skipped.join(", ") || "none"}`, skipped.length ? "warning" : "info");
}

async function runNamed(service: WorkflowCommandService, runControl: WorkflowRunControl, pi: ExtensionAPI, ctx: ExtensionContext, name: string, args: string, background = false): Promise<void> {
	const entries = await discoverWorkflows(ctx.cwd);
	const entry = entries.find((candidate) => candidate.name === name);
	if (!entry) {
		ctx.ui.notify(`Unknown workflow: ${name}\n\nAvailable:\n${entries.map((candidate) => `- ${candidate.name}`).join("\n")}`, "error");
		return;
	}
	let workflowArgs = args;
	if (!workflowArgs && ctx.hasUI) {
		const prompted = await promptForArgs(ctx, entry);
		if (prompted === undefined) { ctx.ui.notify("Workflow cancelled.", "info"); return; }
		workflowArgs = prompted;
	}
	const prepared = await service.prepareNew(ctx, entry, workflowArgs);
	await runAndReport(runControl, pi, ctx, prepared, background);
}

export function registerWorkflowCommands(
	pi: ExtensionAPI,
	service: WorkflowCommandService = productionWorkflowCommandService,
	runControl: WorkflowRunControl = productionWorkflowRunControl,
): void {
	pi.on?.("session_shutdown" as any, async (_event: unknown, ctx: ExtensionContext) => {
		const shutdown = runControl.shutdown("Pi session shut down");
		for (const runId of shutdown.runIds) {
			try { ctx.ui.notify(`Stopped background workflow on shutdown: ${runId}`, "warning"); } catch {}
		}
		await shutdown.completion;
	});

	pi.registerCommand("workflow", {
		description: "Run, inspect, resume, control, and source-view durable workflows",
		getArgumentCompletions: (prefix: string) => {
			const builtins = ["fan-out-and-synthesize", "deep-verification", "deep-research", "generate-filter-tournament", "resume ", "restart ", "stop ", "pause ", "pause-now ", "source ", "background ", "integrate ", "cleanup-worktrees ", "list"];
			return builtins.filter((name) => name.startsWith(prefix)).map((value) => ({ value, label: value }));
		},
		handler: async (args, ctx) => {
			const trimmed = (args || "").trim();
			try {
				if (!trimmed) {
					const entries = await discoverWorkflows(ctx.cwd);
					const picked = await chooseWorkflow(ctx, entries);
					if (!picked) ctx.ui.notify(formatWorkflowList(entries), "info");
					else await runNamed(service, runControl, pi, ctx, picked.name, "");
					return;
				}
				if (trimmed === "list") { ctx.ui.notify(formatWorkflowList(await discoverWorkflows(ctx.cwd)), "info"); return; }
				if (trimmed.startsWith("resume ")) {
					const detail = await service.inspect(ctx.cwd, trimmed.slice("resume ".length).trim());
					const entry = await findEntryForDetail(ctx.cwd, detail);
					await runAndReport(runControl, pi, ctx, await service.prepareExisting(ctx, entry, detail));
					return;
				}
				if (trimmed.startsWith("restart ")) {
					const [, runId, key] = trimmed.match(/^restart\s+(\S+)\s+(\S+)$/) || [];
					await handleRestart(service, runControl, pi, ctx, runId, key);
					return;
				}
				if (trimmed.startsWith("stop ") || trimmed.startsWith("cancel ")) { await handleStop(runControl, ctx, trimmed.replace(/^(stop|cancel)\s+/, "").trim()); return; }
				if (trimmed.startsWith("pause-now ")) { await handlePause(runControl, ctx, trimmed.slice("pause-now ".length).trim(), "now"); return; }
				if (trimmed.startsWith("pause ")) { await handlePause(runControl, ctx, trimmed.slice("pause ".length).trim(), "after-current"); return; }
				if (trimmed.startsWith("source ")) { await handleSource(service, ctx, trimmed.slice("source ".length).trim()); return; }
				if (trimmed.startsWith("background ")) {
					const [name, ...rest] = trimmed.slice("background ".length).trim().split(/\s+/);
					await runNamed(service, runControl, pi, ctx, name, rest.join(" "), true);
					return;
				}
				if (trimmed.startsWith("integrate ")) {
					const [, runId, key] = trimmed.match(/^integrate\s+(\S+)\s+(\S+)$/) || [];
					await handleIntegrate(service, ctx, runId, key);
					return;
				}
				if (trimmed === "cleanup-worktrees" || trimmed.startsWith("cleanup-worktrees ")) {
					await handleCleanupWorktrees(service, ctx, trimmed === "cleanup-worktrees" ? "" : trimmed.slice("cleanup-worktrees ".length).trim());
					return;
				}
				const [name, ...rest] = trimmed.split(/\s+/);
				await runNamed(service, runControl, pi, ctx, name, rest.join(" "));
			} catch (error: unknown) {
				ctx.ui.notify(`Workflow command failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});

	pi.registerCommand("workflows", {
		description: "List workflow runs or inspect a run (/workflows raw <run-id> for JSONL)",
		handler: async (args, ctx) => {
			const trimmed = (args || "").trim();
			if (trimmed.startsWith("raw ")) {
				const runId = trimmed.slice("raw ".length).trim();
				try { ctx.ui.notify((await service.readEvents(ctx.cwd, runId)).map((event) => JSON.stringify(event)).join("\n"), "info"); }
				catch (error: unknown) { ctx.ui.notify(`Run raw log not found: ${runId}\n${error instanceof Error ? error.message : String(error)}`, "error"); }
				return;
			}
			if (trimmed) {
				try { ctx.ui.notify(formatRunDetail(await service.inspect(ctx.cwd, trimmed)), "info"); }
				catch (error: unknown) { ctx.ui.notify(`Run not found: ${trimmed}\n${error instanceof Error ? error.message : String(error)}`, "error"); }
				return;
			}
			ctx.ui.notify(formatRunList(await service.list(ctx.cwd)), "info");
		},
	});
}