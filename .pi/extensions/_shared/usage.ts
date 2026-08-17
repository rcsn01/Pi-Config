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

type ReportedUsage = {
	input?: unknown;
	output?: unknown;
	cacheRead?: unknown;
	cacheWrite?: unknown;
	cost?: unknown;
	turns?: unknown;
};

function emptyUsageTotals(): SessionUsageTotals {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		tokens: 0,
		cost: 0,
		turns: 0,
	};
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null
		? value as Record<string, unknown>
		: undefined;
}

function addUsage(totals: SessionUsageTotals, value: unknown, includeTurns = false): void {
	const usage = asRecord(value) as ReportedUsage | undefined;
	totals.input += finiteNonNegative(usage?.input);
	totals.output += finiteNonNegative(usage?.output);
	totals.cacheRead += finiteNonNegative(usage?.cacheRead);
	totals.cacheWrite += finiteNonNegative(usage?.cacheWrite);
	const cost = asRecord(usage?.cost);
	totals.cost += finiteNonNegative(cost ? cost.total : usage?.cost);
	if (includeTurns) totals.turns += finiteNonNegative(usage?.turns);
}

function nestedSubagentUsages(details: unknown): unknown[] {
	const results = asRecord(details)?.results;
	if (!Array.isArray(results)) return [];
	return results.map((result) => asRecord(result)?.usage).filter((usage) => usage !== undefined);
}

function finalizeUsage(totals: SessionUsageTotals): SessionUsageTotals {
	totals.tokens = totals.input + totals.output + totals.cacheRead + totals.cacheWrite;
	return totals;
}

export function collectSubagentUsage(entries: readonly SessionEntry[]): SessionUsageTotals {
	const totals = emptyUsageTotals();
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.toolName !== "subagent") {
			continue;
		}
		// Newer sessions persist aggregate tool usage at the message level. Older
		// sessions only have per-result usage in details; never add both.
		if (entry.message.usage !== undefined) {
			addUsage(totals, entry.message.usage, true);
		} else {
			for (const usage of nestedSubagentUsages(entry.message.details)) addUsage(totals, usage, true);
		}
	}
	return finalizeUsage(totals);
}

export function collectSessionUsage(entries: readonly SessionEntry[]): SessionUsageTotals {
	const totals = emptyUsageTotals();
	for (const entry of entries) {
		if (entry.type === "message" && entry.message.role === "assistant") {
			addUsage(totals, entry.message.usage);
			totals.turns++;
		} else if (entry.type === "message" && entry.message.role === "toolResult") {
			if (entry.message.usage !== undefined) {
				addUsage(totals, entry.message.usage);
			} else if (entry.message.toolName === "subagent") {
				for (const usage of nestedSubagentUsages(entry.message.details)) addUsage(totals, usage);
			}
		} else if (entry.type === "compaction" || entry.type === "branch_summary") {
			addUsage(totals, entry.usage);
		}
	}
	return finalizeUsage(totals);
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