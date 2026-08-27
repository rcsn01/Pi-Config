import { Buffer } from "node:buffer";
import { createPersistentDashboardRuntime, type PersistentDashboardRuntime } from "../_shared/dashboard-runtime.ts";
import type { ObservabilityEvent, ObservabilitySource } from "../_shared/observability.ts";
import type { AnalysisServer } from "./server.ts";
import { createAnalysisServer } from "./server.ts";
import {
	analyzePayload,
	normalizeUsage,
	reconcileCacheSections,
	serializeJson,
	supportsPrefixCacheEstimate,
	type PayloadSection,
	type UsageView,
} from "./payload.ts";

type OptionalSource<T> = T extends unknown ? Omit<T, "source"> & { source?: ObservabilitySource } : never;
export type AnalysisEvent = OptionalSource<ObservabilityEvent>;
const DEFAULT_SOURCE: ObservabilitySource = { channel: "main", invocationId: "main", displayLabel: "Main agent" };

export interface AnalysisRecordSummary {
	sequence: number;
	source: ObservabilitySource;
	run: number;
	turn: number;
	requestedAt: number;
	completedAt?: number;
	provider: string;
	api: string;
	model: string;
	apiLabel: string;
	status?: number;
	statusEvidence?: number[];
	state: "pending" | "complete";
	correlation: "exact" | "ambiguous";
	diagnostic?: string;
	bytes: number;
	usage?: UsageView;
}

export interface AnalysisRecord extends AnalysisRecordSummary {
	requestJson: string;
	assistantJson?: string;
	sections: PayloadSection[];
	cachePlacement?: "estimated";
	fidelity: "exact-provider" | "pi-preparation";
}

export interface AnalysisSummary {
	activatedAt?: number;
	paused: boolean;
	diagnostic?: string;
	retainedBytes: number;
	limits: { recordBytes: number; totalBytes: number };
	records: AnalysisRecordSummary[];
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

export interface RuntimeOptions {
	maxRecordBytes?: number;
	maxTotalBytes?: number;
	now?: () => number;
	notify?: (message: string) => void;
	serverFactory?: (source: {
		getSummary: () => AnalysisSummary;
		getRecord: (sequence: number) => AnalysisRecord | undefined;
		clear: () => void;
	}) => AnalysisServer;
}

const DEFAULT_RECORD_LIMIT = 64 * 1024 * 1024;
const DEFAULT_TOTAL_LIMIT = 256 * 1024 * 1024;

function byteSize(record: AnalysisRecord): number {
	let assumed = 0;
	for (let index = 0; index < 4; index++) {
		const measured = Buffer.byteLength(JSON.stringify({ ...record, bytes: assumed }), "utf8");
		if (measured === assumed) return measured;
		assumed = measured;
	}
	return assumed;
}

export function createAnalysisRuntime(options: RuntimeOptions = {}): AnalysisRuntimeStore {
	const maxRecordBytes = options.maxRecordBytes ?? DEFAULT_RECORD_LIMIT;
	const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_TOTAL_LIMIT;
	const now = options.now ?? Date.now;
	let server: AnalysisServer | undefined;
	let startPromise: Promise<{ url: string }> | undefined;
	let lifecycle = 0;
	let activatedAt: number | undefined;
	let notify = options.notify;
	let paused = false;
	let diagnostic: string | undefined;
	let retainedBytes = 0;
	let sequence = 0;
	const sourceStates = new Map<string, { run: number; turn: number }>();
	const records: AnalysisRecord[] = [];

	const sourceKey = (source: ObservabilitySource) => `${source.channel}\u0000${source.invocationId}`;
	const stateFor = (source: ObservabilitySource) => {
		const key = sourceKey(source);
		let sourceState = sourceStates.get(key);
		if (!sourceState) {
			sourceState = { run: 0, turn: -1 };
			sourceStates.set(key, sourceState);
		}
		return sourceState;
	};

	const summary = (): AnalysisSummary => ({
		activatedAt,
		paused,
		diagnostic,
		retainedBytes,
		limits: { recordBytes: maxRecordBytes, totalBytes: maxTotalBytes },
		records: records.map(({ requestJson: _request, assistantJson: _assistant, sections: _sections, ...record }) => record),
	});
	const getRecord = (id: number) => records.find((record) => record.sequence === id);
	const clear = () => {
		records.length = 0;
		retainedBytes = 0;
		paused = false;
		diagnostic = undefined;
		sourceStates.clear();
	};
	const source = { getSummary: summary, getRecord, clear };

	function pause(message: string): void {
		paused = true;
		diagnostic = message;
		notify?.(message);
	}

	function tryReplaceRecord(sequenceNumber: number, mutate: (next: AnalysisRecord) => void): boolean {
		const index = records.findIndex((record) => record.sequence === sequenceNumber);
		if (index < 0) return false;
		const current = records[index]!;
		const next = { ...current };
		mutate(next);
		const nextBytes = byteSize(next);
		const nextTotal = retainedBytes - current.bytes + nextBytes;
		if (nextBytes > maxRecordBytes || nextTotal > maxTotalBytes) return false;
		next.bytes = nextBytes;
		records[index] = next;
		retainedBytes = nextTotal;
		return true;
	}

	function markAmbiguous(candidates: AnalysisRecord[], message: string, status?: number): boolean {
		for (const candidate of candidates) {
			const updated = tryReplaceRecord(candidate.sequence, (record) => {
				record.correlation = "ambiguous";
				record.diagnostic = record.diagnostic ? `${record.diagnostic} ${message}` : message;
				if (status !== undefined) record.statusEvidence = [...(record.statusEvidence ?? []), status];
			});
			if (!updated) {
				pause(`Analysis capture paused while retaining correlation evidence for request ${candidate.sequence}: the memory limit would be exceeded.`);
				return false;
			}
		}
		return true;
	}

	function observe(event: AnalysisEvent): void {
		if (activatedAt === undefined || paused) return;
		const at = event.at ?? now();
		const eventSource = event.source ?? DEFAULT_SOURCE;
		const sourceState = stateFor(eventSource);
		if (event.type === "agent_start") {
			sourceState.run++;
			sourceState.turn = -1;
			return;
		}
		if (event.type === "turn_start") {
			sourceState.turn = event.turnIndex;
			return;
		}
		if (event.type === "request") {
			const serialized = serializeJson(event.payload);
			if (!serialized.json) {
				pause(`Analysis capture paused. ${serialized.diagnostic ?? "Request serialization failed."}`);
				return;
			}
			const analysis = analyzePayload(event.api, event.payload);
			const record: AnalysisRecord = {
				sequence: ++sequence, source: { ...eventSource }, run: sourceState.run, turn: sourceState.turn, requestedAt: at,
				provider: event.provider, api: event.api, model: event.model, apiLabel: analysis.apiLabel,
				state: "pending", correlation: "exact", bytes: 0,
				requestJson: serialized.json, sections: analysis.sections,
				fidelity: event.fidelity ?? "exact-provider",
			};
			const bytes = byteSize(record);
			if (bytes > maxRecordBytes || retainedBytes + bytes > maxTotalBytes) {
				pause(`Analysis capture paused before request ${record.sequence}: retaining the complete record would exceed the memory limit.`);
				return;
			}
			record.bytes = bytes;
			records.push(record);
			retainedBytes += bytes;
			return;
		}
		const candidates = records.filter((record) =>
			sourceKey(record.source) === sourceKey(eventSource)
			&& record.run === sourceState.run
			&& record.turn === sourceState.turn
			&& record.state === "pending",
		);
		if (event.type === "response") {
			const statusCandidates = candidates.filter((record) => record.status === undefined);
			if (statusCandidates.length === 0) return;
			if (statusCandidates.length > 1) {
				markAmbiguous(statusCandidates, `HTTP status ${event.status ?? "unknown"} had ${statusCandidates.length} candidates and was not assigned to one request.`, event.status);
				return;
			}
			const target = statusCandidates[0]!;
			if (!tryReplaceRecord(target.sequence, (record) => { record.status = event.status; })) {
				pause(`Analysis capture paused while attaching HTTP status to request ${target.sequence}: the memory limit would be exceeded.`);
			}
			return;
		}
		if (event.type === "assistant") {
			if (candidates.length === 0) return;
			const targetSequence = candidates.at(-1)!.sequence;
			if (candidates.length > 1 && !markAmbiguous(candidates, `Assistant output had ${candidates.length} request candidates; attached to the latest by event order.`)) return;
			const serialized = serializeJson(event.message);
			if (!serialized.json) {
				markAmbiguous([getRecord(targetSequence)!], serialized.diagnostic ?? "Assistant serialization failed.");
				return;
			}
			const message = event.message as { usage?: unknown };
			const usage = normalizeUsage(message?.usage);
			const updated = tryReplaceRecord(targetSequence, (record) => {
				record.assistantJson = serialized.json;
				record.completedAt = at;
				record.state = "complete";
				record.usage = usage;
				if (usage && supportsPrefixCacheEstimate(record.api)) {
					const promptTotal = usage.input + usage.cacheRead + usage.cacheWrite;
					record.sections = reconcileCacheSections(record.sections, promptTotal, usage.cacheRead);
					record.cachePlacement = "estimated";
				}
			});
			if (!updated) {
				const index = records.findIndex((record) => record.sequence === targetSequence);
				const pending = records[index];
				if (pending) {
					records.splice(index, 1);
					retainedBytes -= pending.bytes;
				}
				pause(`Analysis capture paused at request ${targetSequence}: its complete request and output exceed the memory limit, so the pending record was removed rather than truncated.`);
			}
		}
	}

	return {
		isActive: () => activatedAt !== undefined,
		setNotify(next) {
			notify = next;
		},
		async start() {
			if (startPromise) return startPromise;
			const generation = ++lifecycle;
			server = (options.serverFactory ?? createAnalysisServer)(source);
			const current = server;
			startPromise = current.start().then((result) => {
				if (generation !== lifecycle) throw new Error("Analysis server was closed while starting.");
				activatedAt = now();
				return result;
			}).catch((error) => {
				if (generation === lifecycle) {
					startPromise = undefined;
					if (server === current) server = undefined;
				}
				throw error;
			});
			return startPromise;
		},
		observe,
		async close() {
			const active = server;
			const pending = startPromise;
			lifecycle++;
			server = undefined;
			startPromise = undefined;
			activatedAt = undefined;
			notify = undefined;
			clear();
			if (pending) {
				try {
					await pending;
				} catch {
					// The close invalidated a pending start. Its error is not a close failure.
				}
			}
			if (active) await active.close();
		},
		getSummary: summary,
		getRecord,
		clear,
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
