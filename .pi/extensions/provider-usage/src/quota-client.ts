import { normalizeQuota } from "./quota.ts";
import { runProbe, type ProbeOptions, type ProbeResult, type ProviderProbeAdapter } from "./probe.ts";
import type { QuotaSnapshot } from "./types.ts";

// The same endpoint Codex's own BackendClient uses for `/status` rate limits
// (codex-rs/backend-client/src/client/rate_limit_resets.rs, PathStyle::ChatGptApi).
export const QUOTA_ENDPOINT_URL = "https://chatgpt.com/backend-api/wham/usage";

/**
 * The Codex provider probe adapter: the ChatGPT credential headers and the
 * /backend-api/wham/usage wire contract, behind the shared probe seam.
 */
export interface CodexQuotaRequestHeaders {
	readonly Authorization: string;
	readonly "chatgpt-account-id": string;
}

function createCodexAdapter(headers: CodexQuotaRequestHeaders): ProviderProbeAdapter<QuotaSnapshot> {
	return {
		async authenticate() {
			return {
				request: {
					url: QUOTA_ENDPOINT_URL,
					headerCandidates: [{ ...headers }],
				},
			};
		},
		contractMatches(payload) {
			if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return false;
			const root = payload as Record<string, unknown>;
			return typeof root.plan_type === "string"
				&& typeof root.rate_limit === "object"
				&& root.rate_limit !== null
				&& !Array.isArray(root.rate_limit);
		},
		normalize: normalizeQuota,
		messages: {
			endpointLabel: "ChatGPT",
			unreachable: "Could not reach the ChatGPT usage endpoint.",
			authRejected: (status) =>
				`ChatGPT rejected the Codex credential (HTTP ${status}). Select the slot with \`/codex use <name>\` and run \`/login openai-codex\`.`,
		},
	};
}

export async function probeQuota(
	options: ProbeOptions & { headers: CodexQuotaRequestHeaders },
): Promise<ProbeResult<QuotaSnapshot>> {
	return runProbe(createCodexAdapter(options.headers), options);
}
