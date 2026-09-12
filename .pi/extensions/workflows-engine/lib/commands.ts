import * as fs from "node:fs/promises";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { runGit } from "../../_shared/git.ts";
import { discoverWorkflows, entrySource, type RegistryEntry } from "./registry.ts";
import {
	isWorkflowRunNotFound,
	RunAlreadyActiveError,
	workflowRunKey,
	workflowRunModule,
	type WorkflowRunHandle,
	type WorkflowRunDetail,
	type WorkflowRunEventView,
	type WorkflowRunSummary,
} from "./workflow-run.ts";
import { prepareExistingWorkflowRun, prepareNewWorkflowRun, prepareStateEntry, type PreparedWorkflowRun } from "./runner.ts";
import { formatRunDetail, formatRunList, formatWorkflowList } from "./ui.ts";

const CUSTOM_TYPE = "workflow-result";

export interface WorkflowCommandService {
	prepareNew(ctx: ExtensionContext, entry: RegistryEntry, args: string): Promise<PreparedWorkflowRun | undefined>;
	prepareExisting(ctx: ExtensionContext, entry: RegistryEntry, detail: WorkflowRunDetail): Promise<PreparedWorkflowRun>;
	inspect(cwd: string, runId: string): Promise<WorkflowRunDetail>;
	list(cwd: string): Promise<readonly WorkflowRunSummary[]>;
	readEvents(cwd: string, runId: string): Promise<readonly WorkflowRunEventView[]>;
}

export const productionWorkflowCommandService: WorkflowCommandService = {
	prepareNew: prepareNewWorkflowRun,
	prepareExisting: prepareExistingWorkflowRun,
	inspect: workflowRunModule.inspect,
	list: workflowRunModule.list,
	readEvents: workflowRunModule.readEvents,
};

interface ActiveRun {
	handle: WorkflowRunHandle;
	entry: RegistryEntry;
	ctx: ExtensionContext;
	background: boolean;
	promise?: Promise<void>;
}

const activeRuns = new Map<string, ActiveRun>();

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

export async function runAndReport(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	prepared: PreparedWorkflowRun | undefined,
	background = false,
	restartKey?: string,
): Promise<void> {
	if (!prepared) return;
	const key = workflowRunKey(ctx.cwd, prepared.handle.runId);
	if (activeRuns.has(key)) {
		ctx.ui.notify(`Workflow ${prepared.entry.name} (${prepared.handle.runId}) is already running in this session.`, "warning");
		return;
	}
	const active: ActiveRun = { handle: prepared.handle, entry: prepared.entry, ctx, background };
	activeRuns.set(key, active);
	ctx.ui.notify(`${background ? "Started background" : "Started"} workflow ${prepared.entry.name} (${prepared.handle.runId})`, "info");

	const execute = async (): Promise<void> => {
		try {
			const result = restartKey === undefined ? await prepared.handle.execute() : await prepared.handle.restart(restartKey);
			const text = typeof result === "string" ? result : JSON.stringify(result, null, 2) ?? "undefined";
			pi.sendMessage({ customType: CUSTOM_TYPE, content: text, display: true, details: { workflow: prepared.entry.name, runId: prepared.handle.runId, background } });
			ctx.ui.notify(`Workflow completed: ${prepared.entry.name}`, "info");
		} catch (error: unknown) {
			if (error instanceof RunAlreadyActiveError || (Boolean(error) && typeof error === "object" && (error as { code?: unknown }).code === "WORKFLOW_RUN_ALREADY_ACTIVE")) {
				ctx.ui.notify(`Workflow ${prepared.entry.name} (${prepared.handle.runId}) is already running in this session.`, "warning");
			} else {
				let status: WorkflowRunDetail["status"] | undefined;
				try { status = (await prepared.handle.inspect()).status; } catch {}
				if (status === "paused") ctx.ui.notify(`Workflow paused: ${prepared.entry.name}`, "warning");
				else if (status === "stopped") ctx.ui.notify(`Workflow stopped: ${prepared.entry.name}`, "warning");
				else ctx.ui.notify(`Workflow failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		} finally {
			if (activeRuns.get(key)?.handle === prepared.handle) activeRuns.delete(key);
		}
	};

	active.promise = execute();
	if (!background) await active.promise;
}

async function handleRestart(service: WorkflowCommandService, pi: ExtensionAPI, ctx: ExtensionContext, runId: string, key: string): Promise<void> {
	if (!key) { ctx.ui.notify("Usage: /workflow restart <run-id> <durable-key>", "warning"); return; }
	const detail = await service.inspect(ctx.cwd, runId);
	const entry = await findEntryForDetail(ctx.cwd, detail);
	const prepared = await service.prepareExisting(ctx, entry, detail);
	await runAndReport(pi, ctx, prepared, false, key);
}

async function handleStop(ctx: ExtensionContext, runId: string): Promise<void> {
	const key = workflowRunKey(ctx.cwd, runId);
	const active = activeRuns.get(key);
	if (!active) {
		ctx.ui.notify(`No active in-process workflow found for ${runId}. Resume/replay remains available for persisted runs.`, "warning");
		return;
	}
	active.handle.requestStop("Workflow stopped by user");
	ctx.ui.notify(`Stop signal sent to workflow ${runId}`, "warning");
}

async function handlePause(ctx: ExtensionContext, runId: string, mode: "after-current" | "now"): Promise<void> {
	const key = workflowRunKey(ctx.cwd, runId);
	const active = activeRuns.get(key);
	if (!active) {
		ctx.ui.notify(`No active in-process workflow found for ${runId}.`, "warning");
		return;
	}
	try {
		await active.handle.requestPause(mode);
		ctx.ui.notify(`Pause requested for ${runId} (${mode})`, "warning");
	} catch (error: unknown) {
		ctx.ui.notify(`Unable to request pause for ${runId}: ${error instanceof Error ? error.message : String(error)}`, "error");
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

async function handleCleanupWorktrees(service: WorkflowCommandService, ctx: ExtensionContext, runId: string): Promise<void> {
	if (!runId) { ctx.ui.notify("Usage: /workflow cleanup-worktrees <run-id>", "warning"); return; }
	const detail = await service.inspect(ctx.cwd, runId);
	const cleaned: string[] = [];
	const skipped: string[] = [];
	for (const [key, agent] of Object.entries(detail.agents)) {
		const info = agent.worktree;
		if (!info?.path) continue;
		try {
			const status = await runGit(info.path, ["status", "--porcelain"], { signal: ctx.signal });
			if (status.stdout.trim()) { skipped.push(`${key} (dirty worktree preserved)`); continue; }
			await runGit(ctx.cwd, ["worktree", "remove", info.path], { signal: ctx.signal });
			cleaned.push(key);
		} catch (error: unknown) {
			skipped.push(`${key} (${error instanceof Error ? error.message : String(error)})`);
		}
	}
	ctx.ui.notify(`Workflow worktree cleanup\nCleaned: ${cleaned.join(", ") || "none"}\nSkipped: ${skipped.join(", ") || "none"}`, skipped.length ? "warning" : "info");
}

async function runNamed(service: WorkflowCommandService, pi: ExtensionAPI, ctx: ExtensionContext, name: string, args: string, background = false): Promise<void> {
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
	await runAndReport(pi, ctx, prepared, background);
}

export function registerWorkflowCommands(pi: ExtensionAPI, service: WorkflowCommandService = productionWorkflowCommandService): void {
	pi.on?.("session_shutdown" as any, async (_event: unknown, ctx: ExtensionContext) => {
		const pending: Promise<void>[] = [];
		for (const [key, active] of activeRuns) {
			active.handle.requestStop("Pi session shut down");
			try { ctx.ui.notify(`Stopped background workflow on shutdown: ${active.handle.runId}`, "warning"); } catch {}
			if (active.promise) pending.push(active.promise);
			else activeRuns.delete(key);
		}
		await Promise.allSettled(pending);
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
					else await runNamed(service, pi, ctx, picked.name, "");
					return;
				}
				if (trimmed === "list") { ctx.ui.notify(formatWorkflowList(await discoverWorkflows(ctx.cwd)), "info"); return; }
				if (trimmed.startsWith("resume ")) {
					const detail = await service.inspect(ctx.cwd, trimmed.slice("resume ".length).trim());
					const entry = await findEntryForDetail(ctx.cwd, detail);
					await runAndReport(pi, ctx, await service.prepareExisting(ctx, entry, detail));
					return;
				}
				if (trimmed.startsWith("restart ")) {
					const [, runId, key] = trimmed.match(/^restart\s+(\S+)\s+(\S+)$/) || [];
					await handleRestart(service, pi, ctx, runId, key);
					return;
				}
				if (trimmed.startsWith("stop ") || trimmed.startsWith("cancel ")) { await handleStop(ctx, trimmed.replace(/^(stop|cancel)\s+/, "").trim()); return; }
				if (trimmed.startsWith("pause-now ")) { await handlePause(ctx, trimmed.slice("pause-now ".length).trim(), "now"); return; }
				if (trimmed.startsWith("pause ")) { await handlePause(ctx, trimmed.slice("pause ".length).trim(), "after-current"); return; }
				if (trimmed.startsWith("source ")) { await handleSource(service, ctx, trimmed.slice("source ".length).trim()); return; }
				if (trimmed.startsWith("background ")) {
					const [name, ...rest] = trimmed.slice("background ".length).trim().split(/\s+/);
					await runNamed(service, pi, ctx, name, rest.join(" "), true);
					return;
				}
				if (trimmed.startsWith("integrate ")) {
					const [, runId, key] = trimmed.match(/^integrate\s+(\S+)\s+(\S+)$/) || [];
					await handleIntegrate(service, ctx, runId, key);
					return;
				}
				if (trimmed.startsWith("cleanup-worktrees ")) {
					await handleCleanupWorktrees(service, ctx, trimmed.slice("cleanup-worktrees ".length).trim());
					return;
				}
				const [name, ...rest] = trimmed.split(/\s+/);
				await runNamed(service, pi, ctx, name, rest.join(" "));
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