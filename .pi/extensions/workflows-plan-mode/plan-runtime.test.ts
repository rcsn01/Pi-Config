import { describe, expect, it, vi } from "vitest";
import type { PlanSandboxController } from "./plan-sandbox.ts";
import type { PlanWorkspace } from "./plan-workspace.ts";
import { createPlanRuntimeCoordinator } from "./plan-runtime.ts";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

function workspace(id = "one"): PlanWorkspace {
	return {
		root: `/tmp/${id}`,
		hostRoot: "/host/project",
		sandboxRoot: `/tmp/${id}/project`,
		tempRoot: `/tmp/${id}/tmp`,
		dispose: vi.fn(async () => {}),
	};
}

function sandbox(): PlanSandboxController {
	return {
		operations: { exec: vi.fn() },
		initialize: vi.fn(async () => {}),
		dispose: vi.fn(async () => {}),
	};
}

describe("Plan Runtime coordinator", () => {
	it("defers preparation until first use and shares one attempt between callers", async () => {
		const pendingWorkspace = deferred<PlanWorkspace>();
		const createdSandbox = sandbox();
		const createWorkspace = vi.fn(() => pendingWorkspace.promise);
		const createSandbox = vi.fn(() => createdSandbox);
		const statuses: string[] = [];
		const runtime = createPlanRuntimeCoordinator({
			createWorkspace,
			createSandbox,
			onStatus: (status) => statuses.push(status.phase),
		});

		expect(runtime.warm("/host/project")).toBeUndefined();
		expect(createWorkspace).not.toHaveBeenCalled();
		expect(statuses).toEqual([]);

		const first = runtime.require();
		const second = runtime.require();
		await Promise.resolve();
		expect(createWorkspace).toHaveBeenCalledTimes(1);
		expect(statuses).toEqual(["warming"]);

		pendingWorkspace.resolve(workspace());
		await expect(first).resolves.toBe(createdSandbox);
		await expect(second).resolves.toBe(createdSandbox);
		expect(createdSandbox.initialize).toHaveBeenCalledOnce();
		expect(statuses).toEqual(["warming", "ready"]);
	});

	it("does not start preparation for a pre-aborted first-use request", async () => {
		const createWorkspace = vi.fn(async () => workspace());
		const runtime = createPlanRuntimeCoordinator({
			createWorkspace,
			createSandbox: vi.fn(() => sandbox()),
		});
		runtime.warm("/host/project");
		const controller = new AbortController();
		controller.abort();

		await expect(runtime.require(controller.signal)).rejects.toMatchObject({ name: "AbortError" });
		expect(createWorkspace).not.toHaveBeenCalled();
	});

	it("aborts first-use workspace creation when disposed", async () => {
		let copySignal: AbortSignal | undefined;
		const createWorkspace = vi.fn((_root: string, options?: { signal?: AbortSignal }) => {
			copySignal = options?.signal;
			return new Promise<PlanWorkspace>((_resolve, reject) => {
				copySignal?.addEventListener("abort", () => {
					const error = new Error("aborted");
					error.name = "AbortError";
					reject(error);
				}, { once: true });
			});
		});
		const statuses: string[] = [];
		const runtime = createPlanRuntimeCoordinator({
			createWorkspace,
			createSandbox: vi.fn(),
			onStatus: (status) => statuses.push(status.phase),
		});

		runtime.warm("/host/project");
		const requiring = runtime.require();
		const rejected = expect(requiring).rejects.toMatchObject({ name: "AbortError" });
		await runtime.dispose();

		await rejected;
		expect(copySignal?.aborted).toBe(true);
		expect(statuses).toEqual(["warming", "disposing", "idle"]);
	});

	it("disposes stale resources without publishing readiness when exit races sandbox initialization", async () => {
		const pendingInitialization = deferred<void>();
		const createdWorkspace = workspace();
		const createdSandbox = sandbox();
		vi.mocked(createdSandbox.initialize).mockReturnValue(pendingInitialization.promise);
		const statuses: string[] = [];
		const runtime = createPlanRuntimeCoordinator({
			createWorkspace: vi.fn(async () => createdWorkspace),
			createSandbox: vi.fn(() => createdSandbox),
			onStatus: (status) => statuses.push(status.phase),
		});

		runtime.warm("/host/project");
		const requiring = runtime.require();
		const rejected = expect(requiring).rejects.toMatchObject({ name: "AbortError" });
		await vi.waitFor(() => expect(createdSandbox.initialize).toHaveBeenCalledOnce());
		const disposing = runtime.dispose();
		pendingInitialization.resolve();
		await disposing;
		await rejected;

		expect(statuses).toEqual(["warming", "disposing", "idle"]);
		expect(createdSandbox.dispose).toHaveBeenCalledOnce();
		expect(createdWorkspace.dispose).toHaveBeenCalledOnce();
		await expect(runtime.require()).rejects.toThrow("has not been started");
	});

	it("lets a caller cancel its wait without cancelling shared background warm-up", async () => {
		const pendingWorkspace = deferred<PlanWorkspace>();
		const createdSandbox = sandbox();
		const runtime = createPlanRuntimeCoordinator({
			createWorkspace: vi.fn(() => pendingWorkspace.promise),
			createSandbox: vi.fn(() => createdSandbox),
		});
		runtime.warm("/host/project");
		const controller = new AbortController();
		const waiting = runtime.require(controller.signal);
		controller.abort();

		await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
		pendingWorkspace.resolve(workspace());
		await expect(runtime.require()).resolves.toBe(createdSandbox);
	});

	it("rejects new readiness requests while a prepared runtime is being disposed", async () => {
		const pendingSandboxDispose = deferred<void>();
		const createdWorkspace = workspace();
		const createdSandbox = sandbox();
		vi.mocked(createdSandbox.dispose).mockReturnValue(pendingSandboxDispose.promise);
		const createWorkspace = vi.fn(async () => createdWorkspace);
		const runtime = createPlanRuntimeCoordinator({
			createWorkspace,
			createSandbox: vi.fn(() => createdSandbox),
		});
		runtime.warm("/host/project");
		await runtime.require();

		const disposing = runtime.dispose();
		await expect(runtime.require()).rejects.toThrow("being disposed");
		expect(createWorkspace).toHaveBeenCalledOnce();

		pendingSandboxDispose.resolve();
		await disposing;
		await expect(runtime.require()).rejects.toThrow("has not been started");
	});

	it("retains failed cleanup so disposal can retry it", async () => {
		const createdWorkspace = workspace();
		const createdSandbox = sandbox();
		vi.mocked(createdSandbox.dispose)
			.mockRejectedValueOnce(new Error("reset failed"))
			.mockResolvedValueOnce(undefined);
		const runtime = createPlanRuntimeCoordinator({
			createWorkspace: vi.fn(async () => createdWorkspace),
			createSandbox: vi.fn(() => createdSandbox),
		});
		runtime.warm("/host/project");
		await runtime.require();

		await expect(runtime.dispose()).rejects.toThrow("reset failed");
		await expect(runtime.dispose()).resolves.toBeUndefined();
		expect(createdSandbox.dispose).toHaveBeenCalledTimes(2);
		expect(createdWorkspace.dispose).toHaveBeenCalledOnce();
	});

	it("retains one initialization failure until an explicit refresh", async () => {
		const firstError = new Error("proxy startup failed");
		const firstWorkspace = workspace("first");
		const firstSandbox = sandbox();
		vi.mocked(firstSandbox.initialize).mockRejectedValue(firstError);
		const secondWorkspace = workspace("second");
		const secondSandbox = sandbox();
		const createWorkspace = vi.fn()
			.mockResolvedValueOnce(firstWorkspace)
			.mockResolvedValueOnce(secondWorkspace);
		const createSandbox = vi.fn()
			.mockReturnValueOnce(firstSandbox)
			.mockReturnValueOnce(secondSandbox);
		const statuses: string[] = [];
		const runtime = createPlanRuntimeCoordinator({
			createWorkspace,
			createSandbox,
			onStatus: (status) => statuses.push(status.phase),
		});

		runtime.warm("/host/project");
		await expect(runtime.require()).rejects.toBe(firstError);
		await expect(runtime.require()).rejects.toBe(firstError);
		expect(createWorkspace).toHaveBeenCalledTimes(1);
		expect(statuses.filter((phase) => phase === "failed")).toHaveLength(1);

		await expect(runtime.refresh("/host/project")).resolves.toBe(secondSandbox);
		expect(firstSandbox.dispose).toHaveBeenCalledOnce();
		expect(firstWorkspace.dispose).toHaveBeenCalledOnce();
		expect(createWorkspace).toHaveBeenCalledTimes(2);
	});
});
