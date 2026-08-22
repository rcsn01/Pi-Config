import { finite, record } from "./probe.ts";
import type { UsageSnapshot, UsageWindow } from "./ollama-types.ts";

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

// The live contract exposes no reset timestamps (verified against the real
// endpoint; see also ollama/ollama#16448 and fgrehm/pi-ollama-cloud#42). The
// reset countdowns are instead derived from the web UI's observed alignment
// in ollama-render.ts: session windows reset on the full hour, weekly windows
// at the start of the local week.
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
	// The activity period start is the API's own week boundary (Monday 00:00
	// UTC in practice) and serves as the weekly reset anchor.
	const activity = record(root.activity);
	const period = record(activity?.period);
	const startingAt = typeof period?.starting_at === "string" ? Date.parse(period.starting_at) : Number.NaN;
	const weekStartsAt = Number.isFinite(startingAt) ? new Date(startingAt).toISOString() : undefined;
	return {
		...(plan !== undefined ? { plan } : {}),
		...(session !== undefined ? { session } : {}),
		...(weekly !== undefined ? { weekly } : {}),
		...(weekStartsAt !== undefined ? { weekStartsAt } : {}),
		fetchedAt,
	};
}
