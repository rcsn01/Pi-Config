import { describe, expect, it } from "vitest";
import { formatQuotaText, formatResetTimestamp } from "./render.ts";
import type { QuotaSnapshot } from "./types.ts";

const snapshot: QuotaSnapshot = {
	plan: "Pro",
	weekly: { usedPercent: 58, windowMinutes: 10_080, resetsAt: "2026-08-24T14:30:00.000Z" },
	resetCredits: { available: 1, applicable: 2 },
	fetchedAt: "2026-08-17T12:00:00.000Z",
};

describe("codex format_reset_timestamp port", () => {
	it("renders HH:MM when the reset falls on the same local day", () => {
		const now = new Date(2026, 7, 17, 10, 0); // local time
		expect(formatResetTimestamp(new Date(2026, 7, 17, 14, 30).toISOString(), now)).toBe("14:30");
	});

	it("renders 'HH:MM on %-d %b' for other days", () => {
		const now = new Date(2026, 7, 17, 10, 0);
		expect(formatResetTimestamp(new Date(2026, 7, 24, 14, 30).toISOString(), now)).toBe("14:30 on 24 Aug");
	});
});

describe("compact quota rendering", () => {
	it("renders plan, weekly limit with reset, and reset credits", () => {
		const text = formatQuotaText(snapshot, new Date("2026-08-17T10:00:00.000Z"));
		expect(text).toContain("ChatGPT Codex · Plan: Pro");
		expect(text).toContain("Weekly limit: [██████▱▱▱▱] 58% used");
		expect(text).toContain("resets ");
		expect(text).toContain("Rate-limit reset credits: 1 available · 2 applicable");
		expect(text).not.toContain("(stale)");
	});

	it("marks stale snapshots and shows applicable only when present", () => {
		const stale = formatQuotaText(snapshot, new Date("2026-08-17T12:30:00.000Z"));
		expect(stale).toContain("(stale)");

		const noApplicable = formatQuotaText({ ...snapshot, resetCredits: { available: 1 } }, new Date("2026-08-17T10:00:00.000Z"));
		expect(noApplicable).toContain("Rate-limit reset credits: 1 available");
		expect(noApplicable).not.toContain("applicable");
	});

	it("shows unavailable and omits rows when fields are absent", () => {
		const text = formatQuotaText(
			{ plan: undefined, weekly: undefined, resetCredits: undefined, fetchedAt: snapshot.fetchedAt },
			new Date("2026-08-17T10:00:00.000Z"),
		);
		expect(text).toBe("ChatGPT Codex\nWeekly limit: unavailable");
	});
});
