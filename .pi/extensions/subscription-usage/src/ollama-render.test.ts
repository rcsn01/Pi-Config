import { describe, expect, it } from "vitest";
import { formatUsageText, sessionResetAt, sessionResetsIn, weeklyResetAt, weeklyResetsIn } from "./ollama-render.ts";
import type { UsageSnapshot } from "./ollama-types.ts";

const local = (y: number, m: number, d: number, h: number, min: number): Date => new Date(y, m, d, h, min);

describe("session reset (on the full hour)", () => {
	it("counts to the next local full hour with its date", () => {
		expect(sessionResetAt(local(2026, 7, 17, 21, 20)).getHours()).toBe(22);
		expect(sessionResetsIn(local(2026, 7, 17, 21, 20))).toBe("resets in 40m on 17 Aug");
		expect(sessionResetsIn(local(2026, 7, 17, 21, 1))).toBe("resets in 59m on 17 Aug");
		expect(sessionResetsIn(local(2026, 7, 17, 21, 59))).toBe("resets in 1m on 17 Aug");
		expect(sessionResetsIn(local(2026, 7, 17, 23, 45))).toBe("resets in 15m on 18 Aug");
	});

	it("rolls to the next hour at the top of the hour", () => {
		expect(sessionResetsIn(local(2026, 7, 17, 21, 0))).toBe("resets in 1h on 17 Aug");
		expect(sessionResetsIn(local(2026, 7, 17, 0, 0))).toBe("resets in 1h on 17 Aug");
	});
});

describe("weekly reset (anchored to the API period start)", () => {
	const anchor = "2026-07-27T00:00:00.000Z"; // Monday 00:00 UTC

	it("counts to the next 7-day boundary from the anchor with its date", () => {
		expect(weeklyResetsIn(new Date("2026-08-17T11:20:00.000Z"), anchor)).toBe("resets in 6d 12h on 24 Aug"); // Monday
		expect(weeklyResetsIn(new Date("2026-08-18T10:00:00.000Z"), anchor)).toBe("resets in 5d 14h on 24 Aug"); // Tuesday
		expect(weeklyResetsIn(new Date("2026-08-20T10:00:00.000Z"), anchor)).toBe("resets in 3d 14h on 24 Aug"); // Thursday
		expect(weeklyResetsIn(new Date("2026-08-23T23:59:00.000Z"), anchor)).toBe("resets in 1m on 24 Aug"); // Sunday
	});

	it("follows a non-Monday anchor and rolls over at the boundary", () => {
		const wednesday = "2026-07-29T00:00:00.000Z";
		expect(weeklyResetAt(new Date("2026-08-17T11:20:00.000Z"), wednesday).toISOString()).toBe("2026-08-19T00:00:00.000Z");
		expect(weeklyResetsIn(new Date("2026-08-17T11:20:00.000Z"), wednesday)).toBe("resets in 1d 12h on 19 Aug");
		expect(weeklyResetsIn(new Date("2026-08-19T00:00:00.000Z"), wednesday)).toBe("resets in 7d on 26 Aug"); // at the boundary
	});

	it("falls back to local Monday 00:00 without an anchor", () => {
		expect(weeklyResetsIn(local(2026, 7, 17, 21, 20))).toBe("resets in 6d 2h on 24 Aug"); // Monday
		expect(weeklyResetsIn(local(2026, 7, 18, 10, 0))).toBe("resets in 5d 14h on 24 Aug"); // Tuesday 10:00
		expect(weeklyResetsIn(local(2026, 7, 20, 10, 0))).toBe("resets in 3d 14h on 24 Aug"); // Thursday 10:00
		expect(weeklyResetsIn(local(2026, 7, 23, 23, 59))).toBe("resets in 1m on 24 Aug"); // Sunday 23:59
	});

	it("uses the full week from the boundary instant", () => {
		expect(weeklyResetAt(new Date("2026-07-27T00:00:00.000Z"), anchor).toISOString()).toBe("2026-08-03T00:00:00.000Z");
		expect(weeklyResetsIn(new Date("2026-07-27T00:00:00.000Z"), anchor)).toBe("resets in 7d on 3 Aug");
		expect(weeklyResetsIn(local(2026, 7, 17, 0, 0))).toBe("resets in 7d on 24 Aug"); // Monday 00:00, fallback
	});
});

describe("ollama usage rendering with countdowns", () => {
	const snapshot: UsageSnapshot = {
		session: { usedPercent: 16.2 },
		weekly: { usedPercent: 2.9 },
		fetchedAt: "2026-08-17T12:00:00.000Z",
	};

	it("renders computed countdowns for the live contract", () => {
		const text = formatUsageText(snapshot, local(2026, 7, 17, 21, 20));
		expect(text).toContain("Session usage: [███░░░░░░░░░░░░░░░░░] 16% used · resets in 40m on 17 Aug");
		expect(text).toContain("Weekly usage: [█░░░░░░░░░░░░░░░░░░░] 3% used · resets in 6d 2h on 24 Aug");
		expect(text).not.toContain("(stale)");
	});

	it("computes the weekly countdown from the snapshot anchor", () => {
		const text = formatUsageText(
			{ ...snapshot, weekStartsAt: "2026-07-27T00:00:00.000Z" },
			new Date("2026-08-17T11:20:00.000Z"),
		);
		expect(text).toContain("Weekly usage: [█░░░░░░░░░░░░░░░░░░░] 3% used · resets in 6d 12h on 24 Aug");
	});

	it("prefers an explicit resets_in when present", () => {
		const text = formatUsageText({
			...snapshot,
			session: { usedPercent: 5, resetsIn: "5 hours" },
			weekly: { usedPercent: 50, resetsIn: "4 days" },
		}, local(2026, 7, 17, 21, 20));
		expect(text).toContain("Session usage: [█░░░░░░░░░░░░░░░░░░░] 5% used · resets in 5 hours");
		expect(text).toContain("Weekly usage: [██████████░░░░░░░░░░] 50% used · resets in 4 days");
	});

	it("marks stale snapshots and omits absent rows", () => {
		const stale = formatUsageText(snapshot, new Date("2026-08-17T12:30:00.000Z"));
		expect(stale).toContain("(stale)");

		const bare = formatUsageText(
			{ fetchedAt: snapshot.fetchedAt },
			local(2026, 7, 17, 21, 20),
		);
		expect(bare).toBe("Ollama Cloud");
	});
});
