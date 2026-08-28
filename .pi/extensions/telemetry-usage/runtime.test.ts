import { afterEach, describe, expect, it, vi } from "vitest";
import { buildGlobalUsageSnapshot } from "../_shared/global-usage.ts";
import { createTelemetryUsageRuntime, persistentUsageRuntime } from "./runtime.ts";

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
	await persistentUsageRuntime.resetForTests();
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

	it("keeps its close-during-start error at the dashboard seam", async () => {
		let rejectStart!: (error: unknown) => void;
		const server = {
			start: vi.fn(() => new Promise<{ url: string }>((_resolve, reject) => { rejectStart = reject; })),
			close: vi.fn(async () => rejectStart(new Error("listen cancelled"))),
		};
		const scan = vi.fn(async () => buildGlobalUsageSnapshot([]));
		const runtime = createTelemetryUsageRuntime({ scan, serverFactory: () => server });

		const starting = runtime.start();
		const closing = runtime.close();
		await expect(starting).rejects.toThrow("Telemetry usage server was closed while starting.");
		await closing;
		expect(scan).not.toHaveBeenCalled();
	});

	it("invalidates a pending scan when the dashboard closes", async () => {
		const scanResult = deferred<ReturnType<typeof buildGlobalUsageSnapshot>>();
		const server = fakeServer();
		const scan = vi.fn(() => scanResult.promise);
		const runtime = createTelemetryUsageRuntime({ scan, serverFactory: () => server });
		await runtime.start();
		expect(runtime.getState().phase).toBe("scanning");

		await runtime.close();
		scanResult.resolve(buildGlobalUsageSnapshot([]));
		await scanResult.promise;
		await Promise.resolve();

		expect(server.close).toHaveBeenCalledOnce();
		expect(runtime.getState()).toEqual({ phase: "idle" });
	});

	it("ignores an old scan that settles after a restarted dashboard", async () => {
		const oldScan = deferred<ReturnType<typeof buildGlobalUsageSnapshot>>();
		const newScan = deferred<ReturnType<typeof buildGlobalUsageSnapshot>>();
		const scan = vi.fn()
			.mockImplementationOnce(() => oldScan.promise)
			.mockImplementationOnce(() => newScan.promise);
		const runtime = createTelemetryUsageRuntime({ scan, serverFactory: () => fakeServer() });
		await runtime.start();
		await runtime.close();
		await runtime.start();
		const currentRefresh = runtime.refresh();

		const currentSnapshot = buildGlobalUsageSnapshot([]);
		currentSnapshot.scannedAt = 2;
		newScan.resolve(currentSnapshot);
		await currentRefresh;

		const staleSnapshot = buildGlobalUsageSnapshot([]);
		staleSnapshot.scannedAt = 1;
		oldScan.resolve(staleSnapshot);
		await oldScan.promise;
		await Promise.resolve();

		expect(runtime.getState()).toMatchObject({ phase: "ready", data: { scannedAt: 2 } });
	});

	it("shares one persistent runtime across acquisitions and honors the first options", async () => {
		const server = fakeServer();
		const options = {
			scan: vi.fn(async () => buildGlobalUsageSnapshot([])),
			serverFactory: () => server,
		};
		const runtime = persistentUsageRuntime.get(options);
		expect(persistentUsageRuntime.get()).toBe(runtime);
		await runtime.start();
		await persistentUsageRuntime.resetForTests();
		expect(runtime.isActive()).toBe(false);
		expect(server.close).toHaveBeenCalledOnce();
	});
});
