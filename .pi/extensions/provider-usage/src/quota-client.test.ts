import { describe, expect, it, vi } from "vitest";
import { probeQuota, QUOTA_ENDPOINT_URL } from "./quota-client.ts";
import type { CodexAuthInspection } from "./types.ts";

const ready: CodexAuthInspection = {
	state: "ready", path: "/auth.json", fileFound: true,
	accessTokenPresent: true, accountIdPresent: true,
	credential: { accessToken: "TOP_SECRET_TOKEN", accountId: "account-123" },
};

const usagePayload = {
	user_id: "SECRET_USER",
	plan_type: "plus",
	rate_limit: {
		primary_window: { used_percent: 58, limit_window_seconds: 604_800, reset_at: 1_787_581_800 },
	},
	rate_limit_reset_credits: { available_count: 1 },
};

function successfulFetch() {
	return vi.fn<typeof fetch>(async () => Response.json(usagePayload));
}

describe("ChatGPT Codex quota request contract", () => {
	it("fetches the single /backend-api/wham/usage endpoint with only the required Codex headers", async () => {
		const fetchImpl = successfulFetch();
		const result = await probeQuota({ inspect: async () => ready, fetchImpl });

		expect(result).toMatchObject({ state: "ok" });
		expect(fetchImpl).toHaveBeenCalledOnce();
		const [url, init] = fetchImpl.mock.calls[0]!;
		expect(url).toBe(QUOTA_ENDPOINT_URL);
		expect(init).toMatchObject({ method: "GET", redirect: "error" });
		const headers = new Headers(init?.headers);
		expect(headers.get("Authorization")).toBe("Bearer TOP_SECRET_TOKEN");
		expect(headers.get("chatgpt-account-id")).toBe("account-123");
		expect(JSON.stringify(result)).not.toContain("TOP_SECRET_TOKEN");
		expect(JSON.stringify(result)).not.toContain("SECRET_USER");
	});

	it("does not request usage without a usable local credential", async () => {
		const fetchImpl = vi.fn();
		const result = await probeQuota({
			inspect: async () => ({
				state: "expired", path: "/auth.json", fileFound: true,
				accessTokenPresent: true, accountIdPresent: true, message: "Run `codex login`.",
			}),
			fetchImpl,
		});
		expect(result).toMatchObject({ state: "auth-required" });
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it.each([401, 403])("maps an HTTP %s credential rejection to auth-required", async (status) => {
		const result = await probeQuota({
			inspect: async () => ready,
			fetchImpl: vi.fn(async () => new Response("SECRET BODY", { status })),
		});
		expect(result).toMatchObject({ state: "auth-required" });
		expect((result as { message: string }).message).toContain("codex login");
		expect(JSON.stringify(result)).not.toContain("TOP_SECRET_TOKEN");
		expect(JSON.stringify(result)).not.toContain("SECRET BODY");
	});

	it("sanitizes network failures and unexpected HTTP statuses", async () => {
		const network = await probeQuota({
			inspect: async () => ready,
			fetchImpl: vi.fn(async () => { throw new Error("request with TOP_SECRET_TOKEN failed"); }),
		});
		expect(network).toMatchObject({ state: "unavailable" });
		expect(JSON.stringify(network)).not.toContain("TOP_SECRET_TOKEN");

		const server = await probeQuota({
			inspect: async () => ready,
			fetchImpl: vi.fn(async () => new Response("SECRET BODY", { status: 503 })),
		});
		expect(server).toMatchObject({ state: "unavailable" });
		expect((server as { message: string }).message).toContain("HTTP 503");
		expect(JSON.stringify(server)).not.toContain("SECRET BODY");
	});

	it("distinguishes invalid JSON, oversized responses, and changed contracts", async () => {
		const invalid = await probeQuota({
			inspect: async () => ready,
			fetchImpl: vi.fn(async () => new Response("not-json SECRET")),
		});
		expect(invalid).toMatchObject({ state: "contract-unknown" });
		expect(JSON.stringify(invalid)).not.toContain("SECRET");

		const oversized = await probeQuota({
			inspect: async () => ready,
			fetchImpl: vi.fn(async () => Response.json(usagePayload, { headers: { "content-length": "999" } })),
			maxResponseBytes: 100,
		});
		expect(oversized).toMatchObject({ state: "contract-unknown" });

		for (const changed of [
			{ changed: true },
			{ plan_type: "plus" }, // rate_limit object missing
			{ rate_limit: {} }, // plan_type string missing
			[1, 2, 3],
		]) {
			const result = await probeQuota({
				inspect: async () => ready,
				fetchImpl: vi.fn(async () => Response.json(changed)),
			});
			expect(result).toMatchObject({ state: "contract-unknown" });
		}
	});

	it("returns a normalized snapshot for a valid payload", async () => {
		const now = vi.fn(() => new Date("2026-08-17T12:00:00.000Z"));
		const result = await probeQuota({
			inspect: async () => ready,
			fetchImpl: successfulFetch(),
			now,
		});
		expect(result).toEqual({
			state: "ok",
			fetchedAt: "2026-08-17T12:00:00.000Z",
			snapshot: {
				plan: "Plus",
				weekly: { usedPercent: 58, windowMinutes: 10_080, resetsAt: "2026-08-24T14:30:00.000Z" },
				resetCredits: { available: 1 },
				fetchedAt: "2026-08-17T12:00:00.000Z",
			},
		});
	});
});
