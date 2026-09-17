import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { NormalizedWorkflowDefinition, WorkflowAgentOptions, WorkflowParallelOptions, WorkflowContext } from "./definition.ts";
import { AbortError, Semaphore, throwIfAborted } from "./scheduler.ts";
import type { RegistryEntry } from "./registry.ts";
import { runGit } from "../../_shared/git.ts";
import type { AgentResult, RunSubagentOptions, SubagentProgressEvent } from "../../_shared/subagent-service.ts";
import { collectWorktreeArtifacts, type WorktreeInfo } from "./worktree-artifacts.ts";
import { applyWorkflowRunEvent, type KnownWorkflowRunEvent, type WorkflowRunEventView } from "./workflow-run-events.ts";
import {
	cloneJson,
	projectDetail,
	type RunState,
	type WorkflowRunDetail,
	type WorkflowRunSummary,
	type WorkflowWorktreeView,
} from "./workflow-run-state.ts";
import { FileRunPersistence, runPaths, validateRunId, workflowRunsRoot, type RunPersistence } from "./run-store.ts";
import { recoverWorkflowRunState, WorkflowRunNotFoundError } from "./workflow-run-recovery.ts";
import { declareStatus } from "../../_shared/status-registry.ts";

export { WorkflowEventLogEmptyError, WorkflowRunNotFoundError, isWorkflowRunNotFound } from "./workflow-run-recovery.ts";

const WORKFLOW_STATUS_ID = "workflow";
declareStatus({ id: WORKFLOW_STATUS_ID, style: "accent", order: 60 });

const DEFAULT_MAX_AGENTS = 20;
const DEFAULT_MAX_CONCURRENT = 4;
const WORKTREE_ROOT_NAME = ".pi/worktrees";

export type WorkflowPauseMode = "after-current" | "now";

export interface WorkflowSubagentRequest extends Omit<RunSubagentOptions, "onProgress"> {
	onProgress: (event: SubagentProgressEvent, progress?: AgentResult["progress"]) => void | Promise<void>;
}

export type WorkflowSubagentRunner = (options: WorkflowSubagentRequest) => Promise<AgentResult>;

export interface PreparedWorkflowRunOptions {
	entry: RegistryEntry;
	workflow: NormalizedWorkflowDefinition;
	runId: string;
	resume: boolean;
	args: string;
	sourceSnapshotPath?: string;
	cwd: string;
	parentSignal?: AbortSignal;
	cacheAffinitySeed: string;
	persistence: RunPersistence;
	runSubagent: WorkflowSubagentRunner;
	setStatus?: (status: string | undefined) => void;
}

export interface WorkflowRunHandle<TResult = unknown> {
	readonly runId: string;
	execute(): Promise<TResult>;
	restart(key: string): Promise<TResult>;
	requestPause(mode?: WorkflowPauseMode): Promise<void>;
	requestStop(reason?: string): void;
	inspect(): Promise<WorkflowRunDetail>;
}

export type WorkflowWorktreeCleanupSkipReason = "dirty" | "already-absent" | "invalid-record" | "git-failed";

export interface WorkflowWorktreeCleanupSkip {
	readonly key: string;
	readonly reason: WorkflowWorktreeCleanupSkipReason;
	readonly detail?: string;
}

export interface WorkflowWorktreeCleanupResult {
	readonly cleaned: readonly string[];
	readonly skipped: readonly WorkflowWorktreeCleanupSkip[];
}

export interface WorkflowRunModule {
	create(options: PreparedWorkflowRunOptions): Promise<WorkflowRunHandle>;
	inspect(cwd: string, runId: string): Promise<WorkflowRunDetail>;
	list(cwd: string): Promise<readonly WorkflowRunSummary[]>;
	readEvents(cwd: string, runId: string): Promise<readonly WorkflowRunEventView[]>;
	cleanupWorktrees(cwd: string, runId: string, options?: { signal?: AbortSignal }): Promise<WorkflowWorktreeCleanupResult>;
}

export class RunAlreadyActiveError extends Error {
	readonly code = "WORKFLOW_RUN_ALREADY_ACTIVE";
	constructor(runId: string) {
		super(`Workflow run ${runId} already has an active operation`);
		this.name = "RunAlreadyActiveError";
	}
}

export class AsyncQueue {
	private tail = Promise.resolve();

	run<T>(fn: () => Promise<T>): Promise<T> {
		const next = this.tail.then(fn, fn);
		this.tail = next.then(() => undefined, () => undefined);
		return next;
	}
}

interface RunCoordinator {
	readonly key: string;
	readonly queue: AsyncQueue;
	owner?: WorkflowRun;
	initializing: boolean;
}

const coordinators = new Map<string, RunCoordinator>();

function coordinatorFor(key: string): RunCoordinator {
	const canonical = path.resolve(key);
	let coordinator = coordinators.get(canonical);
	if (!coordinator) {
		coordinator = { key: canonical, queue: new AsyncQueue(), initializing: false };
		coordinators.set(canonical, coordinator);
	}
	return coordinator;
}

export function workflowRunKey(cwd: string, runId: string): string {
	return runPaths(cwd, runId).root;
}

function errorMessage(error: unknown, fallback: string): string {
	return error instanceof Error ? error.message : error ? String(error) : fallback;
}

function isAbortLike(error: unknown): boolean {
	return error instanceof AbortError || (Boolean(error) && typeof error === "object" && (error as { name?: unknown }).name === "AbortError");
}

function signalError(signal: AbortSignal, fallback = "Workflow stopped by abort signal"): Error {
	if (signal.reason instanceof Error) return signal.reason;
	return new AbortError(fallback);
}

function cloneResult<T>(value: T): T {
	return cloneJson(value);
}

export function parseJsonOutput(text: string): unknown {
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

function isWithinRoot(target: string, root: string): boolean {
	const relative = path.relative(path.resolve(root), path.resolve(target));
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function realOrResolved(value: string): Promise<string> {
	const suffix: string[] = [];
	let current = path.resolve(value);
	while (true) {
		try {
			const resolved = await fsp.realpath(current);
			return path.join(resolved, ...suffix);
		} catch (error) {
			if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
			const parent = path.dirname(current);
			if (parent === current) return path.resolve(value);
			suffix.unshift(path.basename(current));
			current = parent;
		}
	}
}

async function assertWorktreePath(target: string, managedRoot: string): Promise<void> {
	const root = await realOrResolved(managedRoot);
	const resolved = await realOrResolved(target);
	if (!isWithinRoot(resolved, root) || resolved === root) throw new Error(`Workflow worktree path escapes ${WORKTREE_ROOT_NAME}: ${target}`);
	try {
		const stat = await fsp.stat(target);
		if (!stat.isDirectory()) throw new Error(`Workflow worktree path is not a directory: ${target}`);
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
	}
}

function safeWorktreeId(value: string): string {
	const cleaned = value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
	if (!cleaned || cleaned === "." || cleaned === ".." || cleaned.endsWith(".lock")) throw new Error(`Invalid worktree branch id: ${value}`);
	return cleaned;
}

async function pathExists(file: string): Promise<boolean> {
	try { await fsp.access(file); return true; } catch { return false; }
}

async function cleanupPathExists(file: string): Promise<boolean> {
	try {
		await fsp.access(file);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return false;
		throw error;
	}
}

function throwCleanupAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw signalError(signal, "Workflow worktree cleanup aborted");
}

class WorkflowRun implements WorkflowRunHandle {
	private state!: RunState;
	private initialized = false;
	private operationStarted = false;
	private operationPromise?: Promise<unknown>;
	private operationKind?: "execute" | "restart";
	private operationAttempt = 0;
	private terminalAttempt?: number;
	private projectionDirty = false;
	private settled = false;
	private pauseMode?: WorkflowPauseMode;
	private stopReason?: string;
	private controller = new AbortController();
	private scheduler: Semaphore;
	private readonly parentSignal?: AbortSignal;
	private readonly parentAbortListener?: () => void;
	private parentListenerRemoved = false;

	private readonly options: PreparedWorkflowRunOptions;
	private readonly coordinator: RunCoordinator;

	constructor(options: PreparedWorkflowRunOptions, coordinator: RunCoordinator) {
		this.options = options;
		this.coordinator = coordinator;
		validateRunId(options.runId);
		this.parentSignal = options.parentSignal;
		this.scheduler = new Semaphore(options.workflow.budget?.maxConcurrent || DEFAULT_MAX_CONCURRENT, this.controller.signal);
		if (this.parentSignal) {
			this.parentAbortListener = () => this.controller.abort(this.parentSignal?.reason);
			if (this.parentSignal.aborted) this.controller.abort(this.parentSignal.reason);
			else this.parentSignal.addEventListener("abort", this.parentAbortListener, { once: true });
		}
	}

	get runId(): string { return this.options.runId; }

	async initialize(): Promise<void> {
		if (this.initialized) return;
		await this.coordinator.queue.run(async () => {
			if (this.initialized) return;
			if (this.options.resume) {
				this.state = await this.readStateOnQueue();
			} else {
				await this.options.persistence.initializeInput({
					args: this.options.args,
					workflowName: this.options.entry.name,
					sourceHash: this.options.entry.sourceHash,
				});
				const event: KnownWorkflowRunEvent = {
					runId: this.options.runId,
					workflowName: this.options.entry.name,
					trust: this.options.entry.trust,
					args: this.options.args,
					sourceHash: this.options.entry.sourceHash,
					sourceSnapshotPath: this.options.sourceSnapshotPath,
					description: this.options.entry.description,
					costShape: this.options.entry.cost,
					canEditFiles: this.options.entry.canEditFiles,
					type: "run_created",
				};
				const stamped = { ts: Date.now(), ...event };
				await this.options.persistence.appendEvent(stamped);
				this.state = applyWorkflowRunEvent(undefined, stamped);
				await this.tryWriteProjectionOnQueue();
			}
			this.initialized = true;
		});
	}

	/** Single-flight execution. The returned promise is reused verbatim. */
	execute(): Promise<unknown> {
		if (this.operationPromise) return this.operationPromise;
		if (this.operationStarted) return Promise.reject(new RunAlreadyActiveError(this.runId));
		this.operationStarted = true;
		this.operationKind = "execute";
		try { this.acquireLease(); } catch (error) { return Promise.reject(error); }
		const attempt = ++this.operationAttempt;
		const promise = this.runAttempt(attempt, false).finally(() => this.finishOperation());
		this.operationPromise = promise;
		return promise;
	}

	/** Invalidate and replay while retaining the same coordinator lease. */
	restart(key: string): Promise<unknown> {
		if (this.operationPromise) {
			if (this.operationKind === "restart") return this.operationPromise;
			return Promise.reject(new RunAlreadyActiveError(this.runId));
		}
		if (this.operationStarted) return Promise.reject(new RunAlreadyActiveError(this.runId));
		this.operationStarted = true;
		this.operationKind = "restart";
		try { this.acquireLease(); } catch (error) { return Promise.reject(error); }
		const attempt = ++this.operationAttempt;
		const promise = this.restartAndRun(attempt, key).finally(() => this.finishOperation());
		this.operationPromise = promise;
		return promise;
	}

	async requestPause(mode: WorkflowPauseMode = "after-current"): Promise<void> {
		if (this.settled) return;
		if (this.pauseMode === "now" || this.pauseMode === mode) return;
		this.pauseMode = mode;
		const attempt = this.operationStarted ? this.operationAttempt : undefined;
		await this.record({ type: "run_pausing", mode }, attempt);
		if (mode === "now" && !this.settled) this.controller.abort(new AbortError("Workflow paused by user"));
	}

	requestStop(reason?: string): void {
		if (this.settled) return;
		if (reason !== undefined) this.stopReason = reason;
		if (!this.controller.signal.aborted) this.controller.abort(reason ? new AbortError(reason) : undefined);
	}

	async inspect(): Promise<WorkflowRunDetail> {
		await this.ensureInitialized();
		if (this.coordinator.owner === this) return this.detailFromPrivateState();
		return this.coordinator.queue.run(async () => {
			this.state = await this.readStateOnQueue();
			return this.detailFromPrivateState();
		});
	}

	private async ensureInitialized(): Promise<void> {
		if (!this.initialized) await this.initialize();
	}

	private acquireLease(): void {
		if (this.coordinator.owner && this.coordinator.owner !== this) throw new RunAlreadyActiveError(this.runId);
		this.coordinator.owner = this;
	}

	private finishOperation(): void {
		if (this.coordinator.owner === this) this.coordinator.owner = undefined;
		this.bestEffortStatus(undefined);
		if (this.parentSignal && this.parentAbortListener && !this.parentListenerRemoved) {
			this.parentSignal.removeEventListener("abort", this.parentAbortListener);
			this.parentListenerRemoved = true;
		}
	}

	private async restartAndRun(attempt: number, key: string): Promise<unknown> {
		await this.ensureInitialized();
		await this.coordinator.queue.run(async () => {
			this.state = await this.readStateOnQueue();
			if (!this.state.steps[key] && !this.state.agents[key]) throw new Error(`Durable key not found in run ${this.runId}: ${key}`);
			this.terminalAttempt = undefined;
			this.settled = false;
			const queue = [key];
			const seen = new Set<string>();
			while (queue.length) {
				const current = queue.shift()!;
				if (seen.has(current)) continue;
				seen.add(current);
				await this.recordOnQueue({ type: current === key ? "invalidated" : "dependency_invalidated", key: current, root: key }, attempt);
				for (const child of this.state.dependencies[current] || []) queue.push(child);
			}
		});
		return this.runAttempt(attempt, true);
	}

	private async runAttempt(attempt: number, resumed: boolean): Promise<unknown> {
		await this.ensureInitialized();
		if (this.options.resume && !resumed) {
			this.state = await this.coordinator.queue.run(() => this.readStateOnQueue());
		}
		this.terminalAttempt = undefined;
		this.settled = false;
		try {
			await this.record({ type: resumed || this.options.resume ? "run_resumed" : "run_started" }, attempt);
			if (this.controller.signal.aborted) throw signalError(this.controller.signal);
			const runtimeContext = this.buildContext(attempt);
			const result = await this.options.workflow.run(runtimeContext as WorkflowContext);
			// An immediate pause or stop must win over a workflow that ignores the
			// abort signal. after-current intentionally keeps the old completion rule.
			if (this.pauseMode === "now" || this.stopReason !== undefined || (this.controller.signal.aborted && this.pauseMode !== "after-current")) {
				throw signalError(this.controller.signal, this.pauseMode ? "Workflow paused by user" : "Workflow stopped by abort signal");
			}
			await this.record({ type: "run_completed", result: cloneResult(result) }, attempt);
			return result;
		} catch (error) {
			if (this.pauseMode) {
				if (!this.settled) await this.record({ type: "run_paused", error: errorMessage(error, "Workflow paused") }, attempt);
			} else if (this.stopReason !== undefined || this.controller.signal.aborted || isAbortLike(error)) {
				if (!this.settled) await this.record({ type: "run_stopped", error: this.stopReason || "Workflow stopped by abort signal" }, attempt);
			} else {
				if (!this.settled) await this.record({ type: "run_failed", error: errorMessage(error, "Workflow failed") }, attempt);
			}
			throw error;
		} finally {
			this.bestEffortStatus(undefined);
		}
	}

	private buildContext(attempt: number): WorkflowContext {
		return {
			runId: this.runId,
			args: ((this.state.args || "") as string),
			cwd: this.options.cwd,
			signal: this.controller.signal,
			phase: async <T>(name: string, fn: () => Promise<T> | T): Promise<T> => {
				await this.waitIfPaused(attempt);
				await this.record({ type: "phase_started", name }, attempt);
				try {
					const value = await fn();
					await this.record({ type: "phase_completed", name }, attempt);
					return value;
				} catch (error) {
					await this.record({ type: "phase_failed", name, error: errorMessage(error, "Phase failed") }, attempt);
					throw error;
				}
			},
			step: async <T>(key: string, fn: () => Promise<T> | T, options?: { dependsOn?: string[]; metadata?: Record<string, unknown> }): Promise<T> => this.step(attempt, key, fn, options),
			agent: async <T = string>(options: WorkflowAgentOptions): Promise<T> => this.agent(attempt, options) as Promise<T>,
			parallel: async <T, R>(items: T[], worker: (item: T, index: number) => Promise<R> | R, options: WorkflowParallelOptions): Promise<R[]> => this.parallel(attempt, items, worker, options),
			artifact: async (artifactPath: string, data: unknown): Promise<string> => this.artifact(attempt, artifactPath, data),
			log: async (message: string, details?: Record<string, unknown>): Promise<void> => { await this.record({ type: "log", message, details }, attempt); },
			fail: (message: string): never => { throw new Error(message); },
		} as WorkflowContext;
	}

	private async waitIfPaused(attempt: number): Promise<void> {
		if (this.controller.signal.aborted) {
			if (this.pauseMode) throw new AbortError("Workflow paused by user");
			throw signalError(this.controller.signal);
		}
		if (this.pauseMode === "now") throw new AbortError("Workflow paused by user");
		if (this.pauseMode === "after-current") {
			if (!this.settled) await this.record({ type: "run_paused" }, attempt);
			throw new AbortError("Workflow paused by user");
		}
	}

	private keyInvalidated(key: string): boolean {
		return this.state.invalidatedKeys.includes(key);
	}

	private async step<T>(attempt: number, key: string, fn: () => Promise<T> | T, options: { dependsOn?: string[]; metadata?: Record<string, unknown> } = {}): Promise<T> {
		this.validateKey(key);
		this.validateDependsOn(options.dependsOn);
		await this.waitIfPaused(attempt);
		const existing = this.state.steps[key];
		if (existing?.status === "completed" && !this.keyInvalidated(key)) {
			await this.record({ type: "step_reused", key }, attempt);
			return cloneResult(existing.result as T);
		}
		await this.record({ type: "step_started", key, dependsOn: options.dependsOn, metadata: options.metadata }, attempt);
		try {
			const result = await fn();
			await this.record({ type: "step_completed", key, result: cloneResult(result) }, attempt);
			return result;
		} catch (error) {
			await this.record({ type: "step_failed", key, error: errorMessage(error, "Step failed") }, attempt);
			throw error;
		}
	}

	private async agent(optionsAttempt: number, options: WorkflowAgentOptions): Promise<unknown> {
		this.validateKey(options.key);
		this.validateDependsOn(options.dependsOn);
		await this.waitIfPaused(optionsAttempt);
		const existing = this.state.agents[options.key];
		if (existing?.status === "completed" && !this.keyInvalidated(options.key)) {
			await this.record({ type: "agent_reused", key: options.key, agent: existing.agent }, optionsAttempt);
			return cloneResult(existing.result);
		}

		return this.scheduler.withSlot(async () => {
			await this.waitIfPaused(optionsAttempt);
			const target = await this.admitAgent(optionsAttempt, options);
			try {
				const result = await this.options.runSubagent({
					agent: options.agent,
					task: options.prompt,
					cwd: target.cwd,
					signal: this.controller.signal,
					model: options.model,
					timeoutMs: options.timeoutMs,
					maxOutputBytes: options.maxOutputBytes,
					cacheAffinitySeed: this.options.cacheAffinitySeed,
					onProgress: async (event) => this.recordAgentProgress(optionsAttempt, options.key, event),
				});
				if (result.progress.status === "failed") throw new Error(result.progress.error || result.output || `Subagent ${options.agent} failed`);
				let returned: unknown = options.output === "json" ? parseJsonOutput(result.output) : result.output;
				if (target.worktree) {
					const worktreeResult = await collectWorktreeArtifacts(
						options.key,
						target.worktree,
						returned,
						{ signal: this.controller.signal, writeArtifact: (relativePath, data) => this.artifact(optionsAttempt, relativePath, data) },
					);
					returned = typeof returned === "object" && returned !== null ? { ...(returned as Record<string, unknown>), worktree: worktreeResult } : { output: returned, worktree: worktreeResult };
				}
				await this.record({ type: "agent_completed", key: options.key, agent: options.agent, result: cloneResult(returned), raw: cloneResult(result), usage: result.usage }, optionsAttempt);
				this.enforceTokenBudget();
				this.updateStatus();
				return returned;
			} catch (error) {
				await this.record({ type: "agent_failed", key: options.key, agent: options.agent, error: errorMessage(error, "Agent failed"), stopped: isAbortLike(error) || this.controller.signal.aborted }, optionsAttempt);
				this.updateStatus();
				throw error;
			}
		});
	}

	private async admitAgent(attempt: number, options: WorkflowAgentOptions): Promise<{ cwd: string; worktree?: WorktreeInfo }> {
		return this.coordinator.queue.run(async () => {
			if (this.terminalAttempt === attempt) throw new AbortError();
			const maxAgents = this.options.workflow.budget?.maxAgents ?? DEFAULT_MAX_AGENTS;
			if (this.state.agentsStarted >= maxAgents) throw new Error(`Workflow budget exceeded: maxAgents=${maxAgents}`);
			// Target preparation is deliberately inside the same serialized
			// admission operation as the count check and agent_started event.
			const target = await this.prepareAgentTarget(options);
			await this.recordOnQueue({ type: "agent_started", key: options.key, agent: options.agent, prompt: options.prompt, dependsOn: options.dependsOn, metadata: options.metadata, worktree: target.worktree }, attempt);
			this.updateStatus();
			return target;
		});
	}

	private async parallel<T, R>(attempt: number, items: T[], worker: (item: T, index: number) => Promise<R> | R, options: WorkflowParallelOptions): Promise<R[]> {
		this.validateKey(options.key);
		await this.waitIfPaused(attempt);
		const budgetMax = this.options.workflow.budget?.maxConcurrent || DEFAULT_MAX_CONCURRENT;
		const concurrency = Math.max(1, Math.min(options.concurrency || budgetMax, budgetMax));
		const results: R[] = new Array(items.length);
		let next = 0;
		let firstError: unknown;
		await this.record({ type: "parallel_started", key: options.key, count: items.length, concurrency }, attempt);

		const runWorker = async () => {
			while (next < items.length) {
				await this.waitIfPaused(attempt);
				if (firstError && options.stopOnError !== false) return;
				const index = next++;
				try {
					results[index] = await worker(items[index], index);
				} catch (error) {
					if (options.stopOnError === false) results[index] = { error: error instanceof Error ? error.message : String(error) } as R;
					else { firstError = error; return; }
				}
			}
		};

		await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, runWorker));
		if (firstError) {
			await this.record({ type: "parallel_failed", key: options.key, error: errorMessage(firstError, "Parallel block failed") }, attempt);
			throw firstError;
		}
		await this.record({ type: "parallel_completed", key: options.key, count: items.length }, attempt);
		return results;
	}

	private async artifact(attempt: number, artifactPath: string, data: unknown): Promise<string> {
		throwIfAborted(this.controller.signal);
		const content = typeof data === "string" ? data : JSON.stringify(data, null, 2);
		const relative = await this.options.persistence.writeArtifact(artifactPath, content);
		await this.record({ type: "artifact_written", path: relative }, attempt);
		return relative;
	}

	private async recordAgentProgress(attempt: number, key: string, event: SubagentProgressEvent): Promise<void> {
		if (event.type === "tool_call") await this.record({ type: "agent_tool", key, event, tool: event.tool, args: event.args }, attempt);
		else await this.record({ type: "agent_progress", key, event }, attempt);
		this.enforceTokenBudget();
	}

	private enforceTokenBudget(): void {
		const maxTokens = this.options.workflow.budget?.maxTokens;
		if (maxTokens && this.state.tokens > maxTokens) throw new Error(`Workflow budget exceeded: maxTokens=${maxTokens}`);
	}

	private updateStatus(): void {
		this.bestEffortStatus(`${this.options.entry.name} · ${this.state.currentPhase || "running"} · ${this.state.agentsCompleted}/${this.state.agentsStarted} agents`);
	}

	private bestEffortStatus(value: string | undefined): void {
		try { this.options.setStatus?.(value); } catch {}
	}

	private async prepareAgentTarget(options: WorkflowAgentOptions): Promise<{ cwd: string; worktree?: WorktreeInfo }> {
		if (!options.worktree) return { cwd: options.cwd || this.options.cwd };
		const opts = typeof options.worktree === "object" ? options.worktree : {};
		const branchId = safeWorktreeId(opts.branchId || `workflow-${this.runId}-${options.key}`);
		const branch = `fleet/${branchId}`;
		const managedRoot = path.resolve(this.options.cwd, ".pi", "worktrees");
		const worktreePath = path.join(managedRoot, branchId);
		if (!isWithinRoot(worktreePath, managedRoot) || path.resolve(worktreePath) === path.resolve(managedRoot)) throw new Error(`Workflow worktree path escapes ${WORKTREE_ROOT_NAME}: ${worktreePath}`);
		if (!(await pathExists(worktreePath))) {
			await fsp.mkdir(path.dirname(worktreePath), { recursive: true });
			await assertWorktreePath(worktreePath, managedRoot);
			await runGit(this.options.cwd, ["worktree", "add", "-b", branch, worktreePath, opts.baseRef || "HEAD"], { signal: this.controller.signal });
		}
		await assertWorktreePath(worktreePath, managedRoot);
		return { cwd: worktreePath, worktree: { path: worktreePath, branch, branchId, preserve: opts.preserve !== false, fileOwnership: opts.fileOwnership || [] } };
	}

	private validateDependsOn(dependsOn: string[] | undefined): void {
		for (const dep of dependsOn || []) this.validateKey(dep);
	}

	private validateKey(key: string): void {
		if (!key || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(key)) throw new Error(`Invalid durable key: ${key}`);
	}

	private async record(event: KnownWorkflowRunEvent, attempt?: number): Promise<RunState> {
		return this.coordinator.queue.run(() => this.recordOnQueue(event, attempt));
	}

	private async recordOnQueue(event: KnownWorkflowRunEvent, attempt?: number): Promise<RunState> {
		if (attempt !== undefined && this.terminalAttempt === attempt) return this.state;
		if (!this.state) throw new Error(`Workflow run ${this.runId} is not initialized`);
		const stamped = cloneJson({ ts: Date.now(), ...event });
		await this.options.persistence.appendEvent(stamped);
		this.state = applyWorkflowRunEvent(this.state, stamped);
		if (event.type === "run_completed" || event.type === "run_paused" || event.type === "run_failed" || event.type === "run_stopped") {
			this.terminalAttempt = attempt;
			this.settled = true;
		}
		await this.tryWriteProjectionOnQueue();
		return this.state;
	}

	private async tryWriteProjectionOnQueue(): Promise<void> {
		try {
			await this.options.persistence.writeProjection(cloneJson(this.state));
			this.projectionDirty = false;
		} catch {
			this.projectionDirty = true;
			// JSONL is the commit point. A later open or write will repair the
			// materialized projection from the durable event log.
		}
	}

	private async readStateOnQueue(): Promise<RunState> {
		return recoverWorkflowRunState(this.options.persistence, this.runId);
	}

	private async detailFromPrivateState(): Promise<WorkflowRunDetail> {
		return projectDetail(this.state, {
			root: this.options.persistence.paths().root,
			events: this.options.persistence.paths().events,
			managedWorktreeRoot: path.resolve(this.options.cwd, ".pi", "worktrees"),
		});
	}
}

async function createWorkflowRun(options: PreparedWorkflowRunOptions): Promise<WorkflowRunHandle> {
	validateRunId(options.runId);
	const paths = options.persistence.paths();
	const coordinator = coordinatorFor(paths.root);
	if (coordinator.initializing || (coordinator.owner && !options.resume)) throw new RunAlreadyActiveError(options.runId);
	coordinator.initializing = true;
	try {
		const handle = new WorkflowRun(options, coordinator);
		await handle.initialize();
		return handle;
	} finally {
		coordinator.initializing = false;
	}
}

async function inspectWithPersistence(cwd: string, runId: string): Promise<WorkflowRunDetail> {
	validateRunId(runId);
	const persistence = new FileRunPersistence(cwd, runId);
	const coordinator = coordinatorFor(persistence.paths().root);
	if (coordinator.owner) return coordinator.owner.inspect();
	return coordinator.queue.run(async () => {
		const state = await recoverWorkflowRunState(persistence, runId);
		return projectDetail(state, {
			root: persistence.paths().root,
			events: persistence.paths().events,
			managedWorktreeRoot: path.resolve(cwd, ".pi", "worktrees"),
		});
	});
}

interface CleanupTarget {
	readonly path: string;
	readonly keys: string[];
}

type CleanupKeyOutcome = "cleaned" | Omit<WorkflowWorktreeCleanupSkip, "key">;

async function cleanupWorkflowWorktrees(
	cwd: string,
	runId: string,
	options: { signal?: AbortSignal } = {},
): Promise<WorkflowWorktreeCleanupResult> {
	validateRunId(runId);
	const persistence = new FileRunPersistence(cwd, runId);
	const coordinator = coordinatorFor(persistence.paths().root);
	return coordinator.queue.run(async () => {
		if (coordinator.owner) throw new RunAlreadyActiveError(runId);
		throwCleanupAborted(options.signal);
		const state = await recoverWorkflowRunState(persistence, runId);
		throwCleanupAborted(options.signal);
		const keys = Object.keys(state.agents);
		const outcomes = new Map<string, CleanupKeyOutcome>();
		const targets = new Map<string, CleanupTarget>();
		const managedRoot = path.resolve(cwd, ".pi", "worktrees");

		for (const key of keys) {
			throwCleanupAborted(options.signal);
			const raw = state.agents[key].worktree;
			if (raw === undefined) continue;
			if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
				outcomes.set(key, { reason: "invalid-record", detail: "recorded worktree must be an object" });
				continue;
			}
			const record = raw as Record<string, unknown>;
			if (typeof record.path !== "string" || typeof record.branch !== "string" || typeof record.branchId !== "string") {
				outcomes.set(key, { reason: "invalid-record", detail: "recorded worktree fields must be strings" });
				continue;
			}
			let canonicalId: string;
			try {
				canonicalId = safeWorktreeId(record.branchId);
			} catch {
				outcomes.set(key, { reason: "invalid-record", detail: "recorded worktree branch ID is not canonical" });
				continue;
			}
			if (canonicalId !== record.branchId) {
				outcomes.set(key, { reason: "invalid-record", detail: "recorded worktree branch ID is not canonical" });
				continue;
			}
			const expectedPath = path.resolve(managedRoot, canonicalId);
			const recordedPath = path.resolve(record.path);
			if (path.relative(expectedPath, recordedPath) !== "") {
				outcomes.set(key, { reason: "invalid-record", detail: "recorded worktree path does not match branch ID" });
				continue;
			}
			try {
				await assertWorktreePath(expectedPath, managedRoot);
			} catch {
				outcomes.set(key, { reason: "invalid-record", detail: "recorded worktree path is invalid" });
				continue;
			}
			const target = targets.get(expectedPath);
			if (target) target.keys.push(key);
			else targets.set(expectedPath, { path: expectedPath, keys: [key] });
		}

		const assign = (target: CleanupTarget, outcome: CleanupKeyOutcome) => {
			for (const key of target.keys) outcomes.set(key, outcome);
		};
		for (const target of targets.values()) {
			throwCleanupAborted(options.signal);
			let exists: boolean;
			try {
				exists = await cleanupPathExists(target.path);
			} catch {
				assign(target, { reason: "invalid-record", detail: "recorded worktree path is inaccessible" });
				continue;
			}
			if (!exists) {
				assign(target, { reason: "already-absent" });
				continue;
			}
			let status: Awaited<ReturnType<typeof runGit>>;
			try {
				status = await runGit(target.path, ["status", "--porcelain"], { signal: options.signal });
				throwCleanupAborted(options.signal);
			} catch (error) {
				if (options.signal?.aborted || isAbortLike(error)) throw error;
				assign(target, { reason: "git-failed", detail: errorMessage(error, "Git status failed") });
				continue;
			}
			if (status.stdout.trim()) {
				assign(target, { reason: "dirty" });
				continue;
			}
			try {
				await assertWorktreePath(target.path, managedRoot);
				exists = await cleanupPathExists(target.path);
				throwCleanupAborted(options.signal);
			} catch (error) {
				if (options.signal?.aborted || isAbortLike(error)) throw error;
				assign(target, { reason: "invalid-record", detail: "recorded worktree path is invalid" });
				continue;
			}
			if (!exists) {
				assign(target, { reason: "already-absent" });
				continue;
			}
			try {
				await runGit(cwd, ["worktree", "remove", target.path], { signal: options.signal });
				throwCleanupAborted(options.signal);
				assign(target, "cleaned");
			} catch (error) {
				if (options.signal?.aborted || isAbortLike(error)) throw error;
				assign(target, { reason: "git-failed", detail: errorMessage(error, "Git cleanup failed") });
			}
		}

		throwCleanupAborted(options.signal);
		const cleaned: string[] = [];
		const skipped: WorkflowWorktreeCleanupSkip[] = [];
		for (const key of keys) {
			const outcome = outcomes.get(key);
			if (outcome === "cleaned") cleaned.push(key);
			else if (outcome) skipped.push({ key, ...outcome });
		}
		return { cleaned, skipped };
	});
}

async function listWorkflowRuns(cwd: string): Promise<readonly WorkflowRunSummary[]> {
	const base = workflowRunsRoot(cwd);
	if (!fs.existsSync(base)) return [];
	const entries = await fsp.readdir(base, { withFileTypes: true });
	const summaries: Array<{ summary: WorkflowRunSummary; updatedAt: number }> = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		try {
			const detail = await inspectWithPersistence(cwd, entry.name);
			summaries.push({ summary: {
				runId: detail.runId,
				workflowName: detail.workflowName,
				status: detail.status,
				currentPhase: detail.currentPhase,
				error: detail.error,
				startedAt: detail.startedAt,
				completedAt: detail.completedAt,
				agentsStarted: detail.agentsStarted,
				agentsCompleted: detail.agentsCompleted,
				agentsFailed: detail.agentsFailed,
				tokens: detail.tokens,
				cost: detail.cost,
			}, updatedAt: detail.updatedAt });
		} catch {
			// One malformed run must not make the list command unusable.
		}
	}
	return summaries.sort((a, b) => b.updatedAt - a.updatedAt).map((item) => item.summary);
}

async function readWorkflowEvents(cwd: string, runId: string): Promise<readonly WorkflowRunEventView[]> {
	validateRunId(runId);
	const persistence = new FileRunPersistence(cwd, runId);
	const coordinator = coordinatorFor(persistence.paths().root);
	return coordinator.queue.run(async () => {
		const log = await persistence.readEventLog();
		if (!log.exists) throw new WorkflowRunNotFoundError(runId);
		return cloneJson(log.events);
	});
}

export const workflowRunModule: WorkflowRunModule = {
	create: createWorkflowRun,
	inspect: inspectWithPersistence,
	list: listWorkflowRuns,
	readEvents: readWorkflowEvents,
	cleanupWorktrees: cleanupWorkflowWorktrees,
};

export { createWorkflowRun, WorkflowRun };
export type { WorkflowRunDetail, WorkflowRunEventView, WorkflowRunSummary, WorkflowWorktreeView };