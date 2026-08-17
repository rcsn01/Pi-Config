import { isUsageStale } from "./ollama-usage.ts";
import type { UsageSnapshot } from "./ollama-types.ts";

function windowLine(label: string, window: { usedPercent: number; resetsIn?: string }): string {
	const used = `${Math.round(window.usedPercent)}% used`;
	const resets = window.resetsIn ? ` · resets in ${window.resetsIn}` : "";
	return `${label}: ${used}${resets}`;
}

export function formatUsageText(snapshot: UsageSnapshot, now = new Date()): string {
	const header = snapshot.plan ? `Ollama Cloud · Plan: ${snapshot.plan}` : "Ollama Cloud";
	const lines = [isUsageStale(snapshot.fetchedAt, now) ? `${header} (stale)` : header];
	if (snapshot.session) lines.push(windowLine("Session usage", snapshot.session));
	if (snapshot.weekly) lines.push(windowLine("Weekly usage", snapshot.weekly));
	return lines.join("\n");
}
