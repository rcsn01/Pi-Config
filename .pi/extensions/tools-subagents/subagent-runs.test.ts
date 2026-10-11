import { describe, expect, it } from "vitest";
import { agentResult } from "./test-harness.ts";
import { runHarness } from "./background-test-harness.ts";

describe("background run manager", () => {
	it("returns ordered immutable handles immediately, completes independently, and retains launch data", async () => {
		const h = runHarness();
		const handles = h.spawn(2);
		expect(handles.map((r) => r.status)).toEqual(["queued", "queued"]);
		expect(h.requests).toHaveLength(2);
		h.gates[1].resolve(agentResult({ output: "second" }));
		const [second] = await h.manager.wait([handles[1].runId]);
		expect(second.status).toBe("completed");
		expect(h.manager.get(handles[0].runId).status).toBe("running");
		expect(handles[1].status).toBe("queued");
		expect(Object.isFrozen(second.result?.progress)).toBe(true);
		h.gates[0].resolve(agentResult({ output: "first" }));
		expect((await h.manager.wait(handles.map((r) => r.runId))).map((r) => r.result?.output)).toEqual(["first", "second"]);
		expect(h.terminal).toHaveBeenCalledTimes(2);
	});
	it("validates the whole invocation before admitting records or processes", () => {
		const h = runHarness();
		const options = { cwd: process.cwd(), sessionId: "session" };
		for (const task of [{ agent: "missing", task: "bad" }, { agent: "worker", task: " " }, { agent: "worker", task: "bad", cwd: "/not-a-real-subagent-directory" }]) {
			expect(() => h.manager.spawn([{ agent: "worker", task: "valid" }, task], options)).toThrow();
		}
		h.child.inspectTools.mockReturnValue([{ kind: "unmapped-tool", tool: "custom" }]);
		expect(() => h.spawn()).toThrow(/unmapped/);
		expect(h.manager.list()).toEqual([]); expect(h.child.execute).not.toHaveBeenCalled();
	});
	it("checks abort before admission and enforces task and unfinished-run capacities", async () => {
		const h = runHarness(1);
		const abort = new AbortController(); abort.abort(new Error("pre-aborted"));
		expect(() => h.spawn(1, abort.signal)).toThrow("pre-aborted");
		expect(() => h.spawn(33)).toThrow(/32/);
		h.spawn(32); h.spawn(32);
		expect(() => h.spawn()).toThrow(/64/);
		// Resolve running work and cancel all queued requests without starting them.
		const cleanup = h.manager.cancelAll("done");
		h.gates[0].resolve(agentResult()); await cleanup;
		expect(h.requests).toHaveLength(1);
		expect(h.manager.list().every((r) => r.status === "cancelled")).toBe(true);
	});
	it("owns cancellation independently of spawning and waiting signals", async () => {
		const h = runHarness(1);
		const parent = new AbortController(); const [first, second] = h.spawn(2, parent.signal);
		parent.abort(); expect(h.requests[0].signal.aborted).toBe(false);
		const waiting = new AbortController();
		const wait = h.manager.wait([first.runId], 30000, waiting.signal);
		const rejected = expect(wait).rejects.toThrow("wait cancelled"); waiting.abort(new Error("wait cancelled")); await rejected;
		expect(h.requests[0].signal.aborted).toBe(false);
		h.manager.cancel([second.runId]);
		expect((await h.manager.wait([second.runId]))[0].status).toBe("cancelled");
		expect(h.requests).toHaveLength(1);
		h.manager.cancel([first.runId]); expect(h.manager.get(first.runId).status).toBe("cancelling");
		h.gates[0].resolve(agentResult({ output: "partial" }));
		const [cancelled] = await h.manager.wait([first.runId]);
		expect(cancelled.status).toBe("cancelled"); expect(cancelled.result?.output).toBe("partial");
		expect(h.manager.cancel([first.runId])[0]).toEqual(cancelled);
	});
	it("retains rejections without inventing results and preserves completed-before-cancel outcomes", async () => {
		const h = runHarness(); const [a, b] = h.spawn(2);
		h.gates[0].reject(new Error("spawn failed")); h.gates[1].resolve(agentResult());
		const [failed, completed] = await h.manager.wait([a.runId, b.runId]);
		expect(failed).toMatchObject({ status: "failed", error: "spawn failed" }); expect(failed.result).toBeUndefined();
		expect(h.manager.cancel([b.runId])[0]).toEqual(completed);
	});
	it("wait timeout only polls and multi-ID cancellation is atomic", async () => {
		const h = runHarness(); const [a] = h.spawn();
		expect((await h.manager.wait([a.runId], 1))[0].status).toBe("running");
		expect(() => h.manager.cancel([a.runId, "missing"])).toThrow(/unavailable/);
		expect(() => h.manager.cancel([a.runId, a.runId])).toThrow(/unique/);
		expect(h.requests[0].signal.aborted).toBe(false);
		h.gates[0].resolve(agentResult()); await h.manager.wait([a.runId]);
	});
	it("evicts only oldest terminal records and makes disposed wait subscriptions reject", async () => {
		const h = runHarness(); let first = "";
		for (let i = 0; i < 101; i++) {
			const [handle] = h.spawn(); if (!i) first = handle.runId;
			h.gates[i].resolve(agentResult()); await h.manager.wait([handle.runId]);
		}
		expect(h.manager.list()).toHaveLength(100); expect(() => h.manager.get(first)).toThrow(/unavailable/);
		const [last] = h.spawn();
		const wait = expect(h.manager.wait([last.runId])).rejects.toThrow("dispose");
		const disposal = h.manager.dispose("dispose");
		h.gates[101].resolve(agentResult()); await disposal; await wait;
		expect(() => h.spawn()).toThrow(/closed/);
	});
});

describe("background terminal rejection edge cases", () => {
	it("treats even an undefined rejection as failure rather than success", async () => {
		const h = runHarness(); const [run] = h.spawn(); h.gates[0].reject(undefined);
		expect((await h.manager.wait([run.runId]))[0]).toMatchObject({ status: "failed", error: "undefined" });
	});
	it("honors a local batch limit and cancels locally queued work without waiting for a running sibling", async () => {
		const h = runHarness(4);
		const runs = h.manager.spawn([{ agent: "worker", task: "one" }, { agent: "worker", task: "two" }], { cwd: process.cwd(), sessionId: "session", maxConcurrency: 1 });
		expect(h.requests).toHaveLength(1);
		h.manager.cancel([runs[1].runId]); expect((await h.manager.wait([runs[1].runId]))[0].status).toBe("cancelled");
		h.gates[0].resolve(agentResult()); await h.manager.wait([runs[0].runId]); expect(h.requests).toHaveLength(1);
	});
});
