/**
 * Persistent dashboard runtime: the process-global lifetime policy shared by
 * the telemetry dashboards.
 *
 * Pi rebuilds extension instances for reloads and session replacements, while
 * a dashboard server and its state should keep the same URL and data. Each
 * dashboard builds one store with its own Symbol.for key; the store keeps a
 * single runtime per key, tracks the current claim, and closes an active,
 * unclaimed runtime after the orphan grace period. Runtime options are
 * honored only when the store creates the runtime; later acquisitions return
 * the existing instance unchanged.
 */

import type { DashboardServer } from "./dashboard-server.ts";

/** The runtime interface the lifetime policy touches. */
export interface DashboardRuntimeLike {
	isActive(): boolean;
	close(): Promise<void>;
}

export interface DashboardRuntimeLifecycle extends DashboardRuntimeLike {
	start(): Promise<{ url: string }>;
}

export interface DashboardRuntimeLifecycleOptions {
	/** Construct a fresh server adapter lazily for each start attempt. */
	createServer(): DashboardServer;
	/** Synchronous, non-throwing dashboard state transition after activation. */
	onActivated(): void;
	/** Synchronous, non-throwing dashboard state reset at the start of close. */
	onReset(): void;
	closedWhileStartingMessage: string;
}

/**
 * Own one dashboard server's lifecycle. Starts and closes are single-flight;
 * a start received during close waits for that close before constructing a
 * fresh adapter. A failed close rejects the waiting start, but a later start
 * may retry.
 */
export function createDashboardRuntimeLifecycle(
	options: DashboardRuntimeLifecycleOptions,
): DashboardRuntimeLifecycle {
	let server: DashboardServer | undefined;
	let startPromise: Promise<{ url: string }> | undefined;
	let closePromise: Promise<void> | undefined;
	let generation = 0;
	let active = false;

	const lifecycle: DashboardRuntimeLifecycle = {
		isActive: () => active,

		start(): Promise<{ url: string }> {
			const closing = closePromise;
			if (closing) return closing.then(() => lifecycle.start());
			if (startPromise) return startPromise;

			const currentGeneration = ++generation;
			let current: DashboardServer;
			try {
				current = options.createServer();
				server = current;
			} catch (error) {
				return Promise.reject(error);
			}

			let serverStart: Promise<{ url: string }>;
			try {
				serverStart = current.start();
			} catch (error) {
				serverStart = Promise.reject(error);
			}
			const pending = serverStart.then((result) => {
				if (currentGeneration !== generation) {
					throw new Error(options.closedWhileStartingMessage);
				}
				active = true;
				options.onActivated();
				return result;
			}).catch((error) => {
				if (currentGeneration !== generation) {
					throw new Error(options.closedWhileStartingMessage);
				}
				active = false;
				if (server === current) server = undefined;
				if (startPromise === pending) startPromise = undefined;
				throw error;
			});
			startPromise = pending;
			return pending;
		},

		close(): Promise<void> {
			if (closePromise) return closePromise;

			const current = server;
			const pendingStart = startPromise;
			generation++;
			server = undefined;
			startPromise = undefined;
			active = false;
			options.onReset();

			const pendingSettlement = pendingStart?.catch(() => {
				// Close owns invalidation of an in-flight start.
			});
			// Start and close must settle together: some adapters only reject a
			// pending start after close cancels their listen attempt.
			const adapterClose = current
				? Promise.resolve().then(() => current.close())
				: Promise.resolve();
			const closing = Promise.all([pendingSettlement, adapterClose]).then(() => undefined);
			let trackedClose: Promise<void>;
			trackedClose = closing.finally(() => {
				if (closePromise === trackedClose) closePromise = undefined;
			});
			closePromise = trackedClose;
			return trackedClose;
		},
	};

	return lifecycle;
}

export interface PersistentDashboardRuntime<T extends DashboardRuntimeLike, Options = void> {
	get(options?: Options): T;
	release(runtime: T): void;
	close(runtime: T): Promise<void>;
	/** Close on quit (`permanent`) or release for a replacement instance to reattach. */
	dispose(runtime: T, options: { permanent: boolean }): Promise<void>;
	resetForTests(): Promise<void>;
}

const ORPHAN_RUNTIME_GRACE_MS = 30_000;

interface RuntimeGlobalState<T> {
	runtime?: T;
	claimed: boolean;
	orphanTimer?: ReturnType<typeof setTimeout>;
}

export function createPersistentDashboardRuntime<T extends DashboardRuntimeLike, Options = void>(
	config: { key: symbol; create: (options?: Options) => T },
): PersistentDashboardRuntime<T, Options> {
	function globalState(): RuntimeGlobalState<T> {
		const globals = globalThis as typeof globalThis & Record<symbol, RuntimeGlobalState<T> | undefined>;
		return globals[config.key] ??= { claimed: false };
	}

	function clearOrphanTimer(current: RuntimeGlobalState<T>): void {
		if (!current.orphanTimer) return;
		clearTimeout(current.orphanTimer);
		current.orphanTimer = undefined;
	}

	const store: PersistentDashboardRuntime<T, Options> = {
		get(options?: Options): T {
			const current = globalState();
			clearOrphanTimer(current);
			current.claimed = true;
			if (!current.runtime) current.runtime = config.create(options);
			return current.runtime;
		},

		release(runtime: T): void {
			const current = globalState();
			if (current.runtime !== runtime) return;
			current.claimed = false;
			clearOrphanTimer(current);
			if (!runtime.isActive()) return;
			current.orphanTimer = setTimeout(() => {
				current.orphanTimer = undefined;
				if (current.runtime !== runtime || current.claimed) return;
				void runtime.close().catch(() => {});
			}, ORPHAN_RUNTIME_GRACE_MS);
			current.orphanTimer.unref?.();
		},

		async close(runtime: T): Promise<void> {
			const current = globalState();
			if (current.runtime === runtime) {
				clearOrphanTimer(current);
				delete (globalThis as typeof globalThis & Record<symbol, unknown>)[config.key];
			}
			await runtime.close();
		},

		async dispose(runtime: T, options: { permanent: boolean }): Promise<void> {
			if (options.permanent) {
				await store.close(runtime);
				return;
			}
			store.release(runtime);
		},

		async resetForTests(): Promise<void> {
			const globals = globalThis as typeof globalThis & Record<symbol, RuntimeGlobalState<T> | undefined>;
			const current = globals[config.key];
			if (current) clearOrphanTimer(current);
			const runtime = current?.runtime;
			delete globals[config.key];
			await runtime?.close();
		},
	};

	return store;
}