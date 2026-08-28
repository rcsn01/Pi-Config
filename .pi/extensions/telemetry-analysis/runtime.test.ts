import { afterEach, describe, expect, it, vi } from "vitest";
import { createAnalysisRuntime, getPersistentAnalysisRuntime, persistentAnalysisRuntime } from "./runtime.ts";

afterEach(async () => persistentAnalysisRuntime.resetForTests());

function fakeServer() {
	return { start: vi.fn(async () => ({ url: "http://localhost:1/#token=test" })), close: vi.fn(async () => {}) };
}

describe("analysis runtime", () => {
	it("shares the active runtime and records across extension instances", async () => {
		const first = getPersistentAnalysisRuntime();
		const url = (await first.start()).url;
		first.observe({ type: "request", provider: "openai", api: "openai-responses", model: "gpt", payload: { input: "kept" } });

		const second = getPersistentAnalysisRuntime();
		expect(second).toBe(first);
		expect((await second.start()).url).toBe(url);
		expect(second.isActive()).toBe(true);
		expect(second.getSummary().records).toHaveLength(1);
	});

	it("keeps its close-during-start error at the dashboard seam", async () => {
		let rejectStart!: (error: unknown) => void;
		const server = {
			start: vi.fn(() => new Promise<{ url: string }>((_resolve, reject) => { rejectStart = reject; })),
			close: vi.fn(async () => rejectStart(new Error("listen cancelled"))),
		};
		const runtime = createAnalysisRuntime({ serverFactory: () => server });

		const starting = runtime.start();
		const closing = runtime.close();
		await expect(starting).rejects.toThrow("Analysis server was closed while starting.");
		await closing;
	});

	it("does not retain events before successful activation and starts idempotently", async () => {
		const server = fakeServer();
		const runtime = createAnalysisRuntime({ serverFactory: () => server });
		runtime.observe({ type: "request", provider: "openai", api: "openai-responses", model: "gpt", payload: { input: "early" } });
		expect(runtime.getSummary().records).toHaveLength(0);
		expect((await runtime.start()).url).toContain("#token=");
		await runtime.start();
		expect(server.start).toHaveBeenCalledOnce();
	});

	it("forwards capture diagnostics to the current notifier", async () => {
		const originalNotify = vi.fn();
		const currentNotify = vi.fn();
		const runtime = createAnalysisRuntime({
			serverFactory: () => fakeServer(),
			maxRecordBytes: 1,
			notify: originalNotify,
		});
		await runtime.start();
		runtime.setNotify(currentNotify);
		runtime.observe({ type: "request", provider: "openai", api: "x", model: "x", payload: {} });
		expect(originalNotify).not.toHaveBeenCalled();
		expect(currentNotify).toHaveBeenCalledOnce();
		expect(currentNotify).toHaveBeenCalledWith(expect.stringContaining("memory limit"));
	});

	it("revokes state and closes the server at shutdown", async () => {
		const server = fakeServer();
		const runtime = createAnalysisRuntime({ serverFactory: () => server });
		await runtime.start();
		runtime.observe({ type: "request", provider: "openai", api: "x", model: "x", payload: {} });
		await runtime.close();
		expect(server.close).toHaveBeenCalledOnce();
		expect(runtime.getSummary().activatedAt).toBeUndefined();
		expect(runtime.getSummary().records).toEqual([]);
	});
});
