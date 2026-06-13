import { execFile as execFileCb } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { discoverWorkflows, entrySource, type RegistryEntry } from "./registry.ts";
import { appendRunEvent, listRunStates, readEvents, readRunState, runPaths, type RunState } from "./run-store.ts";
import { formatRunDetail, formatRunList, formatWorkflowList } from "./ui.ts";
import { invalidateKeyAndDependents, prepareExistingWorkflowRun, prepareNewWorkflowRun, prepareStateEntry, runPreparedWorkflow, type WorkflowRunControl } from "./runner.ts";

const execFile = promisify(execFileCb);
const CUSTOM_TYPE = "workflow-result";

interface ActiveRun {
	controller: AbortController;
	control: WorkflowRunControl;
	entry: RegistryEntry;
	promise?: Promise<void>;
	background: boolean;
}

const activeRuns = new Map<string, ActiveRun>();

function withWorkflowAbort(ctx: ExtensionContext, controller: AbortController): ExtensionContext {
	if (ctx.signal?.aborted) controller.abort(ctx.signal.reason);
	else ctx.signal?.addEventListener("abort", () => controller.abort(ctx.signal?.reason), { once: true });
	return { ...ctx, signal: controller.signal } as ExtensionContext;
}

async function findEntryForState(cwd: string, state: RunState): Promise<RegistryEntry> {
	const entries = await discoverWorkflows(cwd);
	const fallback = entries.find((e) => e.name === state.workflowName && e.trust === state.trust) || entries.find((e) => e.name === state.workflowName);
	return prepareStateEntry(cwd, state, fallback);
}

async function chooseWorkflow(ctx: ExtensionContext, entries: RegistryEntry[]): Promise<RegistryEntry | undefined> {
	if (!ctx.hasUI || !entries.length) return undefined;
	const choices = entries.map((e) => `${e.name} — ${e.description} (${e.trust}, ${e.cost}, ${e.canEditFiles ? "may edit" : e.canEditFiles === false ? "read-only" : "unknown files"})`);
	const picked = await ctx.ui.select("Choose workflow", [...choices, "Cancel"]);
	if (!picked || picked === "Cancel") return undefined;
	const name = picked.split(" — ")[0];
	return entries.find((e) => e.name === name);
}

async function runAndReport(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	prepared: Awaited<ReturnType<typeof prepareNewWorkflowRun>> | Awaited<ReturnType<typeof prepareExistingWorkflowRun>>,
	background = false,
): Promise<void> {
	if (!prepared) return;
	const controller = new AbortController();
	const control: WorkflowRunControl = { background };
	const runCtx = withWorkflowAbort(ctx, controller);
	const active: ActiveRun = { controller, control, entry: prepared.entry, background };
	activeRuns.set(prepared.store.runId, active);
	ctx.ui.notify(`${background ? "Started background" : "Started"} workflow ${prepared.entry.name} (${prepared.store.runId})`, "info");

	const execute = async () => {
		try {
			const result = await runPreparedWorkflow(pi, runCtx, prepared, control);
			const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
			pi.sendMessage({ customType: CUSTOM_TYPE, content: text, display: true, details: { workflow: prepared.entry.name, runId: prepared.store.runId, background } });
			ctx.ui.notify(`Workflow completed: ${prepared.entry.name}`, "success");
		} catch (error: any) {
			if (control.pauseMode) ctx.ui.notify(`Workflow paused: ${prepared.entry.name}`, "warning");
			else if (controller.signal.aborted) ctx.ui.notify(`Workflow stopped: ${prepared.entry.name}`, "warning");
			else ctx.ui.notify(`Workflow failed: ${error?.message || String(error)}`, "error");
		} finally {
			activeRuns.delete(prepared.store.runId);
		}
	};

	if (background) {
		active.promise = execute();
		return;
	}
	await execute();
}

async function handleResume(pi: ExtensionAPI, ctx: ExtensionContext, runId: string, background = false): Promise<void> {
	const state = await readRunState(ctx.cwd, runId);
	const entry = await findEntryForState(ctx.cwd, state);
	const prepared = await prepareExistingWorkflowRun(ctx, entry, state);
	await runAndReport(pi, ctx, prepared, background);
}

async function handleRestart(pi: ExtensionAPI, ctx: ExtensionContext, runId: string, key: string): Promise<void> {
	if (!key) { ctx.ui.notify("Usage: /workflow restart <run-id> <durable-key>", "warning"); return; }
	await invalidateKeyAndDependents(ctx.cwd, runId, key);
	await handleResume(pi, ctx, runId);
}

async function handleStop(ctx: ExtensionContext, runId: string): Promise<void> {
	const active = activeRuns.get(runId);
	if (!active) {
		ctx.ui.notify(`No active in-process workflow found for ${runId}. Resume/replay remains available for persisted runs.`, "warning");
		return;
	}
	active.controller.abort(new Error("Workflow stopped by user"));
	ctx.ui.notify(`Stop signal sent to workflow ${runId}`, "warning");
}

async function handlePause(ctx: ExtensionContext, runId: string, mode: "after-current" | "now"): Promise<void> {
	const active = activeRuns.get(runId);
	if (!active) {
		ctx.ui.notify(`No active in-process workflow found for ${runId}.`, "warning");
		return;
	}
	active.control.pauseMode = mode;
	if (mode === "now") active.controller.abort(new Error("Workflow paused by user"));
	ctx.ui.notify(`Pause requested for ${runId} (${mode})`, "warning");
}

async function handleSource(ctx: ExtensionContext, target: string): Promise<void> {
	if (!target) { ctx.ui.notify("Usage: /workflow source <workflow-name|run-id>", "warning"); return; }
	try {
		const state = await readRunState(ctx.cwd, target);
		if (state.sourceSnapshotPath) ctx.ui.notify(await fs.readFile(state.sourceSnapshotPath, "utf-8"), "info");
		else ctx.ui.notify(`Run ${target} has no source snapshot.`, "warning");
		return;
	} catch {}
	const entry = (await discoverWorkflows(ctx.cwd)).find((e) => e.name === target);
	if (!entry) { ctx.ui.notify(`No workflow or run found: ${target}`, "error"); return; }
	ctx.ui.notify(entrySource(entry).slice(0, 20000), "info");
}

async function git(cwd: string, args: string[]): Promise<string> {
	const { stdout } = await execFile("git", args, { cwd, maxBuffer: 20 * 1024 * 1024 });
	return stdout;
}

function worktreeInfoFromState(state: RunState, key: string): any {
	const result = state.agents[key]?.result as any;
	return result?.worktree || result?.output?.worktree;
}

async function handleIntegrate(ctx: ExtensionContext, runId: string, key: string): Promise<void> {
	if (!runId || !key) { ctx.ui.notify("Usage: /workflow integrate <run-id> <agent-key>", "warning"); return; }
	const state = await readRunState(ctx.cwd, runId);
	const info = worktreeInfoFromState(state, key);
	if (!info?.patchPath) { ctx.ui.notify(`No diff artifact found for ${key}.`, "error"); return; }
	const patchPath = path.join(runPaths(ctx.cwd, runId).root, info.patchPath);
	const patch = await fs.readFile(patchPath, "utf-8");
	if (!patch.trim()) { ctx.ui.notify(`Diff artifact for ${key} is empty.`, "warning"); return; }
	await execFile("git", ["apply", "--check", patchPath], { cwd: ctx.cwd });
	if (ctx.hasUI) {
		const ok = await ctx.ui.confirm("Integrate workflow patch?", `Apply ${info.patchPath} from ${key} into the main checkout? This will modify files but will not commit.`);
		if (!ok) return;
	}
	await execFile("git", ["apply", patchPath], { cwd: ctx.cwd });
	ctx.ui.notify(`Applied workflow patch ${info.patchPath}. Review, test, and commit manually.`, "success");
}

async function handleCleanupWorktrees(ctx: ExtensionContext, runId: string): Promise<void> {
	if (!runId) { ctx.ui.notify("Usage: /workflow cleanup-worktrees <run-id>", "warning"); return; }
	const state = await readRunState(ctx.cwd, runId);
	const cleaned: string[] = [];
	const skipped: string[] = [];
	for (const [key, agent] of Object.entries(state.agents)) {
		const info = worktreeInfoFromState(state, key);
		if (!info?.path) continue;
		try {
			const status = await git(info.path, ["status", "--porcelain"]);
			if (status.trim()) { skipped.push(`${key} (dirty worktree preserved)`); continue; }
			await git(ctx.cwd, ["worktree", "remove", info.path]);
			cleaned.push(key);
		} catch (error: any) {
			skipped.push(`${key} (${error?.message || String(error)})`);
		}
	}
	ctx.ui.notify(`Workflow worktree cleanup\nCleaned: ${cleaned.join(", ") || "none"}\nSkipped: ${skipped.join(", ") || "none"}`, skipped.length ? "warning" : "success");
}

async function runNamed(pi: ExtensionAPI, ctx: ExtensionContext, name: string, args: string, background = false): Promise<void> {
	const entries = await discoverWorkflows(ctx.cwd);
	const entry = entries.find((e) => e.name === name);
	if (!entry) {
		ctx.ui.notify(`Unknown workflow: ${name}\n\nAvailable:\n${entries.map((e) => `- ${e.name}`).join("\n")}`, "error");
		return;
	}
	const prepared = await prepareNewWorkflowRun(ctx, entry, args);
	await runAndReport(pi, ctx, prepared, background);
}

export function registerWorkflowCommands(pi: ExtensionAPI): void {
	pi.on?.("session_shutdown" as any, async (_event: any, ctx: ExtensionContext) => {
		for (const [runId, active] of activeRuns) {
			active.controller.abort(new Error("Pi session shut down"));
			try { await appendRunEvent(ctx.cwd, runId, { type: "run_stopped", error: "Pi session shut down" }); } catch {}
			try { ctx.ui.notify(`Stopped background workflow on shutdown: ${runId}`, "warning"); } catch {}
		}
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
					else await runNamed(pi, ctx, picked.name, "");
					return;
				}
				if (trimmed === "list") { ctx.ui.notify(formatWorkflowList(await discoverWorkflows(ctx.cwd)), "info"); return; }
				if (trimmed.startsWith("resume ")) { await handleResume(pi, ctx, trimmed.slice("resume ".length).trim()); return; }
				if (trimmed.startsWith("restart ")) {
					const [, runId, key] = trimmed.match(/^restart\s+(\S+)\s+(\S+)$/) || [];
					await handleRestart(pi, ctx, runId, key);
					return;
				}
				if (trimmed.startsWith("stop ") || trimmed.startsWith("cancel ")) { await handleStop(ctx, trimmed.replace(/^(stop|cancel)\s+/, "").trim()); return; }
				if (trimmed.startsWith("pause-now ")) { await handlePause(ctx, trimmed.slice("pause-now ".length).trim(), "now"); return; }
				if (trimmed.startsWith("pause ")) { await handlePause(ctx, trimmed.slice("pause ".length).trim(), "after-current"); return; }
				if (trimmed.startsWith("source ")) { await handleSource(ctx, trimmed.slice("source ".length).trim()); return; }
				if (trimmed.startsWith("background ")) {
					const [name, ...rest] = trimmed.slice("background ".length).trim().split(/\s+/);
					await runNamed(pi, ctx, name, rest.join(" "), true);
					return;
				}
				if (trimmed.startsWith("integrate ")) {
					const [, runId, key] = trimmed.match(/^integrate\s+(\S+)\s+(\S+)$/) || [];
					await handleIntegrate(ctx, runId, key);
					return;
				}
				if (trimmed.startsWith("cleanup-worktrees ")) {
					await handleCleanupWorktrees(ctx, trimmed.slice("cleanup-worktrees ".length).trim());
					return;
				}

				const [name, ...rest] = trimmed.split(/\s+/);
				await runNamed(pi, ctx, name, rest.join(" "));
			} catch (error: any) {
				ctx.ui.notify(`Workflow command failed: ${error?.message || String(error)}`, "error");
			}
		},
	});

	pi.registerCommand("workflows", {
		description: "List workflow runs or inspect a run (/workflows raw <run-id> for JSONL)",
		handler: async (args, ctx) => {
			const trimmed = (args || "").trim();
			if (trimmed.startsWith("raw ")) {
				const runId = trimmed.slice("raw ".length).trim();
				try { ctx.ui.notify((await readEvents(runPaths(ctx.cwd, runId).events)).map((e) => JSON.stringify(e)).join("\n"), "info"); }
				catch (error: any) { ctx.ui.notify(`Run raw log not found: ${runId}\n${error?.message || String(error)}`, "error"); }
				return;
			}
			if (trimmed) {
				try { ctx.ui.notify(formatRunDetail(await readRunState(ctx.cwd, trimmed), runPaths(ctx.cwd, trimmed).events), "info"); }
				catch (error: any) { ctx.ui.notify(`Run not found: ${trimmed}\n${error?.message || String(error)}`, "error"); }
				return;
			}
			ctx.ui.notify(formatRunList(await listRunStates(ctx.cwd)), "info");
		},
	});
}
