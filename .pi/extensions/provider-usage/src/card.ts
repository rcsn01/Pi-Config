/**
 * Usage card row builders — the shared text shapes of a provider's usage
 * card: one line per window (`Label: [████████████░░░░░░░░] 58% used · resets
 * in 2h 45m`), and a provider header with plan and staleness marker. Both
 * render at the plain-text boundary (no theme styling here; the interactive
 * tool renderers theme the same strings).
 */
import { usageBar } from "./bar.ts";

/** One usage row: `Label: [████████████░░░░░░░░] 58% used · resets in 2h 45m`. */
export function usageRow(label: string, usedPercent: number, resetPhrase?: string): string {
	return `${label}: ${usageBar(usedPercent)} ${Math.round(usedPercent)}% used${resetPhrase ? ` · ${resetPhrase}` : ""}`;
}

/** Card header: `ChatGPT Codex · Plan: Pro`, suffixed `(stale)` when old. */
export function planHeader(provider: string, plan: string | undefined, stale: boolean): string {
	const base = plan ? `${provider} · Plan: ${plan}` : provider;
	return stale ? `${base} (stale)` : base;
}
