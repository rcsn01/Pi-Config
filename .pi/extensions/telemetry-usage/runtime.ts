import type { GlobalUsageSnapshot } from "../_shared/global-usage.ts";
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

const ORPHAN_RUNTIME_GRACE_MS = 30_000;
const TELEMETRY_USAGE_RUNTIME_KEY = Symbol.for("pi.extensions.telemetry-usage.runtime.v1");

interface TelemetryUsageRuntimeGlobalState {
	runtime?: TelemetryUsageRuntimeStore;
	claimed: boolean;
	orphanTimer?: ReturnType<typeof setTimeout>;
}

function globalRuntimeState(): TelemetryUsageRuntimeGlobalState {
	const globals = globalThis as typeof globalThis & {
		[TELEMETRY_USAGE_RUNTIME_KEY]?: TelemetryUsageRuntimeGlobalState;
	};
	return globals[TELEMETRY_USAGE_RUNTIME_KEY] ??= { claimed: false };
}

function clearOrphanTimer(state: TelemetryUsageRuntimeGlobalState): void {
	if (!state.orphanTimer) return;
	clearTimeout(state.orphanTimer);
	state.orphanTimer = undefined;
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
	let server: TelemetryUsageServer | undefined;
	let startPromise: Promise<{ url: string }> | undefined;
	let refreshPromise: Promise<void> | undefined;
	let active = false;
	let lifecycle = 0;

	const getState = () => cloneState(state);

	const refresh = (): Promise<void> => {
		if (refreshPromise) return refreshPromise;
		const generation = lifecycle;
		state = { phase: "scanning", ...(state.data ? { data: state.data } : {}) };
		const current = scan({
			onProgress: (loaded, total) => {
				if (generation !== lifecycle) return;
				state = {
					phase: "scanning",
					progress: { loaded, total },
					...(state.data ? { data: state.data } : {}),
				};
			},
		}).then((snapshot) => {
			if (generation !== lifecycle) return;
			state = { phase: "ready", data: toTelemetryUsagePayload(snapshot) };
		}).catch((error) => {
			if (generation !== lifecycle) return;
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

	return {
		isActive: () => active,
		getState,
		refresh,
		async start() {
			if (startPromise) return startPromise;
			const generation = ++lifecycle;
			server = (options.serverFactory ?? createTelemetryUsageServer)(source);
			const currentServer = server;
			startPromise = currentServer.start().then((result) => {
				if (generation !== lifecycle) throw new Error("Telemetry usage server was closed while starting.");
				active = true;
				void refresh();
				return result;
			}).catch((error) => {
				if (generation === lifecycle) {
					startPromise = undefined;
					if (server === currentServer) server = undefined;
				}
				throw error;
			});
			return startPromise;
		},
		async close() {
			const currentServer = server;
			const pendingStart = startPromise;
			lifecycle++;
			server = undefined;
			startPromise = undefined;
			refreshPromise = undefined;
			active = false;
			state = { phase: "idle" };
			if (pendingStart) {
				try {
					await pendingStart;
				} catch {
					// Closing invalidates an in-flight start.
				}
			}
			if (currentServer) await currentServer.close();
		},
	};
}

export function getPersistentTelemetryUsageRuntime(
	options: TelemetryUsageRuntimeOptions = {},
): TelemetryUsageRuntimeStore {
	const state = globalRuntimeState();
	clearOrphanTimer(state);
	state.claimed = true;
	if (!state.runtime) state.runtime = createTelemetryUsageRuntime(options);
	return state.runtime;
}

export function releasePersistentTelemetryUsageRuntime(runtime: TelemetryUsageRuntimeStore): void {
	const state = globalRuntimeState();
	if (state.runtime !== runtime) return;
	state.claimed = false;
	clearOrphanTimer(state);
	if (!runtime.isActive()) return;
	state.orphanTimer = setTimeout(() => {
		state.orphanTimer = undefined;
		if (state.runtime !== runtime || state.claimed) return;
		void runtime.close().catch(() => {});
	}, ORPHAN_RUNTIME_GRACE_MS);
	state.orphanTimer.unref?.();
}

export async function closePersistentTelemetryUsageRuntime(runtime: TelemetryUsageRuntimeStore): Promise<void> {
	const globals = globalThis as typeof globalThis & {
		[TELEMETRY_USAGE_RUNTIME_KEY]?: TelemetryUsageRuntimeGlobalState;
	};
	const state = globals[TELEMETRY_USAGE_RUNTIME_KEY];
	if (state?.runtime === runtime) {
		clearOrphanTimer(state);
		delete globals[TELEMETRY_USAGE_RUNTIME_KEY];
	}
	await runtime.close();
}

export async function resetPersistentTelemetryUsageRuntimeForTests(): Promise<void> {
	const globals = globalThis as typeof globalThis & {
		[TELEMETRY_USAGE_RUNTIME_KEY]?: TelemetryUsageRuntimeGlobalState;
	};
	const state = globals[TELEMETRY_USAGE_RUNTIME_KEY];
	clearOrphanTimer(state ?? { claimed: false });
	const runtime = state?.runtime;
	delete globals[TELEMETRY_USAGE_RUNTIME_KEY];
	await runtime?.close();
}
