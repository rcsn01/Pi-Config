/**
 * Subscription probe — the shared probe machinery behind every provider
 * adapter in this package.
 *
 * One module owns the parts of a provider probe that must not be copied per
 * provider: the bounded fetch (timeout, abort, response-size limit), the
 * status → result mapping (`ok | auth-required | unavailable |
 * contract-unknown`), the 15-minute staleness policy, and the wire-parsing
 * helpers the normalize functions share. Each provider (codex, ollama) is a
 * small adapter behind this module: auth + request header candidates,
 * contract check, normalization, and the provider's own error messages.
 */

export const DEFAULT_TIMEOUT_MS = 15_000;
export const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

/** A snapshot older than this is marked stale in cards and refetched. */
export const STALE_THRESHOLD_MINUTES = 15;

export type ProbeState = "ok" | "auth-required" | "unavailable" | "contract-unknown";

export type ProbeResult<T> =
	| { state: "ok"; fetchedAt: string; snapshot: T }
	| { state: Exclude<ProbeState, "ok">; message: string };

export function isStale(fetchedAt: string, now = new Date()): boolean {
	const ageMs = Date.parse(fetchedAt);
	if (!Number.isFinite(ageMs)) return true;
	return now.getTime() - ageMs > STALE_THRESHOLD_MINUTES * 60_000;
}

// ── Wire parsing (shared by the normalize functions) ────────────────

export function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}

export function finite(value: unknown): number | undefined {
	const parsed = typeof value === "number"
		? value
		: typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

// ── Transport ───────────────────────────────────────────────────────

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

export interface ProbeRequest {
	url: string;
	/** Header sets tried in order until one is not rejected (HTTP 401/403). */
	headerCandidates: Record<string, string>[];
}

export interface ProviderProbeMessages {
	/** Provider label used in "X usage is unavailable (HTTP n)." */
	endpointLabel: string;
	/** Network-failure message ("Could not reach the X usage endpoint."). */
	unreachable: string;
	/** Credential-rejection message; receives the HTTP status that rejected it. */
	authRejected: (status: number) => string;
}

export interface ProviderProbeAdapter<T> {
	/** Resolve the credential and build the signed request, or say why not. */
	authenticate(): Promise<{ request: ProbeRequest } | { message: string }>;
	contractMatches(payload: unknown): boolean;
	normalize(payload: unknown, fetchedAt: string): T | undefined;
	messages: ProviderProbeMessages;
}

export interface ProbeOptions {
	fetchImpl?: typeof fetch;
	signal?: AbortSignal;
	timeoutMs?: number;
	maxResponseBytes?: number;
	now?: () => Date;
}

/**
 * One bounded probe run against a provider adapter: authenticate, try the
 * header candidates until one is not rejected, then map the response to a
 * result state. Never echoes credentials, bodies, or auth material in any
 * state's message.
 */
export async function runProbe<T>(
	adapter: ProviderProbeAdapter<T>,
	options: ProbeOptions = {},
): Promise<ProbeResult<T>> {
	options.signal?.throwIfAborted();
	const auth = await adapter.authenticate();
	options.signal?.throwIfAborted();
	if (!("request" in auth)) return { state: "auth-required", message: auth.message };
	const { request } = auth;

	options.signal?.throwIfAborted();
	const controller = new AbortController();
	const timeout = setTimeout(
		() => controller.abort(new Error("timeout")),
		options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
	);
	const abort = () => controller.abort(options.signal?.reason);
	options.signal?.addEventListener("abort", abort, { once: true });
	try {
		let response: Response | undefined;
		for (const headers of request.headerCandidates) {
			try {
				response = await (options.fetchImpl ?? fetch)(request.url, {
					method: "GET",
					headers: { Accept: "application/json", ...headers },
					redirect: "error",
					signal: controller.signal,
				});
			} catch {
				options.signal?.throwIfAborted();
				return { state: "unavailable", message: adapter.messages.unreachable };
			}
			if (response.status !== 401 && response.status !== 403) break;
		}
		if (!response) return { state: "unavailable", message: adapter.messages.unreachable };
		options.signal?.throwIfAborted();
		if (response.status === 401 || response.status === 403) {
			return { state: "auth-required", message: adapter.messages.authRejected(response.status) };
		}
		if (!response.ok) {
			return {
				state: "unavailable",
				message: `${adapter.messages.endpointLabel} usage is unavailable (HTTP ${response.status}).`,
			};
		}

		let payload: unknown;
		try {
			payload = await readLimitedJson(response, options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES);
		} catch (error) {
			options.signal?.throwIfAborted();
			const reason = (error as Error).message === "response-too-large"
				? "exceeded the response limit"
				: "returned invalid JSON";
			return { state: "contract-unknown", message: `${adapter.messages.endpointLabel} usage ${reason}.` };
		}
		options.signal?.throwIfAborted();
		if (!adapter.contractMatches(payload)) {
			return {
				state: "contract-unknown",
				message: `${adapter.messages.endpointLabel} usage returned an unrecognized JSON contract.`,
			};
		}
		const fetchedAt = (options.now ?? (() => new Date()))().toISOString();
		const snapshot = adapter.normalize(payload, fetchedAt);
		if (!snapshot) {
			return {
				state: "contract-unknown",
				message: `${adapter.messages.endpointLabel} usage returned an unrecognized JSON contract.`,
			};
		}
		return { state: "ok", fetchedAt, snapshot };
	} finally {
		clearTimeout(timeout);
		options.signal?.removeEventListener("abort", abort);
	}
}
