import { afterEach, describe, expect, it, vi } from "vitest";
import {
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