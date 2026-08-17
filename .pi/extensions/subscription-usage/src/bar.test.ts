import { describe, expect, it } from "vitest";
import { usageBar } from "./bar.ts";

describe("usage bar", () => {
	it("renders 10 segments with the filled share rounded to the nearest 10%", () => {
		expect(usageBar(0)).toBe("[░░░░░░░░░░]");
		expect(usageBar(5)).toBe("[█░░░░░░░░░]");
		expect(usageBar(16.2)).toBe("[██░░░░░░░░]");
		expect(usageBar(50)).toBe("[█████░░░░░]");
		expect(usageBar(58)).toBe("[██████░░░░]");
		expect(usageBar(100)).toBe("[██████████]");
	});

	it("clamps values outside 0-100", () => {
		expect(usageBar(-5)).toBe("[░░░░░░░░░░]");
		expect(usageBar(137)).toBe("[██████████]");
	});

	it("supports a custom width", () => {
		expect(usageBar(25, 20)).toBe(`[${String("█").repeat(5)}${String("░").repeat(15)}]`);
	});
});
