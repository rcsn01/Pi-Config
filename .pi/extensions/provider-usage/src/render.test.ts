import { describe, expect, it } from "vitest";
import { formatQuotaText } from "./render.ts";
import type { QuotaSnapshot } from "./types.ts";

const snapshot: QuotaSnapshot = {
	plan: "Pro",
	session: { usedPercent: 16, windowMinutes: 300, resetsAt: new Date(2026, 7, 17, 15, 0).toISOString() },
	weekly: { usedPercent: 58, windowMinutes: 10_080, resetsAt: new Date(2026, 7, 24, 14, 30).toISOString() },
	resetCredits: { available: 1, applicable: 2 },
	fetchedAt: "2026-08-17T12:00:00.000Z",
};

describe("compact quota rendering", () => {
	it("renders plan, weekly limit with reset countdown and date, and reset credits", () => {
		const text = formatQuotaText(snapshot, new Date(2026, 7, 17, 10, 0));
		expect(text).toContain("ChatGPT Codex · Plan: Pro");
		expect(text).toContain("5-hour session limit: [███░░░░░░░░░░░░░░░░░] 16% used · resets in 5h on 17 Aug");
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

	it("accepts a caller-supplied provider label", () => {
		const text = formatQuotaText(snapshot, new Date(2026, 7, 17, 10, 0), "ChatGPT Codex · Slot: work");
		expect(text).toContain("ChatGPT Codex · Slot: work · Plan: Pro");
		expect(text).not.toContain("ChatGPT Codex · Plan: Pro");
	});

	it("shows unavailable rows when fields are absent", () => {
		const text = formatQuotaText(
			{ plan: undefined, session: undefined, weekly: undefined, resetCredits: undefined, fetchedAt: snapshot.fetchedAt },
			new Date("2026-08-17T10:00:00.000Z"),
		);
		expect(text).toBe("ChatGPT Codex\n5-hour session limit: unavailable\nWeekly limit: unavailable");
	});
});
