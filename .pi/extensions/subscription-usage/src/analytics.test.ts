import { describe, expect, it } from "vitest";
import {
	invocationTotals,
	normalizeCodexAnalytics,
	totalWorkspaceUsage,
	usageByClient,
	usageByModel,
	usageBySurface,
} from "./analytics.ts";
import type { AnalyticsProbeResult } from "./types.ts";

function result(overrides: Partial<Extract<AnalyticsProbeResult, { state: "ok" }>> = {}): Extract<AnalyticsProbeResult, { state: "ok" }> {
	return {
		state: "ok",
		fetchedAt: "2026-08-17T12:30:00.000Z",
		startDate: "2026-08-11",
		endDate: "2026-08-17",
		endpoints: [],
		payloads: {
			quota: {
				user_id: "SECRET_USER", account_id: "SECRET_ACCOUNT", email: "secret@example.com",
				plan_type: "plus",
				rate_limit: {
					allowed: true, limit_reached: false,
					primary_window: { used_percent: 25.5, limit_window_seconds: 18_000, reset_at: 1_786_982_400 },
				},
				credits: { balance: "12.5", has_credits: true, unlimited: false, overage_limit_reached: false },
				spend_control: { reached: false },
			},
			tokens: {
				units: "credits", group_by: "day",
				data: [{
					date: "2026-08-17",
					product_surface_usage_values: { cli: 8, vscode: 2 },
					models: [{ model: "gpt-5.4", speed: "fast", credits: 10 }],
				}],
			},
			workspace: {
				group_by: "day",
				data: [{
					date: "2026-08-17",
					totals: {
						users: 1, threads: 2, turns: 4, credits: 10,
						uncached_text_input_tokens: 100, cached_text_input_tokens: 200,
						text_output_tokens: 50, text_total_tokens: 350,
					},
					clients: [{ client_id: "cli", turns: 4, credits: 10, text_total_tokens: 350 }],
					models: [{ model: "gpt-5.4", users: 1, threads: 2, turns: 4, credits: 10 }],
				}],
			},
			skills: {
				data_freshness_ts: "2026-08-17T12:00:00Z",
				data: [{ date: "2026-08-17", skill_usage_overviews: [
					{ skill_name: "review", display_name: "Code review", skill_ids: ["SECRET_ID"], invocation_counts: 3 },
				] }],
			},
			plugins: {
				data: [{ date: "2026-08-17", plugin_usage_overviews: [
					{ plugin_name: "linear", display_name: "Linear", plugin_ids: ["SECRET_PLUGIN_ID"], invocation_counts: 2 },
				] }],
			},
			credits: { data: [{ event_type: "usage", credit_amount: 4, account_id: "SECRET_ACCOUNT" }] },
		},
		...overrides,
	};
}

describe("Codex analytics normalization", () => {
	it("normalizes every captured analytics section without identity fields", () => {
		const snapshot = normalizeCodexAnalytics(result())!;
		expect(snapshot).toMatchObject({
			startDate: "2026-08-11", endDate: "2026-08-17", units: "credits",
			quota: {
				plan: "plus",
				rateLimits: [{ label: "Codex", allowed: true, primary: { usedPercent: 25.5, windowSeconds: 18_000 } }],
				credits: { balance: 12.5, hasCredits: true },
			},
			dailyWorkspace: [{
				date: "2026-08-17",
				totals: {
					users: 1, threads: 2, turns: 4, credits: 10,
					uncachedInputTokens: 100, cachedInputTokens: 200, outputTokens: 50, totalTokens: 350,
				},
			}],
			dailyTokens: [{ date: "2026-08-17", surfaces: { cli: 8, vscode: 2 } }],
			dailySkills: [{ date: "2026-08-17", items: [{ name: "review", displayName: "Code review", invocations: 3 }] }],
			dailyPlugins: [{ date: "2026-08-17", items: [{ name: "linear", displayName: "Linear", invocations: 2 }] }],
			creditEvents: [{ type: "usage", credits: 4 }],
		});
		const serialized = JSON.stringify(snapshot);
		for (const secret of ["SECRET_USER", "SECRET_ACCOUNT", "secret@example.com", "SECRET_ID", "SECRET_PLUGIN_ID"]) {
			expect(serialized).not.toContain(secret);
		}
	});

	it("aggregates workspace, model, client, surface, skill, and plugin usage", () => {
		const base = result();
		(base.payloads.workspace as any).data.push({
			date: "2026-08-16",
			totals: { threads: 1, turns: 2, credits: 5, text_total_tokens: 100 },
			clients: [{ client_id: "cli", turns: 2, credits: 5 }],
			models: [{ model: "gpt-5.4", threads: 1, turns: 2, credits: 5 }],
		});
		(base.payloads.tokens as any).data.push({
			date: "2026-08-16", product_surface_usage_values: { cli: 5 }, models: [],
		});
		const snapshot = normalizeCodexAnalytics(base)!;
		expect(totalWorkspaceUsage(snapshot)).toMatchObject({ threads: 3, turns: 6, credits: 15, totalTokens: 450 });
		expect(usageByModel(snapshot)[0]).toMatchObject({ name: "gpt-5.4", threads: 3, turns: 6, credits: 15 });
		expect(usageByClient(snapshot)[0]).toMatchObject({ name: "cli", turns: 6, credits: 15 });
		expect(usageBySurface(snapshot)).toEqual([{ name: "cli", credits: 13 }, { name: "vscode", credits: 2 }]);
		expect(invocationTotals(snapshot.dailySkills)).toEqual([{ name: "review", displayName: "Code review", invocations: 3 }]);
		expect(invocationTotals(snapshot.dailyPlugins)).toEqual([{ name: "linear", displayName: "Linear", invocations: 2 }]);
	});

	it("drops malformed values and returns no snapshot for a failed probe", () => {
		const malformed = result();
		malformed.payloads.workspace = { data: [
			{ date: "invalid", totals: { turns: Infinity } },
			{ date: "2026-08-17", totals: { turns: -2, credits: "NaN" }, clients: [{ client_id: null }], models: [] },
		] };
		const snapshot = normalizeCodexAnalytics(malformed)!;
		expect(snapshot.dailyWorkspace).toHaveLength(1);
		expect(snapshot.dailyWorkspace[0]?.totals.turns).toBe(0);
		expect(snapshot.dailyWorkspace[0]?.clients).toEqual([]);
		expect(normalizeCodexAnalytics({ state: "unavailable", message: "no", endpoints: [] })).toBeUndefined();
	});
});
