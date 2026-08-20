/**
 * Global usage aggregation.
 *
 * Classification is shared — the single walker `classifySessionEntries` in
 * ./usage.ts turns a session file's entries into mode-bucketed usage records
 * (main, plan, subagent, advisor, guardian) with per-model attribution. This
 * module aggregates those records across all session files with entry-id
 * dedup so forked sessions (which copy parent entries verbatim) do not
 * double-count.
 */

import { GLOBAL_MODE_LABELS, emptyUsageTotals, type GlobalMode, type SessionUsageEntry, type SessionUsageTotals } from "./usage.ts";

export { classifySessionEntries, GLOBAL_MODES, GLOBAL_MODE_LABELS } from "./usage.ts";
export type { GlobalMode, SessionUsageEntry } from "./usage.ts";

/** A session file with its classified usage entries (no dedup applied yet). */
export interface GlobalSessionRecord {
	file: string;
	id: string;
	cwd: string;
	created: string;
	name?: string;
	firstMessage: string;
	messageCount: number;
	parentSession?: string;
	entries: SessionUsageEntry[];
}

export interface GlobalModeTotals {
	main: SessionUsageTotals;
	plan: SessionUsageTotals;
	subagent: SessionUsageTotals;
	advisor: SessionUsageTotals;
	guardian: SessionUsageTotals;
}

export interface GlobalModelRow {
	model: string;
	usage: SessionUsageTotals;
}

export type GlobalModeModelRows = Record<GlobalMode, GlobalModelRow[]>;

/** Per-session aggregates after dedup: what this session contributes globally. */
export interface GlobalSessionSummary {
	file: string;
	id: string;
	cwd: string;
	created: string;
	name?: string;
	firstMessage: string;
	messageCount: number;
	parentSession?: string;
	totals: GlobalModeTotals;
	total: SessionUsageTotals;
	models: GlobalModeModelRows;
}

export interface GlobalUsageSnapshot {
	scannedAt: number;
	sessions: GlobalSessionSummary[];
	totals: GlobalModeTotals;
	total: SessionUsageTotals;
	models: GlobalModeModelRows;
	modelCount: number;
}

export function emptyGlobalModeTotals(): GlobalModeTotals {
	return {
		main: emptyUsageTotals(),
		plan: emptyUsageTotals(),
		subagent: emptyUsageTotals(),
		advisor: emptyUsageTotals(),
		guardian: emptyUsageTotals(),
	};
}

type ModelAccumulator = Record<GlobalMode, Map<string, SessionUsageTotals>>;

function emptyModelAccumulator(): ModelAccumulator {
	return {
		main: new Map(),
		plan: new Map(),
		subagent: new Map(),
		advisor: new Map(),
		guardian: new Map(),
	};
}

function addTotals(
	target: SessionUsageTotals,
	source: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; turns: number },
): void {
	target.input += source.input;
	target.output += source.output;
	target.cacheRead += source.cacheRead;
	target.cacheWrite += source.cacheWrite;
	target.cost += source.cost;
	target.turns += source.turns;
}

function finalizeTotals(totals: SessionUsageTotals): SessionUsageTotals {
	totals.tokens = totals.input + totals.output + totals.cacheRead + totals.cacheWrite;
	return totals;
}

function sumModeTotals(modes: GlobalModeTotals): SessionUsageTotals {
	const total = emptyUsageTotals();
	for (const { mode } of GLOBAL_MODE_LABELS) addTotals(total, modes[mode]);
	return finalizeTotals(total);
}

function finalizeModeTotals(modes: GlobalModeTotals): GlobalModeTotals {
	for (const { mode } of GLOBAL_MODE_LABELS) finalizeTotals(modes[mode]);
	return modes;
}

function sortedModelRows(rows: Map<string, SessionUsageTotals>): GlobalModelRow[] {
	return [...rows.entries()]
		.map(([model, usage]) => ({ model, usage: finalizeTotals(usage) }))
		.filter((row) => row.usage.tokens > 0 || row.usage.cost > 0 || row.usage.turns > 0)
		.sort((left, right) => {
			if (left.model === "unknown") return 1;
			if (right.model === "unknown") return -1;
			return right.usage.tokens - left.usage.tokens || left.model.localeCompare(right.model);
		});
}

function toModelRows(accumulator: ModelAccumulator): GlobalModeModelRows {
	return {
		main: sortedModelRows(accumulator.main),
		plan: sortedModelRows(accumulator.plan),
		subagent: sortedModelRows(accumulator.subagent),
		advisor: sortedModelRows(accumulator.advisor),
		guardian: sortedModelRows(accumulator.guardian),
	};
}

function parseCreatedMs(created: string): number {
	const ms = Date.parse(created);
	return Number.isFinite(ms) ? ms : 0;
}

/**
 * Aggregate per-session records into a global snapshot. Entry ids are deduped
 * across files with first-occurrence wins; records are processed oldest-first
 * (by header created time, then path) so a fork's copied history is attributed
 * to the original session and only the fork's own continuation counts under
 * the fork. Buckets are exclusive: `total` is the sum of all five modes.
 */
export function buildGlobalUsageSnapshot(records: readonly GlobalSessionRecord[]): GlobalUsageSnapshot {
	const seen = new Set<string>();
	const countedModels = new Set<string>();
	const ordered = [...records].sort(
		(a, b) => parseCreatedMs(a.created) - parseCreatedMs(b.created) || a.file.localeCompare(b.file),
	);

	const globalTotals = emptyGlobalModeTotals();
	const globalModels = emptyModelAccumulator();
	const sessions: GlobalSessionSummary[] = [];

	for (const record of ordered) {
		const sessionTotals = emptyGlobalModeTotals();
		const sessionModels = emptyModelAccumulator();
		for (const entry of record.entries) {
			if (seen.has(entry.id)) continue;
			seen.add(entry.id);
			if (entry.model !== "unknown") countedModels.add(entry.model);
			addTotals(sessionTotals[entry.mode], entry);
			addTotals(globalTotals[entry.mode], entry);
			let sessionModelTotals = sessionModels[entry.mode].get(entry.model);
			if (!sessionModelTotals) {
				sessionModelTotals = emptyUsageTotals();
				sessionModels[entry.mode].set(entry.model, sessionModelTotals);
			}
			addTotals(sessionModelTotals, entry);
			let globalModelTotals = globalModels[entry.mode].get(entry.model);
			if (!globalModelTotals) {
				globalModelTotals = emptyUsageTotals();
				globalModels[entry.mode].set(entry.model, globalModelTotals);
			}
			addTotals(globalModelTotals, entry);
		}
		sessions.push({
			file: record.file,
			id: record.id,
			cwd: record.cwd,
			created: record.created,
			name: record.name,
			firstMessage: record.firstMessage,
			messageCount: record.messageCount,
			parentSession: record.parentSession,
			totals: finalizeModeTotals(sessionTotals),
			total: sumModeTotals(sessionTotals),
			models: toModelRows(sessionModels),
		});
	}

	return {
		scannedAt: Date.now(),
		sessions: sessions.sort(
			(a, b) => b.total.cost - a.total.cost || b.total.tokens - a.total.tokens || a.file.localeCompare(b.file),
		),
		totals: finalizeModeTotals(globalTotals),
		total: sumModeTotals(globalTotals),
		models: toModelRows(globalModels),
		modelCount: countedModels.size,
	};
}
