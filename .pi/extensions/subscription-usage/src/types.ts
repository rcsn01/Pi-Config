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
