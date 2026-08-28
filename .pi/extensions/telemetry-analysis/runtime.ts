import {
	createDashboardRuntimeLifecycle,
	createPersistentDashboardRuntime,
	type PersistentDashboardRuntime,
} from "../_shared/dashboard-runtime.ts";
import {
	createAnalysisCapture,
	type AnalysisCaptureOptions,
	type AnalysisCaptureSummary,
	type AnalysisEvent,
	type AnalysisRecord,
	type AnalysisRecordSummary,
} from "./analysis-capture.ts";
import type { AnalysisServer } from "./server.ts";
import { createAnalysisServer } from "./server.ts";

export type { AnalysisEvent, AnalysisRecord, AnalysisRecordSummary } from "./analysis-capture.ts";

export interface AnalysisSummary extends AnalysisCaptureSummary {
	activatedAt?: number;
}

export interface AnalysisRuntime {
	start(): Promise<{ url: string }>;
	observe(event: AnalysisEvent): void;
	close(): Promise<void>;
}

export interface AnalysisRuntimeStore extends AnalysisRuntime {
	isActive(): boolean;
	setNotify(notify?: (message: string) => void): void;
	getSummary(): AnalysisSummary;
	getRecord(sequence: number): AnalysisRecord | undefined;
	clear(): void;
}

export interface RuntimeOptions extends AnalysisCaptureOptions {
	serverFactory?: (source: {
		getSummary: () => AnalysisSummary;
		getRecord: (sequence: number) => AnalysisRecord | undefined;
		clear: () => void;
	}) => AnalysisServer;
}

export function createAnalysisRuntime(options: RuntimeOptions = {}): AnalysisRuntimeStore {
	const now = options.now ?? Date.now;
	let activatedAt: number | undefined;
	let notify = options.notify;
	const capture = createAnalysisCapture({
		maxRecordBytes: options.maxRecordBytes,
		maxTotalBytes: options.maxTotalBytes,
		now,
		notify: (message) => notify?.(message),
	});

	const getSummary = (): AnalysisSummary => ({ activatedAt, ...capture.getSummary() });
	const source = { getSummary, getRecord: capture.getRecord, clear: capture.clear };

	const lifecycle = createDashboardRuntimeLifecycle({
		createServer: () => (options.serverFactory ?? createAnalysisServer)(source),
		onActivated: () => {
			activatedAt = now();
		},
		onReset: () => {
			activatedAt = undefined;
			notify = undefined;
			capture.clear();
		},
		closedWhileStartingMessage: "Analysis server was closed while starting.",
	});

	return {
		...lifecycle,
		setNotify(next) {
			notify = next;
		},
		observe(event) {
			if (activatedAt === undefined) return;
			capture.observe(event);
		},
		getSummary,
		getRecord: capture.getRecord,
		clear: capture.clear,
	};
}

/**
 * Persistent analysis dashboard runtime: one store per process, sharing the
 * runtime across extension instances and reloads. Claim/release, orphan
 * grace, and close-on-quit live in `_shared/dashboard-runtime.ts`.
 */
export const persistentAnalysisRuntime: PersistentDashboardRuntime<AnalysisRuntimeStore, { notify?: (message: string) => void }> =
	createPersistentDashboardRuntime({
		key: Symbol.for("pi.extensions.telemetry-analysis.runtime.v1"),
		create: (options) => createAnalysisRuntime(options ?? {}),
	});

/** Acquire the persistent runtime and hand it the current notify forwarder. */
export function getPersistentAnalysisRuntime(notify?: (message: string) => void): AnalysisRuntimeStore {
	const runtime = persistentAnalysisRuntime.get({ notify });
	runtime.setNotify(notify);
	return runtime;
}
