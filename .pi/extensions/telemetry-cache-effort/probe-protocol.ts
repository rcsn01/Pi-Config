import { createHash } from "node:crypto";
import type { PayloadObservation, RuntimeObservation, WireMode } from "./experiment.ts";

export const PROBE_MARKER = "PI_CACHE_EFFORT_PROBE ";

export type ProbeEvent =
	| { type: "runtime"; observation: RuntimeObservation }
	| { type: "request"; observation: PayloadObservation }
	| {
		type: "turn";
		requestIndex: number;
		wireMode: WireMode;
		websocketStats?: Record<string, number | string | boolean | undefined>;
	};

function canonicalize(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (typeof value === "object" && value !== null) {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>)
				.filter(([, child]) => child !== undefined)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, child]) => [key, canonicalize(child)]),
		);
	}
	return value;
}

export function stableHash(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex").slice(0, 16);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}

export function fingerprintPayload(payload: unknown, requestIndex: number): PayloadObservation {
	const body = asRecord(payload) ?? {};
	const reasoning = asRecord(body.reasoning);
	const normalized = { ...body };
	delete normalized.input;
	if ("reasoning" in normalized) normalized.reasoning = "<reasoning-effort>";
	else normalized.reasoning = "<reasoning-effort>";
	const input = Array.isArray(body.input) ? body.input : [];
	return {
		requestIndex,
		promptCacheKeyHash: typeof body.prompt_cache_key === "string" ? stableHash(body.prompt_cache_key) : undefined,
		staticBodyHash: stableHash(normalized),
		instructionsHash: typeof body.instructions === "string" ? stableHash(body.instructions) : undefined,
		inputItemHashes: input.map(stableHash),
		effectiveEffort: typeof reasoning?.effort === "string" ? reasoning.effort : reasoning ? "present" : "omitted",
		topLevelKeys: Object.keys(body).sort(),
	};
}

export function serializeProbeEvent(event: ProbeEvent): string {
	return `${PROBE_MARKER}${JSON.stringify(event)}\n`;
}

export function parseProbeLine(line: string): ProbeEvent | undefined {
	if (!line.startsWith(PROBE_MARKER)) return undefined;
	try {
		return JSON.parse(line.slice(PROBE_MARKER.length)) as ProbeEvent;
	} catch {
		return undefined;
	}
}
