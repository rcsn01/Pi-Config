import { describe, expect, it, vi } from "vitest";
import { makeFixtureKey } from "./fixture-key.ts";
import { createSubscriptionUsageExtension } from "./index.ts";
import { probeUsage } from "./ollama-client.ts";
import { normalizeUsage } from "./ollama-usage.ts";

const now = () => new Date("2026-08-17T12:00:00.000Z");
const payload = {
	included: {
		session: { remaining_percent: 75, resets_at: "2026-08-17T14:30:00Z" },
		weekly: { remaining_percent: 40, resets_at: "2026-08-20T12:00:00Z" },
	},
	purchased: { balance_usd: 25 },
	account_id: "SECRET_ACCOUNT",
};

describe("Ollama balance quota contract", () => {
	it("fetches balance and renders real quota percentages and resets through /usage ollama", async () => {
		const fixture = makeFixtureKey();
		const fetchImpl = vi.fn<typeof fetch>(async (url) => {
			expect(String(url)).toMatch(/^https:\/\/ollama\.com\/api\/balance\?ts=\d+$/);
			return Response.json(payload);
		});
		const commands = new Map<string, any>();
		const notify = vi.fn();
		createSubscriptionUsageExtension({
			now,
			probeOllama: (options) => probeUsage({
				...options, now, fetchImpl,
				inspect: async () => ({
					state: "ready", path: "/fixture", fileFound: true,
					credential: { pem: fixture.pem, path: "/fixture" },
				}),
			}),
		})({ registerCommand: (name: string, command: any) => commands.set(name, command) } as any);
		const ctx = { ui: { notify } } as any;
		for (const args of ["ollama", "ollama", "ollama refresh"]) {
			await commands.get("usage").handler(args, ctx);
			const [text, level] = notify.mock.lastCall!;
			expect(level).toBe("info");
			expect(text).toContain("Session usage:");
			expect(text).toContain(`25% used · resets in 2h 30m on ${new Date(payload.included.session.resets_at).getDate()} Aug`);
			expect(text).toContain("Weekly usage:");
			expect(text).toContain(`60% used · resets in 3d on ${new Date(payload.included.weekly.resets_at).getDate()} Aug`);
			expect(text).not.toContain("Requests");
			expect(text).not.toContain("not available");
		}
		expect(fetchImpl).toHaveBeenCalledTimes(2);
		expect(JSON.stringify(notify.mock.calls)).not.toContain("SECRET_ACCOUNT");
	});

	it("converts remaining to consumed and retains only real quota data", () => {
		expect(normalizeUsage(payload, now().toISOString())).toEqual({
			session: { usedPercent: 25, resetsAt: "2026-08-17T14:30:00.000Z" },
			weekly: { usedPercent: 60, resetsAt: "2026-08-20T12:00:00.000Z" },
			fetchedAt: now().toISOString(),
		});
	});

	it("handles empty and full remaining quota", () => {
		for (const remaining_percent of [0, 100]) {
			expect(normalizeUsage({ included: { session: {
				remaining_percent, resets_at: "2026-08-17T14:30:00Z",
			} } }, now().toISOString())).toMatchObject({ session: { usedPercent: 100 - remaining_percent } });
		}
	});

	it("rejects malformed quota and the request-count response", () => {
		for (const remaining_percent of [-1, 101, "75", null, Infinity]) {
			expect(normalizeUsage({ included: { session: {
				remaining_percent, resets_at: "2026-08-17T14:30:00Z",
			} } }, now().toISOString())).toBeUndefined();
		}
		for (const resets_at of [undefined, "bad", 123]) {
			expect(normalizeUsage({ included: { session: {
				remaining_percent: 75, resets_at,
			} } }, now().toISOString())).toBeUndefined();
		}
		expect(normalizeUsage({ range: "7d", scope: "self", totals: { request_count: 1234 } }, now().toISOString())).toBeUndefined();
	});
});
