import { Buffer } from "node:buffer";
import type { ObservabilityEvent, ObservabilitySource } from "../_shared/observability.ts";
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

export type AnalysisRequestActivityKind = "user-input" | "tool-result";
export type AnalysisResponseActivityKind = "thinking" | "tool-call-request" | "output";
export type AnalysisActivityKind = AnalysisRequestActivityKind | AnalysisResponseActivityKind;

export interface AnalysisActivity<K extends AnalysisActivityKind = AnalysisActivityKind> {
	kind: K;
	count: number;
	labels?: string[];
}

interface ActivityEvidence<K extends AnalysisActivityKind = AnalysisActivityKind> {
	kind: K;
	label?: string;
}

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
	requestActivities: AnalysisActivity<AnalysisRequestActivityKind>[];
	responseActivities: AnalysisActivity<AnalysisResponseActivityKind>[];
}

export interface AnalysisRecord extends AnalysisRecordSummary {
	requestJson: string;
	assistantJson?: string;
	sections: PayloadSection[];
	cachePlacement?: "estimated";
	fidelity: "exact-provider" | "pi-preparation";
}

export interface AnalysisCaptureSummary {
	paused: boolean;
	diagnostic?: string;
	retainedBytes: number;
	limits: { recordBytes: number; totalBytes: number };
	records: AnalysisRecordSummary[];
}

export interface AnalysisCaptureOptions {
	maxRecordBytes?: number;
	maxTotalBytes?: number;
	now?: () => number;
	notify?: (message: string) => void;
}

export interface AnalysisCapture {
	observe(event: AnalysisEvent): void;
	getSummary(): AnalysisCaptureSummary;
	getRecord(sequence: number): AnalysisRecord | undefined;
	clear(): void;
}

const DEFAULT_SOURCE: ObservabilitySource = { channel: "main", invocationId: "main", displayLabel: "Main agent" };
const DEFAULT_RECORD_LIMIT = 64 * 1024 * 1024;
const DEFAULT_TOTAL_LIMIT = 256 * 1024 * 1024;
const REQUEST_ACTIVITY_ORDER: AnalysisRequestActivityKind[] = ["user-input", "tool-result"];
const RESPONSE_ACTIVITY_ORDER: AnalysisResponseActivityKind[] = ["thinking", "tool-call-request", "output"];

function recordValue(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}

function addActivity<K extends AnalysisActivityKind>(
	activities: readonly AnalysisActivity<K>[],
	evidence: ActivityEvidence<K>,
	order: readonly K[],
): AnalysisActivity<K>[] {
	const existing = activities.find((activity) => activity.kind === evidence.kind);
	if (!existing) {
		return [...activities, {
			kind: evidence.kind,
			count: 1,
			...(evidence.label === undefined ? {} : { labels: [evidence.label] }),
		}].sort((left, right) => order.indexOf(left.kind) - order.indexOf(right.kind));
	}
	const labels = evidence.label === undefined
		? existing.labels
		: existing.labels?.includes(evidence.label)
			? existing.labels
			: [...(existing.labels ?? []), evidence.label];
	return activities.map((activity) => activity.kind === evidence.kind
		? { ...activity, count: activity.count + 1, ...(labels === undefined ? {} : { labels }) }
		: activity);
}

interface AssistantActivityAnalysis {
	activities: ActivityEvidence<AnalysisResponseActivityKind>[];
}

function classifyAssistantMessage(message: unknown): AssistantActivityAnalysis {
	const assistant = recordValue(message);
	if (assistant?.role !== "assistant") return { activities: [] };
	const activities: ActivityEvidence<AnalysisResponseActivityKind>[] = [];
	const content = assistant.content;
	const items = Array.isArray(content)
		? content
		: content === undefined || content === null
			? []
			: [{ type: "text", text: content }];
	for (const item of items) {
		if (typeof item === "string") {
			activities.push({ kind: "output" });
			continue;
		}
		const part = recordValue(item);
		if (!part) continue;
		const type = typeof part.type === "string" ? part.type.toLowerCase() : "";
		if (type === "toolcall" || type === "tool_call" || type.includes("toolcall") || type.includes("functioncall")) {
			const name = typeof part.name === "string" ? part.name : undefined;
			activities.push({ kind: "tool-call-request", ...(name === undefined ? {} : { label: name }) });
		} else if (type.includes("thinking") || type.includes("reasoning")) {
			activities.push({ kind: "thinking" });
		} else if (type === "text" || type.includes("output") || typeof part.text === "string") {
			activities.push({ kind: "output" });
		}
	}
	const usage = recordValue(assistant.usage);
	if (typeof usage?.reasoning === "number" && Number.isFinite(usage.reasoning) && usage.reasoning > 0
		&& !activities.some((activity) => activity.kind === "thinking")) {
		activities.push({ kind: "thinking" });
	}
	return { activities };
}

interface SourceState {
	run: number;
	turn: number;
	pendingRequestActivities: ActivityEvidence<AnalysisRequestActivityKind>[];
	turnRequestActivities: ActivityEvidence<AnalysisRequestActivityKind>[];
}

function byteSize(record: AnalysisRecord): number {
	let assumed = 0;
	for (let index = 0; index < 4; index++) {
		const measured = Buffer.byteLength(JSON.stringify({ ...record, bytes: assumed }), "utf8");
		if (measured === assumed) return measured;
		assumed = measured;
	}
	return assumed;
}

export function createAnalysisCapture(options: AnalysisCaptureOptions = {}): AnalysisCapture {
	const maxRecordBytes = options.maxRecordBytes ?? DEFAULT_RECORD_LIMIT;
	const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_TOTAL_LIMIT;
	const now = options.now ?? Date.now;
	let paused = false;
	let diagnostic: string | undefined;
	let retainedBytes = 0;
	let sequence = 0;
	const sourceStates = new Map<string, SourceState>();
	const records: AnalysisRecord[] = [];

	const sourceKey = (source: ObservabilitySource) => `${source.channel}\u0000${source.invocationId}`;
	const stateFor = (source: ObservabilitySource) => {
		const key = sourceKey(source);
		let sourceState = sourceStates.get(key);
		if (!sourceState) {
			sourceState = { run: 0, turn: -1, pendingRequestActivities: [], turnRequestActivities: [] };
			sourceStates.set(key, sourceState);
		}
		return sourceState;
	};

	const getSummary = (): AnalysisCaptureSummary => ({
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

	function pause(message: string): void {
		paused = true;
		diagnostic = message;
		options.notify?.(message);
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
		if (paused) return;
		const at = event.at ?? now();
		const eventSource = event.source ?? DEFAULT_SOURCE;
		const sourceState = stateFor(eventSource);
		if (event.type === "agent_start") {
			sourceState.run++;
			sourceState.turn = -1;
			sourceState.pendingRequestActivities = [];
			sourceState.turnRequestActivities = [];
			return;
		}
		if (event.type === "turn_start") {
			if (sourceState.turn !== event.turnIndex) sourceState.turnRequestActivities = [];
			sourceState.turn = event.turnIndex;
			return;
		}
		if (event.type === "request") {
			if (sourceState.pendingRequestActivities.length) {
				sourceState.turnRequestActivities.push(...sourceState.pendingRequestActivities);
				sourceState.pendingRequestActivities = [];
			}
			const requestActivities = sourceState.turnRequestActivities.reduce<AnalysisActivity<AnalysisRequestActivityKind>[]>(
				(current, activity) => addActivity(current, activity, REQUEST_ACTIVITY_ORDER),
				[],
			);

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
				fidelity: event.fidelity ?? "exact-provider", requestActivities, responseActivities: [],
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
		if (event.type === "activity") {
			const activity = event.activity;
			if (activity.kind === "user-input") {
				sourceState.pendingRequestActivities.push({ kind: "user-input" });
			} else if (activity.kind === "tool-result") {
				sourceState.pendingRequestActivities.push({ kind: "tool-result", label: activity.toolName });
			}
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
			const assistantActivities = classifyAssistantMessage(event.message);
			const updated = tryReplaceRecord(targetSequence, (record) => {
				record.assistantJson = serialized.json;
				record.completedAt = at;
				record.state = "complete";
				record.usage = usage;
				for (const activity of assistantActivities.activities) {
					record.responseActivities = addActivity(record.responseActivities, activity, RESPONSE_ACTIVITY_ORDER);
				}
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

	return { observe, getSummary, getRecord, clear };
}
