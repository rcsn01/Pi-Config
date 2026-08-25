import { describe, expect, it } from "vitest";
import { ANALYSIS_PAGE } from "./page.ts";

describe("analysis page", () => {
	it("is dependency-free and inserts captured values with textContent", () => {
		expect(ANALYSIS_PAGE).not.toMatch(/<script[^>]+src=/i);
		expect(ANALYSIS_PAGE).not.toMatch(/<link[^>]+href=/i);
		expect(ANALYSIS_PAGE).not.toMatch(/https?:\/\//i);
		expect(ANALYSIS_PAGE).toContain("textContent");
		expect(ANALYSIS_PAGE).not.toContain("innerHTML");
		expect(ANALYSIS_PAGE).toContain("Estimated cache-prefix placement");
		expect(ANALYSIS_PAGE).toContain("Structured logical request");
		const script = ANALYSIS_PAGE.match(/<script>([\s\S]*)<\/script>/)?.[1];
		expect(() => new Function(script!)).not.toThrow();
	});
});
