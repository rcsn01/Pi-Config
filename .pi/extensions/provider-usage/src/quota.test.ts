import { describe, expect, it } from "vitest";
import {
	getLimitsDuration,
	normalizeQuota,
	planTypeDisplayName,
	selectWeeklyWindow,
	windowMinutesFromSeconds,
} from "./quota.ts";
import type { QuotaWindow } from "./types.ts";

describe("quota window labeling (codex get_limits_duration port)", () => {
	it.each([
		[300, "5h"],
		[1_440, "daily"],
		[10_080, "weekly"],
		[43_200, "monthly"],
		[525_600, "annual"],
	])("labels %i minutes as %s", (minutes, label) => {
		expect(getLimitsDuration(minutes)).toBe(label);
	});

	it("accepts windows within the ±5% tolerance", () => {
		expect(getLimitsDuration(9_576)).toBe("weekly"); // 10080 * 0.95
		expect(getLimitsDuration(10_584)).toBe("weekly"); // 10080 * 1.05
	});

	it("rejects windows outside the tolerance and non-positive durations", () => {
		expect(getLimitsDuration(9_000)).toBeUndefined();
		expect(getLimitsDuration(-60)).toBeUndefined();
		expect(getLimitsDuration(0)).toBeUndefined();
	});

	it("converts seconds to a ceiling of minutes (codex window_minutes_from_seconds port)", () => {
		expect(windowMinutesFromSeconds(604_800)).toBe(10_080);
		expect(windowMinutesFromSeconds(18_001)).toBe(301);
		expect(windowMinutesFromSeconds(0)).toBeUndefined();
		expect(windowMinutesFromSeconds(-5)).toBeUndefined();
		expect(windowMinutesFromSeconds("604800")).toBe(10_080);
	});
});

describe("weekly window selection (codex weekly_status_window port)", () => {
	const weekly: QuotaWindow = { usedPercent: 58, windowMinutes: 10_080, resetsAt: "2026-08-24T14:30:00.000Z" };
	const daily: QuotaWindow = { usedPercent: 20, windowMinutes: 1_440 };
	const secondary: QuotaWindow = { usedPercent: 30, windowMinutes: 300 };

	it("prefers a weekly-labeled primary window", () => {
		expect(selectWeeklyWindow(weekly, daily)).toBe(weekly);
	});

	it("prefers a weekly-labeled secondary window over a non-weekly primary", () => {
		expect(selectWeeklyWindow(daily, weekly)).toBe(weekly);
	});

	it("falls back to the secondary window when nothing is labeled weekly", () => {
		expect(selectWeeklyWindow(daily, secondary)).toBe(secondary);
		expect(selectWeeklyWindow(undefined, secondary)).toBe(secondary);
	});

	it("is unavailable when no windows exist or the fallback is missing", () => {
		expect(selectWeeklyWindow(undefined, undefined)).toBeUndefined();
		expect(selectWeeklyWindow(daily, undefined)).toBeUndefined();
	});

	it("does not match a window without a known duration", () => {
		const noDuration: QuotaWindow = { usedPercent: 58 };
		expect(selectWeeklyWindow(noDuration, undefined)).toBeUndefined();
		expect(selectWeeklyWindow(noDuration, noDuration)).toBe(noDuration); // secondary fallback still applies
	});
});

describe("plan display names (codex plan_type_display_name port)", () => {
	it.each([
		["team", "Business"],
		["self_serve_business_prolite", "Business"],
		["self_serve_business_usage_based", "Business"],
		["business", "Enterprise"],
		["enterprise_cbp_usage_based", "Enterprise"],
		["ent26", "Enterprise"],
		["enterprise_cbp_automation", "Enterprise (Automation)"],
		["pro_lite", "Pro Lite"],
	])("remaps %s to %s", (raw, expected) => {
		expect(planTypeDisplayName(raw)).toBe(expected);
	});

	it("title-cases unknown raw values", () => {
		expect(planTypeDisplayName("plus")).toBe("Plus");
		expect(planTypeDisplayName("pro")).toBe("Pro");
		expect(planTypeDisplayName("free")).toBe("Free");
		expect(planTypeDisplayName("edu")).toBe("Edu");
		expect(planTypeDisplayName("enterprise")).toBe("Enterprise");
	});
});

describe("quota payload normalization", () => {
	it("normalizes plan, weekly window, and reset credits from the usage payload", () => {
		const snapshot = normalizeQuota({
			user_id: "SECRET_USER",
			plan_type: "team",
			rate_limit: {
				primary_window: { used_percent: 58, limit_window_seconds: 604_800, reset_at: 1_787_581_800 },
				secondary_window: { used_percent: 20, limit_window_seconds: 18_000 },
			},
			rate_limit_reset_credits: { available_count: 1, applicable_available_count: 2 },
		}, "2026-08-17T12:00:00.000Z")!;

		expect(snapshot).toEqual({
			plan: "Business",
			weekly: { usedPercent: 58, windowMinutes: 10_080, resetsAt: "2026-08-24T14:30:00.000Z" },
			resetCredits: { available: 1, applicable: 2 },
			fetchedAt: "2026-08-17T12:00:00.000Z",
		});
		expect(JSON.stringify(snapshot)).not.toContain("SECRET_USER");
	});

	it("omits reset credits when the field is absent and applicable when absent", () => {
		const none = normalizeQuota({
			plan_type: "plus",
			rate_limit: { primary_window: { used_percent: 10 } },
		}, "2026-08-17T12:00:00.000Z")!;
		expect(none.resetCredits).toBeUndefined();

		const noApplicable = normalizeQuota({
			plan_type: "plus",
			rate_limit: { primary_window: { used_percent: 10 } },
			rate_limit_reset_credits: { available_count: 3 },
		}, "2026-08-17T12:00:00.000Z")!;
		expect(noApplicable.resetCredits).toEqual({ available: 3 });
	});

	it("marks the weekly limit unavailable without a weekly-labeled or secondary window", () => {
		const snapshot = normalizeQuota({
			plan_type: "plus",
			rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 300 } },
		}, "2026-08-17T12:00:00.000Z")!;
		expect(snapshot.weekly).toBeUndefined();
	});

	it("returns undefined for payloads missing the required contract fields", () => {
		expect(normalizeQuota({ plan_type: "plus" }, "2026-08-17T12:00:00.000Z")).toBeUndefined();
		expect(normalizeQuota({ rate_limit: {} }, "2026-08-17T12:00:00.000Z")).toBeUndefined();
		expect(normalizeQuota("nope", "2026-08-17T12:00:00.000Z")).toBeUndefined();
	});
});
