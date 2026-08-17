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

export const ANALYTICS_ENDPOINT_IDS = ["quota", "tokens", "workspace", "skills", "plugins", "credits"] as const;
export type AnalyticsEndpointId = (typeof ANALYTICS_ENDPOINT_IDS)[number];

export type AnalyticsPayloads = Record<AnalyticsEndpointId, unknown>;

export interface EndpointProbe {
	id: AnalyticsEndpointId;
	path: string;
	status: number;
	state: "ok" | "auth-required" | "unavailable" | "contract-unknown";
	rowCount?: number;
}

export type AnalyticsProbeResult =
	| {
		state: "ok";
		fetchedAt: string;
		startDate: string;
		endDate: string;
		endpoints: EndpointProbe[];
		payloads: AnalyticsPayloads;
	}
	| {
		state: "auth-required" | "unavailable" | "contract-unknown";
		message: string;
		endpoints: EndpointProbe[];
	};

export type CodexAuthStatus =
	| {
		state: "accepted";
		path: string;
		fileFound: true;
		accessTokenPresent: true;
		accountIdPresent: true;
		credentialAccepted: true;
	}
	| {
		state: "missing" | "invalid" | "unreadable" | "expired" | "rejected" | "unavailable";
		path: string;
		fileFound: boolean;
		accessTokenPresent: boolean;
		accountIdPresent: boolean;
		credentialAccepted: false;
		message: string;
		statusCode?: number;
	};
