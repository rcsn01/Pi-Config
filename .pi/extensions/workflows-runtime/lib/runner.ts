import { execFile as execFileCb } from "node:child_process";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { NormalizedWorkflowDefinition, WorkflowAgentOptions, WorkflowParallelOptions } from "./definition.ts";
import type { RegistryEntry } from "./registry.ts";
import { enrichEntryWithWorkflow, entrySource, loadWorkflowFromEntry, nowId, writeWorkflowSnapshot } from "./registry.ts";
import { approve, removeApproval } from "./approval.ts";
import { RunStore, initialState, readRunState, runPaths, safeArtifactPath, type RunState } from "./run-store.ts";
import { AbortError, Semaphore, throwIfAborted } from "./scheduler.ts";
import { loadAgents, runSubagent, type AgentConfig, type AgentResult, type WorkflowSubagentProgressEvent } from "./subagent-runner.ts";

const execFile = promisify(execFileCb);
const DEFAULT_MAX_AGENTS = 20;
const DEFAULT_MAX_CONCURRENT = 4;

function parseJsonOutput(text: string): unknown {
	const trimmed = text.trim();
	try { return JSON.parse(trimmed); } catch {}
	const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
	if (fenced) {
		try { return JSON.parse(fenced[1].trim()); } catch {}
	}
	const firstObj = trimmed.indexOf("{");
	const lastObj = trimmed.lastIndexOf("}");
	if (firstObj >= 0 && lastObj > firstObj) {
		try { return JSON.parse(trimmed.slice(firstObj, lastObj + 1)); } catch {}
	}
	const firstArr = trimmed.indexOf("[");
	const lastArr = trimmed.lastIndexOf("]");
	if (firstArr >= 0 && lastArr > firstArr) {
		try { return JSON.parse(trimmed.slice(firstArr, lastArr + 1)); } catch {}
	}
	throw new Error("Agent did not return valid JSON");
}

function clone<T>(value: T): T {
	if (value === undefined) return value;
	return JSON.parse(JSON.stringify(value));
}

export interface PreparedWorkflowRun {
	entry: RegistryEntry;
	workflow: NormalizedWorkflowDefinition;
	store: RunStore;
	state: RunState;
}

export interface WorkflowRunControl {
	pauseMode?: "after-current" | "now";
	background?: boolean;
}

export async function prepareNewWorkflowRun(ctx: ExtensionContext, entry: RegistryEntry, args: string): Promise<PreparedWorkflowRun | undefined> {
	const approved = await approve({} as ExtensionAPI, ctx, entry, args);
	if (!approved) return undefined;

	const runId = nowId(entry.name);
	const store = new RunStore(ctx.cwd, runId);
	const paths = store.paths;
	const sourceSnapshotPath = await writeWorkflowSnapshot(paths.root, entry);
	let workflow: NormalizedWorkflowDefinition;
	try {
		workflow = await loadWorkflowFromEntry(entry, entry.trust === "project" ? sourceSnapshotPath : undefined);
	} catch (error) {
		if (entry.trust === "project") await removeApproval(ctx.cwd, entry);
		throw error;
	}
	const enriched = enrichEntryWithWorkflow(entry, workflow);
	const state = await store.initialize(enriched, args, sourceSnapshotPath);
	return { entry: enriched, workflow, store, state };
}

export async function prepareExistingWorkflowRun(ctx: ExtensionContext, entry: RegistryEntry, state: RunState): Promise<PreparedWorkflowRun> {
	const store = new RunStore(ctx.cwd, state.runId);
	if (!state.sourceSnapshotPath) throw new Error(`Run ${state.runId} cannot be replayed: missing workflow source snapshot`);
	const workflow = await loadWorkflowFromEntry({ ...entry, sourceHash: state.sourceHash, source: entrySource(entry) }, state.trust === "project" ? state.sourceSnapshotPath : undefined);
	const enriched = enrichEntryWithWorkflow({ ...entry, sourceHash: state.sourceHash }, workflow);
	return { entry: enriched, workflow, store, state };
}

function safeWorktreeId(value: string): string {
	const cleaned = value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
	if (!cleaned) throw new Error(`Invalid worktree branch id: ${value}`);
	return cleaned;
}

async function git(cwd: string, args: string[]): Promise<string> {
	const { stdout } = await execFile("git", args, { cwd, maxBuffer: 20 * 1024 * 1024 });
	return stdout;
}

async function pathExists(file: string): Promise<boolean> {
	try { await fsp.access(file); return true; } catch { return false; }
}

export async function prepareStateEntry(cwd: string, state: RunState, fallback?: RegistryEntry): Promise<RegistryEntry> {
	if (state.trust === "project") {
		if (!state.sourceSnapshotPath) throw new Error(`Run ${state.runId} cannot be replayed: missing source snapshot`);
		const source = await fsp.readFile(state.sourceSnapshotPath, "utf-8").catch((error: any) => {
			throw new Error(`Run ${state.runId} cannot be replayed: cannot read source snapshot ${state.sourceSnapshotPath}: ${error?.message || String(error)}`);
		});
		return {
			name: state.workflowName,
			description: state.description || fallback?.description || "Project workflow snapshot",
			trust: "project",
			cost: (state.costShape as any) || fallback?.cost || "unknown",
			canEditFiles: state.canEditFiles ?? fallback?.canEditFiles,
			extension: path.extname(state.sourceSnapshotPath) || ".js",
			source,
			sourceHash: state.sourceHash,
		};
	}
	if (!fallback) throw new Error(`Bundled workflow definition not found for ${state.workflowName}`);
	return fallback;
}

export class WorkflowRun {
	private agentConfigs: AgentConfig[];
	private scheduler: Semaphore;
	private state: RunState;
	private pi: ExtensionAPI;
	private commandCtx: ExtensionContext;
	private entry: RegistryEntry;
	private workflow: NormalizedWorkflowDefinition;
	private store: RunStore;
	private control: WorkflowRunControl;

	constructor(
		pi: ExtensionAPI,
		commandCtx: ExtensionContext,
		entry: RegistryEntry,
		workflow: NormalizedWorkflowDefinition,
		store: RunStore,
		state: RunState,
		control: WorkflowRunControl = {},
	) {
		this.pi = pi;
		this.commandCtx = commandCtx;
		this.entry = entry;
		this.workflow = workflow;
		this.store = store;
		this.control = control;
		this.agentConfigs = loadAgents();
		this.state = state;
		this.scheduler = new Semaphore(workflow.budget?.maxConcurrent || DEFAULT_MAX_CONCURRENT, commandCtx.signal);
	}

	get runId(): string { return this.state.runId; }

	async execute(): Promise<unknown> {
		this.state = await this.store.append({ type: "run_started" });
		const runtimeCtx = this.buildContext();
		try {
			throwIfAborted(this.commandCtx.signal);
			const result = await this.workflow.run(runtimeCtx as any);
			this.state = await this.store.append({ type: "run_completed", result });
			return result;
		} catch (error: any) {
			if (this.control.pauseMode) {
				if (this.state.status !== "paused") this.state = await this.store.append({ type: "run_paused", error: error?.message || "Workflow paused" });
			} else if (this.commandCtx.signal?.aborted || error instanceof AbortError || error?.name === "AbortError") {
				this.state = await this.store.append({ type: "run_stopped", error: "Workflow stopped by abort signal" });
			} else {
				this.state = await this.store.append({ type: "run_failed", error: error?.message || String(error) });
			}
			throw error;
		} finally {
			this.commandCtx.ui.setStatus?.("workflow", "");
		}
	}

	async requestPause(mode: "after-current" | "now" = "after-current"): Promise<void> {
		this.control.pauseMode = mode;
		this.state = await this.store.append({ type: "run_pausing", mode });
		if (mode === "now") throw new AbortError("Workflow paused by user");
	}

	private async waitIfPaused(): Promise<void> {
		throwIfAborted(this.commandCtx.signal);
		if (this.control.pauseMode === "now") throw new AbortError("Workflow paused by user");
		if (this.control.pauseMode === "after-current") {
			this.state = await this.store.append({ type: "run_paused" });
			throw new AbortError("Workflow paused by user");
		}
	}

	private keyInvalidated(key: string): boolean {
		return this.state.invalidatedKeys.includes(key);
	}

	private buildContext() {
		return {
			runId: this.state.runId,
			args: this.state.args,
			cwd: this.commandCtx.cwd,
			signal: this.commandCtx.signal,
			phase: async <T>(name: string, fn: () => Promise<T> | T): Promise<T> => {
				await this.waitIfPaused();
				this.state = await this.store.append({ type: "phase_started", name });
				try {
					const value = await fn();
					this.state = await this.store.append({ type: "phase_completed", name });
					return value;
				} catch (error: any) {
					this.state = await this.store.append({ type: "phase_failed", name, error: error?.message || String(error) });
					throw error;
				}
			},
			step: async <T>(key: string, fn: () => Promise<T> | T, options?: any): Promise<T> => this.step(key, fn, options),
			agent: async <T>(options: WorkflowAgentOptions): Promise<T> => this.agent(options) as Promise<T>,
			parallel: async <T, R>(items: T[], worker: (item: T, index: number) => Promise<R> | R, options: WorkflowParallelOptions): Promise<R[]> => this.parallel(items, worker, options),
			artifact: async (artifactPath: string, data: unknown): Promise<string> => this.artifact(artifactPath, data),
			log: async (message: string, details?: Record<string, unknown>): Promise<void> => {
				this.state = await this.store.append({ type: "log", message, details });
			},
			fail: (message: string): never => { throw new Error(message); },
		};
	}

	private async step<T>(key: string, fn: () => Promise<T> | T, options: { dependsOn?: string[]; metadata?: Record<string, unknown> } = {}): Promise<T> {
		this.validateKey(key);
		this.validateDependsOn(options.dependsOn);
		await this.waitIfPaused();
		const existing = this.state.steps[key];
		if (existing?.status === "completed" && !this.keyInvalidated(key)) {
			this.state = await this.store.append({ type: "step_reused", key });
			return existing.result as T;
		}
		this.state = await this.store.append({ type: "step_started", key, dependsOn: options.dependsOn, metadata: options.metadata });
		try {
			const result = await fn();
			this.state = await this.store.append({ type: "step_completed", key, result: clone(result) });
			return result;
		} catch (error: any) {
			this.state = await this.store.append({ type: "step_failed", key, error: error?.message || String(error) });
			throw error;
		}
	}

	private async agent(options: WorkflowAgentOptions): Promise<unknown> {
		this.validateKey(options.key);
		this.validateDependsOn(options.dependsOn);
		await this.waitIfPaused();
		const existing = this.state.agents[options.key];
		if (existing?.status === "completed" && !this.keyInvalidated(options.key)) {
			this.state = await this.store.append({ type: "agent_reused", key: options.key, agent: existing.agent });
			return existing.result;
		}

		const maxAgents = this.workflow.budget?.maxAgents ?? DEFAULT_MAX_AGENTS;
		if (this.state.agentsStarted >= maxAgents) throw new Error(`Workflow budget exceeded: maxAgents=${maxAgents}`);
		return this.scheduler.withSlot(async () => {
			await this.waitIfPaused();

			const agent = this.agentConfigs.find((a) => a.name === options.agent);
			if (!agent) throw new Error(`Unknown subagent '${options.agent}'. Available: ${this.agentConfigs.map((a) => a.name).join(", ") || "none"}`);

			const runTarget = await this.prepareAgentTarget(options);
			this.state = await this.store.append({ type: "agent_started", key: options.key, agent: options.agent, prompt: options.prompt, dependsOn: options.dependsOn, metadata: options.metadata, worktree: runTarget.worktree });
			this.updateStatus();

			try {
				const result = await runSubagent({
					agent,
					prompt: options.prompt,
					cwd: runTarget.cwd,
					signal: this.commandCtx.signal,
					model: options.model,
					timeoutMs: options.timeoutMs,
					maxOutputBytes: options.maxOutputBytes,
					onProgress: async (event) => this.recordAgentProgress(options.key, event),
				});
				if (result.exitCode !== 0 || result.progress?.error) {
					throw new Error(result.progress?.error || result.output || `Subagent ${options.agent} failed`);
				}
				let returned: unknown = options.output === "json" ? parseJsonOutput(result.output) : result.output;
				if (runTarget.worktree) {
					const worktreeResult = await this.collectWorktreeArtifacts(options.key, runTarget.worktree as any, returned);
					returned = typeof returned === "object" && returned !== null ? { ...(returned as any), worktree: worktreeResult } : { output: returned, worktree: worktreeResult };
				}
				this.state = await this.store.append({ type: "agent_completed", key: options.key, agent: options.agent, result: clone(returned), raw: result, usage: result.usage });
				this.enforceTokenBudget();
				this.updateStatus();
				return returned;
			} catch (error: any) {
				this.state = await this.store.append({ type: "agent_failed", key: options.key, agent: options.agent, error: error?.message || String(error), stopped: error instanceof AbortError || error?.name === "AbortError" });
				this.updateStatus();
				throw error;
			}
		});
	}

	private async parallel<T, R>(items: T[], worker: (item: T, index: number) => Promise<R> | R, options: WorkflowParallelOptions): Promise<R[]> {
		this.validateKey(options.key);
		await this.waitIfPaused();
		const budgetMax = this.workflow.budget?.maxConcurrent || DEFAULT_MAX_CONCURRENT;
		const concurrency = Math.max(1, Math.min(options.concurrency || budgetMax, budgetMax));
		const results: R[] = new Array(items.length);
		let next = 0;
		let firstError: unknown;
		this.state = await this.store.append({ type: "parallel_started", key: options.key, count: items.length, concurrency });

		const runWorker = async () => {
			while (next < items.length) {
				await this.waitIfPaused();
				if (firstError && options.stopOnError !== false) return;
				const index = next++;
				try {
					results[index] = await worker(items[index], index);
				} catch (error) {
					if (options.stopOnError === false) {
						results[index] = { error: error instanceof Error ? error.message : String(error) } as R;
					} else {
						firstError = error;
						return;
					}
				}
			}
		};

		await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, runWorker));
		if (firstError) {
			this.state = await this.store.append({ type: "parallel_failed", key: options.key, error: firstError instanceof Error ? firstError.message : String(firstError) });
			throw firstError;
		}
		this.state = await this.store.append({ type: "parallel_completed", key: options.key, count: items.length });
		return results;
	}

	private async artifact(artifactPath: string, data: unknown): Promise<string> {
		throwIfAborted(this.commandCtx.signal);
		const target = safeArtifactPath(this.store.paths.artifacts, artifactPath);
		await fsp.mkdir(path.dirname(target), { recursive: true });
		const content = typeof data === "string" ? data : JSON.stringify(data, null, 2);
		await fsp.writeFile(target, content, "utf-8");
		const rel = path.relative(this.store.paths.root, target);
		this.state = await this.store.append({ type: "artifact_written", path: rel });
		return rel;
	}

	private async recordAgentProgress(key: string, event: WorkflowSubagentProgressEvent): Promise<void> {
		this.state = await this.store.append({ type: event.type === "tool_call" ? "agent_tool" : "agent_progress", key, event, tool: (event as any).tool, args: (event as any).args });
		this.enforceTokenBudget();
	}

	private enforceTokenBudget(): void {
		const maxTokens = this.workflow.budget?.maxTokens;
		if (maxTokens && this.state.tokens > maxTokens) throw new Error(`Workflow budget exceeded: maxTokens=${maxTokens}`);
	}

	private updateStatus(): void {
		this.commandCtx.ui.setStatus?.("workflow", `${this.entry.name}: ${this.state.currentPhase || "running"} · ${this.state.agentsCompleted}/${this.state.agentsStarted} agents · ${this.state.tokens} tok`);
	}

	private async prepareAgentTarget(options: WorkflowAgentOptions): Promise<{ cwd: string; worktree?: unknown }> {
		if (!options.worktree) return { cwd: options.cwd || this.commandCtx.cwd };
		const opts = typeof options.worktree === "object" ? options.worktree as any : {};
		const branchId = safeWorktreeId(opts.branchId || `workflow-${this.state.runId}-${options.key}`);
		const branch = `fleet/${branchId}`;
		const worktreePath = path.join(this.commandCtx.cwd, ".pi", "worktrees", branchId);
		if (!(await pathExists(worktreePath))) {
			await fsp.mkdir(path.dirname(worktreePath), { recursive: true });
			await git(this.commandCtx.cwd, ["worktree", "add", "-b", branch, worktreePath, opts.baseRef || "HEAD"]);
		}
		return { cwd: worktreePath, worktree: { path: worktreePath, branch, branchId, preserve: opts.preserve !== false, fileOwnership: opts.fileOwnership || [] } };
	}

	private async collectWorktreeArtifacts(key: string, worktree: { path: string; branch: string; branchId: string; preserve?: boolean; fileOwnership?: string[] }, returned: unknown): Promise<Record<string, unknown>> {
		const status = await git(worktree.path, ["status", "--porcelain"]).catch(() => "");
		const changedFiles = status.split(/\r?\n/).map((line) => line.slice(3).trim()).filter(Boolean);
		const unstaged = await git(worktree.path, ["diff", "--binary"]).catch(() => "");
		const staged = await git(worktree.path, ["diff", "--binary", "--cached"]).catch(() => "");
		const patch = [staged, unstaged].filter(Boolean).join("\n");
		const patchPath = patch ? await this.artifact(`diffs/${key}.patch`, patch) : undefined;
		const summary = { ...worktree, changedFiles, status, patchPath, result: returned };
		const jsonPath = await this.artifact(`diffs/${key}.json`, summary);
		return { ...summary, jsonPath };
	}

	private validateDependsOn(dependsOn: string[] | undefined): void {
		for (const dep of dependsOn || []) this.validateKey(dep);
	}

	private validateKey(key: string): void {
		if (!key || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(key)) throw new Error(`Invalid durable key: ${key}`);
	}
}

export async function invalidateKeyAndDependents(cwd: string, runId: string, key: string): Promise<RunState> {
	let state = await readRunState(cwd, runId);
	const queue = [key];
	const seen = new Set<string>();
	while (queue.length) {
		const current = queue.shift()!;
		if (seen.has(current)) continue;
		seen.add(current);
		state = await new RunStore(cwd, runId).append({ type: current === key ? "invalidated" : "dependency_invalidated", key: current, root: key });
		for (const child of state.dependencies[current] || []) queue.push(child);
	}
	return state;
}

export async function runPreparedWorkflow(pi: ExtensionAPI, ctx: ExtensionContext, prepared: PreparedWorkflowRun, control: WorkflowRunControl = {}): Promise<unknown> {
	const run = new WorkflowRun(pi, ctx, prepared.entry, prepared.workflow, prepared.store, prepared.state || initialState(prepared.store.runId, prepared.entry, ""), control);
	return run.execute();
}

export { readRunState, runPaths };
