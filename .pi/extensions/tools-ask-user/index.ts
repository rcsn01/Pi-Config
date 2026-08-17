import type {
	ExtensionAPI,
	KeybindingsManager,
	Theme,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
	Input,
	Text,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
	type Component,
	type TUI,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";

export interface AskUserAnswer {
	id: string;
	question: string;
	answer: string | null;
	index?: number;
	notes?: string;
	cancelled?: boolean;
}

export interface AskUserDetails {
	answers: AskUserAnswer[];
	cancelled: boolean;
}

interface AskUserOption {
	label: string;
	description?: string;
}

interface AskUserSelection {
	index: number;
	notes?: string;
}

export const NONE_OF_THE_ABOVE: AskUserOption = {
	label: "None of the above",
	description: "Optionally, add details in notes (tab)",
};

export const AskUserOptionSchema = Type.Object({
	label: Type.String({ description: "Short option label shown to the user; do not use ‘None of the above’" }),
	description: Type.Optional(Type.String({ description: "Optional explanation shown next to the option" })),
});

export const AskUserQuestionSchema = Type.Object({
	id: Type.String({ description: "Stable short identifier for this question, e.g. scope or style" }),
	question: Type.String({ description: "The clarification question to ask the user" }),
	options: Type.Array(AskUserOptionSchema, {
		minItems: 3,
		maxItems: 3,
		description: "Exactly three meaningful options; do not include ‘None of the above’ because it is added automatically",
	}),
	recommended: Type.Optional(Type.String({ description: "Optional label of the recommended option" })),
});

export const AskUserParams = Type.Object({
	questions: Type.Array(AskUserQuestionSchema, {
		minItems: 1,
		maxItems: 3,
		description: "One to three multiple-choice clarification questions",
	}),
});

function addWrapped(lines: string[], text: string, width: number): void {
	lines.push(...wrapTextWithAnsi(text, Math.max(1, width)));
}

function addWrappedWithPrefix(lines: string[], prefix: string, text: string, width: number): void {
	const prefixWidth = visibleWidth(prefix);
	if (prefixWidth >= width) {
		addWrapped(lines, prefix + text, width);
		return;
	}
	const wrapped = wrapTextWithAnsi(text, Math.max(1, width - prefixWidth));
	const continuationPrefix = " ".repeat(prefixWidth);
	for (let index = 0; index < wrapped.length; index++) {
		lines.push(`${index === 0 ? prefix : continuationPrefix}${wrapped[index]}`);
	}
}

/** The interactive selector is exported to keep its keyboard and width behavior directly testable. */
export class AskUserComponent implements Component {
	private optionIndex = 0;
	private editing = false;
	private focusedState = false;
	private readonly input = new Input();
	private readonly notes = new Map<number, string>();

	constructor(
		private readonly question: string,
		private readonly options: readonly AskUserOption[],
		private readonly recommended: string | undefined,
		private readonly tui: Pick<TUI, "requestRender">,
		private readonly theme: Theme,
		private readonly keybindings: Pick<KeybindingsManager, "matches">,
		private readonly done: (selection: AskUserSelection | undefined) => void,
	) {}

	get focused(): boolean {
		return this.focusedState;
	}

	set focused(value: boolean) {
		this.focusedState = value;
		this.input.focused = value && this.editing;
	}

	private refresh(): void {
		this.input.invalidate();
		this.tui.requestRender();
	}

	private startEditing(): void {
		this.editing = true;
		this.input.setValue(this.notes.get(this.optionIndex) ?? "");
		this.input.focused = this.focusedState;
		this.refresh();
	}

	private finish(): void {
		const notes = this.input.getValue().trim();
		if (notes) this.notes.set(this.optionIndex, notes);
		else this.notes.delete(this.optionIndex);
		this.done({ index: this.optionIndex, ...(notes ? { notes } : {}) });
	}

	handleInput(data: string): void {
		if (this.editing) {
			if (this.keybindings.matches(data, "tui.select.cancel")) {
				this.editing = false;
				this.input.focused = false;
				this.input.setValue("");
				this.refresh();
				return;
			}
			if (this.keybindings.matches(data, "tui.input.submit")) {
				this.finish();
				return;
			}
			this.input.handleInput(data);
			this.refresh();
			return;
		}

		if (this.keybindings.matches(data, "tui.select.up")) {
			this.optionIndex = Math.max(0, this.optionIndex - 1);
			this.refresh();
			return;
		}
		if (this.keybindings.matches(data, "tui.select.down")) {
			this.optionIndex = Math.min(this.options.length - 1, this.optionIndex + 1);
			this.refresh();
			return;
		}
		if (this.keybindings.matches(data, "tui.input.tab")) {
			this.startEditing();
			return;
		}
		if (this.keybindings.matches(data, "tui.select.confirm")) {
			const notes = this.notes.get(this.optionIndex);
			this.done({ index: this.optionIndex, ...(notes ? { notes } : {}) });
			return;
		}
		if (this.keybindings.matches(data, "tui.select.cancel")) this.done(undefined);
	}

	render(width: number): string[] {
		const renderWidth = Math.max(1, width);
		const lines: string[] = [this.theme.fg("accent", "─".repeat(renderWidth))];
		addWrappedWithPrefix(lines, " ", this.theme.fg("text", this.question), renderWidth);
		lines.push("");

		for (let index = 0; index < this.options.length; index++) {
			const option = this.options[index]!;
			const selected = index === this.optionIndex;
			const prefix = selected ? this.theme.fg("accent", "> ") : "  ";
			const recommended = this.recommended === option.label ? " (recommended)" : "";
			const editMarker = selected && this.editing ? " ✎" : "";
			const color = selected ? "accent" : "text";
			const label = this.theme.fg(color, `${index + 1}. ${option.label}${recommended}${editMarker}`);
			const description = option.description ? this.theme.fg("muted", ` — ${option.description}`) : "";
			addWrappedWithPrefix(lines, prefix, `${label}${description}`, renderWidth);
			const savedNotes = this.notes.get(index);
			if (savedNotes) {
				addWrappedWithPrefix(lines, "     ", this.theme.fg("dim", `Notes: ${savedNotes} (Tab to edit)`), renderWidth);
			}
		}

		if (this.editing) {
			lines.push("");
			addWrappedWithPrefix(lines, " ", this.theme.fg("muted", "Notes:"), renderWidth);
			const inputPrefix = renderWidth > 1 ? " " : "";
			const inputWidth = Math.max(1, renderWidth - visibleWidth(inputPrefix));
			for (const line of this.input.render(inputWidth)) {
				lines.push(`${inputPrefix}${truncateToWidth(line, inputWidth)}`);
			}
		}

		lines.push("");
		const hint = this.editing
			? "Enter select with notes • Esc discard edit"
			: "Optional notes (Tab) • ↑↓ navigate • Enter select • Esc cancel";
		addWrappedWithPrefix(lines, " ", this.theme.fg("dim", hint), renderWidth);
		lines.push(this.theme.fg("accent", "─".repeat(renderWidth)));
		return lines;
	}

	invalidate(): void {
		this.input.invalidate();
	}
}

function allOptions(options: readonly AskUserOption[]): AskUserOption[] {
	return [...options, { ...NONE_OF_THE_ABOVE }];
}

function optionDisplay(option: AskUserOption, index: number, recommended?: string): string {
	const suffix = option.description ? ` — ${option.description}` : "";
	const recommendedSuffix = recommended && option.label === recommended ? " (recommended)" : "";
	return `${index + 1}. ${option.label}${recommendedSuffix}${suffix}`;
}

function answerLines(answers: readonly AskUserAnswer[]): string[] {
	return answers.filter((answer) => !answer.cancelled).map((answer) => {
		const notes = answer.notes ? `\n  Notes: ${answer.notes}` : "";
		return `- ${answer.id}: ${answer.index}. ${answer.answer}${notes}`;
	});
}

function hasDuplicateNoneOption(options: readonly AskUserOption[]): boolean {
	return options.some((option) => option.label.trim().toLocaleLowerCase() === NONE_OF_THE_ABOVE.label.toLocaleLowerCase());
}

export function createAskUserTool(): ToolDefinition<typeof AskUserParams, AskUserDetails> {
	return {
		name: "ask_user",
		label: "Ask User",
		description:
			"Ask the user 1-3 concise multiple-choice questions. Provide exactly three options per question; ‘None of the above’ is always added as option 4.",
		promptSnippet: "Ask concise multiple-choice clarification questions",
		promptGuidelines: [
			"Use ask_user only when missing user input materially affects the work; first inspect available context when exploration can answer the question, and recommend a default when appropriate.",
			"Provide exactly three generated options for each question and never generate ‘None of the above’; the tool adds it automatically.",
		],
		parameters: AskUserParams,
		executionMode: "sequential",

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (ctx.mode !== "tui" && ctx.mode !== "rpc") {
				return {
					content: [{
						type: "text",
						text: "Error: ask_user requires an interactive UI so the user can select answers.",
					}],
					details: { answers: [], cancelled: true },
					isError: true,
				};
			}

			if (!ctx.hasUI) {
				return {
					content: [{ type: "text", text: "Error: ask_user requires an interactive UI so the user can select answers." }],
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
				if (question.options.length !== 3) {
					return {
						content: [{ type: "text", text: `Error: question ${question.id} must have exactly 3 generated options.` }],
						details: { answers, cancelled: true },
						isError: true,
					};
				}
				if (hasDuplicateNoneOption(question.options)) {
					return {
						content: [{ type: "text", text: `Error: question ${question.id} must not generate “None of the above”; it is added automatically.` }],
						details: { answers, cancelled: true },
						isError: true,
					};
				}

				const options = allOptions(question.options);
				let selection: AskUserSelection | undefined;
				if (ctx.mode === "rpc") {
					const choices = options.map((option, index) => optionDisplay(option, index, question.recommended));
					const selected = await ctx.ui.select(question.question, choices);
					if (selected) {
						const index = choices.indexOf(selected);
						if (index >= 0) {
							const notes = (await ctx.ui.input(`Optional notes for ${options[index]!.label}`, "Leave blank for no notes"))?.trim();
							selection = { index, ...(notes ? { notes } : {}) };
						}
					}
				} else {
					selection = await ctx.ui.custom<AskUserSelection | undefined>((tui, theme, keybindings, done) =>
						new AskUserComponent(question.question, options, question.recommended, tui, theme, keybindings, done));
				}

				if (!selection) {
					answers.push({ id: question.id, question: question.question, answer: null, cancelled: true });
					const partial = answerLines(answers);
					return {
						content: [{
							type: "text",
							text: `${partial.length ? `User answered before cancellation:\n${partial.join("\n")}\n` : ""}User cancelled clarification questions.`,
						}],
						details: { answers, cancelled: true },
					};
				}

				const option = options[selection.index]!;
				answers.push({
					id: question.id,
					question: question.question,
					answer: option.label,
					index: selection.index + 1,
					...(selection.notes ? { notes: selection.notes } : {}),
				});
			}

			return {
				content: [{ type: "text", text: `User answered clarification questions:\n${answerLines(answers).join("\n")}` }],
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
			const lines = details.answers.filter((answer) => !answer.cancelled).map((answer) => {
				const notes = answer.notes ? `\n  ${theme.fg("muted", `Notes: ${answer.notes}`)}` : "";
				return `${theme.fg("success", "✓")} ${answer.id}: ${theme.fg("accent", `${answer.index}. ${answer.answer ?? ""}`)}${notes}`;
			});
			if (details.cancelled) lines.push(theme.fg("warning", "Clarification cancelled"));
			return new Text(lines.join("\n"), 0, 0);
		},
	};
}

export default function askUserExtension(pi: ExtensionAPI): void {
	pi.registerTool(createAskUserTool());
}
