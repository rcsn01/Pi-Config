import { inspectCodexAuth } from "./codex-auth.ts";
import type {
	AnalyticsEndpointId,
	AnalyticsPayloads,
	AnalyticsProbeResult,
	CodexAuthInspection,
	EndpointProbe,
} from "./types.ts";

const CHATGPT_ORIGIN = "https://chatgpt.com";
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export const ANALYTICS_ENDPOINTS = {
	quota: "/backend-api/wham/usage",
	tokens: "/backend-api/wham/usage/daily-token-usage-breakdown",
	workspace: "/backend-api/wham/analytics/daily-workspace-usage-counts",
	skills: "/backend-api/wham/analytics/daily-skill-usage-metrics",
	plugins: "/backend-api/wham/analytics/daily-plugin-usage-metrics",
	credits: "/backend-api/wham/usage/credit-usage-events",
} as const satisfies Record<AnalyticsEndpointId, string>;

function utcDate(value: Date): string {
	return value.toISOString().slice(0, 10);
}

export function defaultAnalyticsDateRange(now = new Date()): { startDate: string; endDate: string } {
	const start = new Date(now);
	start.setUTCDate(start.getUTCDate() - 29);
	return { startDate: utcDate(start), endDate: utcDate(now) };
}

function validDate(value: string): boolean {
	return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00.000Z`));
}

export function analyticsRequestUrls(startDate: string, endDate: string): Record<AnalyticsEndpointId, URL> {
	if (!validDate(startDate) || !validDate(endDate) || startDate > endDate) {
		throw new Error("Analytics date range must contain valid YYYY-MM-DD dates in ascending order");
	}
	const url = (path: string, params?: Record<string, string>) => {
		const result = new URL(path, CHATGPT_ORIGIN);
		for (const [name, value] of Object.entries(params ?? {})) result.searchParams.set(name, value);
		return result;
	};
	const common = { start_date: startDate, end_date: endDate, group_by: "day" };
	return {
		quota: url(ANALYTICS_ENDPOINTS.quota),
		tokens: url(ANALYTICS_ENDPOINTS.tokens, common),
		workspace: url(ANALYTICS_ENDPOINTS.workspace, { ...common, workspace_user: "true" }),
		skills: url(ANALYTICS_ENDPOINTS.skills, { ...common, workspace_user: "true", top_skill_limit: "10" }),
		plugins: url(ANALYTICS_ENDPOINTS.plugins, { ...common, workspace_user: "true", top_plugin_limit: "10" }),
		credits: url(ANALYTICS_ENDPOINTS.credits),
	};
}

function object(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}

function contractMatches(id: AnalyticsEndpointId, payload: unknown): boolean {
	const root = object(payload);
	if (!root) return false;
	if (id === "quota") return object(root.rate_limit) !== undefined || root.plan_type !== undefined;
	return Array.isArray(root.data);
}

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

function authFailure(inspection: Exclude<CodexAuthInspection, { state: "ready" }>): AnalyticsProbeResult {
	return {
		state: "auth-required",
		message: inspection.message,
		endpoints: [],
	};
}

export async function probeCodexAnalytics(options: {
	inspect?: () => Promise<CodexAuthInspection>;
	fetchImpl?: typeof fetch;
	signal?: AbortSignal;
	timeoutMs?: number;
	maxResponseBytes?: number;
	startDate?: string;
	endDate?: string;
	now?: Date;
} = {}): Promise<AnalyticsProbeResult> {
	const inspection = await (options.inspect ?? inspectCodexAuth)();
	if (inspection.state !== "ready") return authFailure(inspection);

	const fallbackRange = defaultAnalyticsDateRange(options.now);
	const startDate = options.startDate ?? fallbackRange.startDate;
	const endDate = options.endDate ?? fallbackRange.endDate;
	const urls = analyticsRequestUrls(startDate, endDate);
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(new Error("timeout")), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
	const abort = () => controller.abort(options.signal?.reason);
	options.signal?.addEventListener("abort", abort, { once: true });
	const endpointResults: EndpointProbe[] = [];
	const payloads = {} as AnalyticsPayloads;
	try {
		for (const id of Object.keys(ANALYTICS_ENDPOINTS) as AnalyticsEndpointId[]) {
			options.signal?.throwIfAborted();
			let response: Response;
			try {
				response = await (options.fetchImpl ?? fetch)(urls[id], {
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
				return {
					state: "unavailable",
					message: `Could not reach the ChatGPT analytics endpoint '${id}'.`,
					endpoints: endpointResults,
				};
			}
			if (response.status === 401 || response.status === 403) {
				return {
					state: "auth-required",
					message: `ChatGPT rejected the Codex credential for analytics '${id}' (HTTP ${response.status}).`,
					endpoints: [...endpointResults, { id, path: ANALYTICS_ENDPOINTS[id], status: response.status, state: "auth-required" }],
				};
			}
			if (!response.ok) {
				return {
					state: "unavailable",
					message: `ChatGPT analytics '${id}' is unavailable (HTTP ${response.status}).`,
					endpoints: [...endpointResults, { id, path: ANALYTICS_ENDPOINTS[id], status: response.status, state: "unavailable" }],
				};
			}
			let payload: unknown;
			try {
				payload = await readLimitedJson(response, options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES);
			} catch (error) {
				const reason = (error as Error).message === "response-too-large" ? "exceeded the response limit" : "returned invalid JSON";
				return {
					state: "contract-unknown",
					message: `ChatGPT analytics '${id}' ${reason}.`,
					endpoints: [...endpointResults, { id, path: ANALYTICS_ENDPOINTS[id], status: response.status, state: "contract-unknown" }],
				};
			}
			if (!contractMatches(id, payload)) {
				return {
					state: "contract-unknown",
					message: `ChatGPT analytics '${id}' returned an unrecognized JSON contract.`,
					endpoints: [...endpointResults, { id, path: ANALYTICS_ENDPOINTS[id], status: response.status, state: "contract-unknown" }],
				};
			}
			const rowCount = id === "quota" ? undefined : (object(payload)?.data as unknown[]).length;
			endpointResults.push({ id, path: ANALYTICS_ENDPOINTS[id], status: response.status, state: "ok", rowCount });
			payloads[id] = payload;
		}
		return {
			state: "ok",
			fetchedAt: new Date().toISOString(),
			startDate,
			endDate,
			endpoints: endpointResults,
			payloads,
		};
	} finally {
		clearTimeout(timeout);
		options.signal?.removeEventListener("abort", abort);
	}
}
