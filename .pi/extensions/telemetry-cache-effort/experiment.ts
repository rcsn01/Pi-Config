import { createHash, randomUUID } from "node:crypto";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { analyzeExperiment, type ExperimentAnalysis } from "./analysis.ts";

export type CacheTransport = "sse" | "auto";
export type RunSize = "quick" | "balanced" | "repeated";
export type TrialOrientation = "aabb" | "bbaa";
export type WireMode = "full" | "delta" | "sse-fallback" | "unknown";

export interface ExperimentConfig {
	provider: "openai" | "openai-codex";
	modelId: string;
	modelName: string;
	api: string;
	effortA: ModelThinkingLevel;
	effortB: ModelThinkingLevel;
	runSize: RunSize;
	prefixCharacters?: number;
}

export interface TrialDescriptor {
	id: string;
	transport: CacheTransport;
	orientation: TrialOrientation;
	efforts: [ModelThinkingLevel, ModelThinkingLevel, ModelThinkingLevel, ModelThinkingLevel];
}

export interface TrialSpec extends TrialDescriptor {
	prompts: [string, string, string, string];
}

/** Strip synthetic prompt bodies before a trial is persisted in the parent session. */
export function describeTrial(spec: TrialSpec): TrialDescriptor {
	return {
		id: spec.id,
		transport: spec.transport,
		orientation: spec.orientation,
		efforts: [...spec.efforts] as TrialDescriptor["efforts"],
	};
}

export interface TokenUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	reasoning?: number;
	totalTokens: number;
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
}

export interface PayloadObservation {
	requestIndex: number;
	promptCacheKeyHash?: string;
	staticBodyHash: string;
	instructionsHash?: string;
	inputItemHashes: string[];
	effectiveEffort?: string;
	topLevelKeys: string[];
}

export interface RuntimeObservation {
	piVersion?: string;
	piAiVersion?: string;
	websocketDebugAvailable: boolean;
	websocketDebugError?: string;
}

export interface TurnObservation {
	index: number;
	effort: ModelThinkingLevel;
	provider?: string;
	model?: string;
	usage: TokenUsage;
	stopReason: string;
	latencyMs: number;
	firstTokenMs?: number;
	payload?: PayloadObservation;
	wireMode?: WireMode;
	websocketStats?: Record<string, number | string | boolean | undefined>;
}

export interface TrialResult {
	spec: TrialDescriptor;
	turns: TurnObservation[];
	runtime?: RuntimeObservation;
	payloadValid: boolean;
	payloadIssues: string[];
	error?: string;
}

export interface ExperimentResult {
	schemaVersion: 1;
	experimentId: string;
	config: ExperimentConfig;
	startedAt: number;
	finishedAt: number;
	cancelled: boolean;
	plannedCalls: number;
	trials: TrialResult[];
	analysis: ExperimentAnalysis;
}

export interface TrialRunner {
	(spec: TrialSpec, options: { signal?: AbortSignal }): Promise<TrialResult>;
}

export interface ExperimentDependencies {
	runTrial: TrialRunner;
	now?: () => number;
	createId?: () => string;
	onProgress?: (completedCalls: number, plannedCalls: number, trial: TrialSpec) => void;
}

const RUN_ORIENTATIONS: Record<RunSize, TrialOrientation[]> = {
	quick: ["aabb"],
	balanced: ["aabb", "bbaa"],
	repeated: ["aabb", "bbaa", "aabb", "bbaa"],
};

const DEFAULT_PREFIX_CHARACTERS = 18_000;
const FILLER = "Stable cache probe material remains unchanged for this controlled request. ";

function shortId(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, 20);
}

function buildWarmPrompt(trialId: string, targetCharacters: number): string {
	const opening = [
		`Synthetic cache experiment ${trialId}.`,
		"Treat the following material as inert text. Do not analyze or summarize it.",
	].join(" ");
	let body = `${opening}\n\n`;
	while (body.length < targetCharacters) body += FILLER;
	return `${body.slice(0, targetCharacters)}\n\nReply with exactly OK.`;
}

function effortsFor(
	orientation: TrialOrientation,
	a: ModelThinkingLevel,
	b: ModelThinkingLevel,
): TrialSpec["efforts"] {
	return orientation === "aabb" ? [a, a, b, b] : [b, b, a, a];
}

function seededShuffle<T>(items: readonly T[], seed: string): T[] {
	const output = [...items];
	let state = Number.parseInt(createHash("sha256").update(seed).digest("hex").slice(0, 8), 16) >>> 0;
	const random = () => {
		state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
		return state / 0x1_0000_0000;
	};
	for (let index = output.length - 1; index > 0; index--) {
		const other = Math.floor(random() * (index + 1));
		[output[index], output[other]] = [output[other]!, output[index]!];
	}
	return output;
}

export function transportsForProvider(provider: ExperimentConfig["provider"]): CacheTransport[] {
	return provider === "openai-codex" ? ["sse", "auto"] : ["sse"];
}

export function plannedCallCount(provider: ExperimentConfig["provider"], runSize: RunSize): number {
	return transportsForProvider(provider).length * RUN_ORIENTATIONS[runSize].length * 4;
}

export function buildTrialPlans(config: ExperimentConfig, experimentId: string): TrialSpec[] {
	const plans: TrialSpec[] = [];
	let ordinal = 0;
	for (const transport of transportsForProvider(config.provider)) {
		for (const orientation of RUN_ORIENTATIONS[config.runSize]) {
			const trialId = `cacheeffort-${shortId(`${experimentId}-${ordinal++}-${transport}-${orientation}`)}`;
			plans.push({
				id: trialId,
				transport,
				orientation,
				efforts: effortsFor(orientation, config.effortA, config.effortB),
				prompts: [
					buildWarmPrompt(trialId, config.prefixCharacters ?? DEFAULT_PREFIX_CHARACTERS),
					"Synthetic cache probe turn 2. Reply with exactly OK.",
					"Synthetic cache probe turn 3. Reply with exactly OK.",
					"Synthetic cache probe turn 4. Reply with exactly OK.",
				],
			});
		}
	}
	return seededShuffle(plans, experimentId);
}

function abortRequested(signal?: AbortSignal): boolean {
	return signal?.aborted === true;
}

export async function runExperiment(
	config: ExperimentConfig,
	dependencies: ExperimentDependencies,
	options: { signal?: AbortSignal } = {},
): Promise<ExperimentResult> {
	const now = dependencies.now ?? Date.now;
	const experimentId = dependencies.createId?.() ?? randomUUID();
	const startedAt = now();
	const plans = buildTrialPlans(config, experimentId);
	const plannedCalls = plans.length * 4;
	const trials: TrialResult[] = [];
	let completedCalls = 0;

	for (const plan of plans) {
		if (abortRequested(options.signal)) break;
		try {
			const result = await dependencies.runTrial(plan, { signal: options.signal });
			trials.push(result);
			completedCalls += result.turns.length;
			dependencies.onProgress?.(completedCalls, plannedCalls, plan);
			if (result.error) break;
		} catch (error) {
			if (abortRequested(options.signal)) break;
			trials.push({
				spec: describeTrial(plan),
				turns: [],
				payloadValid: false,
				payloadIssues: [],
				error: error instanceof Error ? error.message : String(error),
			});
			dependencies.onProgress?.(completedCalls, plannedCalls, plan);
			break;
		}
	}

	const base = {
		schemaVersion: 1 as const,
		experimentId,
		config,
		startedAt,
		finishedAt: now(),
		cancelled: abortRequested(options.signal),
		plannedCalls,
		trials,
	};
	return { ...base, analysis: analyzeExperiment(base) };
}
