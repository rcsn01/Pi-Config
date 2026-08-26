import { describe, expect, it, vi } from "vitest";
import { probeQuota, QUOTA_ENDPOINT_URL } from "./quota-client.ts";

const headers = {
	Authorization: "Bearer TOP_SECRET_TOKEN",
	"chatgpt-account-id": "account-123",
};

const usagePayload = {
	user_id: "SECRET_USER",
	plan_type: "plus",
	rate_limit: {
		primary_window: { used_percent: 16, limit_window_seconds: 18_000, reset_at: "2026-08-17T15:00:00.000Z" },
		secondary_window: { used_percent: 58, limit_window_seconds: 604_800, reset_at: 1_787_581_800 },
	},
	rate_limit_reset_credits: { available_count: 1 },
};

function successfulFetch() {
	return vi.fn<typeof fetch>(async () => Response.json(usagePayload));
}

describe("ChatGPT Codex quota request contract", () => {
	it("fetches the single /backend-api/wham/usage endpoint with only caller-supplied Codex headers", async () => {
		const fetchImpl = successfulFetch();
		const result = await probeQuota({ headers, fetchImpl });

		expect(result).toMatchObject({ state: "ok" });
		expect(fetchImpl).toHaveBeenCalledOnce();
		const [url, init] = fetchImpl.mock.calls[0]!;
		expect(url).toBe(QUOTA_ENDPOINT_URL);
		expect(init).toMatchObject({ method: "GET", redirect: "error" });
		const requestHeaders = new Headers(init?.headers);
		expect(requestHeaders.get("Authorization")).toBe("Bearer TOP_SECRET_TOKEN");
		expect(requestHeaders.get("chatgpt-account-id")).toBe("account-123");
		expect(JSON.stringify(result)).not.toContain("TOP_SECRET_TOKEN");
		expect(JSON.stringify(result)).not.toContain("SECRET_USER");
	});

	it.each([401, 403])("maps an HTTP %s credential rejection to auth-required", async (status) => {
		const result = await probeQuota({
			headers,
			fetchImpl: vi.fn(async () => new Response("SECRET BODY", { status })),
		});
		expect(result).toMatchObject({ state: "auth-required" });
		expect((result as { message: string }).message).toContain("/codex use <name>");
		expect(JSON.stringify(result)).not.toContain("TOP_SECRET_TOKEN");
		expect(JSON.stringify(result)).not.toContain("SECRET BODY");
	});

	it("sanitizes network failures and unexpected HTTP statuses", async () => {
		const network = await probeQuota({
			headers,
			fetchImpl: vi.fn(async () => { throw new Error("request with TOP_SECRET_TOKEN failed"); }),
		});
		expect(network).toMatchObject({ state: "unavailable" });
		expect(JSON.stringify(network)).not.toContain("TOP_SECRET_TOKEN");

		const server = await probeQuota({
			headers,
			fetchImpl: vi.fn(async () => new Response("SECRET BODY", { status: 503 })),
		});
		expect(server).toMatchObject({ state: "unavailable" });
		expect((server as { message: string }).message).toContain("HTTP 503");
		expect(JSON.stringify(server)).not.toContain("SECRET BODY");
	});

	it("distinguishes invalid JSON, oversized responses, and changed contracts", async () => {
		const invalid = await probeQuota({
			headers,
			fetchImpl: vi.fn(async () => new Response("not-json SECRET")),
		});
		expect(invalid).toMatchObject({ state: "contract-unknown" });
		expect(JSON.stringify(invalid)).not.toContain("SECRET");

		const oversized = await probeQuota({
			headers,
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
				headers,
				fetchImpl: vi.fn(async () => Response.json(changed)),
			});
			expect(result).toMatchObject({ state: "contract-unknown" });
		}
	});

	it("returns a normalized snapshot for a valid payload", async () => {
		const now = vi.fn(() => new Date("2026-08-17T12:00:00.000Z"));
		const result = await probeQuota({
			headers,
			fetchImpl: successfulFetch(),
			now,
		});
		expect(result).toEqual({
			state: "ok",
			fetchedAt: "2026-08-17T12:00:00.000Z",
			snapshot: {
				plan: "Plus",
				session: { usedPercent: 16, windowMinutes: 300, resetsAt: "2026-08-17T15:00:00.000Z" },
				weekly: { usedPercent: 58, windowMinutes: 10_080, resetsAt: "2026-08-24T14:30:00.000Z" },
				resetCredits: { available: 1 },
				fetchedAt: "2026-08-17T12:00:00.000Z",
			},
		});
	});
});
