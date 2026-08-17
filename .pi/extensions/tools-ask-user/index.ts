import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

export interface AskUserAnswer {
	id: string;
	question: string;
	answer: string | null;
	index?: number;
	cancelled?: boolean;
}

export interface AskUserDetails {
	answers: AskUserAnswer[];
	cancelled: boolean;
}

export const AskUserOptionSchema = Type.Object({
	label: Type.String({ description: "Short option label shown to the user" }),
	description: Type.Optional(Type.String({ description: "Optional explanation shown next to the option" })),
});

export const AskUserQuestionSchema = Type.Object({
	id: Type.String({ description: "Stable short identifier for this question, e.g. scope or style" }),
	question: Type.String({ description: "The clarification question to ask the user" }),
	options: Type.Array(AskUserOptionSchema, {
		description: "Two to five meaningful options for the user to choose from",
	}),
	recommended: Type.Optional(Type.String({ description: "Optional label of the recommended option" })),
});

export const AskUserParams = Type.Object({
	questions: Type.Array(AskUserQuestionSchema, {
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

export function createAskUserTool(): ToolDefinition<typeof AskUserParams, AskUserDetails> {
	return {
		name: "ask_user",
		label: "Ask User",
		description:
			"Ask the user 1-3 concise multiple-choice questions when their input is needed to resolve material ambiguity or choose between meaningful tradeoffs.",
		promptSnippet: "Ask concise multiple-choice clarification questions",
		promptGuidelines: [
			"Use ask_user only when missing user input materially affects the work; first inspect available context when exploration can answer the question, and recommend a default when appropriate.",
		],
		parameters: AskUserParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!ctx.hasUI) {
				return {
					content: [{
						type: "text",
						text: "Error: ask_user requires an interactive UI so the user can select answers.",
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

			const answers: AskUserAnswer[] = [];
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
			const text = theme.fg("toolTitle", theme.bold("ask_user ")) +
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

export default function askUserExtension(pi: ExtensionAPI): void {
	pi.registerTool(createAskUserTool());
}
