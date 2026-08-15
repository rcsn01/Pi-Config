import { describe, expect, it } from "vitest";
import {
	discardAssistantMessage,
	extractAssistantText,
	extractLegacyCustomMessageContent,
	extractProposedPlan,
	isAmbiguousPlanAcceptance,
	isDuplicatePlanText,
	jaccardSimilarity,
	normalizeComparableText,
	planSignature,
	replaceAssistantText,
	replaceProposedPlanBlocks,
} from "./plan-content.ts";

describe("proposed-plan content", () => {
	it("extracts assistant text and chooses the last complete plan block", () => {
		const text = "before <proposed_plan>old</proposed_plan> middle <proposed_plan>final</proposed_plan> trailing <proposed_plan>open";
		expect(extractAssistantText({ content: [
			{ type: "text", text: text.slice(0, 20) },
			{ type: "toolCall", name: "read" },
			{ type: "text", text: text.slice(20) },
		] })).toBe(text);
		expect(extractProposedPlan(text)).toBe("final");
		expect(extractProposedPlan("<proposed_plan>unfinished")).toBeUndefined();
	});

	it("normalizes all complete blocks to the authoritative plan", () => {
		expect(replaceProposedPlanBlocks(
			"Intro\n<proposed_plan>old</proposed_plan>\n\n\n<proposed_plan>final</proposed_plan>\nOutro",
			"final",
		)).toBe("Intro\n\nfinal\nOutro");
	});

	it("replaces assistant text while retaining non-text parts", () => {
		const toolCall = { type: "toolCall", id: "one", name: "read" };
		const result = replaceAssistantText({
			role: "assistant",
			content: [{ type: "text", text: "old" }, toolCall, { type: "text", text: "also old" }],
		}, "normalized");
		expect(result.content).toEqual([{ type: "text", text: "normalized" }, toolCall]);
	});

	it("discards every stale response part including tool calls", () => {
		const result = discardAssistantMessage({
			role: "assistant",
			content: [
				{ type: "text", text: "stale" },
				{ type: "toolCall", id: "danger", name: "write", arguments: {} },
			],
		});
		expect(result.content).toEqual([{
			type: "text",
			text: expect.stringContaining("runtime mode changed"),
		}]);
	});

	it("creates stable signatures and normalizes comparable text", () => {
		expect(planSignature("same")).toBe(planSignature("same"));
		expect(planSignature("same")).not.toBe(planSignature("different"));
		expect(normalizeComparableText("<proposed_plan>\n# Hello, WORLD!\n</proposed_plan>"))
			.toBe("hello world");
		expect(jaccardSimilarity("alpha beta gamma", "alpha beta delta")).toBeCloseTo(0.5);
	});

	it("detects exact, tagged, and sufficiently similar long duplicate plans", () => {
		const plan = Array.from({ length: 100 }, (_, index) => `step ${index} implementation detail`).join(" ");
		expect(isDuplicatePlanText(plan, plan)).toBe(true);
		expect(isDuplicatePlanText(`<proposed_plan>${plan}</proposed_plan>`, plan)).toBe(true);
		expect(isDuplicatePlanText(`${plan} additional`, plan)).toBe(true);
		expect(isDuplicatePlanText("please change the API", plan)).toBe(false);
	});

	it.each(["continue", "OK", "go ahead", "implement", "ship it"])(
		"recognizes ambiguous acceptance: %s",
		(input) => expect(isAmbiguousPlanAcceptance(input)).toBe(true),
	);

	it("extracts legacy custom-message text content", () => {
		expect(extractLegacyCustomMessageContent([
			{ type: "text", text: "first" },
			{ type: "image", data: "ignored" },
			{ type: "text", text: "second" },
		])).toBe("first\nsecond");
	});
});
