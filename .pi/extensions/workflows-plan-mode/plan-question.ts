import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

export interface PlanQuestionAnswer {
	id: string;
	question: string;
	answer: string | null;
	index?: number;
	cancelled?: boolean;
}

export interface PlanQuestionDetails {
	answers: PlanQuestionAnswer[];
	cancelled: boolean;
}

export const PlanQuestionOptionSchema = Type.Object({
	label: Type.String({ description: "Short option label shown to the user" }),
	description: Type.Optional(Type.String({ description: "Optional explanation shown next to the option" })),
});

export const PlanQuestionSchema = Type.Object({
	id: Type.String({ description: "Stable short identifier for this question, e.g. scope or style" }),
	question: Type.String({ description: "The clarification question to ask the user" }),
	options: Type.Array(PlanQuestionOptionSchema, {
		description: "Two to five meaningful options for the user to choose from",
	}),
	recommended: Type.Optional(Type.String({ description: "Optional label of the recommended option" })),
});

export const PlanQuestionParams = Type.Object({
	questions: Type.Array(PlanQuestionSchema, {
		description: "One to three multiple-choice clarification questions",
	}),
});

function optionDisplay(
	option: { label: string; description?: string },
	index: number,
	recommended?: string,
): string {
	const suffix = option.description ? ` — ${option.description}` : "";
	const recommendedSuffix = recommended && option.label === recommended ? " (recommended)" : "";
	return `${index + 1}. ${option.label}${recommendedSuffix}${suffix}`;
}

/** Create the complete clarification tool; callers only supply current mode. */
export function createPlanQuestionTool(
	isActive: () => boolean,
): ToolDefinition<typeof PlanQuestionParams, PlanQuestionDetails> {
	return {
		name: "plan_question",
		label: "Plan Question",
		description:
			"Plan Mode only. Ask the user 1-3 concise multiple-choice clarification questions before finalizing a proposed plan.",
		promptSnippet: "Ask planning questions",
		parameters: PlanQuestionParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!isActive()) {
				return {
					content: [{ type: "text", text: "Error: plan_question is only available in Plan Mode." }],
					details: { answers: [], cancelled: true },
					isError: true,
				};
			}

			if (ctx.mode !== "tui") {
				return {
					content: [{
						type: "text",
						text: "Error: plan_question requires the interactive TUI so the user can select answers.",
					}],
					details: { answers: [], cancelled: true },
					isError: true,
				};
			}

			if (params.questions.length === 0 || params.questions.length > 3) {
				return {
					content: [{ type: "text", text: "Error: ask between 1 and 3 questions." }],
					details: { answers: [], cancelled: true },
					isError: true,
				};
			}

			const answers: PlanQuestionAnswer[] = [];
			for (const question of params.questions) {
				if (question.options.length < 2 || question.options.length > 5) {
					return {
						content: [{
							type: "text",
							text: `Error: question ${question.id} must have between 2 and 5 options.`,
						}],
						details: { answers, cancelled: true },
						isError: true,
					};
				}

				const choices = question.options.map((option, index) =>
					optionDisplay(option, index, question.recommended)
				);
				const selected = await ctx.ui.select(question.question, choices);
				if (!selected) {
					answers.push({ id: question.id, question: question.question, answer: null, cancelled: true });
					return {
						content: [{ type: "text", text: "User cancelled clarification questions." }],
						details: { answers, cancelled: true },
					};
				}

				const index = Math.max(0, choices.indexOf(selected));
				const option = question.options[index];
				answers.push({
					id: question.id,
					question: question.question,
					answer: option.label,
					index: index + 1,
				});
			}

			const lines = answers.map((answer) => `- ${answer.id}: ${answer.index}. ${answer.answer}`);
			return {
				content: [{ type: "text", text: `User answered clarification questions:\n${lines.join("\n")}` }],
				details: { answers, cancelled: false },
			};
		},

		renderCall(args, theme, _context) {
			const count = Array.isArray(args.questions) ? args.questions.length : 0;
			const text = theme.fg("toolTitle", theme.bold("plan_question ")) +
				theme.fg("muted", `${count} question${count === 1 ? "" : "s"}`);
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme, _context) {
			const details = result.details;
			if (!details) {
				const first = result.content[0];
				return new Text(first?.type === "text" ? first.text : "", 0, 0);
			}
			if (details.cancelled) {
				return new Text(theme.fg("warning", "Clarification cancelled"), 0, 0);
			}
			const text = details.answers
				.map((answer) =>
					`${theme.fg("success", "✓")} ${answer.id}: ${theme.fg("accent", answer.answer ?? "")}`
				)
				.join("\n");
			return new Text(text, 0, 0);
		},
	};
}
