import { describe, expect, it } from "vitest";
import { formatQuotaText } from "./render.ts";
import type { QuotaSnapshot } from "./types.ts";

const snapshot: QuotaSnapshot = {
	plan: "Pro",
	weekly: { usedPercent: 58, windowMinutes: 10_080, resetsAt: new Date(2026, 7, 24, 14, 30).toISOString() },
	resetCredits: { available: 1, applicable: 2 },
	fetchedAt: "2026-08-17T12:00:00.000Z",
};

describe("compact quota rendering", () => {
	it("renders plan, weekly limit with reset countdown and date, and reset credits", () => {
		const text = formatQuotaText(snapshot, new Date(2026, 7, 17, 10, 0));
		expect(text).toContain("ChatGPT Codex · Plan: Pro");
		expect(text).toContain("Weekly limit: [████████████░░░░░░░░] 58% used · resets in 7d 4h on 24 Aug");
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
