import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import type { AgentProgress, AgentResult } from "../_shared/subagent-service.ts";
import { formatChildToolDiagnostic, type SubagentChildExecution } from "./child-execution.ts";
import { createSubagentExecutionScheduler } from "./execution-scheduler.ts";
import type { RunSubagentBatchOptions, SubagentExecution, SubagentExecutionTask } from "./subagent-execution.ts";

export type SubagentRunStatus = "queued" | "running" | "cancelling" | "completed" | "failed" | "cancelled";
export interface SubagentRunSnapshot {
	runId: string;
	sessionId: string;
	agent: string;
	task: string;
	cwd: string;
	model: string;
	thinkingLevel?: string;
	cacheSessionId?: string;
	status: SubagentRunStatus;
	createdAt: number;
	startedAt?: number;
	finishedAt?: number;
	progress?: AgentProgress;
	result?: AgentResult;
	error?: string;
}
export const isTerminalRun = (run: SubagentRunSnapshot) =>
	run.status === "completed" || run.status === "failed" || run.status === "cancelled";

function immutable<T>(value: T): T {
	const copy = structuredClone(value);
	function freeze(item: unknown) {
		if (item && typeof item === "object") {
			Object.values(item).forEach(freeze);
			Object.freeze(item);
		}
	}
	freeze(copy);
	return copy;
}

export function createSubagentRunManager(dependencies: {
	execution: Pick<SubagentExecution, "prepareBatch" | "runPrepared">;
	childExecution: Pick<SubagentChildExecution, "inspectTools">;
	onTerminal?: (run: SubagentRunSnapshot) => void;
	onChange?: () => void;
}) {
	interface Record { snapshot: SubagentRunSnapshot; controller: AbortController; completion: Promise<void> }
	const records = new Map<string, Record>();
	const listeners = new Set<() => void>();
	let closed = false;
	const disposal = new AbortController();
	const getRecord = (id: string) => {
		const record = records.get(id);
		if (!record) throw new Error(`Subagent run ${id} is unavailable. It may be evicted or belong to a previous runtime or branch.`);
		return record;
	};
	function changed() {
		for (const listener of listeners) listener();
		try { dependencies.onChange?.(); } catch { /* UI does not own execution. */ }
	}
	function evict() {
		const terminal = [...records.values()].filter((record) => isTerminalRun(record.snapshot));
		terminal.sort((a, b) => a.snapshot.finishedAt! - b.snapshot.finishedAt!);
		for (const record of terminal.slice(0, Math.max(0, terminal.length - 100))) records.delete(record.snapshot.runId);
	}
	const manager = {
		spawn(tasks: readonly SubagentExecutionTask[], options: RunSubagentBatchOptions & { sessionId: string }): SubagentRunSnapshot[] {
			if (closed) throw new Error("Background subagent admission is closed.");
			options.signal?.throwIfAborted();
			if (!tasks.length || tasks.length > 32) throw new Error("Submit 1–32 background tasks per invocation.");
			if ([...records.values()].filter((r) => !isTerminalRun(r.snapshot)).length + tasks.length > 64) {
				throw new Error("At most 64 unfinished background runs are allowed. Wait or cancel existing runs.");
			}
			const batch = dependencies.execution.prepareBatch(tasks, options);
			for (const request of batch.requests) {
				if (!request.task.trim()) throw new Error("Subagent task must not be blank.");
				if (!statSync(request.cwd).isDirectory()) throw new Error(`Subagent cwd is not a directory: ${request.cwd}`);
				const diagnostics = dependencies.childExecution.inspectTools(request.agent.tools);
				if (diagnostics.length) throw new Error(`Subagent ${request.agent.name} cannot launch: ${diagnostics.map(formatChildToolDiagnostic).join("; ")}`);
			}
			options.signal?.throwIfAborted();
			const admitted = batch.requests.map((request): Record => ({
				snapshot: {
					runId: randomUUID(), sessionId: options.sessionId, agent: request.agent.name,
					task: request.task, cwd: request.cwd, model: request.launch.model,
					thinkingLevel: request.launch.thinkingLevel, cacheSessionId: request.cacheSessionId,
					status: "queued", createdAt: Date.now(),
				}, controller: new AbortController(), completion: Promise.resolve(),
			}));
			for (const record of admitted) records.set(record.snapshot.runId, record);
			// Capture acknowledgement before any scheduled callback changes live state.
			const handles = admitted.map((record) => immutable(record.snapshot));
			const local = createSubagentExecutionScheduler(batch.concurrency);
			admitted.forEach((record, index) => {
				const request = batch.requests[index];
				const finish = (result?: AgentResult, error?: unknown, rejected = false) => {
					if (isTerminalRun(record.snapshot)) return;
					record.snapshot = {
						...record.snapshot, finishedAt: Date.now(),
						status: record.controller.signal.aborted ? "cancelled" : rejected || result?.progress.status === "failed" ? "failed" : "completed",
						...(result ? { result: structuredClone(result), progress: structuredClone(result.progress) } : {}),
						...(rejected ? { error: String(error instanceof Error ? error.message : error) } : {}),
					};
					evict();
					changed();
					try { dependencies.onTerminal?.(immutable(record.snapshot)); } catch { /* Results remain retrievable. */ }
				};
				record.completion = (async () => {
					try {
						const result = await local.run(() => dependencies.execution.runPrepared({
							...request, signal: record.controller.signal,
							onProgress: undefined,
							onUpdate(progress) {
								if (isTerminalRun(record.snapshot)) return;
								record.snapshot.progress = structuredClone(progress);
								changed();
							},
						}, () => {
							record.snapshot.status = "running";
							record.snapshot.startedAt = Date.now();
							changed();
						}), record.controller.signal);
						finish(result);
					} catch (error) { finish(undefined, error, true); }
				})();
			});
			changed();
			return handles;
		},
		list(): SubagentRunSnapshot[] { return [...records.values()].map((record) => immutable(record.snapshot)); },
		get(id: string): SubagentRunSnapshot { return immutable(getRecord(id).snapshot); },
		validateIds(ids: readonly string[]) {
			if (!ids.length || ids.length > 32 || new Set(ids).size !== ids.length) throw new Error("runIds must contain 1–32 unique IDs.");
			ids.forEach(getRecord);
		},
		async wait(ids: readonly string[], timeoutMs = 30000, signal?: AbortSignal): Promise<SubagentRunSnapshot[]> {
			manager.validateIds(ids);
			if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 300000) throw new Error("timeoutMs must be an integer from 0 through 300000.");
			// Keep references so eviction by unrelated completions cannot invalidate an active wait.
			const selected = ids.map(getRecord);
			signal?.throwIfAborted();
			disposal.signal.throwIfAborted();
			if (timeoutMs && !selected.every((r) => isTerminalRun(r.snapshot))) {
				await new Promise<void>((resolve, reject) => {
					const cleanup = () => {
						clearTimeout(timer); listeners.delete(check);
						signal?.removeEventListener("abort", abort); disposal.signal.removeEventListener("abort", abort);
					};
					const done = () => { cleanup(); resolve(); };
					const abort = () => { cleanup(); reject(signal?.reason ?? disposal.signal.reason ?? new Error("Wait aborted")); };
					const check = () => { if (selected.every((r) => isTerminalRun(r.snapshot))) done(); };
					const timer = setTimeout(done, timeoutMs);
					listeners.add(check);
					signal?.addEventListener("abort", abort, { once: true });
					disposal.signal.addEventListener("abort", abort, { once: true });
					check();
				});
			}
			return selected.map((r) => immutable(r.snapshot));
		},
		cancel(ids: readonly string[], reason = "Subagent cancelled"): SubagentRunSnapshot[] {
			manager.validateIds(ids);
			for (const id of ids) {
				const record = getRecord(id);
				if (isTerminalRun(record.snapshot)) continue;
				record.snapshot.status = "cancelling";
				record.snapshot.error = reason;
				record.controller.abort(new Error(reason));
			}
			changed();
			return ids.map(manager.get);
		},
		async cancelAll(reason: string): Promise<void> {
			const pending = [...records.values()].filter((r) => !isTerminalRun(r.snapshot));
			for (let i = 0; i < pending.length; i += 32) manager.cancel(pending.slice(i, i + 32).map((r) => r.snapshot.runId), reason);
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				await Promise.race([
					Promise.all(pending.map((r) => r.completion)),
					new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Subagent cleanup did not finish within 6 seconds.")), 6000); }),
				]);
			} finally { if (timer) clearTimeout(timer); }
		},
		close() { closed = true; },
		async dispose(reason = "Session ended") {
			closed = true;
			disposal.abort(new Error(reason));
			try { await manager.cancelAll(reason); } finally { listeners.clear(); }
		},
	};
	return manager;
}
export type SubagentRunManager = ReturnType<typeof createSubagentRunManager>;
