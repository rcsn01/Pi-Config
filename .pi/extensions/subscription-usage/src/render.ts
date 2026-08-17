import { isSnapshotStale } from "./quota.ts";
import { usageBar } from "./bar.ts";
import { resetsInText } from "./countdown.ts";
import type { QuotaSnapshot } from "./types.ts";

export function formatQuotaText(snapshot: QuotaSnapshot, now = new Date()): string {
	const header = snapshot.plan ? `ChatGPT Codex · Plan: ${snapshot.plan}` : "ChatGPT Codex";
	const lines = [isSnapshotStale(snapshot.fetchedAt, now) ? `${header} (stale)` : header];
	if (snapshot.weekly) {
		const used = `${Math.round(snapshot.weekly.usedPercent)}% used`;
		const resets = snapshot.weekly.resetsAt
			? ` · ${resetsInText(new Date(snapshot.weekly.resetsAt), now)}`
			: "";
		lines.push(`Weekly limit: ${usageBar(snapshot.weekly.usedPercent)} ${used}${resets}`);
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