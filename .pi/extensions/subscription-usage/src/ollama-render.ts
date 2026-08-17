import { isUsageStale } from "./ollama-usage.ts";
import type { UsageSnapshot } from "./ollama-types.ts";

// The /api/usage contract exposes no reset timestamps, so the countdowns
// mirror the web UI's observed window alignment instead:
// - Session windows reset on the full hour (observed: the settings page
//   showed "resets in 40 minutes" at twenty minutes past the hour).
// - Weekly windows reset at the API's own week boundary: the 4-week activity
//   period starts at `activity.period.starting_at` (Monday 00:00 UTC in
//   practice) and boundaries repeat every 7 days from that instant — the
//   countdown is computed relative to that real anchor. When the anchor is
//   missing, the local Monday 00:00 rule is used as a fallback.
// Both are to be revisited if the API ever exposes real timestamps; an
// explicit `resets_in` (proposal shape) wins when present.
export function sessionResetsIn(now = new Date()): string {
	const nextHour = new Date(now);
	nextHour.setHours(nextHour.getHours() + 1, 0, 0, 0);
	const minutes = Math.max(1, Math.ceil((nextHour.getTime() - now.getTime()) / 60_000));
	return minutes >= 60 ? "1 hour" : `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

export function weeklyResetsIn(now = new Date(), weekStartsAt?: string): string {
	const anchor = weekStartsAt !== undefined ? Date.parse(weekStartsAt) : Number.NaN;
	if (Number.isFinite(anchor)) {
		const elapsed = now.getTime() - anchor;
		const nextBoundary = anchor + (Math.floor(elapsed / WEEK_MS) + 1) * WEEK_MS;
		const days = Math.max(1, Math.floor((nextBoundary - now.getTime()) / DAY_MS));
		return `${days} day${days === 1 ? "" : "s"}`;
	}
	// Fallback: local Monday 00:00 (observed web UI alignment).
	const nextMonday = new Date(now);
	// getDay(): Monday is 1, Sunday is 0.
	nextMonday.setDate(nextMonday.getDate() + ((8 - nextMonday.getDay()) % 7 || 7));
	nextMonday.setHours(0, 0, 0, 0);
	const days = Math.max(1, Math.floor((nextMonday.getTime() - now.getTime()) / DAY_MS));
	return `${days} day${days === 1 ? "" : "s"}`;
}

function windowLine(label: string, usedPercent: number, resetsIn: string): string {
	return `${label}: ${Math.round(usedPercent)}% used · resets in ${resetsIn}`;
}

export function formatUsageText(snapshot: UsageSnapshot, now = new Date()): string {
	const header = snapshot.plan ? `Ollama Cloud · Plan: ${snapshot.plan}` : "Ollama Cloud";
	const lines = [isUsageStale(snapshot.fetchedAt, now) ? `${header} (stale)` : header];
	if (snapshot.session) {
		lines.push(windowLine("Session usage", snapshot.session.usedPercent, snapshot.session.resetsIn ?? sessionResetsIn(now)));
	}
	if (snapshot.weekly) {
		lines.push(windowLine("Weekly usage", snapshot.weekly.usedPercent, snapshot.weekly.resetsIn ?? weeklyResetsIn(now, snapshot.weekStartsAt)));
	}
	return lines.join("\n");
}
