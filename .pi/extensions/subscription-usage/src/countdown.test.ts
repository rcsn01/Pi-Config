import { describe, expect, it } from "vitest";
import { formatCountdown, formatDate, resetsInText } from "./countdown.ts";

describe("compact countdown format", () => {
	it("formats minutes, hours, and days in the web UI style", () => {
		expect(formatCountdown(40 * 60_000)).toBe("40m");
		expect(formatCountdown(59 * 60_000 + 30_000)).toBe("1h");
		expect(formatCountdown(60 * 60_000)).toBe("1h");
		expect(formatCountdown(2 * 3_600_000 + 45 * 60_000)).toBe("2h 45m");
		expect(formatCountdown(6 * 86_400_000)).toBe("6d");
		expect(formatCountdown(6 * 86_400_000 + 4 * 3_600_000)).toBe("6d 4h");
		expect(formatCountdown(7 * 86_400_000 + 4 * 3_600_000 + 30 * 60_000)).toBe("7d 4h");
	});

	it("never reports less than a minute", () => {
		expect(formatCountdown(500)).toBe("1m");
		expect(formatCountdown(-5_000)).toBe("1m");
	});
});

describe("reset date", () => {
	it("renders day and month abbreviation", () => {
		expect(formatDate(new Date(2026, 7, 24, 14, 30))).toBe("24 Aug");
		expect(formatDate(new Date(2026, 7, 17, 0, 0))).toBe("17 Aug");
	});
});

describe("resets in text", () => {
	it("combines the countdown and the reset date", () => {
		const now = new Date(2026, 7, 17, 10, 0);
		const at = new Date(2026, 7, 24, 14, 30);
		expect(resetsInText(at, now)).toBe("resets in 7d 4h on 24 Aug");
	});
});
