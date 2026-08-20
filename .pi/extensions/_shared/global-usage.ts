/**
 * Global usage classification and aggregation.
 *
 * Classifies every usage-bearing entry of a session file into one of five
 * exclusive buckets — main, plan mode, subagent, advisor, guardian — with
 * per-model attribution, then aggregates across all session files with
 * entry-id dedup so forked sessions (which copy parent entries verbatim) do
 * not double-count.
 *
 * Plan Mode turns are ordinary assistant messages in the same session; mode
 * transitions are persisted as `plan-mode-state` custom entries (new
 * `{mode}` shape and legacy `{active}` shape). Attribution walks entries
 * with parentId-chain mode tracking so every branch inherits the mode of its
 * own ancestor chain.
 */

import type { FileEntry } from "@earendil-works/pi-coding-agent";
import { PLAN_STATE_ENTRY_TYPE } from "./session-entries.ts";
import {
	asRecord,
	emptyUsageTotals,
	finiteNonNegative,
	modelKey,
	modelName,
	nestedSubagentResults,
	type SessionUsageTotals,
} from "./usage.ts";

export const GLOBAL_MODES = ["main", "plan", "subagent", "advisor", "guardian"] as const;
export type GlobalMode = (typeof GLOBAL_MODES)[number];

export const GLOBAL_MODE_LABELS: readonly { mode: GlobalMode; label: string }[] = [
	{ mode: "main", label: "Main" },
	{ mode: "plan", label: "Plan mode" },
	{ mode: "subagent", label: "Subagent" },
	{ mode: "advisor", label: "Advisor" },
	{ mode: "guardian", label: "Guardian" },
];

/** One classified usage record. `model` is `provider/model` or "unknown". */
export interface SessionUsageEntry {
	id: string;
	mode: GlobalMode;
	model: string;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
}

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

/** Resolve the mode a plan-mode-state entry activates; undefined = no change. */
function planModeFromState(data: Record<string, unknown> | undefined): GlobalMode | undefined {
	if (!data) return undefined;
	if (data.mode === "plan") return "plan";
	if (data.mode === "default") return "main";
	if (data.active === true) return "plan";
	if (data.active === false) return "main";
	return undefined;
}

interface UsageEntryOptions {
	/** Base turn count added to the usage-reported turns (assistant messages). */
	turns?: number;
	/** Keep the entry even when the usage record is missing entirely. */
	keepWhenMissing?: boolean;
}

function usageEntry(
	id: string,
	mode: GlobalMode,
	model: string | undefined,
	usage: unknown,
	options: UsageEntryOptions = {},
): SessionUsageEntry | undefined {
	const record = asRecord(usage);
	if (!record && !options.keepWhenMissing) return undefined;
	const cost = asRecord(record?.cost);
	const entry: SessionUsageEntry = {
		id,
		mode,
		model: model ?? "unknown",
		input: finiteNonNegative(record?.input),
		output: finiteNonNegative(record?.output),
		cacheRead: finiteNonNegative(record?.cacheRead),
		cacheWrite: finiteNonNegative(record?.cacheWrite),
		cost: finiteNonNegative(cost ? cost.total : record?.cost),
		turns: (options.turns ?? 0) + finiteNonNegative(record?.turns),
	};
	// Drop all-zero records (e.g. malformed usage): they carry no information.
	// Assistant turns are kept even when empty because the turn itself counts.
	if (!options.keepWhenMissing &&
		entry.input === 0 && entry.output === 0 && entry.cacheRead === 0 && entry.cacheWrite === 0 &&
		entry.cost === 0 && entry.turns === 0) {
		return undefined;
	}
	return entry;
}

/**
 * One classification pass over a session file's entries. Plan-mode turns are
 * split out of main; subagent, advisor, and guardian usage is bucketed by
 * tool/entry type; compaction and branch summaries follow the current mode.
 * Nested subagent results get deterministic synthetic ids (`<entryId>:<i>`)
 * so they dedup correctly across forked copies.
 */
export function classifySessionEntries(entries: readonly FileEntry[]): SessionUsageEntry[] {
	const result: SessionUsageEntry[] = [];
	const modeById = new Map<string, GlobalMode>();
	let currentModel: string | undefined;

	for (const entry of entries) {
		const inherited = entry.type !== "session" && entry.parentId ? modeById.get(entry.parentId) : undefined;
		let mode: GlobalMode = inherited ?? "main";
		if (entry.type === "custom" && entry.customType === PLAN_STATE_ENTRY_TYPE) {
			const fromState = planModeFromState(asRecord(entry.data));
			if (fromState) mode = fromState;
		}
		modeById.set(entry.id, mode);

		if (entry.type !== "message") {
			if ((entry.type === "custom" || entry.type === "custom_message") &&
				entry.customType === "auto-review-verdict") {
				const data = entry.type === "custom_message" ? asRecord(entry.details) : asRecord(entry.data);
				const verdict = usageEntry(entry.id, "guardian", modelName(data?.model) ?? currentModel, data?.usage);
				if (verdict) result.push(verdict);
			} else if (entry.type === "compaction" || entry.type === "branch_summary") {
				const summary = usageEntry(entry.id, mode === "plan" ? "plan" : "main", currentModel, entry.usage);
				if (summary) result.push(summary);
			}
			continue;
		}

		const message = entry.message;
		if (message.role === "assistant") {
			const assistantModel = modelKey(message.provider, message.model);
			if (assistantModel) currentModel = assistantModel;
			const assistant = usageEntry(
				entry.id,
				mode === "plan" ? "plan" : "main",
				assistantModel ?? currentModel,
				message.usage,
				{ turns: 1, keepWhenMissing: true },
			);
			if (assistant) result.push(assistant);
		} else if (message.role === "toolResult") {
			if (message.toolName === "subagent") {
				// Newer sessions persist aggregate tool usage at the message
				// level; older sessions only have per-result usage in details.
				// Never add both.
				if (message.usage !== undefined) {
					const aggregate = usageEntry(entry.id, "subagent", currentModel, message.usage);
					if (aggregate) result.push(aggregate);
				} else {
					nestedSubagentResults(message.details).forEach((nestedResult, index) => {
						const nested = usageEntry(
							`${entry.id}:${index}`,
							"subagent",
							modelName(nestedResult.model) ?? currentModel,
							nestedResult.usage,
						);
						if (nested) result.push(nested);
					});
				}
			} else if (message.toolName === "advisor") {
				const advisor = usageEntry(
					entry.id,
					"advisor",
					modelName(asRecord(message.details)?.model) ?? currentModel,
					message.usage,
				);
				if (advisor) result.push(advisor);
			} else {
				const tool = usageEntry(entry.id, "main", currentModel, message.usage);
				if (tool) result.push(tool);
			}
		}
	}

	return result;
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
