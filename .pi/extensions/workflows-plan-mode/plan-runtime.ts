import type { PlanSandboxController } from "./plan-sandbox.ts";
import type { PlanWorkspace, PlanWorkspaceOptions } from "./plan-workspace.ts";

export type PlanRuntimePhase = "idle" | "warming" | "ready" | "failed" | "disposing";

export interface PlanRuntimeStatus {
	phase: PlanRuntimePhase;
	error?: unknown;
}

export interface PlanRuntimeCoordinator {
	warm(hostRoot: string): void;
	require(signal?: AbortSignal): Promise<PlanSandboxController>;
	refresh(hostRoot: string): Promise<PlanSandboxController>;
	dispose(): Promise<void>;
}

export interface PlanRuntimeDependencies {
	createWorkspace(hostRoot: string, options?: PlanWorkspaceOptions): Promise<PlanWorkspace>;
	createSandbox(workspace: PlanWorkspace): PlanSandboxController;
	onStatus?(status: PlanRuntimeStatus): void;
}

interface RuntimeBundle {
	workspace?: PlanWorkspace;
	sandbox?: PlanSandboxController;
}

interface RuntimeAttempt {
	generation: number;
	root: string;
	controller: AbortController;
	promise: Promise<PlanSandboxController>;
}

function abortError(): Error {
	const error = new Error("Plan Runtime initialization was aborted.");
	error.name = "AbortError";
	return error;
}

function throwIfAborted(signal: AbortSignal): void {
	if (signal.aborted) throw abortError();
}

function waitWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return promise;
	if (signal.aborted) return Promise.reject(abortError());
	return new Promise<T>((resolve, reject) => {
		let settled = false;
		const finish = (callback: () => void) => {
			if (settled) return;
			settled = true;
			signal.removeEventListener("abort", onAbort);
			callback();
		};
		const onAbort = () => finish(() => reject(abortError()));
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => finish(() => resolve(value)),
			(error) => finish(() => reject(error)),
		);
	});
}

export function createPlanRuntimeCoordinator(
	dependencies: PlanRuntimeDependencies,
): PlanRuntimeCoordinator {
	let generation = 0;
	let phase: PlanRuntimePhase = "idle";
	let hostRoot: string | undefined;
	let attempt: RuntimeAttempt | undefined;
	let readyBundle: RuntimeBundle | undefined;
	let failure: unknown;
	let disposePromise: Promise<void> | undefined;
	const ownedBundles = new Set<RuntimeBundle>();

	function emit(nextPhase: PlanRuntimePhase, error?: unknown): void {
		phase = nextPhase;
		dependencies.onStatus?.({ phase: nextPhase, error });
	}

	async function cleanupBundle(bundle: RuntimeBundle): Promise<void> {
		let firstError: unknown;
		if (bundle.sandbox) {
			try {
				await bundle.sandbox.dispose();
				bundle.sandbox = undefined;
			} catch (error) {
				firstError = error;
			}
		}
		if (bundle.workspace) {
			try {
				await bundle.workspace.dispose();
				bundle.workspace = undefined;
			} catch (error) {
				firstError ??= error;
			}
		}
		if (!bundle.sandbox && !bundle.workspace) ownedBundles.delete(bundle);
		if (firstError) throw firstError;
	}

	function start(root: string): Promise<PlanSandboxController> {
		if (phase === "disposing" || disposePromise) {
			return Promise.reject(new Error("Plan Runtime is being disposed."));
		}
		if (readyBundle?.sandbox) {
			return hostRoot === root
				? Promise.resolve(readyBundle.sandbox)
				: Promise.reject(new Error(`Plan Runtime is already prepared for ${hostRoot}.`));
		}
		if (attempt) {
			return attempt.root === root
				? attempt.promise
				: Promise.reject(new Error(`Plan Runtime is already preparing ${attempt.root}.`));
		}
		if (failure) return Promise.reject(failure);

		hostRoot = root;
		const attemptGeneration = ++generation;
		const controller = new AbortController();
		emit("warming");

		const promise = (async () => {
			const bundle: RuntimeBundle = {};
			try {
				bundle.workspace = await dependencies.createWorkspace(root, { signal: controller.signal });
				ownedBundles.add(bundle);
				throwIfAborted(controller.signal);

				bundle.sandbox = dependencies.createSandbox(bundle.workspace);
				await bundle.sandbox.initialize();
				throwIfAborted(controller.signal);
				if (attemptGeneration !== generation) throw abortError();

				readyBundle = bundle;
				emit("ready");
				return bundle.sandbox;
			} catch (error) {
				let cleanupError: unknown;
				try {
					await cleanupBundle(bundle);
				} catch (failure) {
					cleanupError = failure;
				}
				const reportedError = cleanupError ?? error;
				if (attemptGeneration === generation && !controller.signal.aborted) {
					failure = reportedError;
					emit("failed", reportedError);
				}
				throw reportedError;
			}
		})().finally(() => {
			if (attempt?.generation === attemptGeneration) attempt = undefined;
		});

		attempt = { generation: attemptGeneration, root, controller, promise };
		return promise;
	}

	async function disposeInternal(): Promise<void> {
		generation++;
		failure = undefined;
		emit("disposing");
		readyBundle = undefined;

		const pending = attempt;
		pending?.controller.abort();
		if (pending) {
			try { await pending.promise; } catch { /* cancelled/failed initialization is cleaned internally */ }
		}
		attempt = undefined;

		let firstError: unknown;
		for (const bundle of [...ownedBundles]) {
			try {
				await cleanupBundle(bundle);
			} catch (error) {
				firstError ??= error;
			}
		}
		if (firstError) {
			failure = firstError;
			emit("failed", firstError);
			throw firstError;
		}

		hostRoot = undefined;
		emit("idle");
	}

	function dispose(): Promise<void> {
		if (disposePromise) return disposePromise;
		disposePromise = disposeInternal().finally(() => {
			disposePromise = undefined;
		});
		return disposePromise;
	}

	return {
		warm(root) {
			void start(root).catch(() => {});
		},
		async require(signal) {
			if (phase === "disposing" || disposePromise) {
				throw new Error("Plan Runtime is being disposed.");
			}
			if (readyBundle?.sandbox) return readyBundle.sandbox;
			if (attempt) return waitWithSignal(attempt.promise, signal);
			if (failure) throw failure;
			if (!hostRoot) throw new Error("Plan Runtime has not been started.");
			return waitWithSignal(start(hostRoot), signal);
		},
		async refresh(root) {
			await dispose();
			return start(root);
		},
		dispose,
	};
}
