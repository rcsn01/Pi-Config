import { buildAuthorization, inspectOllamaAuth } from "./ollama-auth.ts";
import { normalizeUsage } from "./ollama-usage.ts";
import type { OllamaAuthInspection, UsageProbeResult } from "./ollama-types.ts";

// The single usage endpoint behind the Ollama web UI's usage card.
export const USAGE_ENDPOINT_URL = "https://ollama.com/api/usage";
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

// A real-client User-Agent, mirroring the shape of the Ollama app's
// userAgent() (app/ui/ui.go): `ollama/<v> (<arch> <os>) app/<v> Go/<go>`.
const USER_AGENT = "ollama/v0.32.14 (arm64 darwin) app/v0.32.14 Go/1.24";

async function readLimitedJson(response: Response, maxBytes: number): Promise<unknown> {
	const declared = Number(response.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > maxBytes) throw new Error("response-too-large");
	if (!response.body) throw new Error("invalid-json");
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let bytes = 0;
	let text = "";
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			bytes += value.byteLength;
			if (bytes > maxBytes) throw new Error("response-too-large");
			text += decoder.decode(value, { stream: true });
		}
		text += decoder.decode();
	} finally {
		reader.releaseLock();
	}
	try {
		return JSON.parse(text);
	} catch {
		throw new Error("invalid-json");
	}
}

function contractMatches(payload: unknown): boolean {
	if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return false;
	const root = payload as Record<string, unknown>;
	const hasWindow = (value: unknown): boolean =>
		typeof value === "object" && value !== null && !Array.isArray(value);
	// Either the proposed window keys (session_usage/weekly_usage) or the
	// live `limits` object must be present.
	return hasWindow(root.session_usage) || hasWindow(root.weekly_usage) || hasWindow(root.limits);
}

export async function probeUsage(options: {
	inspect?: () => Promise<OllamaAuthInspection>;
	fetchImpl?: typeof fetch;
	signal?: AbortSignal;
	timeoutMs?: number;
	maxResponseBytes?: number;
	now?: () => Date;
} = {}): Promise<UsageProbeResult> {
	const inspection = await (options.inspect ?? inspectOllamaAuth)();
	if (inspection.state !== "ready") {
		return { state: "auth-required", message: inspection.message };
	}

	// ts is unix seconds; the challenge `GET,/api/usage?ts=<ts>` is signed the
	// way the Ollama app signs its own requests (app/ui/ui.go doSelfSigned and
	// server/cloud_proxy.go buildCloudSignatureChallenge agree on this form).
	const now = options.now ?? (() => new Date());
	const ts = String(Math.floor(now().getTime() / 1000));
	const signed = await buildAuthorization(inspection.credential.pem, ts);
	if (!signed) {
		return {
			state: "auth-required",
			message: "The Ollama key is not a valid Ed25519 OpenSSH key. Sign in to the Ollama app to regenerate it.",
		};
	}

	options.signal?.throwIfAborted();
	const controller = new AbortController();
	const timeout = setTimeout(
		() => controller.abort(new Error("timeout")),
		options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
	);
	const abort = () => controller.abort(options.signal?.reason);
	options.signal?.addEventListener("abort", abort, { once: true });
	try {
		const url = `${USAGE_ENDPOINT_URL}?ts=${ts}`;
		// The app sends `Bearer <signature>` (doSelfSigned); the cloud proxy
		// sends the bare `<signature>`. Try Bearer first, fall back to bare on
		// an auth rejection.
		const attempts = [`Bearer ${signed.signature}`, signed.signature];
		let response: Response | undefined;
		for (const authorization of attempts) {
			try {
				response = await (options.fetchImpl ?? fetch)(url, {
					method: "GET",
					headers: {
						Accept: "application/json",
						"User-Agent": USER_AGENT,
						Authorization: authorization,
					},
					redirect: "error",
					signal: controller.signal,
				});
			} catch {
				return { state: "unavailable", message: "Could not reach the Ollama usage endpoint." };
			}
			if (response.status !== 401 && response.status !== 403) break;
		}
		if (!response) return { state: "unavailable", message: "Could not reach the Ollama usage endpoint." };
		if (response.status === 401 || response.status === 403) {
			return {
				state: "auth-required",
				message: "the Ollama key is not linked to an account — open https://ollama.com/connect",
			};
		}
		if (!response.ok) {
			return { state: "unavailable", message: `Ollama usage is unavailable (HTTP ${response.status}).` };
		}

		let payload: unknown;
		try {
			payload = await readLimitedJson(response, options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES);
		} catch (error) {
			const reason = (error as Error).message === "response-too-large"
				? "exceeded the response limit"
				: "returned invalid JSON";
			return { state: "contract-unknown", message: `Ollama usage ${reason}.` };
		}
		if (!contractMatches(payload)) {
			return { state: "contract-unknown", message: "Ollama usage returned an unrecognized JSON contract." };
		}
		const fetchedAt = now().toISOString();
		const snapshot = normalizeUsage(payload, fetchedAt);
		if (!snapshot) {
			return { state: "contract-unknown", message: "Ollama usage returned an unrecognized JSON contract." };
		}
		return { state: "ok", fetchedAt, snapshot };
	} finally {
		clearTimeout(timeout);
		options.signal?.removeEventListener("abort", abort);
	}
}
