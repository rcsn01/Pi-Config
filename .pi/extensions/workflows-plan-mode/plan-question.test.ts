import { describe, expect, it, vi } from "vitest";
import { createPlanQuestionTool } from "./plan-question.ts";

function theme() {
	return {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	} as any;
}

function context(mode: "tui" | "print" = "tui") {
	return {
		mode,
		ui: { select: vi.fn() },
	} as any;
}

const question = {
	id: "scope",
	question: "Which scope?",
	options: [
		{ label: "Small", description: "Change one module" },
		{ label: "Large", description: "Change all modules" },
	],
	recommended: "Small",
};

describe("plan_question", () => {
	it("keeps registered schema and prompt metadata", () => {
		const tool = createPlanQuestionTool(() => true);
		expect(tool).toMatchObject({
			name: "plan_question",
			label: "Plan Question",
			description: expect.stringContaining("Ask the user 1-3"),
			promptSnippet: "Ask planning questions",
		});
		expect((tool.parameters as any).properties.questions.description)
			.toBe("One to three multiple-choice clarification questions");
	});

	it("rejects inactive and non-TUI execution", async () => {
		const inactive = createPlanQuestionTool(() => false);
		const inactiveResult = await inactive.execute("call", { questions: [question] }, undefined, undefined, context());
		expect(inactiveResult).toMatchObject({ isError: true, details: { answers: [], cancelled: true } });
		expect(inactiveResult.content[0]).toMatchObject({ text: expect.stringContaining("only available in Plan Mode") });

		const nonTui = createPlanQuestionTool(() => true);
		const nonTuiResult = await nonTui.execute("call", { questions: [question] }, undefined, undefined, context("print"));
		expect(nonTuiResult).toMatchObject({ isError: true, details: { cancelled: true } });
		expect(nonTuiResult.content[0]).toMatchObject({ text: expect.stringContaining("interactive TUI") });
	});

	it("validates question and option counts", async () => {
		const tool = createPlanQuestionTool(() => true);
		const ctx = context();
		const noQuestions = await tool.execute("call", { questions: [] }, undefined, undefined, ctx);
		expect(noQuestions.content[0]).toMatchObject({ text: "Error: ask between 1 and 3 questions." });

		const invalidOptions = await tool.execute("call", {
			questions: [{ ...question, options: [{ label: "Only" }] }],
		}, undefined, undefined, ctx);
		expect(invalidOptions.content[0]).toMatchObject({ text: expect.stringContaining("scope must have between 2 and 5") });
	});

	it("formats recommendations and collects sequential answers", async () => {
		const tool = createPlanQuestionTool(() => true);
		const ctx = context();
		ctx.ui.select
			.mockResolvedValueOnce("1. Small (recommended) — Change one module")
			.mockResolvedValueOnce("2. Blue");
		const result = await tool.execute("call", {
			questions: [question, {
				id: "color",
				question: "Which color?",
				options: [{ label: "Red" }, { label: "Blue" }],
			}],
		}, undefined, undefined, ctx);

		expect(ctx.ui.select).toHaveBeenNthCalledWith(1, "Which scope?", [
			"1. Small (recommended) — Change one module",
			"2. Large — Change all modules",
		]);
		expect(result.details).toEqual({
			answers: [
				{ id: "scope", question: "Which scope?", answer: "Small", index: 1 },
				{ id: "color", question: "Which color?", answer: "Blue", index: 2 },
			],
			cancelled: false,
		});
		expect(result.content[0]).toMatchObject({ text: expect.stringContaining("- color: 2. Blue") });
	});

	it("returns partial answers when selection is cancelled", async () => {
		const tool = createPlanQuestionTool(() => true);
		const ctx = context();
		ctx.ui.select.mockResolvedValue(undefined);
		const result = await tool.execute("call", { questions: [question] }, undefined, undefined, ctx);
		expect(result.details).toEqual({
			answers: [{ id: "scope", question: "Which scope?", answer: null, cancelled: true }],
			cancelled: true,
		});
		expect(result.content[0]).toMatchObject({ text: "User cancelled clarification questions." });
	});

	it("renders calls, successful results, cancellation, and fallback text", () => {
		const tool = createPlanQuestionTool(() => true);
		expect(tool.renderCall?.({ questions: [question] }, theme(), {} as any).render(80).join("\n"))
			.toContain("plan_question 1 question");
		expect(tool.renderResult?.({
			content: [{ type: "text", text: "done" }],
			details: { answers: [{ id: "scope", question: "Which?", answer: "Small" }], cancelled: false },
		}, {} as any, theme(), {} as any).render(80).join("\n")).toContain("✓ scope: Small");
		expect(tool.renderResult?.({
			content: [{ type: "text", text: "cancelled" }],
			details: { answers: [], cancelled: true },
		}, {} as any, theme(), {} as any).render(80).join("\n")).toContain("Clarification cancelled");
	});
});
