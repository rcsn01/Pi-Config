import { describe, expect, it } from "vitest";
import { normalizeThinkingLevel } from "./model-thinking.ts";

describe("normalizeThinkingLevel", () => {
	it("trims and lowercases valid levels", () => {
		expect(normalizeThinkingLevel(" HIGH ", { label: "advisor.thinkingLevel" })).toBe("high");
		expect(normalizeThinkingLevel("XHigh", { label: "x" })).toBe("xhigh");
		expect(normalizeThinkingLevel("off", { label: "x" })).toBe("off");
	});

	it.each([
		undefined,
		null,
		5,
		{},
		"",
		"  ",
		"turbo",
		"highish",
	])("rejects %s with the labeled vocabulary list", (value) => {
		expect(() => normalizeThinkingLevel(value, { label: "advisor.thinkingLevel" }))
			.toThrow("advisor.thinkingLevel must be one of: off, minimal, low, medium, high, xhigh, max.");
	});
});