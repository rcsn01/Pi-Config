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

/** Activity persisted in a session file, kept separate from token usage. */
export type SessionActivityKind = "assistant" | "tool";

export interface SessionActivityEntry {
	id: string;
	kind: SessionActivityKind;
	toolName?: string;
	/** Milliseconds since Unix epoch for calendar activity attribution. */
	timestamp?: number;
}

export interface GlobalToolRow {
	tool: string;
	runs: number;
}

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
	/** Activity records are separate from usage because tools may have no usage. */
	activity?: SessionActivityEntry[];
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
	/** Non-error assistant responses in this session, including copied fork history. */
	chatTurns: number;
	/** Persisted toolResult messages in this session, including copied fork history. */
	toolRuns: number;
	totals: GlobalModeTotals;
	total: SessionUsageTotals;
	models: GlobalModeModelRows;
}

export interface GlobalUsageSnapshot {
	scannedAt: number;
	/** Deduplicated records retained for time-series bucketing. */
	timeline: SessionUsageEntry[];
	sessions: GlobalSessionSummary[];
	totals: GlobalModeTotals;
	total: SessionUsageTotals;
	models: GlobalModeModelRows;
	modelCount: number;
	/** All globally deduplicated tool runs, sorted by count. */
	tools: GlobalToolRow[];
	toolRunCount: number;
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

function sortedToolRows(counts: Map<string, number>): GlobalToolRow[] {
	return [...counts.entries()]
		.map(([tool, runs]) => ({ tool, runs }))
		.sort((left, right) => right.runs - left.runs || left.tool.localeCompare(right.tool));
}

function parseCreatedMs(created: string): number {
	const ms = Date.parse(created);
	return Number.isFinite(ms) ? ms : 0;
}

/**
 * Aggregate per-session records into a global snapshot. Entry ids are deduped
 * across files with the parent session processed before its forks, so copied
 * history is attributed to the original session and only a fork's continuation
 * counts under the fork. Missing or malformed ancestry falls back to creation
 * time and path. Buckets are exclusive: `total` is the sum of all five modes.
 */
export function buildGlobalUsageSnapshot(records: readonly GlobalSessionRecord[]): GlobalUsageSnapshot {
	const seen = new Set<string>();
	const seenActivity = new Set<string>();
	const countedModels = new Set<string>();
	const globalToolCounts = new Map<string, number>();
	const byFile = new Map(records.map((record) => [record.file, record]));
	const sorted = [...records].sort(
		(a, b) => parseCreatedMs(a.created) - parseCreatedMs(b.created) || a.file.localeCompare(b.file),
	);
	const ordered: GlobalSessionRecord[] = [];
	const visited = new Set<string>();
	const visiting = new Set<string>();
	const visit = (record: GlobalSessionRecord): void => {
		if (visited.has(record.file)) return;
		if (visiting.has(record.file)) {
			// Malformed ancestry should not prevent the rest of the scan from loading.
			return;
		}
		visiting.add(record.file);
		const parent = record.parentSession ? byFile.get(record.parentSession) : undefined;
		if (parent) visit(parent);
		visiting.delete(record.file);
		visited.add(record.file);
		ordered.push(record);
	};
	for (const record of sorted) visit(record);

	const globalTotals = emptyGlobalModeTotals();
	const globalModels = emptyModelAccumulator();
	const timeline: SessionUsageEntry[] = [];
	const sessions: GlobalSessionSummary[] = [];

	for (const record of ordered) {
		const activity = record.activity ?? [];
		const chatTurns = activity.filter((entry) => entry.kind === "assistant").length;
		const toolRuns = activity.filter((entry) => entry.kind === "tool").length;
		for (const entry of activity) {
			if (seenActivity.has(entry.id)) continue;
			seenActivity.add(entry.id);
			if (entry.kind !== "tool" || !entry.toolName) continue;
			globalToolCounts.set(entry.toolName, (globalToolCounts.get(entry.toolName) ?? 0) + 1);
		}
		const sessionTotals = emptyGlobalModeTotals();
		const sessionModels = emptyModelAccumulator();
		for (const entry of record.entries) {
			if (seen.has(entry.id)) continue;
			seen.add(entry.id);
			timeline.push({ ...entry });
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
			chatTurns,
			toolRuns,
			totals: finalizeModeTotals(sessionTotals),
			total: sumModeTotals(sessionTotals),
			models: toModelRows(sessionModels),
		});
	}

	return {
		scannedAt: Date.now(),
		timeline: timeline.sort((left, right) => (left.timestamp ?? 0) - (right.timestamp ?? 0) || left.id.localeCompare(right.id)),
		sessions: sessions.sort(
			(a, b) => b.total.cost - a.total.cost || b.total.tokens - a.total.tokens || a.file.localeCompare(b.file),
		),
		totals: finalizeModeTotals(globalTotals),
		total: sumModeTotals(globalTotals),
		models: toModelRows(globalModels),
		modelCount: countedModels.size,
		tools: sortedToolRows(globalToolCounts),
		toolRunCount: [...globalToolCounts.values()].reduce((total, runs) => total + runs, 0),
	};
}
