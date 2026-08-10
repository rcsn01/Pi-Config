import type { ContextUsage, SessionEntry } from "@earendil-works/pi-coding-agent";

export interface SessionUsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	tokens: number;
	cost: number;
	turns: number;
}

export interface ContextUsageTotals {
	tokens: number | null;
	contextWindow: number;
	percent: number | null;
}

export function collectSessionUsage(entries: readonly SessionEntry[]): SessionUsageTotals {
	const totals: SessionUsageTotals = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		tokens: 0,
		cost: 0,
		turns: 0,
	};

	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const usage = entry.message.usage;
		totals.input += finiteNonNegative(usage?.input);
		totals.output += finiteNonNegative(usage?.output);
		totals.cacheRead += finiteNonNegative(usage?.cacheRead);
		totals.cacheWrite += finiteNonNegative(usage?.cacheWrite);
		totals.cost += finiteNonNegative(usage?.cost?.total);
		totals.turns++;
	}

	totals.tokens = totals.input + totals.output + totals.cacheRead + totals.cacheWrite;
	return totals;
}

export function normalizeContextUsage(
	usage: ContextUsage | undefined,
	modelContextWindow = 0,
): ContextUsageTotals {
	const contextWindow = finiteNonNegative(usage?.contextWindow) || finiteNonNegative(modelContextWindow);
	const tokens = usage?.tokens === null || usage?.tokens === undefined
		? null
		: finiteNonNegative(usage.tokens);
	const reportedPercent = usage?.percent === null || usage?.percent === undefined
		? null
		: clampPercent(usage.percent);
	const percent = reportedPercent ?? (tokens !== null && contextWindow > 0
		? clampPercent((tokens / contextWindow) * 100)
		: null);

	return { tokens, contextWindow, percent };
}

function finiteNonNegative(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function clampPercent(value: number): number {
	return Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 0;
}