import type { ProbeResult } from "./probe.ts";

export interface OllamaCredential {
	pem: string;
	path: string;
}

export type OllamaAuthInspection =
	| {
		state: "ready";
		path: string;
		fileFound: true;
		credential: OllamaCredential;
	}
	| {
		state: "missing" | "invalid" | "unreadable";
		path: string;
		fileFound: boolean;
		message: string;
	};

export interface UsageWindow {
	usedPercent: number;
	resetsIn?: string;
}

export interface UsageSnapshot {
	plan?: string;
	session?: UsageWindow;
	weekly?: UsageWindow;
	// ISO timestamp of the API's 4-week activity period start — the weekly
	// reset anchor: boundaries repeat every 7 days from this instant.
	weekStartsAt?: string;
	fetchedAt: string;
}

export type UsageProbeResult = ProbeResult<UsageSnapshot>;
