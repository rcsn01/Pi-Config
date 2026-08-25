import type { ExperimentConfig, TrialResult, TurnObservation } from "./experiment.ts";

export type Conclusion = "supports" | "contradicts" | "mixed" | "inconclusive";
export type TransitionOutcome = "hit" | "miss" | "inconclusive";
export type ContinuationConclusion = "invalidated-on-change" | "retained-on-change" | "mixed" | "inconclusive";

export interface TransitionAnalysis {
	trialId: string;
	direction: string;
	outcome: TransitionOutcome;
	anchorTokens?: number;
	changeCacheRead?: number;
	controlCacheReads: number[];
	reason?: string;
}

export interface ServerCacheAnalysis {
	conclusion: Conclusion;
	transitions: TransitionAnalysis[];
	valid: number;
	hits: number;
	misses: number;
}

export interface ContinuationTrialAnalysis {
	trialId: string;
	outcome: ContinuationConclusion;
	wireModes: string[];
	reason?: string;
}

export interface ContinuationAnalysis {
	conclusion: ContinuationConclusion;
	trials: ContinuationTrialAnalysis[];
}

export interface ExperimentAnalysis {
	serverCache: ServerCacheAnalysis;
	continuation?: ContinuationAnalysis;
	completedCalls: number;
	reportedCost: number;
	complete: boolean;
}

const NOISE_FLOOR_TOKENS = 1024;
const MIN_ANCHOR_TOKENS = 2048;

function promptTokens(turn: TurnObservation): number {
	return turn.usage.input + turn.usage.cacheRead + turn.usage.cacheWrite;
}

function cacheCoversAnchor(turn: TurnObservation, anchor: number): boolean {
	return turn.usage.cacheRead >= Math.max(0, anchor - NOISE_FLOOR_TOKENS);
}

function directionFor(trial: TrialResult): string {
	const efforts = trial.spec.efforts;
	return `${efforts[1]}→${efforts[2]}`;
}

export function analyzeServerTrial(trial: TrialResult): TransitionAnalysis {
	const base = {
		trialId: trial.spec.id,
		direction: directionFor(trial),
		controlCacheReads: [trial.turns[1]?.usage.cacheRead ?? 0, trial.turns[3]?.usage.cacheRead ?? 0],
	};
	if (trial.spec.transport !== "sse") {
		return { ...base, outcome: "inconclusive", reason: "Server-cache verdicts use the full-context SSE control." };
	}
	if (trial.error || trial.turns.length !== 4) {
		return { ...base, outcome: "inconclusive", reason: trial.error ?? "The trial did not complete four turns." };
	}
	if (!trial.payloadValid) {
		return { ...base, outcome: "inconclusive", reason: trial.payloadIssues.join(" ") || "Payload invariants failed." };
	}
	if (trial.turns.some((turn) => turn.stopReason !== "stop" || promptTokens(turn) <= 0)) {
		return { ...base, outcome: "inconclusive", reason: "One or more turns did not complete successfully with usage." };
	}
	const anchor = promptTokens(trial.turns[0]!);
	if (anchor < MIN_ANCHOR_TOKENS) {
		return { ...base, outcome: "inconclusive", anchorTokens: anchor, reason: "The cacheable anchor was too small." };
	}
	const before = trial.turns[1]!;
	const changed = trial.turns[2]!;
	const after = trial.turns[3]!;
	if (!cacheCoversAnchor(before, anchor) || !cacheCoversAnchor(after, anchor)) {
		return {
			...base,
			outcome: "inconclusive",
			anchorTokens: anchor,
			changeCacheRead: changed.usage.cacheRead,
			reason: "One or both same-effort controls did not read the stable cache anchor.",
		};
	}
	return {
		...base,
		outcome: cacheCoversAnchor(changed, anchor) ? "hit" : "miss",
		anchorTokens: anchor,
		changeCacheRead: changed.usage.cacheRead,
	};
}

function aggregateServer(transitions: TransitionAnalysis[]): ServerCacheAnalysis {
	const valid = transitions.filter((transition) => transition.outcome !== "inconclusive");
	const hits = valid.filter((transition) => transition.outcome === "hit").length;
	const misses = valid.filter((transition) => transition.outcome === "miss").length;
	let conclusion: Conclusion;
	if (valid.length === 0) conclusion = "inconclusive";
	else if (hits > 0 && misses > 0) conclusion = "mixed";
	else if (misses > 0) conclusion = "contradicts";
	else conclusion = "supports";
	return { conclusion, transitions, valid: valid.length, hits, misses };
}

export function analyzeContinuationTrial(trial: TrialResult): ContinuationTrialAnalysis {
	const wireModes = trial.turns.map((turn) => turn.wireMode ?? "unknown");
	const base = { trialId: trial.spec.id, wireModes };
	if (trial.spec.transport !== "auto" || trial.turns.length !== 4 || trial.error) {
		return { ...base, outcome: "inconclusive", reason: trial.error ?? "The auto trial did not complete." };
	}
	if (!trial.payloadValid || trial.turns.some((turn) => turn.stopReason !== "stop" || promptTokens(turn) <= 0)) {
		return { ...base, outcome: "inconclusive", reason: "The auto trial failed request or response validation." };
	}
	if (wireModes.includes("sse-fallback")) {
		return { ...base, outcome: "inconclusive", reason: "Auto transport fell back to SSE." };
	}
	if (wireModes.some((mode) => mode === "unknown")) {
		return { ...base, outcome: "inconclusive", reason: "Installed Pi WebSocket debug statistics were unavailable." };
	}
	const controlsUseDelta = wireModes[1] === "delta" && wireModes[3] === "delta";
	if (!controlsUseDelta) {
		return { ...base, outcome: "inconclusive", reason: "Same-effort controls did not demonstrate continuation reuse." };
	}
	if (wireModes[2] === "full") return { ...base, outcome: "invalidated-on-change" };
	if (wireModes[2] === "delta") return { ...base, outcome: "retained-on-change" };
	return { ...base, outcome: "inconclusive", reason: "The changed-effort request transport was not classified." };
}

function aggregateContinuation(trials: ContinuationTrialAnalysis[]): ContinuationAnalysis {
	const valid = trials.filter((trial) => trial.outcome !== "inconclusive");
	const outcomes = new Set(valid.map((trial) => trial.outcome));
	let conclusion: ContinuationConclusion;
	if (valid.length === 0) conclusion = "inconclusive";
	else if (outcomes.size > 1) conclusion = "mixed";
	else conclusion = valid[0]!.outcome;
	return { conclusion, trials };
}

export function analyzeExperiment(result: {
	config: ExperimentConfig;
	trials: TrialResult[];
	plannedCalls?: number;
	cancelled?: boolean;
}): ExperimentAnalysis {
	const serverTransitions = result.trials
		.filter((trial) => trial.spec.transport === "sse")
		.map(analyzeServerTrial);
	const autoTrials = result.trials
		.filter((trial) => trial.spec.transport === "auto")
		.map(analyzeContinuationTrial);
	const completedTurns = result.trials.flatMap((trial) => trial.turns);
	const complete = result.cancelled !== true &&
		!result.trials.some((trial) => Boolean(trial.error)) &&
		(result.plannedCalls === undefined || completedTurns.length === result.plannedCalls);
	const serverCache = aggregateServer(serverTransitions);
	const continuation = result.config.provider === "openai-codex" ? aggregateContinuation(autoTrials) : undefined;
	if (!complete) {
		serverCache.conclusion = "inconclusive";
		if (continuation) continuation.conclusion = "inconclusive";
	}
	return {
		serverCache,
		continuation,
		completedCalls: completedTurns.length,
		reportedCost: completedTurns.reduce((sum, turn) => sum + turn.usage.cost.total, 0),
		complete,
	};
}
