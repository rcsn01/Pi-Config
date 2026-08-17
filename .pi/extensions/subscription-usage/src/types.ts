export interface CodexCredential {
	accessToken: string;
	accountId: string;
	expiresAt?: string;
}

export type CodexAuthInspection =
	| {
		state: "ready";
		path: string;
		fileFound: true;
		accessTokenPresent: true;
		accountIdPresent: true;
		credential: CodexCredential;
	}
	| {
		state: "missing" | "invalid" | "unreadable" | "expired";
		path: string;
		fileFound: boolean;
		accessTokenPresent: boolean;
		accountIdPresent: boolean;
		message: string;
	};

export interface QuotaWindow {
	usedPercent: number;
	windowMinutes?: number;
	resetsAt?: string;
}

export interface QuotaSnapshot {
	plan?: string;
	weekly?: QuotaWindow;
	resetCredits?: { available: number; applicable?: number };
	fetchedAt: string;
}

export type QuotaProbeResult =
	| { state: "ok"; fetchedAt: string; snapshot: QuotaSnapshot }
	| { state: "auth-required"; message: string }
	| { state: "unavailable"; message: string }
	| { state: "contract-unknown"; message: string };
