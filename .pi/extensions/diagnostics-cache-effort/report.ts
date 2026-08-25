import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Box } from "@earendil-works/pi-tui";
import { renderTranscriptCard, type TranscriptCardState } from "../_shared/transcript-card.ts";
import type { Conclusion, ContinuationConclusion } from "./analysis.ts";
import type { ExperimentResult, TrialResult } from "./experiment.ts";

export const REPORT_ENTRY_TYPE = "diagnostics-cache-effort-report-v1";

function serverLabel(conclusion: Conclusion): string {
	switch (conclusion) {
		case "supports": return "supports no effort-induced miss";
		case "contradicts": return "observed effort-specific misses";
		case "mixed": return "mixed results";
		case "inconclusive": return "inconclusive";
	}
}

function continuationLabel(conclusion: ContinuationConclusion): string {
	switch (conclusion) {
		case "invalidated-on-change": return "effort changes used full context";
		case "retained-on-change": return "effort changes retained delta continuation";
		case "mixed": return "mixed transport behavior";
		case "inconclusive": return "inconclusive";
	}
}

function stateFor(result: ExperimentResult): TranscriptCardState {
	if (result.analysis.completedCalls === 0) return "error";
	if (result.cancelled || result.analysis.serverCache.conclusion !== "supports") return "warning";
	return "success";
}

export function compactReportSummary(result: ExperimentResult): string {
	const server = serverLabel(result.analysis.serverCache.conclusion);
	const continuation = result.analysis.continuation
		? ` · Pi continuation: ${continuationLabel(result.analysis.continuation.conclusion)}`
		: "";
	return `OpenAI cache: ${server}${continuation} · ${result.analysis.completedCalls}/${result.plannedCalls} calls`;
}

function integer(value: number | undefined): string {
	return value === undefined ? "—" : Math.round(value).toLocaleString("en-US");
}

function formatTrial(trial: TrialResult): string {
	const heading = `### ${trial.spec.transport.toUpperCase()} · ${trial.spec.orientation.toUpperCase()} · ${trial.spec.id}`;
	if (trial.error) return `${heading}\n\nError: ${trial.error}`;
	const rows = trial.turns.map((turn) => {
		const prompt = turn.usage.input + turn.usage.cacheRead + turn.usage.cacheWrite;
		return `| ${turn.index + 1} | ${turn.effort} | ${integer(prompt)} | ${integer(turn.usage.cacheRead)} | ${integer(turn.usage.output)} | ${integer(turn.usage.reasoning)} | ${turn.wireMode ?? "—"} | ${integer(turn.latencyMs)} |`;
	});
	const firstPayload = trial.turns.find((turn) => turn.payload)?.payload;
	const payload = trial.payloadValid
		? `valid; cache key ${firstPayload?.promptCacheKeyHash ?? "unavailable"}; body ${firstPayload?.staticBodyHash ?? "unavailable"}`
		: `invalid: ${trial.payloadIssues.join(" ")}`;
	return [
		heading,
		"",
		"| Turn | Effort | Prompt | Cache read | Output | Reasoning | Wire | Latency ms |",
		"|---:|---|---:|---:|---:|---:|---|---:|",
		...rows,
		"",
		`Payload invariants: ${payload}.`,
	].join("\n");
}

export function formatExpandedReport(result: ExperimentResult): string {
	const server = result.analysis.serverCache;
	const transitionRows = server.transitions.map((transition) =>
		`| ${transition.direction} | ${transition.outcome} | ${integer(transition.anchorTokens)} | ${integer(transition.changeCacheRead)} | ${transition.controlCacheReads.map(integer).join(" / ")} |`,
	);
	const sections = [
		"## OpenAI server prompt cache · SSE",
		"",
		`Conclusion: **${serverLabel(server.conclusion)}** (${server.hits} hit, ${server.misses} miss, ${server.transitions.length - server.valid} inconclusive).`,
		"",
		"| Change | Outcome | Anchor | Change cache read | Control cache reads |",
		"|---|---|---:|---:|---|",
		...transitionRows,
	];
	if (result.analysis.continuation) {
		sections.push(
			"",
			"## Pi WebSocket continuation · auto",
			"",
			`Conclusion: **${continuationLabel(result.analysis.continuation.conclusion)}**.`,
			...result.analysis.continuation.trials.map((trial) =>
				`- ${trial.trialId}: ${trial.outcome} (${trial.wireModes.join(" → ")})${trial.reason ? ` — ${trial.reason}` : ""}`,
			),
		);
	}
	sections.push("", "## Per-turn evidence", "", ...result.trials.map(formatTrial));
	if (!result.analysis.complete) {
		sections.push("", "Run incomplete; aggregate conclusions are intentionally inconclusive. Completed trials remain diagnostic evidence only.");
	}
	return sections.join("\n");
}

export function renderExperimentReport(result: ExperimentResult, expanded: boolean, theme: Theme): Box {
	const runtime = result.trials.find((trial) => trial.runtime)?.runtime;
	return renderTranscriptCard(theme, {
		title: `Prompt-cache effort test · ${result.config.provider}/${result.config.modelId}`,
		state: stateFor(result),
		summary: compactReportSummary(result),
		body: formatExpandedReport(result),
		metadata: [
			`${result.config.effortA} ↔ ${result.config.effortB} · ${result.config.runSize}`,
			`Pi ${runtime?.piVersion ?? "unknown"} · pi-ai ${runtime?.piAiVersion ?? "unknown"}`,
			`reported cost estimate $${result.analysis.reportedCost.toFixed(4)} · ${new Date(result.startedAt).toLocaleString()}`,
		],
		expanded,
	});
}

export function isExperimentResult(value: unknown): value is ExperimentResult {
	return typeof value === "object" && value !== null &&
		(value as { schemaVersion?: unknown }).schemaVersion === 1 &&
		Array.isArray((value as { trials?: unknown }).trials);
}
