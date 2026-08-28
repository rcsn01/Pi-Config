import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createDashboardRuntimeLifecycle,
	createPersistentDashboardRuntime,
	type DashboardRuntimeLike,
	type PersistentDashboardRuntime,
} from "./dashboard-runtime.ts";

interface FakeRuntime extends DashboardRuntimeLike {
	active: boolean;
}

function fakeRuntime(overrides: Partial<FakeRuntime> = {}): FakeRuntime {
	const runtime: FakeRuntime = {
		active: true,
		isActive: () => runtime.active,
		close: vi.fn(async () => {
			runtime.active = false;
		}),
		...overrides,
	};
	return runtime;
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
	return { promise, resolve, reject };
}

function fakeServer(
	start: () => Promise<{ url: string }> = async () => ({ url: "http://localhost:1/#token=test" }),
	close: () => Promise<void> = async () => {},
) {
	return { start: vi.fn(start), close: vi.fn(close) };
}

function uniqueKey(): symbol {
	return Symbol.for(`test.dashboard-runtime.${Math.random()}`);
}

function storeFor(create?: (options?: { label?: string }) => FakeRuntime) {
	return createPersistentDashboardRuntime<FakeRuntime, { label?: string }>({
		key: uniqueKey(),
		create: create ?? (() => fakeRuntime()),
	});
}

afterEach(() => {
	vi.useRealTimers();
});

describe("persistent dashboard runtime", () => {
	it("returns the same runtime across acquisitions and honors only the first options", async () => {
		const create = vi.fn((options?: { label?: string }) => fakeRuntime({ active: options?.label === "first" }));
		const store = storeFor(create);
		const first = store.get({ label: "first" });
		const second = store.get({ label: "second" });

		expect(second).toBe(first);
		expect(first.isActive()).toBe(true);
		expect(create).toHaveBeenCalledOnce();
		expect(create).toHaveBeenCalledWith({ label: "first" });
	});

	it("closes an active unclaimed runtime after the orphan grace", async () => {
		vi.useFakeTimers();
		const store = storeFor();
		const runtime = store.get();
		store.release(runtime);
		await vi.advanceTimersByTimeAsync(29_999);
		expect(runtime.close).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(runtime.close).toHaveBeenCalledOnce();
	});

	it("keeps the runtime alive when re-acquired before the grace expires", async () => {
		vi.useFakeTimers();
		const store = storeFor();
		const runtime = store.get();
		store.release(runtime);
		expect(store.get()).toBe(runtime);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(runtime.close).not.toHaveBeenCalled();
	});

	it("ignores a release for a runtime the store does not own", async () => {
		vi.useFakeTimers();
		const store = storeFor();
		store.release(fakeRuntime());
		await vi.advanceTimersByTimeAsync(60_000);
	});

	it("closes and forgets the runtime on close, so the next get creates a new one", async () => {
		const store = storeFor();
		const runtime = store.get();
		await store.close(runtime);
		expect(runtime.close).toHaveBeenCalledOnce();

		const replacement = store.get();
		expect(replacement).not.toBe(runtime);
	});

	it("dispose closes permanently or releases for a replacement to reattach", async () => {
		vi.useFakeTimers();
		const store = storeFor();
		const permanent = store.get();
		await store.dispose(permanent, { permanent: true });
		expect(permanent.close).toHaveBeenCalledOnce();
		expect(store.get()).not.toBe(permanent);

		const temporary = store.get();
		await store.dispose(temporary, { permanent: false });
		await vi.advanceTimersByTimeAsync(60_000);
		expect(temporary.close).toHaveBeenCalledOnce();
	});

	it("resetForTests clears the global entry and closes the runtime", async () => {
		const store = storeFor();
		const runtime = store.get();
		await store.resetForTests();
		expect(runtime.close).toHaveBeenCalledOnce();

		const replacement = store.get();
		expect(replacement).not.toBe(runtime);
	});
});

describe("dashboard runtime lifecycle", () => {
	it("coalesces starts and activates only after the server starts", async () => {
		const started = deferred<{ url: string }>();
		const server = fakeServer(() => started.promise);
		const onActivated = vi.fn();
		const lifecycle = createDashboardRuntimeLifecycle({
			createServer: () => server,
			onActivated,
			onReset: vi.fn(),
			closedWhileStartingMessage: "closed while starting",
		});

		const first = lifecycle.start();
		const second = lifecycle.start();
		expect(server.start).toHaveBeenCalledOnce();
		expect(lifecycle.isActive()).toBe(false);
		started.resolve({ url: "http://localhost:1/#token=test" });
		expect(await first).toEqual(await second);
		expect(lifecycle.isActive()).toBe(true);
		expect(onActivated).toHaveBeenCalledOnce();
	});

	it("invalidates a pending start, resets immediately, and closes its adapter", async () => {
		const started = deferred<{ url: string }>();
		const server = fakeServer(() => started.promise);
		const onReset = vi.fn();
		const lifecycle = createDashboardRuntimeLifecycle({
			createServer: () => server,
			onActivated: vi.fn(),
			onReset,
			closedWhileStartingMessage: "dashboard closed while starting",
		});

		const starting = lifecycle.start();
		const closing = lifecycle.close();
		expect(onReset).toHaveBeenCalledOnce();
		expect(lifecycle.isActive()).toBe(false);
		started.resolve({ url: "http://localhost:1/#token=test" });
		await expect(starting).rejects.toThrow("dashboard closed while starting");
		await closing;
		expect(server.close).toHaveBeenCalledOnce();
	});

	it("closes an adapter whose pending start settles only when cancelled", async () => {
		let rejectStart!: (error: unknown) => void;
		const server = fakeServer(
			() => new Promise((_, reject) => { rejectStart = reject; }),
			async () => rejectStart(new Error("listen cancelled")),
		);
		const lifecycle = createDashboardRuntimeLifecycle({
			createServer: () => server,
			onActivated: vi.fn(),
			onReset: vi.fn(),
			closedWhileStartingMessage: "dashboard closed while starting",
		});

		const starting = lifecycle.start();
		const closing = lifecycle.close();
		await closing;
		await expect(starting).rejects.toThrow("dashboard closed while starting");
		expect(server.close).toHaveBeenCalledOnce();
	});

	it("coalesces closes and makes a new start wait for close", async () => {
		const closed = deferred<void>();
		const firstServer = fakeServer(undefined, () => closed.promise);
		const secondServer = fakeServer();
		const createServer = vi.fn()
			.mockReturnValueOnce(firstServer)
			.mockReturnValueOnce(secondServer);
		const lifecycle = createDashboardRuntimeLifecycle({
			createServer,
			onActivated: vi.fn(),
			onReset: vi.fn(),
			closedWhileStartingMessage: "closed while starting",
		});
		await lifecycle.start();

		const firstClose = lifecycle.close();
		const secondClose = lifecycle.close();
		expect(firstClose).toBe(secondClose);
		const restarting = lifecycle.start();
		expect(secondServer.start).not.toHaveBeenCalled();
		closed.resolve();
		await firstClose;
		await restarting;
		expect(secondServer.start).toHaveBeenCalledOnce();
	});

	it("rejects a queued start on close failure, then permits an explicit retry", async () => {
		const closeError = new Error("close failed");
		const firstServer = fakeServer(undefined, async () => { throw closeError; });
		const secondServer = fakeServer();
		const createServer = vi.fn()
			.mockReturnValueOnce(firstServer)
			.mockReturnValueOnce(secondServer);
		const lifecycle = createDashboardRuntimeLifecycle({
			createServer,
			onActivated: vi.fn(),
			onReset: vi.fn(),
			closedWhileStartingMessage: "closed while starting",
		});
		await lifecycle.start();

		const closing = lifecycle.close();
		const queuedStart = lifecycle.start();
		await expect(closing).rejects.toBe(closeError);
		await expect(queuedStart).rejects.toBe(closeError);
		await expect(lifecycle.start()).resolves.toEqual({ url: "http://localhost:1/#token=test" });
	});

	it("retries with a fresh adapter after start failure", async () => {
		const startError = new Error("start failed");
		const failedServer = fakeServer(async () => { throw startError; });
		const replacement = fakeServer();
		const lifecycle = createDashboardRuntimeLifecycle({
			createServer: vi.fn()
				.mockReturnValueOnce(failedServer)
				.mockReturnValueOnce(replacement),
			onActivated: vi.fn(),
			onReset: vi.fn(),
			closedWhileStartingMessage: "closed while starting",
		});

		await expect(lifecycle.start()).rejects.toBe(startError);
		expect(failedServer.close).not.toHaveBeenCalled();
		await expect(lifecycle.start()).resolves.toEqual({ url: "http://localhost:1/#token=test" });
		expect(replacement.start).toHaveBeenCalledOnce();
	});

	it("resets an inactive runtime and resolves", async () => {
		const onReset = vi.fn();
		const lifecycle = createDashboardRuntimeLifecycle({
			createServer: () => fakeServer(),
			onActivated: vi.fn(),
			onReset,
			closedWhileStartingMessage: "closed while starting",
		});

		await expect(lifecycle.close()).resolves.toBeUndefined();
		expect(onReset).toHaveBeenCalledOnce();
	});
});