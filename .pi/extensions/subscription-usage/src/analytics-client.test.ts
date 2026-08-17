import { describe, expect, it, vi } from "vitest";
import {
	ANALYTICS_ENDPOINTS,
	analyticsRequestUrls,
	defaultAnalyticsDateRange,
	probeCodexAnalytics,
} from "./analytics-client.ts";
import type { CodexAuthInspection } from "./types.ts";

const ready: CodexAuthInspection = {
	state: "ready", path: "/auth.json", fileFound: true,
	accessTokenPresent: true, accountIdPresent: true,
	credential: { accessToken: "TOP_SECRET_TOKEN", accountId: "account-123" },
};

function payloadFor(path: string): unknown {
	return path === ANALYTICS_ENDPOINTS.quota
		? { plan_type: "plus", rate_limit: {} }
		: { data: [], group_by: "day" };
}

function successfulFetch() {
	return vi.fn<typeof fetch>(async (input) => {
		const url = new URL(input instanceof Request ? input.url : input.toString());
		return Response.json(payloadFor(url.pathname));
	});
}

describe("ChatGPT Codex analytics request contract", () => {
	it("builds the captured six-endpoint contract for an inclusive 30-day range", () => {
		expect(defaultAnalyticsDateRange(new Date("2026-08-17T12:00:00Z"))).toEqual({
			startDate: "2026-07-19", endDate: "2026-08-17",
		});
		const urls = analyticsRequestUrls("2026-08-11", "2026-08-17");
		expect(urls.tokens.pathname).toBe(ANALYTICS_ENDPOINTS.tokens);
		expect(Object.fromEntries(urls.tokens.searchParams)).toEqual({
			start_date: "2026-08-11", end_date: "2026-08-17", group_by: "day",
		});
		expect(Object.fromEntries(urls.workspace.searchParams)).toMatchObject({ workspace_user: "true" });
		expect(Object.fromEntries(urls.skills.searchParams)).toMatchObject({ top_skill_limit: "10" });
		expect(Object.fromEntries(urls.plugins.searchParams)).toMatchObject({ top_plugin_limit: "10" });
		expect(urls.quota.search).toBe("");
		expect(urls.credits.search).toBe("");
		expect(() => analyticsRequestUrls("not-a-date", "2026-08-17")).toThrow("YYYY-MM-DD");
		expect(() => analyticsRequestUrls("2026-08-18", "2026-08-17")).toThrow("ascending");
	});

	it("probes every endpoint with only the required Codex headers", async () => {
		const fetchImpl = successfulFetch();
		const result = await probeCodexAnalytics({
			inspect: async () => ready,
			fetchImpl,
			startDate: "2026-08-11",
			endDate: "2026-08-17",
		});
		expect(result).toMatchObject({ state: "ok", startDate: "2026-08-11", endDate: "2026-08-17" });
		expect(result.endpoints.map((endpoint) => endpoint.id)).toEqual(Object.keys(ANALYTICS_ENDPOINTS));
		expect(fetchImpl).toHaveBeenCalledTimes(6);
		for (const [, init] of fetchImpl.mock.calls) {
			expect(init).toMatchObject({ method: "GET", redirect: "error" });
			expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer TOP_SECRET_TOKEN");
			expect(new Headers(init?.headers).get("chatgpt-account-id")).toBe("account-123");
		}
		expect(JSON.stringify(result)).not.toContain("TOP_SECRET_TOKEN");
	});

	it("does not request analytics without a usable local credential", async () => {
		const fetchImpl = successfulFetch();
		const result = await probeCodexAnalytics({
			inspect: async () => ({
				state: "expired", path: "/auth.json", fileFound: true,
				accessTokenPresent: true, accountIdPresent: true, message: "Run `codex login`.",
			}),
			fetchImpl,
		});
		expect(result).toMatchObject({ state: "auth-required" });
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it.each([401, 403])("distinguishes an HTTP %s credential rejection", async (status) => {
		const result = await probeCodexAnalytics({
			inspect: async () => ready,
			fetchImpl: vi.fn(async () => new Response("SECRET BODY", { status })),
		});
		expect(result).toMatchObject({ state: "auth-required" });
		expect(JSON.stringify(result)).not.toContain("TOP_SECRET_TOKEN");
		expect(JSON.stringify(result)).not.toContain("SECRET BODY");
	});

	it("distinguishes unavailable, invalid, oversized, and changed responses", async () => {
		const unavailable = await probeCodexAnalytics({
			inspect: async () => ready,
			fetchImpl: vi.fn(async () => new Response("SECRET BODY", { status: 503 })),
		});
		expect(unavailable).toMatchObject({ state: "unavailable" });
		expect(JSON.stringify(unavailable)).not.toContain("SECRET BODY");

		const invalid = await probeCodexAnalytics({
			inspect: async () => ready,
			fetchImpl: vi.fn(async () => new Response("not-json SECRET")),
		});
		expect(invalid).toMatchObject({ state: "contract-unknown" });
		expect(JSON.stringify(invalid)).not.toContain("SECRET");

		const oversized = await probeCodexAnalytics({
			inspect: async () => ready,
			fetchImpl: vi.fn(async () => Response.json({ plan_type: "plus" }, { headers: { "content-length": "999" } })),
			maxResponseBytes: 100,
		});
		expect(oversized).toMatchObject({ state: "contract-unknown" });

		const changed = await probeCodexAnalytics({
			inspect: async () => ready,
			fetchImpl: vi.fn(async () => Response.json({ changed: true })),
		});
		expect(changed).toMatchObject({ state: "contract-unknown" });
	});

	it("sanitizes network failures and requests redirects be rejected", async () => {
		const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
			expect(init?.redirect).toBe("error");
			throw new Error("TOP_SECRET_TOKEN appeared in low-level error");
		});
		const result = await probeCodexAnalytics({ inspect: async () => ready, fetchImpl });
		expect(result).toMatchObject({ state: "unavailable" });
		expect(JSON.stringify(result)).not.toContain("TOP_SECRET_TOKEN");
	});
});
