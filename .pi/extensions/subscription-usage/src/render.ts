import { isSnapshotStale } from "./quota.ts";
import type { QuotaSnapshot } from "./types.ts";

const MONTH_ABBREVIATIONS = [
	"Jan", "Feb", "Mar", "Apr", "May", "Jun",
	"Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

function sameLocalDate(a: Date, b: Date): boolean {
	return a.getFullYear() === b.getFullYear()
		&& a.getMonth() === b.getMonth()
		&& a.getDate() === b.getDate();
}

// Port of codex `format_reset_timestamp` (codex-rs/tui/src/status/helpers.rs):
// `HH:MM` when the reset falls on the same local day as the capture time,
// otherwise `HH:MM on %-d %b` (e.g. "14:30 on 24 Aug").
export function formatResetTimestamp(resetsAt: string, now: Date): string {
	const reset = new Date(resetsAt);
	if (!Number.isFinite(reset.getTime())) return "";
	const time = `${String(reset.getHours()).padStart(2, "0")}:${String(reset.getMinutes()).padStart(2, "0")}`;
	if (sameLocalDate(reset, now)) return time;
	return `${time} on ${reset.getDate()} ${MONTH_ABBREVIATIONS[reset.getMonth()]}`;
}

export function formatQuotaText(snapshot: QuotaSnapshot, now = new Date()): string {
	const header = snapshot.plan ? `ChatGPT Codex · Plan: ${snapshot.plan}` : "ChatGPT Codex";
	const lines = [isSnapshotStale(snapshot.fetchedAt, now) ? `${header} (stale)` : header];
	if (snapshot.weekly) {
		const used = `${Math.round(snapshot.weekly.usedPercent)}% used`;
		const resets = snapshot.weekly.resetsAt
			? ` · resets ${formatResetTimestamp(snapshot.weekly.resetsAt, now)}`
			: "";
		lines.push(`Weekly limit: ${used}${resets}`);
	} else {
		lines.push("Weekly limit: unavailable");
	}
	if (snapshot.resetCredits) {
		const parts = [`${snapshot.resetCredits.available} available`];
		if (snapshot.resetCredits.applicable !== undefined) {
			parts.push(`${snapshot.resetCredits.applicable} applicable`);
		}
		lines.push(`Rate-limit reset credits: ${parts.join(" · ")}`);
	}
	return lines.join("\n");
}
