import { describe, expect, it } from "vitest";
import { usageBar } from "./bar.ts";

const filled = (n: number): string => String("█").repeat(n);
const empty = (n: number): string => String("░").repeat(n);
const bar = (n: number): string => `[${filled(n)}${empty(20 - n)}]`;

describe("usage bar", () => {
	it("renders 20 segments with the filled share rounded to the nearest 5%", () => {
		expect(usageBar(0)).toBe(bar(0));
		expect(usageBar(2.9)).toBe(bar(1));
		expect(usageBar(5)).toBe(bar(1));
		expect(usageBar(16.2)).toBe(bar(3));
		expect(usageBar(50)).toBe(bar(10));
		expect(usageBar(58)).toBe(bar(12));
		expect(usageBar(100)).toBe(bar(20));
	});

	it("clamps values outside 0-100", () => {
		expect(usageBar(-5)).toBe(bar(0));
		expect(usageBar(137)).toBe(bar(20));
	});

	it("supports a custom width", () => {
		expect(usageBar(25, 10)).toBe(`[${filled(3)}${empty(7)}]`);
		expect(usageBar(25, 20)).toBe(`[${filled(5)}${empty(15)}]`);
	});
});
