import { describe, expect, it, vi } from "vitest";
import { isStale, runProbe, type ProviderProbeAdapter } from "./probe.ts";

interface FakeSnapshot {
	plan?: string;
	value: number;
	fetchedAt: string;
}

function adapter(overrides: Partial<ProviderProbeAdapter<FakeSnapshot>> = {}): ProviderProbeAdapter<FakeSnapshot> {
	return {
		authenticate: async () => ({
			request: {
				url: "https://example.test/usage",
				headerCandidates: [{ Authorization: "Bearer TOP_SECRET_TOKEN" }],
			},
		}),
		contractMatches: () => true,
		normalize: (_payload, fetchedAt) => ({ value: 42, fetchedAt }),
		messages: {
			endpointLabel: "Example",
			unreachable: "Could not reach the Example usage endpoint.",
			authRejected: (status) => `Example rejected the credential (HTTP ${status}).`,
		},
		...overrides,
	};
}

const payload = { plan: "pro", value: 42 };

describe("snapshot staleness (shared 15-minute policy)", () => {
	const fetchedAt = "2026-08-17T12:00:00.000Z";

	it("is fresh within 15 minutes and stale after", () => {
		expect(isStale(fetchedAt, new Date("2026-08-17T12:14:59.000Z"))).toBe(false);
		expect(isStale(fetchedAt, new Date("2026-08-17T12:15:00.000Z"))).toBe(false);
		expect(isStale(fetchedAt, new Date("2026-08-17T12:15:01.000Z"))).toBe(true);
		expect(isStale(fetchedAt, new Date("2026-08-17T13:00:00.000Z"))).toBe(true);
	});

	it("treats an unparsable fetch time as stale", () => {
		expect(isStale("not-a-date", new Date("2026-08-17T12:15:00.000Z"))).toBe(true);
	});
});

describe("runProbe status mapping", () => {
	it("returns auth-required without fetching when authentication fails", async () => {
		const fetchImpl = vi.fn();
		const result = await runProbe(adapter({
			authenticate: async () => ({ message: "Sign in first." }),
		}), { fetchImpl });
		expect(result).toEqual({ state: "auth-required", message: "Sign in first." });
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("maps an HTTP 401/403 rejection to auth-required with the status", async () => {
		for (const status of [401, 403]) {
			const result = await runProbe(adapter(), {
				fetchImpl: vi.fn(async () => new Response("SECRET BODY", { status })),
			});
			expect(result).toEqual({ state: "auth-required", message: `Example rejected the credential (HTTP ${status}).` });
		}
	});

	it("never echoes credentials or bodies in the auth-rejected message", async () => {
		const result = await runProbe(adapter(), {
			fetchImpl: vi.fn(async () => new Response("SECRET BODY", { status: 401 })),
		});
		expect(result).toMatchObject({ state: "auth-required" });
		expect(JSON.stringify(result)).not.toContain("TOP_SECRET_TOKEN");
		expect(JSON.stringify(result)).not.toContain("SECRET BODY");
	});

	it("tries header candidates in order and falls back on rejection", async () => {
		let attempts = 0;
		const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
			const headers = new Headers(init?.headers);
			attempts += 1;
			if (attempts === 1) {
				expect(headers.get("Authorization")).toBe("Bearer TOP_SECRET_TOKEN");
				return new Response("SECRET BODY", { status: 401 });
			}
			expect(headers.get("Authorization")).toBe("bare-token");
			return Response.json(payload);
		});
		const result = await runProbe(adapter({
			authenticate: async () => ({
				request: {
					url: "https://example.test/usage",
					headerCandidates: [
						{ Authorization: "Bearer TOP_SECRET_TOKEN" },
						{ Authorization: "bare-token" },
					],
				},
			}),
		}), { fetchImpl });
		expect(result).toMatchObject({ state: "ok" });
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});

	it("maps unexpected HTTP statuses to unavailable with the status", async () => {
		const result = await runProbe(adapter(), {
			fetchImpl: vi.fn(async () => new Response("SECRET BODY", { status: 503 })),
		});
		expect(result).toEqual({
			state: "unavailable",
			message: "Example usage is unavailable (HTTP 503).",
		});
	});

	it("maps network failures to unavailable without echoing the error", async () => {
		const result = await runProbe(adapter(), {
			fetchImpl: vi.fn(async () => { throw new Error("request with TOP_SECRET_TOKEN failed"); }),
		});
		expect(result).toEqual({ state: "unavailable", message: "Could not reach the Example usage endpoint." });
		expect(JSON.stringify(result)).not.toContain("TOP_SECRET_TOKEN");
	});

	it("distinguishes invalid JSON, oversized responses, and changed contracts", async () => {
		const invalid = await runProbe(adapter(), {
			fetchImpl: vi.fn(async () => new Response("not-json SECRET")),
		});
		expect(invalid).toEqual({
			state: "contract-unknown",
			message: "Example usage returned invalid JSON.",
		});
		expect(JSON.stringify(invalid)).not.toContain("SECRET");

		const oversized = await runProbe(adapter(), {
			fetchImpl: vi.fn(async () => Response.json(payload, { headers: { "content-length": "999" } })),
			maxResponseBytes: 100,
		});
		expect(oversized).toMatchObject({
			state: "contract-unknown",
			message: "Example usage exceeded the response limit.",
		});

		const changed = await runProbe(adapter({ contractMatches: () => false }), {
			fetchImpl: vi.fn(async () => Response.json(payload)),
		});
		expect(changed).toEqual({
			state: "contract-unknown",
			message: "Example usage returned an unrecognized JSON contract.",
		});
	});

	it("treats an adapter that cannot normalize as a changed contract", async () => {
		const result = await runProbe(adapter({ normalize: () => undefined }), {
			fetchImpl: vi.fn(async () => Response.json(payload)),
		});
		expect(result).toMatchObject({ state: "contract-unknown" });
	});

	it("returns a normalized snapshot with the injected clock", async () => {
		const now = vi.fn(() => new Date("2026-08-17T12:00:00.000Z"));
		const result = await runProbe(adapter(), { fetchImpl: vi.fn(async () => Response.json(payload)), now });
		expect(result).toEqual({
			state: "ok",
			fetchedAt: "2026-08-17T12:00:00.000Z",
			snapshot: { value: 42, fetchedAt: "2026-08-17T12:00:00.000Z" },
		});
		expect(JSON.stringify(result)).not.toContain("TOP_SECRET_TOKEN");
	});

	it("rejects when the caller's signal is already aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		const fetchImpl = vi.fn();
		await expect(runProbe(adapter(), { signal: controller.signal, fetchImpl })).rejects.toThrow();
		expect(fetchImpl).not.toHaveBeenCalled();
	});
});
