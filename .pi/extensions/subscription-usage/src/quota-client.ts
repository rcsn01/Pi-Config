import { inspectCodexAuth } from "./codex-auth.ts";
import { normalizeQuota } from "./quota.ts";
import type { CodexAuthInspection, QuotaProbeResult } from "./types.ts";

// The same endpoint Codex's own BackendClient uses for `/status` rate limits
// (codex-rs/backend-client/src/client/rate_limit_resets.rs, PathStyle::ChatGptApi).
export const QUOTA_ENDPOINT_URL = "https://chatgpt.com/backend-api/wham/usage";
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

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
	return typeof root.plan_type === "string"
		&& typeof root.rate_limit === "object"
		&& root.rate_limit !== null
		&& !Array.isArray(root.rate_limit);
}

export async function probeQuota(options: {
	inspect?: () => Promise<CodexAuthInspection>;
	fetchImpl?: typeof fetch;
	signal?: AbortSignal;
	timeoutMs?: number;
	maxResponseBytes?: number;
	now?: () => Date;
} = {}): Promise<QuotaProbeResult> {
	const inspection = await (options.inspect ?? inspectCodexAuth)();
	if (inspection.state !== "ready") {
		return { state: "auth-required", message: inspection.message };
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
		let response: Response;
		try {
			response = await (options.fetchImpl ?? fetch)(QUOTA_ENDPOINT_URL, {
				method: "GET",
				headers: {
					Accept: "application/json",
					Authorization: `Bearer ${inspection.credential.accessToken}`,
					"chatgpt-account-id": inspection.credential.accountId,
				},
				redirect: "error",
				signal: controller.signal,
			});
		} catch {
			return { state: "unavailable", message: "Could not reach the ChatGPT usage endpoint." };
		}
		if (response.status === 401 || response.status === 403) {
			return {
				state: "auth-required",
				message: `ChatGPT rejected the Codex credential (HTTP ${response.status}). Run \`codex login\` and try again.`,
			};
		}
		if (!response.ok) {
			return { state: "unavailable", message: `ChatGPT usage is unavailable (HTTP ${response.status}).` };
		}

		let payload: unknown;
		try {
			payload = await readLimitedJson(response, options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES);
		} catch (error) {
			const reason = (error as Error).message === "response-too-large"
				? "exceeded the response limit"
				: "returned invalid JSON";
			return { state: "contract-unknown", message: `ChatGPT usage ${reason}.` };
		}
		if (!contractMatches(payload)) {
			return { state: "contract-unknown", message: "ChatGPT usage returned an unrecognized JSON contract." };
		}
		const fetchedAt = (options.now ?? (() => new Date()))().toISOString();
		const snapshot = normalizeQuota(payload, fetchedAt);
		if (!snapshot) {
			return { state: "contract-unknown", message: "ChatGPT usage returned an unrecognized JSON contract." };
		}
		return { state: "ok", fetchedAt, snapshot };
	} finally {
		clearTimeout(timeout);
		options.signal?.removeEventListener("abort", abort);
	}
}
