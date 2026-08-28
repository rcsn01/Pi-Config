import type { GlobalUsageSnapshot } from "../_shared/global-usage.ts";
import {
	createDashboardRuntimeLifecycle,
	createPersistentDashboardRuntime,
	type PersistentDashboardRuntime,
} from "../_shared/dashboard-runtime.ts";
import { scanGlobalUsage, type ScanGlobalUsageOptions } from "./global-usage-store.ts";
import { toTelemetryUsagePayload, type TelemetryUsageState } from "./payload.ts";
import { createTelemetryUsageServer, type TelemetryUsageServer } from "./server.ts";

export interface TelemetryUsageRuntime {
	start(): Promise<{ url: string }>;
	close(): Promise<void>;
}

export interface TelemetryUsageRuntimeStore extends TelemetryUsageRuntime {
	isActive(): boolean;
	getState(): TelemetryUsageState;
	refresh(): Promise<void>;
}

export interface TelemetryUsageRuntimeOptions {
	scan?: (options?: ScanGlobalUsageOptions) => Promise<GlobalUsageSnapshot>;
	serverFactory?: (source: {
		getState: () => TelemetryUsageState;
		refresh: () => Promise<void>;
	}) => TelemetryUsageServer;
}

function cloneState(state: TelemetryUsageState): TelemetryUsageState {
	return {
		phase: state.phase,
		...(state.progress ? { progress: { ...state.progress } } : {}),
		...(state.diagnostic === undefined ? {} : { diagnostic: state.diagnostic }),
		...(state.data === undefined ? {} : { data: state.data }),
	};
}

export function createTelemetryUsageRuntime(
	options: TelemetryUsageRuntimeOptions = {},
): TelemetryUsageRuntimeStore {
	const scan = options.scan ?? scanGlobalUsage;
	let state: TelemetryUsageState = { phase: "idle" };
	let refreshPromise: Promise<void> | undefined;
	let scanGeneration = 0;

	const getState = () => cloneState(state);

	const refresh = (): Promise<void> => {
		if (refreshPromise) return refreshPromise;
		const generation = scanGeneration;
		state = { phase: "scanning", ...(state.data ? { data: state.data } : {}) };
		const current = scan({
			onProgress: (loaded, total) => {
				if (generation !== scanGeneration) return;
				state = {
					phase: "scanning",
					progress: { loaded, total },
					...(state.data ? { data: state.data } : {}),
				};
			},
		}).then((snapshot) => {
			if (generation !== scanGeneration) return;
			state = { phase: "ready", data: toTelemetryUsagePayload(snapshot) };
		}).catch((error) => {
			if (generation !== scanGeneration) return;
			state = {
				phase: "error",
				diagnostic: error instanceof Error ? error.message : String(error),
				...(state.data ? { data: state.data } : {}),
			};
		}).finally(() => {
			if (refreshPromise === current) refreshPromise = undefined;
		});
		refreshPromise = current;
		return current;
	};

	const source = { getState, refresh };
	const lifecycle = createDashboardRuntimeLifecycle({
		createServer: () => (options.serverFactory ?? createTelemetryUsageServer)(source),
		onActivated: () => {
			void refresh();
		},
		onReset: () => {
			scanGeneration++;
			refreshPromise = undefined;
			state = { phase: "idle" };
		},
		closedWhileStartingMessage: "Telemetry usage server was closed while starting.",
	});

	return {
		...lifecycle,
		getState,
		refresh,
	};
}

/**
 * Persistent usage dashboard runtime: one store per process, sharing the
 * runtime across extension instances and reloads. Claim/release, orphan
 * grace, and close-on-quit live in `_shared/dashboard-runtime.ts`.
 */
export const persistentUsageRuntime: PersistentDashboardRuntime<TelemetryUsageRuntimeStore, TelemetryUsageRuntimeOptions> =
	createPersistentDashboardRuntime({
		key: Symbol.for("pi.extensions.telemetry-usage.runtime.v1"),
		create: (options) => createTelemetryUsageRuntime(options ?? {}),
	});
