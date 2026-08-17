import { describe, expect, it, vi } from "vitest";
import { makeFixtureKey } from "./fixture-key.ts";
import { probeUsage, USAGE_ENDPOINT_URL } from "./usage-client.ts";
import type { OllamaAuthInspection } from "./types.ts";

const fixture = makeFixtureKey();
const ready: OllamaAuthInspection = {
	state: "ready",
	path: "/home/user/.ollama/id_ed25519",
	fileFound: true,
	credential: { pem: fixture.pem, path: "/home/user/.ollama/id_ed25519" },
};

const usagePayload = {
	activity: {
		cost: "0.00000",
		period: { type: "last_4_weeks", starting_at: "2026-07-27T00:00:00Z" },
		models: [],
	},
	limits: {
		session: { usage: 0.161, models: [{ name: "SECRET_MODEL", request_count: 640 }] },
		weekly: { usage: 0.028, models: [{ name: "SECRET_MODEL", request_count: 640 }] },
	},
};

// The shape proposed in ollama/ollama#16448, still accepted defensively.
const proposalPayload = {
	plan: "pro",
	session_usage: { percentage: 5, resets_in: "5 hours" },
	weekly_usage: { percentage: 50, resets_in: "4 days" },
};

function successfulFetch() {
	return vi.fn<typeof fetch>(async () => Response.json(usagePayload));
}

describe("Ollama usage request contract", () => {
	it("fetches /api/usage?ts=<unix-seconds> with a Bearer pubkey:signature header", async () => {
		const now = new Date("2026-08-17T12:00:00.000Z");
		const expectedTs = String(Math.floor(now.getTime() / 1000));
		const fetchImpl = successfulFetch();
		const result = await probeUsage({ inspect: async () => ready, fetchImpl, now: () => now });

		expect(result).toMatchObject({ state: "ok" });
		expect(fetchImpl).toHaveBeenCalledOnce();
		const [url, init] = fetchImpl.mock.calls[0]!;
		expect(url).toBe(`${USAGE_ENDPOINT_URL}?ts=${expectedTs}`);
		expect(init).toMatchObject({ method: "GET", redirect: "error" });
		const headers = new Headers(init?.headers);
		const authorization = headers.get("Authorization");
		expect(authorization?.startsWith("Bearer ")).toBe(true);
		const signature = authorization!.slice("Bearer ".length);
		const [pubkeyB64, signatureB64] = signature.split(":");
		expect(pubkeyB64).toBe(fixture.publicKeyWireB64);
		expect(signatureB64).toMatch(/^[A-Za-z0-9+/]+=*$/);
		expect(headers.get("User-Agent")).toMatch(/^ollama\/v\d+\.\d+\.\d+/);
		expect(JSON.stringify(result)).not.toContain("SECRET_MODEL");
	});

	it("falls back to a bare pubkey:signature header when Bearer is rejected", async () => {
		let attempts = 0;
		const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
			const headers = new Headers(init?.headers);
			attempts += 1;
			if (attempts === 1) {
				expect(headers.get("Authorization")?.startsWith("Bearer ")).toBe(true);
				return new Response("SECRET BODY", { status: 401 });
			}
			expect(headers.get("Authorization")?.startsWith("Bearer ")).toBe(false);
			expect(headers.get("Authorization")?.split(":")).toHaveLength(2);
			return Response.json(usagePayload);
		});
		const result = await probeUsage({ inspect: async () => ready, fetchImpl });
		expect(result).toMatchObject({ state: "ok" });
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});

	it("reports auth-required when both forms are rejected, without echoing the body", async () => {
		const fetchImpl = vi.fn<typeof fetch>(async () => new Response("SECRET BODY", { status: 401 }));
		const result = await probeUsage({ inspect: async () => ready, fetchImpl });
		expect(result).toMatchObject({ state: "auth-required" });
		expect((result as { message: string }).message).toContain("https://ollama.com/connect");
		expect(JSON.stringify(result)).not.toContain("SECRET BODY");
		expect(JSON.stringify(result)).not.toContain(fixture.pem);
		expect(fetchImpl).toHaveBeenCalledTimes(2);
	});

	it("does not request usage without a usable local key", async () => {
		const fetchImpl = vi.fn();
		const result = await probeUsage({
			inspect: async () => ({
				state: "missing",
				path: "/missing/id_ed25519",
				fileFound: false,
				message: "Sign in to the Ollama app to create ~/.ollama/id_ed25519.",
			}),
			fetchImpl,
		});
		expect(result).toMatchObject({ state: "auth-required" });
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("sanitizes network failures and unexpected HTTP statuses", async () => {
		const network = await probeUsage({
			inspect: async () => ready,
			fetchImpl: vi.fn(async () => { throw new Error("request with the pem failed"); }),
		});
		expect(network).toMatchObject({ state: "unavailable" });
		expect(JSON.stringify(network)).not.toContain(fixture.pem);

		const server = await probeUsage({
			inspect: async () => ready,
			fetchImpl: vi.fn(async () => new Response("SECRET BODY", { status: 503 })),
		});
		expect(server).toMatchObject({ state: "unavailable" });
		expect((server as { message: string }).message).toContain("HTTP 503");
		expect(JSON.stringify(server)).not.toContain("SECRET BODY");
	});

	it("distinguishes invalid JSON, oversized responses, and changed contracts", async () => {
		const invalid = await probeUsage({
			inspect: async () => ready,
			fetchImpl: vi.fn(async () => new Response("not-json SECRET")),
		});
		expect(invalid).toMatchObject({ state: "contract-unknown" });
		expect(JSON.stringify(invalid)).not.toContain("SECRET");

		const oversized = await probeUsage({
			inspect: async () => ready,
			fetchImpl: vi.fn(async () => Response.json(usagePayload, { headers: { "content-length": "999" } })),
			maxResponseBytes: 100,
		});
		expect(oversized).toMatchObject({ state: "contract-unknown" });

		for (const changed of [
			{ changed: true },
			{ plan: "pro" }, // no usage windows
			{ session_usage: "5" }, // non-object window
			[1, 2, 3],
		]) {
			const result = await probeUsage({
				inspect: async () => ready,
				fetchImpl: vi.fn(async () => Response.json(changed)),
			});
			expect(result).toMatchObject({ state: "contract-unknown" });
		}
	});

	it("returns a normalized snapshot for a valid payload", async () => {
		const now = vi.fn(() => new Date("2026-08-17T12:00:00.000Z"));
		const result = await probeUsage({
			inspect: async () => ready,
			fetchImpl: successfulFetch(),
			now,
		});
		expect(result).toEqual({
			state: "ok",
			fetchedAt: "2026-08-17T12:00:00.000Z",
			snapshot: {
				session: { usedPercent: 16.1 },
				weekly: { usedPercent: 2.8 },
				fetchedAt: "2026-08-17T12:00:00.000Z",
			},
		});
	});

	it("still accepts the proposed session_usage/weekly_usage shape", async () => {
		const result = await probeUsage({
			inspect: async () => ready,
			fetchImpl: vi.fn(async () => Response.json(proposalPayload)),
		});
		expect(result).toMatchObject({
			state: "ok",
			snapshot: {
				plan: "pro",
				session: { usedPercent: 5, resetsIn: "5 hours" },
				weekly: { usedPercent: 50, resetsIn: "4 days" },
			},
		});
	});
});
