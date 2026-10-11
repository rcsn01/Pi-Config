import { getSubagentService, registerSubagentService, type SubagentService } from "../_shared/subagent-service.ts";
import type { AgentRegistry } from "./agent-registry.ts";
import type { SubagentChildExecution } from "./child-execution.ts";
import type { RunSubagentBatchOptions, SubagentExecution, SubagentExecutionTask } from "./subagent-execution.ts";
import { createSubagentRunManager, isTerminalRun, type SubagentRunManager, type SubagentRunSnapshot } from "./subagent-runs.ts";

export interface SubagentSessionHost {
	readonly sessionId: string;
	getSessionId(): string;
	setStatus(status: string | undefined): void;
	publishCompletion(run: SubagentRunSnapshot, options: { triggerTurn: boolean }): void;
}
export type SubagentSessionEvent =
	| { type: "sessionStarted"; host: SubagentSessionHost; prepare: () => void | Promise<void> }
	| { type: "branchChanged"; host: SubagentSessionHost }
	| { type: "shutdown"; reason: string };
export interface SubagentRunControl {
	list(): SubagentRunSnapshot[];
	get(runId: string): SubagentRunSnapshot;
	wait(runIds: readonly string[], timeoutMs?: number, signal?: AbortSignal): Promise<SubagentRunSnapshot[]>;
	cancel(runIds: readonly string[], reason?: string): SubagentRunSnapshot[];
}
export interface SubagentSessionExecution {
	handle(event: SubagentSessionEvent): Promise<void>;
	spawn(tasks: readonly SubagentExecutionTask[], options: Pick<RunSubagentBatchOptions, "cwd" | "signal">): SubagentRunSnapshot[];
	readonly runs: SubagentRunControl;
}

interface ShutdownReports {
	allowed: boolean;
	ids: Set<string>;
	snapshots: Map<string, SubagentRunSnapshot>;
}
interface Owner {
	host: SubagentSessionHost;
	manager?: SubagentRunManager;
	sent: Set<string>;
	timer?: ReturnType<typeof setTimeout>;
	cancellation?: Promise<void>;
	shutdownReports?: ShutdownReports;
}
interface Retirement {
	owner: Owner;
	phase: "retiring" | "retired" | "failed";
	promise: Promise<void>;
}
interface Preparation { promise: Promise<boolean> }
interface Transition {
	kind: "transition";
	ready: boolean;
	retirement?: Retirement;
	preparation?: Preparation;
}
type State =
	| { kind: "unbound" }
	| { kind: "active"; owner: Owner }
	| Transition
	| { kind: "stopped"; operation: Promise<void>; retirement?: Retirement };

const noSession = () => new Error("No active background subagent session.");
const closed = () => new Error("Background subagent admission is closed during session cleanup.");

/** Owns background admission and effects without changing awaited execution or child lifetime. */
export function createSubagentSessionExecution(dependencies: {
	execution: SubagentExecution;
	registry: Pick<AgentRegistry, "register" | "unregister" | "load">;
	childExecution: Pick<SubagentChildExecution, "inspectTools">;
}): SubagentSessionExecution {
	let state: State = { kind: "unbound" };
	let revision = 0;
	const service: SubagentService = {
		id: "tools-subagents",
		registerAgent: (agent) => dependencies.registry.register(agent),
		unregisterAgent: (name) => dependencies.registry.unregister(name),
		loadAgents: () => dependencies.registry.load(),
		runSubagent: (options) => dependencies.execution.runSubagent(options),
		runSubagentsParallel: (options) => dependencies.execution.runSubagentsParallel(options),
		cancelBackgroundRuns,
	};
	const unregister = registerSubagentService(service);

	function usable(owner: Owner): boolean {
		if (getSubagentService() !== service) return false;
		try { return owner.host.getSessionId() === owner.host.sessionId; }
		catch { return false; }
	}
	function current(owner: Owner): boolean {
		return state.kind === "active" && state.owner === owner && usable(owner);
	}
	function clearStatus(owner: Owner): void {
		if (!usable(owner)) return;
		try { owner.host.setStatus(undefined); } catch { /* Host effects do not own results. */ }
	}
	function publish(owner: Owner, run: SubagentRunSnapshot, triggerTurn: boolean): void {
		if (run.sessionId !== owner.host.sessionId || owner.sent.has(run.runId)) return;
		if (triggerTurn ? !current(owner) : !owner.shutdownReports?.allowed || !usable(owner)) return;
		owner.sent.add(run.runId);
		try { owner.host.publishCompletion(run, { triggerTurn }); } catch { /* Keep at-most-once attempts and retrievable results. */ }
	}
	function refresh(owner: Owner): void {
		if (!current(owner) || owner.timer !== undefined) return;
		owner.timer = setTimeout(() => {
			owner.timer = undefined;
			if (!current(owner)) return;
			const runs = owner.manager!.list();
			const running = runs.filter((run) => run.status === "running" || run.status === "cancelling").length;
			const queued = runs.filter((run) => run.status === "queued").length;
			try { owner.host.setStatus(running || queued ? `${running} running · ${queued} queued` : undefined); }
			catch { /* A stale or failing UI must not escape the timer. */ }
		}, 150);
	}
	function manager(owner: Owner): SubagentRunManager {
		return owner.manager ??= createSubagentRunManager({
			execution: dependencies.execution,
			childExecution: dependencies.childExecution,
			onChange: () => refresh(owner),
			onTerminal(run) {
				const reports = owner.shutdownReports;
				if (reports?.ids.has(run.runId)) reports.snapshots.set(run.runId, run);
				publish(owner, run, true);
			},
		});
	}
	function activeOwner(): Owner {
		if (state.kind === "stopped" || (state.kind === "transition" && state.retirement && state.retirement.phase !== "retired")) throw closed();
		if (state.kind !== "active") throw noSession();
		if (!usable(state.owner)) throw closed();
		return state.owner;
	}
	function drain(retirement: Retirement, reason: string): void {
		retirement.phase = "retiring";
		// dispose closes admission and aborts subscriptions synchronously, before its first await.
		retirement.promise = (retirement.owner.manager?.dispose(reason) ?? Promise.resolve()).then(
			() => { retirement.phase = "retired"; },
			(error: unknown) => { retirement.phase = "failed"; throw error; },
		).finally(() => {
			if (state.kind !== "stopped" || state.retirement !== retirement) clearStatus(retirement.owner);
		});
	}
	function transition(reason: string, report = false, retry = true): Transition {
		if (state.kind === "transition") {
			if (retry && state.retirement?.phase === "failed") drain(state.retirement, reason);
			return state;
		}
		if (state.kind !== "active") {
			const next: Transition = { kind: "transition", ready: false };
			state = next;
			return next;
		}
		const owner = state.owner;
		if (owner.timer !== undefined) clearTimeout(owner.timer);
		owner.timer = undefined;
		owner.manager?.close();
		if (report) owner.shutdownReports = {
			allowed: true,
			ids: new Set(owner.manager?.list().filter((run) => !isTerminalRun(run)).map((run) => run.runId)),
			snapshots: new Map(),
		};
		const retirement: Retirement = { owner, phase: "retiring", promise: Promise.resolve() };
		const next: Transition = { kind: "transition", ready: true, retirement };
		state = next; // Revoke effects and controls before beginning disposal.
		drain(retirement, reason);
		return next;
	}
	function install(host: SubagentSessionHost, token: number, next: Transition): void {
		if (state !== next || token !== revision || !next.ready || getSubagentService() !== service) return;
		const owner: Owner = { host, sent: new Set() };
		if (usable(owner)) state = { kind: "active", owner };
	}
	function start(event: Extract<SubagentSessionEvent, { type: "sessionStarted" }>): Promise<void> {
		if (state.kind === "stopped") return state.operation;
		const token = ++revision;
		const next = transition("Session replaced");
		const previous = next.preparation;
		const retirement = next.retirement?.promise;
		next.ready = false;
		const preparation: Preparation = { promise: Promise.resolve(false) };
		next.preparation = preparation;
		preparation.promise = (async () => {
			await retirement;
			// A superseded, already-running preparation still owns config mutations until it settles.
			if (previous) await previous.promise.catch(() => false);
			if (state !== next || next.preparation !== preparation || getSubagentService() !== service) return false;
			await event.prepare();
			if (state !== next || next.preparation !== preparation || getSubagentService() !== service) return false;
			next.ready = true;
			return true;
		})().finally(() => {
			if (next.preparation === preparation) next.preparation = undefined;
		});
		return preparation.promise.then(() => install(event.host, token, next));
	}
	function branch(host: SubagentSessionHost): Promise<void> {
		const token = ++revision;
		if (state.kind === "stopped") {
			if (state.retirement?.owner.shutdownReports) state.retirement.owner.shutdownReports.allowed = false;
			return state.operation;
		}
		const next = transition("Session branch changed");
		if (next.retirement?.owner.shutdownReports) next.retirement.owner.shutdownReports.allowed = false;
		if (!next.ready && !next.preparation) return Promise.reject(noSession());
		const preparation = next.preparation;
		const retirement = next.retirement?.promise;
		return (async () => {
			await retirement;
			if (preparation) await preparation.promise;
			if (state === next && !next.ready) throw noSession();
			install(host, token, next);
		})();
	}
	function shutdown(reason: string): Promise<void> {
		if (state.kind === "stopped") return state.operation;
		++revision;
		const next = transition(reason, true, false);
		const retirement = next.retirement;
		const stopped: Extract<State, { kind: "stopped" }> = { kind: "stopped", operation: Promise.resolve(), retirement };
		state = stopped;
		stopped.operation = (async () => {
			try {
				await retirement?.promise;
				const reports = retirement?.owner.shutdownReports;
				if (reports) for (const id of reports.ids) {
					const run = reports.snapshots.get(id);
					if (run) publish(retirement!.owner, run, false);
				}
			} finally {
				if (retirement) clearStatus(retirement.owner);
				unregister();
			}
		})();
		return stopped.operation;
	}
	function cancelBackgroundRuns(reason: string): Promise<void> {
		if (state.kind === "stopped") return state.operation;
		if (state.kind === "transition" && state.retirement) return state.retirement.promise;
		if (state.kind !== "active") return Promise.resolve();
		const owner = state.owner;
		if (!usable(owner)) return Promise.reject(closed());
		if (owner.cancellation) return owner.cancellation;
		owner.cancellation = (owner.manager?.cancelAll(reason) ?? Promise.resolve()).finally(() => {
			if (state.kind === "active" && state.owner === owner) owner.cancellation = undefined;
		});
		return owner.cancellation;
	}

	const runs: SubagentRunControl = {
		list() {
			if (state.kind === "unbound" || (state.kind === "transition" && (!state.retirement || state.retirement.phase === "retired"))) return [];
			return activeOwner().manager?.list() ?? [];
		},
		get: (id) => manager(activeOwner()).get(id),
		wait: async (ids, timeoutMs, signal) => manager(activeOwner()).wait(ids, timeoutMs, signal),
		cancel: (ids, reason) => manager(activeOwner()).cancel(ids, reason),
	};
	return {
		runs,
		spawn(tasks, options) {
			const owner = activeOwner();
			if (owner.cancellation) throw closed();
			return manager(owner).spawn(tasks, { ...options, sessionId: owner.host.sessionId, cacheAffinitySeed: owner.host.sessionId });
		},
		handle(event) {
			switch (event.type) {
				case "sessionStarted": return start(event);
				case "branchChanged": return branch(event.host);
				case "shutdown": return shutdown(event.reason);
			}
		},
	};
}
