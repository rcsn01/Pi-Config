import { describe, expect, it, vi } from "vitest";
import { createSubagentExecutionScheduler } from "./execution-scheduler.ts";

import { deferred } from "./test-harness.ts";
describe("shared FIFO execution scheduler", () => {
	it("shares slots across invocations and admits queued work in FIFO order", async () => {
		const scheduler = createSubagentExecutionScheduler(2);
		const gates = Array.from({ length: 4 }, () => deferred());
		const started: number[] = [];
		let active = 0, peak = 0;
		const runs = gates.map((gate, i) => scheduler.run(async () => {
			started.push(i); active++; peak = Math.max(peak, active);
			await gate.promise; active--; return i;
		}));
		expect(started).toEqual([0, 1]);
		gates[1].resolve(); await runs[1];
		expect(started).toEqual([0, 1, 2]);
		gates[0].resolve(); await runs[0];
		expect(started).toEqual([0, 1, 2, 3]);
		gates[2].resolve(); gates[3].resolve();
		expect(await Promise.all(runs)).toEqual([0, 1, 2, 3]);
		expect(peak).toBe(2);
	});
	it("removes aborted queued requests and releases rejected slots", async () => {
		const scheduler = createSubagentExecutionScheduler(1);
		const gate = deferred();
		const first = scheduler.run(() => gate.promise);
		const failed = expect(first).rejects.toThrow("failure");
		const controller = new AbortController();
		const never = vi.fn();
		const queued = scheduler.run(never, controller.signal);
		const cancelled = expect(queued).rejects.toThrow("cancel");
		controller.abort(new Error("cancel"));
		const next = scheduler.run(async () => 42);
		gate.reject(new Error("failure"));
		await failed; await cancelled;
		expect(await next).toBe(42); expect(never).not.toHaveBeenCalled();
	});
	it("lowering a limit leaves active work alone and raising it drains the queue", async () => {
		const scheduler = createSubagentExecutionScheduler(2);
		const gates = [deferred(), deferred(), deferred()];
		const started: number[] = [];
		const runs = gates.map((g, i) => scheduler.run(async () => { started.push(i); await g.promise; }));
		scheduler.setLimit(1);
		gates[0].resolve(); await runs[0]; expect(started).toEqual([0, 1]);
		scheduler.setLimit(2); expect(started).toEqual([0, 1, 2]);
		gates[1].resolve(); gates[2].resolve(); await Promise.all(runs);
	});
});
