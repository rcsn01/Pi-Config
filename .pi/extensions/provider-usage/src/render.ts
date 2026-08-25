import { isStale } from "./probe.ts";
import { planHeader, usageRow } from "./card.ts";
import { resetsInText } from "./countdown.ts";
import type { QuotaSnapshot } from "./types.ts";

export function formatQuotaText(snapshot: QuotaSnapshot, now = new Date()): string {
	const lines = [planHeader("ChatGPT Codex", snapshot.plan, isStale(snapshot.fetchedAt, now))];
	if (snapshot.weekly) {
		const resetPhrase = snapshot.weekly.resetsAt
			? resetsInText(new Date(snapshot.weekly.resetsAt), now)
			: undefined;
		lines.push(usageRow("Weekly limit", snapshot.weekly.usedPercent, resetPhrase));
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
