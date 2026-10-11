import { describe, expect, it, vi } from "vitest";
import { createSubagentSessionExecution } from "../tools-subagents/session-execution.ts";
import { createSubagentExecution } from "../tools-subagents/subagent-execution.ts";
import { agent, agentResult, memoryConfigStore, memoryRegistry } from "../tools-subagents/test-harness.ts";
import { activePlanningEntry, createHarness, createProfileDependencies, deferred, normalModel } from "./test-harness.ts";

async function fixture(active = false) {
	const stores = createProfileDependencies();
	const plan = createHarness({ branch: active ? [activePlanningEntry()] : [], model: normalModel, availableModels: [normalModel], dependencies: stores.dependencies });
	const registry = memoryRegistry([
		agent({ name: "explorer", tools: ["read", "repo_query"] }),
		agent({ name: "researcher", tools: ["ddg_search", "ddg_fetch"] }),
		agent({ name: "tool-less", tools: [] }),
		agent({ name: "alternate", tools: ["read", "grep", "find", "ls", "repo_query", "ddg_search", "ddg_fetch"] }),
		agent({ name: "default", tools: [] }),
		agent({ name: "mutating", tools: ["safe_bash"] }),
		agent({ name: "shell", tools: ["bash"] }),
		agent({ name: "uppercase", tools: ["Read"] }),
		agent({ name: "unknown-capability", tools: ["unknown"] }),
	]);
	const outcome = deferred<ReturnType<typeof agentResult>>(); const aborted = deferred<void>();
	const childExecution = {
		inspectTools: () => [],
		execute: vi.fn((request: any) => {
			request.signal.addEventListener("abort", () => aborted.resolve(), { once: true });
			return outcome.promise;
		}),
	};
	const execution = createSubagentExecution({ registry, config: memoryConfigStore({ maxConcurrency: 1 }), childExecution });
	const session = createSubagentSessionExecution({ execution, registry, childExecution });
	await session.handle({ type: "sessionStarted", host: {
		sessionId: plan.ctx.sessionManager.getSessionId(),
		getSessionId: () => plan.ctx.sessionManager.getSessionId(),
		setStatus: vi.fn(), publishCompletion: vi.fn(),
	}, prepare() {} });
	await plan.emit("session_start", { type: "session_start", reason: "startup" });
	const spawn = () => session.spawn([{ agent: "explorer", task: "inspect" }], { cwd: process.cwd() });
	const close = async () => {
		outcome.resolve(agentResult());
		try { await plan.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }); }
		finally { await session.handle({ type: "shutdown", reason: "test teardown" }); }
	};
	return { session, plan, stores, outcome, aborted, spawn, close };
}

describe("Plan entry through the real Session-owned Subagent facade", () => {
	it.each([false, true])("awaits real child drain before defaults capture and commit, timeout=%s", async (timesOut) => {
		const h = await fixture();
		if (timesOut) vi.useFakeTimers();
		try {
			const [run] = h.spawn();
			const entering = h.plan.shortcuts.get("shift+tab").handler(h.plan.ctx);
			await h.aborted.promise;
			expect(h.stores.capture).not.toHaveBeenCalled();
			expect(h.plan.appendedEntries.some((entry) => entry.data?.mode === "plan")).toBe(false);
			expect(() => h.spawn()).toThrow("admission is closed");
			if (timesOut) await vi.advanceTimersByTimeAsync(6000);
			else h.outcome.resolve(agentResult({ output: "cancelled output" }));
			await entering;
			if (timesOut) {
				expect(h.stores.capture).not.toHaveBeenCalled();
				expect(h.plan.appendedEntries.some((entry) => entry.data?.mode === "plan")).toBe(false);
				expect(h.plan.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("within 6 seconds"), "error");
				expect(h.session.runs.get(run.runId).status).toBe("cancelling");
			} else {
				expect(h.stores.capture).toHaveBeenCalledOnce();
				expect(h.plan.getActiveToolNames()).toContain("plan_bash");
				expect(h.session.runs.get(run.runId)).toMatchObject({ status: "cancelled", result: { output: "cancelled output" } });
			}
		} finally { await h.close(); vi.useRealTimers(); }
	});
	it.each(["entering", "active"])("preserves the complete capability taxonomy in %s Plan Mode for both execution modes", async (phase) => {
		const h = await fixture(phase === "active");
		let entering: Promise<void> | undefined;
		try {
			if (phase === "entering") {
				h.spawn(); entering = h.plan.shortcuts.get("shift+tab").handler(h.plan.ctx); await h.aborted.promise;
			}
			const allowed = [
				{ tasks: [{ agent: "explorer" }, { agent: "researcher" }] },
				{ agent: "explorer" }, { tasks: [{ agent: "tool-less" }] }, { tasks: [{ agent: "alternate" }] },
				{ tasks: [{ agent: "tool-less" }], agent: "missing" },
			];
			const blocked = [
				{ agent: "default" }, { agent: "missing" }, { tasks: [] }, { tasks: [], agent: "explorer" },
				{ tasks: [{ agent: "mutating" }] }, { tasks: [{ agent: "shell" }] }, { tasks: [{ agent: "uppercase" }] },
				{ tasks: [{ agent: "unknown-capability" }] }, { tasks: [{ agent: "explorer" }, { agent: "default" }] },
			];
			for (const background of [false, true]) {
				for (const input of allowed) expect((await h.plan.emit("tool_call", { type: "tool_call", toolName: "subagent", input: { ...input, background } }))[0]).toBeUndefined();
				for (const input of blocked) expect((await h.plan.emit("tool_call", { type: "tool_call", toolName: "subagent", input: { ...input, background } }))[0]).toMatchObject({ block: true });
			}
		} finally { h.outcome.resolve(agentResult()); await entering; await h.close(); }
	});
});
