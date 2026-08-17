import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import type { CodexAnalyticsSnapshot } from "./analytics.ts";
import { AnalyticsComponent, formatAnalyticsText } from "./render.ts";

const metrics = {
	users: 1, threads: 2, turns: 3, credits: 4,
	uncachedInputTokens: 100, cachedInputTokens: 200, outputTokens: 50, totalTokens: 350,
};
const snapshot: CodexAnalyticsSnapshot = {
	startDate: "2026-08-11", endDate: "2026-08-17", fetchedAt: "2026-08-17T12:00:00Z", units: "credits",
	quota: {
		plan: "plus",
		rateLimits: [{ label: "Codex", allowed: true, primary: { usedPercent: 25, resetAt: "2026-08-18T00:00:00Z" } }],
		credits: { balance: 12.5, hasCredits: true, unlimited: false, approxCloudMessages: [20, 40], approxLocalMessages: [] },
		spendLimitReached: false,
	},
	dailyWorkspace: [{
		date: "2026-08-17", totals: metrics,
		clients: [{ name: "cli", ...metrics }],
		models: [{ name: "gpt-5.4", ...metrics }],
	}],
	dailyTokens: [{ date: "2026-08-17", surfaces: { cli: 4 }, models: [{ model: "gpt-5.4", credits: 4 }] }],
	dailySkills: [{ date: "2026-08-17", items: [{ name: "review", displayName: "Code review", invocations: 2 }] }],
	dailyPlugins: [],
	creditEvents: [{ date: "2026-08-17", type: "usage", credits: 4 }],
};
const theme = new Proxy({}, {
	get: () => (_colorOrText: string, maybeText?: string) => maybeText ?? _colorOrText,
}) as Theme;

describe("Codex analytics rendering", () => {
	it("renders every analytics section in text output", () => {
		const text = formatAnalyticsText(snapshot);
		for (const expected of [
			"Plan: plus", "25% used", "Period totals", "Input tokens: 100 uncached · 200 cached",
			"gpt-5.4", "gpt-5.4: 3 turns", "gpt-5.4: 4", "cli", "Product surfaces (credits)", "Code review: 2 invocations",
			"Plugins:\n  None", "2026-08-17: 3 turns", "usage · 4 credits",
		]) expect(text).toContain(expected);
	});

	it("bounds every component line and closes on supported keys", () => {
		const close = vi.fn();
		const component = new AnalyticsComponent(snapshot, theme, close);
		for (const width of [20, 50, 100]) {
			const lines = component.render(width);
			expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
			component.invalidate();
		}
		component.handleInput("\x1b");
		expect(close).toHaveBeenCalledOnce();
	});
});
