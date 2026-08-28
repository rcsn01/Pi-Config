import { describe, expect, it } from "vitest";
import type { Usage } from "@earendil-works/pi-ai";
import {
	advisorFailure,
	advisorSuccess,
	advisorWarning,
	classifyAdvisorToolResult,
	toAdvisorToolResult,
} from "./outcome.ts";

const usage: Usage = {
	input: 20,
	output: 10,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 30,
	cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 },
};

describe("Advisor execution outcome", () => {
	it("converts success without exposing its domain code", () => {
		const outcome = advisorSuccess("Use the narrow change.", "anthropic/strong", usage);
		expect(outcome).toMatchObject({
			disposition: "success",
			code: "advisor_ok",
			consumesBudget: true,
			truncated: false,
		});
		expect(toAdvisorToolResult(outcome)).toEqual({
			content: [{ type: "text", text: "Use the narrow change." }],
			details: { model: "anthropic/strong", consumesBudget: true, truncated: false },
			usage,
		});
	});

	it("converts truncation to a budget-consuming warning", () => {
		const result = toAdvisorToolResult(advisorWarning("Advice so far", "anthropic/strong", usage));
		expect(result).toEqual({
			content: [{ type: "text", text: "advisor_truncated: Advice so far" }],
			details: { model: "anthropic/strong", consumesBudget: true, truncated: true },
			usage,
		});
		expect(result).not.toHaveProperty("isError");
	});

	it("converts failures with their exact code, budget effect, and error flag", () => {
		const result = toAdvisorToolResult(advisorFailure(
			"advisor_provider_error",
			"unavailable",
			"anthropic/strong",
			true,
			usage,
		));
		expect(result).toEqual({
			content: [{ type: "text", text: "advisor_provider_error: unavailable" }],
			details: { model: "anthropic/strong", consumesBudget: true, truncated: false },
			usage,
			isError: true,
		});
	});

	it("keeps every transcript projection code in the closed failure vocabulary", () => {
		for (const projectionCode of [
			"missing_current_call",
			"parallel_tool_calls",
			"unsupported_modality",
			"context_too_large",
		] as const) {
			const code = `advisor_${projectionCode}` as const;
			expect(toAdvisorToolResult(advisorFailure(code, "projection failed", "anthropic/strong", false))).toEqual({
				content: [{ type: "text", text: `${code}: projection failed` }],
				details: { model: "anthropic/strong", consumesBudget: false, truncated: false },
				isError: true,
			});
		}
	});

	it("classifies current and legacy persisted results in compatibility order", () => {
		expect(classifyAdvisorToolResult({
			content: [{ type: "text", text: "advisor_truncated: partial" }],
			details: { model: "m", consumesBudget: true, truncated: true },
			isError: true,
		})).toBe("warning");
		expect(classifyAdvisorToolResult({
			content: [{ type: "text", text: "plain failure" }],
			details: { model: "m", consumesBudget: true, truncated: false },
			isError: true,
		})).toBe("failure");
		expect(classifyAdvisorToolResult({
			content: [{ type: "text", text: "advisor_provider_error: legacy" }],
			details: { model: "m", consumesBudget: false, truncated: false },
		})).toBe("failure");
		expect(classifyAdvisorToolResult({
			content: [{ type: "text", text: "Advice" }],
			details: { model: "m", consumesBudget: true, truncated: false },
		})).toBe("success");
	});
});
