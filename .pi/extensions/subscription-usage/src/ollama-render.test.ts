import { describe, expect, it } from "vitest";
import { formatUsageText, sessionResetsIn, weeklyResetsIn } from "./ollama-render.ts";
import type { UsageSnapshot } from "./ollama-types.ts";

const local = (y: number, m: number, d: number, h: number, min: number): Date => new Date(y, m, d, h, min);

describe("session countdown (resets on the full hour)", () => {
	it("counts minutes to the next local full hour", () => {
		expect(sessionResetsIn(local(2026, 7, 17, 21, 20))).toBe("40 minutes");
		expect(sessionResetsIn(local(2026, 7, 17, 21, 1))).toBe("59 minutes");
		expect(sessionResetsIn(local(2026, 7, 17, 21, 59))).toBe("1 minute");
		expect(sessionResetsIn(local(2026, 7, 17, 23, 45))).toBe("15 minutes");
	});

	it("rolls to the next hour at the top of the hour", () => {
		expect(sessionResetsIn(local(2026, 7, 17, 21, 0))).toBe("1 hour");
		expect(sessionResetsIn(local(2026, 7, 17, 0, 0))).toBe("1 hour");
	});
});

describe("weekly countdown (resets at local Monday 00:00)", () => {
	it("counts days to the next local Monday", () => {
		expect(weeklyResetsIn(local(2026, 7, 17, 21, 20))).toBe("6 days"); // Monday
		expect(weeklyResetsIn(local(2026, 7, 18, 10, 0))).toBe("5 days"); // Tuesday 10:00
		expect(weeklyResetsIn(local(2026, 7, 20, 10, 0))).toBe("3 days"); // Thursday 10:00
		expect(weeklyResetsIn(local(2026, 7, 23, 23, 59))).toBe("1 day"); // Sunday 23:59
	});

	it("uses the full week from Monday midnight", () => {
		expect(weeklyResetsIn(local(2026, 7, 17, 0, 0))).toBe("7 days"); // Monday 00:00
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
		expect(text).toContain("Session usage: 16% used · resets in 40 minutes");
		expect(text).toContain("Weekly usage: 3% used · resets in 6 days");
		expect(text).not.toContain("(stale)");
	});

	it("prefers an explicit resets_in when present", () => {
		const text = formatUsageText({
			...snapshot,
			session: { usedPercent: 5, resetsIn: "5 hours" },
			weekly: { usedPercent: 50, resetsIn: "4 days" },
		}, local(2026, 7, 17, 21, 20));
		expect(text).toContain("Session usage: 5% used · resets in 5 hours");
		expect(text).toContain("Weekly usage: 50% used · resets in 4 days");
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
