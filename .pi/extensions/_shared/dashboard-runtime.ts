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

/** The runtime surface the lifetime policy touches. */
export interface DashboardRuntimeLike {
	isActive(): boolean;
	close(): Promise<void>;
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