import { describe, expect, it } from "vitest";
import { isUsageStale, normalizeUsage } from "./usage.ts";

describe("usage snapshot normalization", () => {
	it("normalizes session and weekly windows with percentages and resets_in", () => {
		const snapshot = normalizeUsage({
			user_id: "SECRET_USER",
			plan: "pro",
			session_usage: { percentage: 5, resets_in: "5 hours" },
			weekly_usage: { percentage: 50, resets_in: "4 days" },
		}, "2026-08-17T12:00:00.000Z")!;

		expect(snapshot).toEqual({
			plan: "pro",
			session: { usedPercent: 5, resetsIn: "5 hours" },
			weekly: { usedPercent: 50, resetsIn: "4 days" },
			fetchedAt: "2026-08-17T12:00:00.000Z",
		});
		expect(JSON.stringify(snapshot)).not.toContain("SECRET_USER");
	});

	it("tolerates numeric-string percentages and omits absent resets_in", () => {
		const snapshot = normalizeUsage({
			weekly_usage: { percentage: "42.5" },
		}, "2026-08-17T12:00:00.000Z")!;
		expect(snapshot.weekly).toEqual({ usedPercent: 42.5 });
		expect(snapshot.session).toBeUndefined();
		expect(snapshot.plan).toBeUndefined();
	});

	it("normalizes the live limits contract (usage fractions) without carrying models", () => {
		const snapshot = normalizeUsage({
			activity: { cost: "0.00000", period: { type: "last_4_weeks" }, models: [] },
			limits: {
				session: { usage: 0.161, models: [{ name: "deepseek-v4-flash:0731", request_count: 640 }] },
				weekly: { usage: 0.028, models: [{ name: "deepseek-v4-flash:0731", request_count: 640 }] },
			},
		}, "2026-08-17T12:00:00.000Z")!;

		expect(snapshot).toEqual({
			session: { usedPercent: 16.1 },
			weekly: { usedPercent: 2.8 },
			fetchedAt: "2026-08-17T12:00:00.000Z",
		});
		expect(JSON.stringify(snapshot)).not.toContain("deepseek");
		expect(JSON.stringify(snapshot)).not.toContain("SECRET");
	});

	it("treats usage values above 1 as already-percentages defensively", () => {
		const snapshot = normalizeUsage({
			limits: { weekly: { usage: 42 } },
		}, "2026-08-17T12:00:00.000Z")!;
		expect(snapshot.weekly).toEqual({ usedPercent: 42 });
	});

	it("omits rows for windows that lack a usable percentage", () => {
		const snapshot = normalizeUsage({
			plan: "pro",
			session_usage: { percentage: "n/a", resets_in: "5 hours" },
			weekly_usage: { percentage: -3 },
		}, "2026-08-17T12:00:00.000Z");
		expect(snapshot).toBeUndefined();
	});

	it("returns undefined when no usage window is present", () => {
		expect(normalizeUsage({ plan: "pro" }, "2026-08-17T12:00:00.000Z")).toBeUndefined();
		expect(normalizeUsage({}, "2026-08-17T12:00:00.000Z")).toBeUndefined();
		expect(normalizeUsage("nope", "2026-08-17T12:00:00.000Z")).toBeUndefined();
		expect(normalizeUsage([1, 2], "2026-08-17T12:00:00.000Z")).toBeUndefined();
	});
});

describe("usage snapshot staleness", () => {
	const fetchedAt = "2026-08-17T12:00:00.000Z";

	it("is fresh within 15 minutes and stale after", () => {
		expect(isUsageStale(fetchedAt, new Date("2026-08-17T12:14:59.000Z"))).toBe(false);
		expect(isUsageStale(fetchedAt, new Date("2026-08-17T12:15:00.000Z"))).toBe(false);
		expect(isUsageStale(fetchedAt, new Date("2026-08-17T12:15:01.000Z"))).toBe(true);
		expect(isUsageStale(fetchedAt, new Date("2026-08-17T13:00:00.000Z"))).toBe(true);
	});

	it("treats an unparsable fetch time as stale", () => {
		expect(isUsageStale("not-a-date", new Date("2026-08-17T12:15:00.000Z"))).toBe(true);
	});
});
