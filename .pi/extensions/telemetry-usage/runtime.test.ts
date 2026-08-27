import { afterEach, describe, expect, it, vi } from "vitest";
import { buildGlobalUsageSnapshot } from "../_shared/global-usage.ts";
import {
	createTelemetryUsageRuntime,
	getPersistentTelemetryUsageRuntime,
	releasePersistentTelemetryUsageRuntime,
	resetPersistentTelemetryUsageRuntimeForTests,
} from "./runtime.ts";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
	return { promise, resolve, reject };
}

function fakeServer(start = async () => ({ url: "http://localhost:1/#token=test" })) {
	return { start: vi.fn(start), close: vi.fn(async () => {}) };
}

afterEach(async () => {
	vi.useRealTimers();
	await resetPersistentTelemetryUsageRuntimeForTests();
});

describe("telemetry usage runtime", () => {
	it("starts once, launches an initial scan, and records progress and payload", async () => {
		const scanResult = deferred<ReturnType<typeof buildGlobalUsageSnapshot>>();
		let progress: ((loaded: number, total: number) => void) | undefined;
		const scan = vi.fn((options: any) => {
			progress = options.onProgress;
			return scanResult.promise;
		});
		const server = fakeServer();
		const runtime = createTelemetryUsageRuntime({ scan, serverFactory: () => server });

		const first = await runtime.start();
		const second = await runtime.start();
		expect(first).toEqual(second);
		expect(server.start).toHaveBeenCalledOnce();
		expect(scan).toHaveBeenCalledOnce();
		expect(runtime.getState().phase).toBe("scanning");
		progress?.(2, 5);
		expect(runtime.getState().progress).toEqual({ loaded: 2, total: 5 });

		const snapshot = buildGlobalUsageSnapshot([]);
		snapshot.scannedAt = 55;
		scanResult.resolve(snapshot);
		await runtime.refresh();
		expect(runtime.getState()).toMatchObject({ phase: "ready", data: { scannedAt: 55, sessionCount: 0 } });
	});

	it("deduplicates refreshes and keeps stale data when a later scan fails", async () => {
		const secondScan = deferred<ReturnType<typeof buildGlobalUsageSnapshot>>();
		const snapshot = buildGlobalUsageSnapshot([]);
		snapshot.scannedAt = 10;
		const scan = vi.fn()
			.mockResolvedValueOnce(snapshot)
			.mockImplementationOnce(() => secondScan.promise);
		const runtime = createTelemetryUsageRuntime({ scan, serverFactory: () => fakeServer() });
		await runtime.start();
		await Promise.resolve();
		await Promise.resolve();
		expect(runtime.getState().phase).toBe("ready");

		const one = runtime.refresh();
		const two = runtime.refresh();
		expect(one).toBe(two);
		expect(scan).toHaveBeenCalledTimes(2);
		expect(runtime.getState()).toMatchObject({ phase: "scanning", data: { scannedAt: 10 } });
		secondScan.reject(new Error("disk unavailable"));
		await one;
		expect(runtime.getState()).toMatchObject({
			phase: "error",
			diagnostic: "disk unavailable",
			data: { scannedAt: 10 },
		});
	});

	it("invalidates pending work and closes a server that is still starting", async () => {
		const startResult = deferred<{ url: string }>();
		const server = fakeServer(() => startResult.promise);
		const scan = vi.fn(async () => buildGlobalUsageSnapshot([]));
		const runtime = createTelemetryUsageRuntime({ scan, serverFactory: () => server });
		const starting = runtime.start();
		const closing = runtime.close();
		startResult.resolve({ url: "http://localhost:1/#token=test" });
		await expect(starting).rejects.toThrow("closed while starting");
		await closing;
		expect(server.close).toHaveBeenCalledOnce();
		expect(scan).not.toHaveBeenCalled();
		expect(runtime.getState()).toEqual({ phase: "idle" });
	});

	it("shares a persistent runtime and closes an unclaimed active server after the grace period", async () => {
		vi.useFakeTimers();
		const server = fakeServer();
		const options = {
			scan: vi.fn(async () => buildGlobalUsageSnapshot([])),
			serverFactory: () => server,
		};
		const runtime = getPersistentTelemetryUsageRuntime(options);
		expect(getPersistentTelemetryUsageRuntime()).toBe(runtime);
		await runtime.start();
		releasePersistentTelemetryUsageRuntime(runtime);
		await vi.advanceTimersByTimeAsync(29_999);
		expect(server.close).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(server.close).toHaveBeenCalledOnce();
	});
});
