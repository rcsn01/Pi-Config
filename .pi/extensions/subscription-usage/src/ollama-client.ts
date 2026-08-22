import { buildAuthorization, inspectOllamaAuth } from "./ollama-auth.ts";
import { normalizeUsage } from "./ollama-usage.ts";
import { runProbe, type ProbeOptions, type ProbeResult, type ProviderProbeAdapter } from "./probe.ts";
import type { OllamaAuthInspection, UsageSnapshot } from "./ollama-types.ts";

// The single usage endpoint behind the Ollama web UI's usage card.
export const USAGE_ENDPOINT_URL = "https://ollama.com/api/usage";

// A real-client User-Agent, mirroring the shape of the Ollama app's
// userAgent() (app/ui/ui.go): `ollama/<v> (<arch> <os>) app/<v> Go/<go>`.
const USER_AGENT = "ollama/v0.32.14 (arm64 darwin) app/v0.32.14 Go/1.24";

/**
 * The Ollama provider probe adapter: the Ed25519-signed challenge request and
 * the /api/usage wire contract, behind the shared probe seam.
 */
function createOllamaAdapter(
	inspect: () => Promise<OllamaAuthInspection> = inspectOllamaAuth,
	now: () => Date = () => new Date(),
): ProviderProbeAdapter<UsageSnapshot> {
	return {
		async authenticate() {
			const inspection = await inspect();
			if (inspection.state !== "ready") return { message: inspection.message };

			// ts is unix seconds; the challenge `GET,/api/usage?ts=<ts>` is signed the
			// way the Ollama app signs its own requests (app/ui/ui.go doSelfSigned and
			// server/cloud_proxy.go buildCloudSignatureChallenge agree on this form).
			const ts = String(Math.floor(now().getTime() / 1000));
			const signed = await buildAuthorization(inspection.credential.pem, ts);
			if (!signed) {
				return {
					message: "The Ollama key is not a valid Ed25519 OpenSSH key. Sign in to the Ollama app to regenerate it.",
				};
			}
			// The app sends `Bearer <signature>` (doSelfSigned); the cloud proxy
			// sends the bare `<signature>`. Try Bearer first, fall back to bare on
			// an auth rejection.
			return {
				request: {
					url: `${USAGE_ENDPOINT_URL}?ts=${ts}`,
					headerCandidates: [
						{ "User-Agent": USER_AGENT, Authorization: `Bearer ${signed.signature}` },
						{ "User-Agent": USER_AGENT, Authorization: signed.signature },
					],
				},
			};
		},
		contractMatches(payload) {
			if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return false;
			const root = payload as Record<string, unknown>;
			const hasWindow = (value: unknown): boolean =>
				typeof value === "object" && value !== null && !Array.isArray(value);
			// Either the proposed window keys (session_usage/weekly_usage) or the
			// live `limits` object must be present.
			return hasWindow(root.session_usage) || hasWindow(root.weekly_usage) || hasWindow(root.limits);
		},
		normalize: normalizeUsage,
		messages: {
			endpointLabel: "Ollama",
			unreachable: "Could not reach the Ollama usage endpoint.",
			authRejected: () => "the Ollama key is not linked to an account — open https://ollama.com/connect",
		},
	};
}

export async function probeUsage(options: ProbeOptions & {
	inspect?: () => Promise<OllamaAuthInspection>;
} = {}): Promise<ProbeResult<UsageSnapshot>> {
	return runProbe(createOllamaAdapter(options.inspect, options.now), options);
}
