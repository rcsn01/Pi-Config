import { describe, expect, it, vi } from "vitest";
import askUserExtension, { createAskUserTool } from "./index.ts";

function theme() {
	return {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	} as any;
}

function context(hasUI = true) {
	return {
		hasUI,
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

describe("ask_user", () => {
	it("registers as a standalone generic clarification tool", () => {
		const registerTool = vi.fn();
		askUserExtension({ registerTool } as any);
		expect(registerTool).toHaveBeenCalledOnce();

		const tool = registerTool.mock.calls[0][0];
		expect(tool).toMatchObject({
			name: "ask_user",
			label: "Ask User",
			description: expect.stringContaining("material ambiguity"),
			promptSnippet: "Ask concise multiple-choice clarification questions",
			promptGuidelines: [expect.stringContaining("Use ask_user")],
		});
		expect((tool.parameters as any).properties.questions.description)
			.toBe("One to three multiple-choice clarification questions");
	});

	it("works outside Plan Mode and rejects non-interactive execution", async () => {
		const tool = createAskUserTool();
		const ctx = context();
		ctx.ui.select.mockResolvedValue("1. Small (recommended) — Change one module");
		const result = await tool.execute("call", { questions: [question] }, undefined, undefined, ctx);
		expect(result.details).toMatchObject({ cancelled: false, answers: [{ answer: "Small" }] });

		const nonInteractiveResult = await tool.execute(
			"call",
			{ questions: [question] },
			undefined,
			undefined,
			context(false),
		);
		expect(nonInteractiveResult).toMatchObject({ isError: true, details: { cancelled: true } });
		expect(nonInteractiveResult.content[0]).toMatchObject({ text: expect.stringContaining("interactive UI") });
	});

	it("validates question and option counts", async () => {
		const tool = createAskUserTool();
		const ctx = context();
		const noQuestions = await tool.execute("call", { questions: [] }, undefined, undefined, ctx);
		expect(noQuestions.content[0]).toMatchObject({ text: "Error: ask between 1 and 3 questions." });

		const invalidOptions = await tool.execute("call", {
			questions: [{ ...question, options: [{ label: "Only" }] }],
		}, undefined, undefined, ctx);
		expect(invalidOptions.content[0]).toMatchObject({ text: expect.stringContaining("scope must have between 2 and 5") });
	});

	it("formats recommendations and collects sequential answers", async () => {
		const tool = createAskUserTool();
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
		const tool = createAskUserTool();
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
		const tool = createAskUserTool();
		expect(tool.renderCall?.({ questions: [question] }, theme(), {} as any).render(80).join("\n"))
			.toContain("ask_user 1 question");
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
