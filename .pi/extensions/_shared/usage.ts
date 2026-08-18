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

function nestedSubagentResults(details: unknown): Record<string, unknown>[] {
	const results = asRecord(details)?.results;
	if (!Array.isArray(results)) return [];
	return results.map(asRecord).filter((result): result is Record<string, unknown> => result !== undefined);
}

function nestedSubagentUsages(details: unknown): unknown[] {
	return nestedSubagentResults(details)
		.map((result) => result.usage)
		.filter((usage) => usage !== undefined);
}

function modelKey(provider: unknown, model: unknown): string | undefined {
	if (typeof provider !== "string" || typeof model !== "string") return undefined;
	const normalizedProvider = provider.trim();
	const normalizedModel = model.trim();
	return normalizedProvider && normalizedModel ? `${normalizedProvider}/${normalizedModel}` : undefined;
}

function modelName(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim();
	return normalized || undefined;
}

function finalizeUsage(totals: SessionUsageTotals): SessionUsageTotals {
	totals.tokens = totals.input + totals.output + totals.cacheRead + totals.cacheWrite;
	return totals;
}

/** Collect usage persisted directly on tool-result messages with the requested tool name. */
export function collectToolUsage(entries: readonly SessionEntry[], toolName: string): SessionUsageTotals {
	const totals = emptyUsageTotals();
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.toolName !== toolName) continue;
		addUsage(totals, entry.message.usage);
	}
	return finalizeUsage(totals);
}

/** Collect usage nested in custom entries (messages or persisted entries) with the requested custom type. */
export function collectCustomUsage(entries: readonly SessionEntry[], customType: string): SessionUsageTotals {
	const totals = emptyUsageTotals();
	for (const entry of entries) {
		if (entry.type !== "custom_message" && entry.type !== "custom") continue;
		if (entry.customType !== customType) continue;
		if (entry.type === "custom_message") {
			addUsage(totals, asRecord(entry.details)?.usage);
		} else {
			addUsage(totals, asRecord(entry.data)?.usage);
		}
	}
	return finalizeUsage(totals);
}

/**
 * Attribute active-branch usage to the model that produced or initiated it,
 * split by usage category (session, subagent, advisor, guardian).
 * Model-specific metadata wins for delegated work; the current session model
 * is used as a fallback for older entries without that metadata.
 */
export function collectModelUsage(entries: readonly SessionEntry[]): ModelUsageRow[] {
	const byModel = new Map<string, ModelUsageRow>();
	let currentModel: string | undefined;

	const add = (model: string | undefined, category: ModelUsageCategory, value: unknown, includeTurns = false): void => {
		const key = model ?? "unknown";
		let row = byModel.get(key);
		if (!row) {
			row = {
				model: key,
				session: emptyUsageTotals(),
				subagent: emptyUsageTotals(),
				advisor: emptyUsageTotals(),
				guardian: emptyUsageTotals(),
			};
			byModel.set(key, row);
		}
		addUsage(row[category], value, includeTurns);
	};

	for (const entry of entries) {
		if (entry.type === "model_change") {
			currentModel = modelKey(entry.provider, entry.modelId) ?? currentModel;
			continue;
		}

		if (entry.type === "message") {
			if (entry.message.role === "assistant") {
				const assistantModel = modelKey(entry.message.provider, entry.message.model);
				if (assistantModel) currentModel = assistantModel;
				add(currentModel, "session", entry.message.usage);
				byModel.get(currentModel ?? "unknown")!.session.turns++;
			} else if (entry.message.role === "toolResult") {
				if (entry.message.toolName === "subagent") {
					if (entry.message.usage !== undefined) {
						add(currentModel, "subagent", entry.message.usage, true);
					} else {
						for (const result of nestedSubagentResults(entry.message.details)) {
							add(modelName(result.model) ?? currentModel, "subagent", result.usage, true);
						}
					}
				} else {
					const delegatedModel = entry.message.toolName === "advisor"
						? modelName(asRecord(entry.message.details)?.model)
						: undefined;
					add(
						delegatedModel ?? currentModel,
						entry.message.toolName === "advisor" ? "advisor" : "session",
						entry.message.usage,
					);
				}
			}
			continue;
		}

		if ((entry.type === "custom_message" || entry.type === "custom") && entry.customType === "auto-review-verdict") {
			const data = entry.type === "custom_message" ? asRecord(entry.details) : asRecord(entry.data);
			if (data) add(modelName(data.model) ?? currentModel, "guardian", data.usage);
		} else if (entry.type === "compaction" || entry.type === "branch_summary") {
			add(currentModel, "session", entry.usage);
		}
	}

	return [...byModel.values()]
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
		});
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
		} else if ((entry.type === "custom_message" || entry.type === "custom") && entry.customType === "auto-review-verdict") {
			const data = entry.type === "custom_message" ? asRecord(entry.details) : asRecord(entry.data);
			addUsage(totals, data?.usage);
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