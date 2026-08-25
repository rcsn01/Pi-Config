import { isStale } from "./probe.ts";
import { planHeader, usageRow } from "./card.ts";
import { resetsInText } from "./countdown.ts";
import type { UsageSnapshot } from "./ollama-types.ts";

// The /api/usage contract exposes no reset timestamps, so the reset instants
// mirror the web UI's observed window alignment instead:
// - Session windows reset on the full hour (observed: the settings page
//   showed "resets in 2h 15m" mid-window).
// - Weekly windows reset at the API's own week boundary: the 4-week activity
//   period starts at `activity.period.starting_at` (Monday 00:00 UTC in
//   practice) and boundaries repeat every 7 days from that instant. When the
//   anchor is missing, the local Monday 00:00 rule is used as a fallback.
// Both are to be revisited if the API ever exposes real timestamps; an
// explicit `resets_in` (proposal shape) wins when present.
export function sessionResetAt(now = new Date()): Date {
	const nextHour = new Date(now);
	nextHour.setHours(nextHour.getHours() + 1, 0, 0, 0);
	return nextHour;
}

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

export function weeklyResetAt(now = new Date(), weekStartsAt?: string): Date {
	const anchor = weekStartsAt !== undefined ? Date.parse(weekStartsAt) : Number.NaN;
	if (Number.isFinite(anchor)) {
		const elapsed = now.getTime() - anchor;
		return new Date(anchor + (Math.floor(elapsed / WEEK_MS) + 1) * WEEK_MS);
	}
	// Fallback: local Monday 00:00 (observed web UI alignment).
	const nextMonday = new Date(now);
	// getDay(): Monday is 1, Sunday is 0.
	nextMonday.setDate(nextMonday.getDate() + ((8 - nextMonday.getDay()) % 7 || 7));
	nextMonday.setHours(0, 0, 0, 0);
	return nextMonday;
}

export function sessionResetsIn(now = new Date()): string {
	return resetsInText(sessionResetAt(now), now);
}

export function weeklyResetsIn(now = new Date(), weekStartsAt?: string): string {
	return resetsInText(weeklyResetAt(now, weekStartsAt), now);
}

export function formatUsageText(snapshot: UsageSnapshot, now = new Date()): string {
	const lines = [planHeader("Ollama Cloud", snapshot.plan, isStale(snapshot.fetchedAt, now))];
	if (snapshot.session) {
		lines.push(usageRow("Session usage", snapshot.session.usedPercent, snapshot.session.resetsIn
			? `resets in ${snapshot.session.resetsIn}`
			: sessionResetsIn(now)));
	}
	if (snapshot.weekly) {
		lines.push(usageRow("Weekly usage", snapshot.weekly.usedPercent, snapshot.weekly.resetsIn
			? `resets in ${snapshot.weekly.resetsIn}`
			: weeklyResetsIn(now, snapshot.weekStartsAt)));
	}
	return lines.join("\n");
}
