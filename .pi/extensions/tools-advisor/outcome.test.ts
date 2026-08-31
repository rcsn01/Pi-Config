import { describe, expect, it } from "vitest";
import type { Usage } from "@earendil-works/pi-ai";
import {
	advisorFailure,
	advisorSuccess,
	classifyAdvisorToolResult,
	toAdvisorToolResult,
} from "./outcome.ts";

const usage: Usage = {
	input: 20, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 30,
	cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 },
};

describe("advisor outcomes", () => {
	it("converts successful advice", () => {
		expect(toAdvisorToolResult(advisorSuccess("Use the narrow change.", "anthropic/strong", usage))).toEqual({
			content: [{ type: "text", text: "Use the narrow change." }],
			details: { model: "anthropic/strong", truncated: false },
			usage,
		});
	});

	it("marks truncated success as a warning", () => {
		const result = toAdvisorToolResult(advisorSuccess("Partial advice", "anthropic/strong", usage, true));
		expect(result.details.truncated).toBe(true);
		expect(result).not.toHaveProperty("isError");
		expect(classifyAdvisorToolResult(result)).toBe("warning");
	});

	it("converts failures without exposing an error taxonomy", () => {
		const result = toAdvisorToolResult(advisorFailure("Provider unavailable", "anthropic/strong", usage));
		expect(result).toEqual({
			content: [{ type: "text", text: "Provider unavailable" }],
			details: { model: "anthropic/strong", truncated: false },
			usage,
			isError: true,
		});
	});

	it("still recognizes legacy persisted failure text", () => {
		expect(classifyAdvisorToolResult({ content: [{ type: "text", text: "advisor_provider_error: old" }] })).toBe("failure");
	});
});
