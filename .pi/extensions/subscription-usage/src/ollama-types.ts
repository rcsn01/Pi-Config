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
	fetchedAt: string;
}

export type UsageProbeResult =
	| { state: "ok"; fetchedAt: string; snapshot: UsageSnapshot }
	| { state: "auth-required"; message: string }
	| { state: "unavailable"; message: string }
	| { state: "contract-unknown"; message: string };
