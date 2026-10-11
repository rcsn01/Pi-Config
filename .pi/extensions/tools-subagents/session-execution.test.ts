import { afterEach, describe, expect, it, vi } from "vitest";
import { getSubagentService, requireSubagentService } from "../_shared/subagent-service.ts";
import { createSubagentSessionExecution, type SubagentSessionHost, type SubagentSessionExecution } from "./session-execution.ts";
import { createSubagentExecution } from "./subagent-execution.ts";
import { agent, agentResult, deferred, memoryConfigStore, memoryRegistry } from "./test-harness.ts";

function harness(concurrency = 4) {
	const registry = memoryRegistry();
	const config = memoryConfigStore({ maxConcurrency: concurrency });
	const requests: any[] = [];
	const gates: ReturnType<typeof deferred<ReturnType<typeof agentResult>>>[] = [];
	const childExecution = {
		inspectTools: vi.fn(() => []),
		execute: vi.fn((request: any) => {
			requests.push(request);
			const gate = deferred<ReturnType<typeof agentResult>>();
			gates.push(gate);
			return gate.promise;
		}),
	};
	const execution = createSubagentExecution({ registry, config, childExecution });
	const session = createSubagentSessionExecution({ execution, registry, childExecution });
	const host = (sessionId = "session"): SubagentSessionHost => ({
		sessionId,
		getSessionId: vi.fn(() => sessionId),
		setStatus: vi.fn(),
		publishCompletion: vi.fn(),
	});
	const owner = host();
	const start = (prepare: () => void | Promise<void> = vi.fn(), destination = owner) => session.handle({ type: "sessionStarted", host: destination, prepare });
	const spawn = (count = 1, signal?: AbortSignal) => session.spawn(Array.from({ length: count }, (_, i) => ({ agent: "worker", task: `task ${i}` })), { cwd: process.cwd(), signal });
	const h = { session, execution, registry, config, childExecution, requests, gates, host, owner, start, spawn, shutdownError: undefined as string | undefined };
	fixtures.push(h);
	return h;
}
const fixtures: Array<{ session: SubagentSessionExecution; gates: ReturnType<typeof deferred<ReturnType<typeof agentResult>>>[]; shutdownError?: string }> = [];
afterEach(async () => {
	for (const h of fixtures.splice(0).reverse()) {
		h.gates.forEach((gate) => gate.resolve(agentResult()));
		const shutdown = h.session.handle({ type: "shutdown", reason: "test teardown" });
		if (h.shutdownError) await expect(shutdown).rejects.toThrow(h.shutdownError);
		else await shutdown;
	}
	vi.useRealTimers();
});

describe("Session-owned Subagent execution", () => {
	it("registers during loading, rejects background work until prepared, and retains an immutable accepted result", async () => {
		const h = harness();
		const service = requireSubagentService();
		service.registerAgent(agent({ name: "sibling" }));
		expect(service.loadAgents().map((a) => a.name)).toContain("sibling");
		expect(h.session.runs.list()).toEqual([]);
		expect(h.requests).toEqual([]);
		expect(() => h.spawn()).toThrow("No active background subagent session.");
		const preparation = deferred();
		const started = h.start(() => preparation.promise);
		expect(() => h.spawn()).toThrow("No active background subagent session.");
		preparation.resolve(); await started;
		const [run] = h.spawn();
		expect(run).toMatchObject({ sessionId: "session", status: "queued", cacheSessionId: expect.stringMatching(/^subagent-/) });
		expect(Object.isFrozen(run)).toBe(true);
		h.gates[0].resolve(agentResult({ output: "report" }));
		const [result] = await h.session.runs.wait([run.runId]);
		expect(result).toMatchObject({ status: "completed", result: { output: "report" } });
		expect(h.owner.publishCompletion).toHaveBeenCalledWith(result, { triggerTurn: true });
	});
});

describe("preparation and owner replacement", () => {
	it("cannot acquire readiness through a branch before startup or after failed preparation", async () => {
		const h = harness();
		await expect(h.session.handle({ type: "branchChanged", host: h.owner })).rejects.toThrow("No active background");
		await expect(h.start(() => { throw new Error("bad settings"); })).rejects.toThrow("bad settings");
		await expect(h.session.handle({ type: "branchChanged", host: h.host() })).rejects.toThrow("No active background");
		expect(() => h.spawn()).toThrow("No active background");
		await h.start();
		expect(h.spawn()).toHaveLength(1);
	});
	it.each(["before invocation", "during await"])("a branch %s preserves required preparation and selects its newest host", async (when) => {
		const h = harness(); const gate = deferred(); const prepare = vi.fn(() => gate.promise);
		const started = h.start(prepare);
		if (when === "during await") await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce());
		const destination = h.host();
		const branch = h.session.handle({ type: "branchChanged", host: destination });
		expect(() => h.spawn()).toThrow("No active background");
		gate.resolve(); await Promise.all([started, branch]);
		expect(prepare).toHaveBeenCalledOnce();
		const [run] = h.spawn(); h.gates[0].resolve(agentResult()); await h.session.runs.wait([run.runId]);
		expect(h.owner.publishCompletion).not.toHaveBeenCalled(); expect(destination.publishCompletion).toHaveBeenCalledOnce();
	});
	it("serializes started preparations and skips a superseded callback that has not begun", async () => {
		const h = harness(); const first = deferred(); const begun = deferred(); const order: string[] = [];
		const old = h.start(async () => { order.push("first"); begun.resolve(); await first.promise; order.push("first settled"); });
		await begun.promise;
		const skipped = vi.fn(); const middle = h.start(skipped);
		const latest = h.start(() => { order.push("latest"); });
		first.resolve(); await Promise.all([old, middle, latest]);
		expect(skipped).not.toHaveBeenCalled(); expect(order).toEqual(["first", "first settled", "latest"]);
		expect(h.spawn()).toHaveLength(1);
	});
	it("retires old work before invoking repeated-start preparation, including an intervening branch", async () => {
		const h = harness(); await h.start(); h.spawn(); const prepare = vi.fn();
		const restarted = h.start(prepare);
		const destination = h.host(); const branch = h.session.handle({ type: "branchChanged", host: destination });
		expect(h.requests[0].signal.aborted).toBe(true); expect(prepare).not.toHaveBeenCalled();
		h.gates[0].resolve(agentResult()); await Promise.all([restarted, branch]);
		expect(prepare).toHaveBeenCalledOnce();
		const [run] = h.spawn(); h.gates[1].resolve(agentResult()); await h.session.runs.wait([run.runId]);
		expect(destination.publishCompletion).toHaveBeenCalledOnce();
	});
	it("revokes controls, waits and callbacks immediately, and installs only the newest overlapping destination", async () => {
		vi.useFakeTimers(); const h = harness(1); await h.start(); const [run, queued] = h.spawn(2);
		const waiting = expect(h.session.runs.wait([run.runId])).rejects.toThrow("Session branch changed");
		const discarded = h.host(); const destination = h.host();
		const oldBranch = h.session.handle({ type: "branchChanged", host: discarded });
		const newBranch = h.session.handle({ type: "branchChanged", host: destination });
		expect(h.requests[0].signal.aborted).toBe(true);
		expect(() => h.spawn()).toThrow("admission is closed");
		expect(() => h.session.runs.list()).toThrow("admission is closed");
		await waiting;
		h.requests[0].onUpdate(agentResult().progress);
		h.gates[0].resolve(agentResult({ output: "old" })); await Promise.all([oldBranch, newBranch]);
		expect(h.requests).toHaveLength(1); expect(h.owner.publishCompletion).not.toHaveBeenCalled();
		expect(() => h.session.runs.get(queued.runId)).toThrow("unavailable");
		const [fresh] = h.spawn(); h.gates[1].resolve(agentResult({ output: "fresh" })); await h.session.runs.wait([fresh.runId]);
		await vi.advanceTimersByTimeAsync(150);
		expect(discarded.publishCompletion).not.toHaveBeenCalled(); expect(destination.publishCompletion).toHaveBeenCalledOnce();
		expect(discarded.setStatus).not.toHaveBeenCalled();
	});
});

describe("terminal shutdown", () => {
	it("joins branch retirement without reporting the old branch or reopening admission", async () => {
		const h = harness(); await h.start(); h.spawn();
		const branch = h.session.handle({ type: "branchChanged", host: h.host() });
		const shutdown = h.session.handle({ type: "shutdown", reason: "quit" });
		h.gates[0].resolve(agentResult()); await Promise.all([branch, shutdown]);
		expect(h.owner.publishCompletion).not.toHaveBeenCalled(); expect(getSubagentService()).toBeUndefined();
		await h.start(); expect(() => h.spawn()).toThrow("admission is closed");
	});
	it("reports cancellation without waking the parent and clears all owner timers", async () => {
		vi.useFakeTimers(); const h = harness(); await h.start(); const [run] = h.spawn();
		const shutdown = h.session.handle({ type: "shutdown", reason: "quit" });
		expect(h.requests[0].signal.aborted).toBe(true);
		expect(h.session.handle({ type: "shutdown", reason: "again" })).toBe(shutdown);
		h.gates[0].resolve(agentResult({ output: "partial" })); await shutdown;
		expect(h.owner.publishCompletion).toHaveBeenCalledWith(expect.objectContaining({ runId: run.runId, status: "cancelled", result: expect.objectContaining({ output: "partial" }) }), { triggerTurn: false });
		expect(h.owner.setStatus).toHaveBeenCalledWith(undefined); expect(vi.getTimerCount()).toBe(0);
		expect(getSubagentService()).toBeUndefined();
	});
	it("revokes final reporting when a branch callback arrives after shutdown began", async () => {
		const h = harness(); await h.start(); h.spawn();
		const shutdown = h.session.handle({ type: "shutdown", reason: "quit" });
		const branch = h.session.handle({ type: "branchChanged", host: h.host() });
		h.gates[0].resolve(agentResult()); await Promise.all([shutdown, branch]);
		expect(h.owner.publishCompletion).not.toHaveBeenCalled();
	});
	it.each(["resolve", "reject"])("shuts down without waiting for preparation and cannot reactivate after its late %s", async (outcome) => {
		const h = harness(); const gate = deferred(); const begun = deferred();
		const start = h.start(() => { begun.resolve(); return gate.promise; });
		const observed = outcome === "reject" ? expect(start).rejects.toThrow("late failure") : start;
		await begun.promise;
		await h.session.handle({ type: "shutdown", reason: "quit" });
		expect(getSubagentService()).toBeUndefined(); expect(h.requests).toEqual([]);
		if (outcome === "reject") gate.reject(new Error("late failure")); else gate.resolve();
		await observed; expect(() => h.spawn()).toThrow("admission is closed");
	});
	it("captures final snapshots even when timestamp-tied retention evicts an older pending record", async () => {
		vi.useFakeTimers(); vi.setSystemTime(1000); const h = harness(); await h.start(); const [old] = h.spawn();
		for (let i = 0; i < 100; i++) {
			const [run] = h.spawn(); h.gates[i + 1].resolve(agentResult()); await h.session.runs.wait([run.runId]);
		}
		vi.mocked(h.owner.publishCompletion).mockClear();
		const shutdown = h.session.handle({ type: "shutdown", reason: "quit" });
		h.gates[0].resolve(agentResult()); await shutdown;
		expect(h.owner.publishCompletion).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ runId: old.runId, status: "cancelled" }), { triggerTurn: false });
	});
});

describe("Plan cancellation and failed retirement", () => {
	it("temporarily gates and coalesces cancellation even before the lazy manager exists", async () => {
		vi.useFakeTimers(); const h = harness(); await h.start();
		const service = requireSubagentService();
		const drain = service.cancelBackgroundRuns!("Entering Plan Mode");
		expect(service.cancelBackgroundRuns!("again")).toBe(drain);
		expect(() => h.spawn()).toThrow("admission is closed");
		expect(h.session.runs.list()).toEqual([]); expect(h.requests).toEqual([]);
		expect(vi.getTimerCount()).toBe(0);
		await drain;
		expect(h.spawn()).toHaveLength(1);
	});
	it("coalesces temporary cancellation, keeps controls and reports available, then reopens the same owner", async () => {
		const h = harness(); await h.start(); const [run] = h.spawn(); const service = requireSubagentService();
		const drain = service.cancelBackgroundRuns!("Entering Plan Mode");
		expect(service.cancelBackgroundRuns!("again")).toBe(drain);
		expect(() => h.spawn()).toThrow("admission is closed");
		expect(h.session.runs.get(run.runId).status).toBe("cancelling");
		h.gates[0].resolve(agentResult()); await drain;
		expect(h.session.runs.get(run.runId).status).toBe("cancelled");
		expect(h.owner.publishCompletion).toHaveBeenCalledWith(expect.objectContaining({ status: "cancelled" }), { triggerTurn: true });
		expect(h.spawn()).toHaveLength(1);
	});
	it("disposal aborts subscriptions immediately without waiting sequentially behind Plan cancellation", async () => {
		const h = harness(); await h.start(); const [run] = h.spawn(); const service = requireSubagentService();
		const cancellation = service.cancelBackgroundRuns!("Plan");
		const waiting = expect(h.session.runs.wait([run.runId])).rejects.toThrow("Session branch changed");
		const branch = h.session.handle({ type: "branchChanged", host: h.host() });
		const joiningCancellation = service.cancelBackgroundRuns!("Plan again");
		await waiting; expect(() => h.spawn()).toThrow("admission is closed");
		h.gates[0].resolve(agentResult()); await Promise.all([branch, cancellation, joiningCancellation]);
		expect(h.spawn()).toHaveLength(1);
	});
	it("Plan timeout retains records and releases only its temporary admission gate", async () => {
		vi.useFakeTimers(); const h = harness(); await h.start(); const [run] = h.spawn();
		const drain = expect(requireSubagentService().cancelBackgroundRuns!("Plan")).rejects.toThrow("within 6 seconds");
		await vi.advanceTimersByTimeAsync(6000); await drain;
		expect(h.session.runs.get(run.runId).status).toBe("cancelling");
		expect(h.spawn()).toHaveLength(1);
	});
	it("retains a failed branch retirement, rejects Plan cleanup, and retries only on an explicit later transition", async () => {
		vi.useFakeTimers(); const h = harness(); await h.start(); h.spawn();
		const branch = expect(h.session.handle({ type: "branchChanged", host: h.host() })).rejects.toThrow("within 6 seconds");
		await vi.advanceTimersByTimeAsync(6000); await branch;
		expect(() => h.spawn()).toThrow("admission is closed");
		await expect(requireSubagentService().cancelBackgroundRuns!("Plan")).rejects.toThrow("within 6 seconds");
		h.gates[0].resolve(agentResult());
		await h.session.handle({ type: "branchChanged", host: h.host() });
		expect(h.spawn()).toHaveLength(1); expect(h.owner.publishCompletion).not.toHaveBeenCalled();
	});
	it("shutdown after failed retirement unregisters without another drain, retry or replacement", async () => {
		vi.useFakeTimers(); const h = harness(); await h.start(); h.spawn();
		const branch = expect(h.session.handle({ type: "branchChanged", host: h.host() })).rejects.toThrow("within 6 seconds");
		await vi.advanceTimersByTimeAsync(6000); await branch;
		h.shutdownError = "within 6 seconds";
		const shutdown = h.session.handle({ type: "shutdown", reason: "quit" });
		await expect(shutdown).rejects.toThrow(h.shutdownError);
		expect(h.session.handle({ type: "shutdown", reason: "again" })).toBe(shutdown);
		expect(vi.getTimerCount()).toBe(0); expect(getSubagentService()).toBeUndefined();
		await expect(h.start()).rejects.toThrow(h.shutdownError); expect(() => h.spawn()).toThrow("admission is closed");
	});
	it("shutdown timeout remains terminal and still removes registration and status", async () => {
		vi.useFakeTimers(); const h = harness(); await h.start(); h.spawn(); h.shutdownError = "within 6 seconds";
		const shutdown = expect(h.session.handle({ type: "shutdown", reason: "quit" })).rejects.toThrow(h.shutdownError);
		await vi.advanceTimersByTimeAsync(6000); await shutdown;
		expect(getSubagentService()).toBeUndefined(); expect(h.owner.setStatus).toHaveBeenCalledWith(undefined);
		expect(h.owner.publishCompletion).not.toHaveBeenCalled(); expect(() => h.spawn()).toThrow("admission is closed");
	});
});

describe("host currency and best-effort effects", () => {
	it("a replacement facade blocks old admissions, retrieval and effects and survives stale cleanup", async () => {
		vi.useFakeTimers(); const old = harness(); await old.start(); const [run] = old.spawn();
		const replacement = harness(); const facade = requireSubagentService(); await replacement.start();
		expect(() => old.spawn()).toThrow("admission is closed"); expect(() => old.session.runs.get(run.runId)).toThrow("admission is closed");
		old.gates[0].resolve(agentResult()); await old.session.handle({ type: "shutdown", reason: "reload" });
		await vi.advanceTimersByTimeAsync(150);
		expect(requireSubagentService()).toBe(facade); expect(old.owner.publishCompletion).not.toHaveBeenCalled(); expect(old.owner.setStatus).not.toHaveBeenCalled();
	});
	it.each(["throw", "different session"])("a stale getter %s cannot escape a timer, report, retrieval or shutdown", async (kind) => {
		vi.useFakeTimers(); const h = harness(); await h.start(); const [run] = h.spawn();
		vi.mocked(h.owner.getSessionId).mockImplementation(() => { if (kind === "throw") throw new Error("stale context"); return "different"; });
		await vi.advanceTimersByTimeAsync(150);
		expect(() => h.session.runs.get(run.runId)).toThrow("admission is closed");
		h.gates[0].resolve(agentResult()); await h.session.handle({ type: "shutdown", reason: "quit" });
		expect(h.owner.setStatus).not.toHaveBeenCalled(); expect(h.owner.publishCompletion).not.toHaveBeenCalled();
	});
	it.each(["completed", "failed", "cancelled"])("one attempted %s report survives a failing synchronous host", async (status) => {
		const h = harness(); await h.start(); const [run] = h.spawn();
		vi.mocked(h.owner.publishCompletion).mockImplementation(() => { throw new Error("send failed"); });
		if (status === "cancelled") h.session.runs.cancel([run.runId]);
		h.gates[0].resolve(agentResult({ progress: { ...agentResult().progress, status: status === "failed" ? "failed" : "completed" } }));
		const [terminal] = await h.session.runs.wait([run.runId]);
		expect(terminal.status).toBe(status); expect(h.session.runs.get(run.runId)).toEqual(terminal);
		await h.session.handle({ type: "shutdown", reason: "quit" }); expect(h.owner.publishCompletion).toHaveBeenCalledOnce();
	});
	it("one 150 ms refresh counts cancelling as running and contains UI failure", async () => {
		vi.useFakeTimers(); const h = harness(1); await h.start(); const [first] = h.spawn(2);
		h.requests[0].onUpdate(agentResult().progress); h.session.runs.cancel([first.runId]);
		expect(vi.getTimerCount()).toBe(1);
		vi.mocked(h.owner.setStatus).mockImplementation(() => { throw new Error("UI gone"); });
		await vi.advanceTimersByTimeAsync(150);
		expect(h.owner.setStatus).toHaveBeenCalledWith("1 running · 1 queued");
		h.gates[0].resolve(agentResult()); await h.session.runs.wait([first.runId]);
	});
	it("all extension work uses the same execution budget, with launch settings fixed while queued", async () => {
		const h = harness(1); await h.start(); const [background] = h.spawn();
		const foreground = requireSubagentService().runSubagent({ agent: "worker", task: "foreground", cwd: process.cwd() });
		h.config.document = { maxConcurrency: 1, defaultModel: "openai/changed" };
		expect(h.requests).toHaveLength(1);
		h.gates[0].resolve(agentResult()); await h.session.runs.wait([background.runId]);
		await vi.waitFor(() => expect(h.requests).toHaveLength(2));
		expect(h.requests[1].launch.model).toBe("openai/test-model");
		h.gates[1].resolve(agentResult()); await foreground;
	});
	it("delegates unknown-ID and malformed-wait validation without losing precedence", async () => {
		const h = harness(); await h.start(); const abort = new AbortController(); abort.abort(new Error("caller aborted"));
		await expect(h.session.runs.wait([], -1, abort.signal)).rejects.toThrow("1–32 unique IDs");
		await expect(h.session.runs.wait(["missing"], -1, abort.signal)).rejects.toThrow("unavailable");
		expect(() => h.session.runs.cancel(["missing", "missing"])).toThrow("1–32 unique IDs");
		const [run] = h.spawn();
		await expect(h.session.runs.wait([run.runId], -1, abort.signal)).rejects.toThrow("integer from 0");
		await expect(h.session.runs.wait([run.runId], 0, abort.signal)).rejects.toThrow("caller aborted");
		expect(h.requests[0].signal.aborted).toBe(false);
	});
});
