import type { ContextUsage, FileEntry, SessionEntry } from "@earendil-works/pi-coding-agent";
import { PLAN_STATE_ENTRY_TYPE } from "./session-entries.ts";

export interface SessionUsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	tokens: number;
	cost: number;
	turns: number;
}

export interface ModelUsageRow {
	model: string;
	session: SessionUsageTotals;
	subagent: SessionUsageTotals;
	advisor: SessionUsageTotals;
	guardian: SessionUsageTotals;
}

type ModelUsageCategory = keyof Omit<ModelUsageRow, "model">;

export interface ContextUsageTotals {
	tokens: number | null;
	contextWindow: number;
	percent: number | null;
}

/**
 * One classification pass over session entries. `session` is the cumulative
 * union of all usage — subagent, advisor, and guardian contributions are also
 * counted in `session` — so the four totals must never be summed together.
 * `models` attributes the same usage to the model that produced it.
 */
export interface UsageSnapshot {
	session: SessionUsageTotals;
	subagent: SessionUsageTotals;
	advisor: SessionUsageTotals;
	guardian: SessionUsageTotals;
	models: ModelUsageRow[];
}

type ReportedUsage = {
	input?: unknown;
	output?: unknown;
	cacheRead?: unknown;
	cacheWrite?: unknown;
	cost?: unknown;
	turns?: unknown;
};

export function emptyUsageTotals(): SessionUsageTotals {
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

export function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null
		? value as Record<string, unknown>
		: undefined;
}

export function addUsage(totals: SessionUsageTotals, value: unknown, includeTurns = false): void {
	const usage = asRecord(value) as ReportedUsage | undefined;
	totals.input += finiteNonNegative(usage?.input);
	totals.output += finiteNonNegative(usage?.output);
	totals.cacheRead += finiteNonNegative(usage?.cacheRead);
	totals.cacheWrite += finiteNonNegative(usage?.cacheWrite);
	const cost = asRecord(usage?.cost);
	totals.cost += finiteNonNegative(cost ? cost.total : usage?.cost);
	if (includeTurns) totals.turns += finiteNonNegative(usage?.turns);
}

export function nestedSubagentResults(details: unknown): Record<string, unknown>[] {
	const results = asRecord(details)?.results;
	if (!Array.isArray(results)) return [];
	return results.map(asRecord).filter((result): result is Record<string, unknown> => result !== undefined);
}

export function modelKey(provider: unknown, model: unknown): string | undefined {
	if (typeof provider !== "string" || typeof model !== "string") return undefined;
	const normalizedProvider = provider.trim();
	const normalizedModel = model.trim();
	return normalizedProvider && normalizedModel ? `${normalizedProvider}/${normalizedModel}` : undefined;
}

export function modelName(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim();
	return normalized || undefined;
}

function finalizeUsage(totals: SessionUsageTotals): SessionUsageTotals {
	totals.tokens = totals.input + totals.output + totals.cacheRead + totals.cacheWrite;
	return totals;
}

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
	/** Milliseconds since Unix epoch for time-series attribution. */
	timestamp?: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
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
	/** Milliseconds since Unix epoch from the containing session entry. */
	timestamp?: number;
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
		...(options.timestamp === undefined ? {} : { timestamp: options.timestamp }),
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
 * One classification pass over a session's entries — the single rule behind
 * both the per-session snapshot (`collectUsageSnapshot`) and the global view
 * (`buildGlobalUsageSnapshot`). Plan-mode turns are split out of main;
 * subagent, advisor, and guardian usage is bucketed by tool/entry type;
 * compaction and branch summaries follow the current mode. `model_change`
 * entries repoint the current session model; assistant messages also track
 * it. Nested subagent results get deterministic synthetic ids (`<entryId>:<i>`)
 * so they dedup correctly across forked copies.
 */
function entryTimestamp(entry: FileEntry): number | undefined {
	if (entry.type === "session") return undefined;
	const parsed = Date.parse(entry.timestamp);
	return Number.isFinite(parsed) ? parsed : undefined;
}

export function classifySessionEntries(entries: readonly FileEntry[]): SessionUsageEntry[] {
	const result: SessionUsageEntry[] = [];
	const modeById = new Map<string, GlobalMode>();
	let currentModel: string | undefined;

	for (const entry of entries) {
		const timestamp = entryTimestamp(entry);
		const inherited = entry.type !== "session" && entry.parentId ? modeById.get(entry.parentId) : undefined;
		let mode: GlobalMode = inherited ?? "main";
		if (entry.type === "custom" && entry.customType === PLAN_STATE_ENTRY_TYPE) {
			const fromState = planModeFromState(asRecord(entry.data));
			if (fromState) mode = fromState;
		}
		modeById.set(entry.id, mode);

		if (entry.type === "model_change") {
			currentModel = modelKey(entry.provider, entry.modelId) ?? currentModel;
			continue;
		}

		if (entry.type !== "message") {
			if ((entry.type === "custom" || entry.type === "custom_message") &&
				entry.customType === "auto-review-verdict") {
				const data = entry.type === "custom_message" ? asRecord(entry.details) : asRecord(entry.data);
				const verdict = usageEntry(entry.id, "guardian", modelName(data?.model) ?? currentModel, data?.usage, { timestamp });
				if (verdict) result.push(verdict);
			} else if (entry.type === "compaction" || entry.type === "branch_summary") {
				const summary = usageEntry(entry.id, mode === "plan" ? "plan" : "main", currentModel, entry.usage, { timestamp });
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
				{ turns: 1, keepWhenMissing: true, timestamp },
			);
			if (assistant) result.push(assistant);
		} else if (message.role === "toolResult") {
			if (message.toolName === "subagent") {
				// Newer sessions persist aggregate tool usage at the message
				// level; older sessions only have per-result usage in details.
				// Never add both.
				if (message.usage !== undefined) {
					const aggregate = usageEntry(entry.id, "subagent", currentModel, message.usage, { timestamp });
					if (aggregate) result.push(aggregate);
				} else {
					nestedSubagentResults(message.details).forEach((nestedResult, index) => {
						const nested = usageEntry(
							`${entry.id}:${index}`,
							"subagent",
							modelName(nestedResult.model) ?? currentModel,
							nestedResult.usage,
							{ timestamp },
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
					{ timestamp },
				);
				if (advisor) result.push(advisor);
			} else {
				const tool = usageEntry(entry.id, "main", currentModel, message.usage, { timestamp });
				if (tool) result.push(tool);
			}
		}
	}

	return result;
}

/**
 * Classify every entry once and accumulate session totals, per-category totals
 * (subagent, advisor, guardian), and per-model attribution into one snapshot.
 * `session` is the cumulative union of all usage — subagent, advisor, and
 * guardian contributions are also counted in `session` — so the four totals
 * must never be summed together. `models` attributes the same usage to the
 * model that produced it; main/plan records collapse into the session
 * category. The classification rule itself lives in `classifySessionEntries`.
 */
export function collectUsageSnapshot(entries: readonly SessionEntry[]): UsageSnapshot {
	const session = emptyUsageTotals();
	const subagent = emptyUsageTotals();
	const advisor = emptyUsageTotals();
	const guardian = emptyUsageTotals();
	const byModel = new Map<string, ModelUsageRow>();

	const addToModel = (record: SessionUsageEntry, includeTurns: boolean): void => {
		const category: ModelUsageCategory = record.mode === "main" || record.mode === "plan"
			? "session"
			: record.mode;
		let row = byModel.get(record.model);
		if (!row) {
			row = {
				model: record.model,
				session: emptyUsageTotals(),
				subagent: emptyUsageTotals(),
				advisor: emptyUsageTotals(),
				guardian: emptyUsageTotals(),
			};
			byModel.set(record.model, row);
		}
		addUsage(row[category], record, includeTurns);
	};

	for (const record of classifySessionEntries(entries)) {
		// The union counts assistant turns only; subagent turns are the
		// reported ones, attributed to the subagent category, never the union.
		if (record.mode === "main" || record.mode === "plan") {
			addUsage(session, record, true);
			addToModel(record, true);
		} else if (record.mode === "subagent") {
			addUsage(session, record);
			addUsage(subagent, record, true);
			addToModel(record, true);
		} else if (record.mode === "advisor") {
			addUsage(session, record);
			addUsage(advisor, record);
			addToModel(record, false);
		} else {
			addUsage(session, record);
			addUsage(guardian, record);
			addToModel(record, false);
		}
	}

	return {
		session: finalizeUsage(session),
		subagent: finalizeUsage(subagent),
		advisor: finalizeUsage(advisor),
		guardian: finalizeUsage(guardian),
		models: [...byModel.values()]
			.map((row) => ({
				...row,
				session: finalizeUsage(row.session),
				subagent: finalizeUsage(row.subagent),
				advisor: finalizeUsage(row.advisor),
				guardian: finalizeUsage(row.guardian),
			}))
			.filter((row) =>
				row.session.tokens + row.subagent.tokens + row.advisor.tokens + row.guardian.tokens > 0 ||
				row.session.cost + row.subagent.cost + row.advisor.cost + row.guardian.cost > 0 ||
				row.session.turns + row.subagent.turns + row.advisor.turns + row.guardian.turns > 0,
			)
			.sort((left, right) => {
				if (left.model === "unknown") return 1;
				if (right.model === "unknown") return -1;
				const leftTokens = left.session.tokens + left.subagent.tokens + left.advisor.tokens + left.guardian.tokens;
				const rightTokens = right.session.tokens + right.subagent.tokens + right.advisor.tokens + right.guardian.tokens;
				return rightTokens - leftTokens || left.model.localeCompare(right.model);
			}),
	};
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

export function finiteNonNegative(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function clampPercent(value: number): number {
	return Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 0;
}
