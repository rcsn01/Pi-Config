import type { UsageSnapshot, UsageWindow } from "./ollama-types.ts";

// Same staleness threshold pattern as the Codex quota card: a snapshot older
// than 15 minutes is marked stale.
export const USAGE_STALE_THRESHOLD_MINUTES = 15;

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}

function finite(value: unknown): number | undefined {
	const parsed = typeof value === "number"
		? value
		: typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

export function isUsageStale(fetchedAt: string, now = new Date()): boolean {
	const ageMs = Date.parse(fetchedAt);
	if (!Number.isFinite(ageMs)) return true;
	return now.getTime() - ageMs > USAGE_STALE_THRESHOLD_MINUTES * 60_000;
}

// Two accepted window shapes:
// 1. The web UI contract proposed in ollama/ollama#16448: `{ percentage,
//    resets_in }` (percentage numeric or numeric-string; resets_in a
//    human-readable duration string like "5 hours").
// 2. The live /api/usage contract observed on 2026-08-17: `limits.session` /
//    `limits.weekly` as `{ usage: <fraction 0-1>, models: [...] }` — usage is
//    a ratio of the window limit; the models list is ignored.
function windowOf(value: unknown): UsageWindow | undefined {
	const source = record(value);
	if (!source) return undefined;
	const usedPercent = finite(source.percentage);
	if (usedPercent === undefined) return undefined;
	const resetsIn = typeof source.resets_in === "string" && source.resets_in.trim()
		? source.resets_in.trim()
		: undefined;
	return {
		usedPercent,
		...(resetsIn !== undefined ? { resetsIn } : {}),
	};
}

function limitsWindowOf(value: unknown): UsageWindow | undefined {
	const source = record(value);
	if (!source) return undefined;
	const usage = finite(source.usage);
	if (usage === undefined) return undefined;
	// Live contract: usage is a fraction of the limit (0.161 → 16.1%).
	// Values above 1 are treated as already-percentage defensively.
	const usedPercent = usage <= 1 ? Math.round(usage * 100 * 10) / 10 : Math.round(usage * 10) / 10;
	return { usedPercent };
}

export function normalizeUsage(payload: unknown, fetchedAt: string): UsageSnapshot | undefined {
	const root = record(payload);
	if (!root) return undefined;
	const limits = record(root.limits);
	const session = windowOf(root.session_usage) ?? limitsWindowOf(limits?.session);
	const weekly = windowOf(root.weekly_usage) ?? limitsWindowOf(limits?.weekly);
	if (!session && !weekly) return undefined;
	const plan = typeof root.plan === "string" && root.plan.trim() ? root.plan.trim() : undefined;
	return {
		...(plan !== undefined ? { plan } : {}),
		...(session !== undefined ? { session } : {}),
		...(weekly !== undefined ? { weekly } : {}),
		fetchedAt,
	};
}
