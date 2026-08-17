import { isUsageStale } from "./ollama-usage.ts";
import type { UsageSnapshot } from "./ollama-types.ts";

// The /api/usage contract exposes no reset timestamps, so the countdowns
// mirror the web UI's observed window alignment instead:
// - Session windows reset on the full hour (observed: the settings page
//   showed "resets in 40 minutes" at twenty minutes past the hour).
// - Weekly windows reset at the start of the local week (Monday 00:00;
//   observed: "resets in 6 days" on a Monday evening, and the API's 4-week
//   activity period is Monday-aligned).
// Both are assumptions to be revisited if the API ever exposes real
// timestamps; an explicit `resets_in` (proposal shape) wins when present.
export function sessionResetsIn(now = new Date()): string {
	const nextHour = new Date(now);
	nextHour.setHours(nextHour.getHours() + 1, 0, 0, 0);
	const minutes = Math.max(1, Math.ceil((nextHour.getTime() - now.getTime()) / 60_000));
	return minutes >= 60 ? "1 hour" : `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

export function weeklyResetsIn(now = new Date()): string {
	const nextMonday = new Date(now);
	// getUTCDay()-free local week: Monday is 1, Sunday is 0.
	nextMonday.setDate(nextMonday.getDate() + ((8 - nextMonday.getDay()) % 7 || 7));
	nextMonday.setHours(0, 0, 0, 0);
	const days = Math.max(1, Math.floor((nextMonday.getTime() - now.getTime()) / 86_400_000));
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
		lines.push(windowLine("Weekly usage", snapshot.weekly.usedPercent, snapshot.weekly.resetsIn ?? weeklyResetsIn(now)));
	}
	return lines.join("\n");
}
