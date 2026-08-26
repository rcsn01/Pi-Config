import { isStale } from "./probe.ts";
import { planHeader, usageRow } from "./card.ts";
import { resetsInText } from "./countdown.ts";
import type { QuotaSnapshot, QuotaWindow } from "./types.ts";

function resetPhrase(window: QuotaWindow, now: Date): string | undefined {
	return window.resetsAt ? resetsInText(new Date(window.resetsAt), now) : undefined;
}

export function formatQuotaText(
	snapshot: QuotaSnapshot,
	now = new Date(),
	provider = "ChatGPT Codex",
): string {
	const lines = [planHeader(provider, snapshot.plan, isStale(snapshot.fetchedAt, now))];
	if (snapshot.session) {
		lines.push(usageRow("5-hour session limit", snapshot.session.usedPercent, resetPhrase(snapshot.session, now)));
	} else {
		lines.push("5-hour session limit: unavailable");
	}
	if (snapshot.weekly) {
		lines.push(usageRow("Weekly limit", snapshot.weekly.usedPercent, resetPhrase(snapshot.weekly, now)));
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
