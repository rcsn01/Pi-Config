import type { ProbeResult } from "./probe.ts";

export interface QuotaWindow {
	usedPercent: number;
	windowMinutes?: number;
	resetsAt?: string;
}

export interface QuotaSnapshot {
	plan?: string;
	session?: QuotaWindow;
	weekly?: QuotaWindow;
	resetCredits?: { available: number; applicable?: number };
	fetchedAt: string;
}

export type QuotaProbeResult = ProbeResult<QuotaSnapshot>;
