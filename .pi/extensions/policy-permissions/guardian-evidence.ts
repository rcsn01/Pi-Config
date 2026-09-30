import type { GuardianTrigger } from "./policy-types.ts";

const DEFAULT_MAX_USER_TURNS = 3;
const DEFAULT_MAX_CHARACTERS = 16_000;

export interface BoundedGuardianEvidence {
	text: string;
	truncated: boolean;
}

export interface GuardianConversationMessage extends BoundedGuardianEvidence {
	role: "user" | "assistant";
}

export interface GuardianAskUserOption {
	readonly label: string;
	readonly description?: string;
}

export interface GuardianAskUserQuestion {
	readonly id: string;
	readonly question: string;
	readonly recommended?: string;
	readonly options: readonly GuardianAskUserOption[];
}

export interface GuardianAskUserAnswer {
	readonly id: string;
	readonly question: string;
	readonly answer: string | null;
	readonly index?: number;
	readonly notes?: string;
	readonly cancelled?: boolean;
}

export interface GuardianAskUserInteraction {
	readonly questions: readonly GuardianAskUserQuestion[];
	readonly answers: readonly GuardianAskUserAnswer[];
	readonly outcome: "completed" | "cancelled" | "error";
}

export interface GuardianConversationEvidence {
	messages: GuardianConversationMessage[];
	askUserInteractions: GuardianAskUserInteraction[];
	omittedEarlierUserTurns: number;
	truncated: boolean;
}

export interface GuardianSkillInvocation {
	name: string;
	source: string;
}

export interface GuardianSourceToolCallPart {
	type: "toolCall";
	id?: unknown;
	name?: unknown;
	arguments?: unknown;
}

export interface GuardianSourceMessage {
	role: string;
	content?: unknown;
	toolCallId?: unknown;
	toolName?: unknown;
	details?: unknown;
	isError?: unknown;
}

export interface GuardianContextSnapshot {
	conversation: GuardianConversationEvidence;
	invokedSkill?: GuardianSkillInvocation;
}

export interface GuardianReviewRequest {
	readonly conversation: {
		readonly messages: readonly Readonly<GuardianConversationMessage>[];
		readonly askUserInteractions: readonly GuardianAskUserInteraction[];
		readonly omittedEarlierUserTurns: number;
		readonly truncated: boolean;
	};
	readonly invokedSkill?: Readonly<GuardianSkillInvocation>;
	readonly action: {
		readonly title: string;
		readonly description: string;
		readonly descriptionTruncated: boolean;
		readonly triggers: readonly GuardianTrigger[];
	};
}

export interface GuardianReviewActionInput {
	readonly title: string;
	readonly description: string;
	readonly triggers: readonly GuardianTrigger[];
}

/** Preserve both ends of long evidence so destructive suffixes are not hidden. */
export function boundGuardianEvidence(text: string, maxLength: number): BoundedGuardianEvidence {
	if (text.length <= maxLength) return { text, truncated: false };
	if (maxLength <= 0) return { text: "", truncated: true };
	const marker = "\n...[truncated]...\n";
	if (maxLength <= marker.length) return { text: text.slice(0, maxLength), truncated: true };
	const available = maxLength - marker.length;
	const headLength = Math.ceil(available / 2);
	const tailLength = Math.floor(available / 2);
	return {
		text: `${text.slice(0, headLength)}${marker}${text.slice(text.length - tailLength)}`,
		truncated: true,
	};
}

function messageText(message: GuardianSourceMessage): string {
	const content = "content" in message ? message.content : undefined;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block): block is { type: "text"; text: string } =>
			typeof block === "object" && block !== null && block.type === "text" && typeof block.text === "string"
		)
		.map((block) => block.text)
		.join("\n");
}

function recentConversationMessages(
	messages: readonly GuardianSourceMessage[],
	maxUserTurns: number,
): {
	messages: GuardianConversationMessage[];
	firstRetainedUserIndex?: number;
	newestRetainedUserMessage?: GuardianConversationMessage;
	omittedEarlierUserTurns: number;
} {
	const userIndices = messages
		.map((message, index) => message.role === "user" ? index : -1)
		.filter((index) => index >= 0);
	const selectedUserIndices = userIndices.slice(-maxUserTurns);
	const selected: GuardianConversationMessage[] = [];
	let newestRetainedUserMessage: GuardianConversationMessage | undefined;
	const newestSelectedUserIndex = selectedUserIndices.at(-1);

	for (const userIndex of selectedUserIndices) {
		const previousUserIndex = [...userIndices].reverse().find((index) => index < userIndex) ?? -1;
		for (let index = userIndex - 1; index > previousUserIndex; index--) {
			const candidate = messages[index];
			if (candidate?.role !== "assistant") continue;
			const text = messageText(candidate);
			if (text) selected.push({ role: "assistant", text, truncated: false });
			break;
		}
		const text = messageText(messages[userIndex]!);
		if (text) {
			const userMessage = { role: "user" as const, text, truncated: false };
			selected.push(userMessage);
			if (userIndex === newestSelectedUserIndex) newestRetainedUserMessage = userMessage;
		}
	}

	return {
		messages: selected,
		...(selectedUserIndices.length > 0 ? { firstRetainedUserIndex: selectedUserIndices[0] } : {}),
		...(newestRetainedUserMessage ? { newestRetainedUserMessage } : {}),
		omittedEarlierUserTurns: Math.max(0, userIndices.length - selectedUserIndices.length),
	};
}

const NONE_OF_THE_ABOVE = "None of the above";

interface ToolCallCandidate {
	index: number;
	part: GuardianSourceToolCallPart;
}

interface PairedAskUserInteraction {
	interaction: GuardianAskUserInteraction;
	resultIndex: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toolCallParts(message: GuardianSourceMessage): GuardianSourceToolCallPart[] {
	if (message.role !== "assistant" || !Array.isArray(message.content)) return [];
	return message.content.filter((part): part is GuardianSourceToolCallPart =>
		isRecord(part) && part.type === "toolCall"
	);
}

function validateQuestions(argumentsValue: unknown): GuardianAskUserQuestion[] | undefined {
	if (!isRecord(argumentsValue) || !Array.isArray(argumentsValue.questions)) return undefined;
	const sourceQuestions = argumentsValue.questions;
	if (sourceQuestions.length < 1 || sourceQuestions.length > 3) return undefined;

	const questions: GuardianAskUserQuestion[] = [];
	for (const sourceQuestion of sourceQuestions) {
		if (!isRecord(sourceQuestion) || typeof sourceQuestion.id !== "string" || typeof sourceQuestion.question !== "string") {
			return undefined;
		}
		if ("recommended" in sourceQuestion && typeof sourceQuestion.recommended !== "string") return undefined;
		if (!Array.isArray(sourceQuestion.options) || sourceQuestion.options.length !== 3) return undefined;

		const options: GuardianAskUserOption[] = [];
		for (const sourceOption of sourceQuestion.options) {
			if (!isRecord(sourceOption) || typeof sourceOption.label !== "string") return undefined;
			if ("description" in sourceOption && typeof sourceOption.description !== "string") return undefined;
			if (sourceOption.label.trim().toLocaleLowerCase() === NONE_OF_THE_ABOVE.toLocaleLowerCase()) return undefined;
			options.push({
				label: sourceOption.label,
				...(typeof sourceOption.description === "string" ? { description: sourceOption.description } : {}),
			});
		}

		questions.push({
			id: sourceQuestion.id,
			question: sourceQuestion.question,
			...(typeof sourceQuestion.recommended === "string" ? { recommended: sourceQuestion.recommended } : {}),
			options,
		});
	}
	return questions;
}

function validateSelectedAnswer(
	value: unknown,
	question: GuardianAskUserQuestion,
): GuardianAskUserAnswer | undefined {
	if (!isRecord(value) || value.id !== question.id || value.question !== question.question) return undefined;
	if (typeof value.answer !== "string" || !Number.isInteger(value.index) || (value.index as number) < 1 || (value.index as number) > 4) {
		return undefined;
	}
	if ("cancelled" in value && typeof value.cancelled !== "boolean") return undefined;
	if (value.cancelled === true) return undefined;
	if ("notes" in value && typeof value.notes !== "string") return undefined;

	const index = value.index as number;
	const expectedAnswer = index === 4 ? NONE_OF_THE_ABOVE : question.options[index - 1]?.label;
	if (value.answer !== expectedAnswer) return undefined;
	return {
		id: question.id,
		question: question.question,
		answer: value.answer,
		index,
		...(typeof value.notes === "string" ? { notes: value.notes } : {}),
		...(value.cancelled === false ? { cancelled: false } : {}),
	};
}

function validateSelectedAnswers(
	values: unknown[],
	questions: readonly GuardianAskUserQuestion[],
): GuardianAskUserAnswer[] | undefined {
	if (values.length > questions.length) return undefined;
	const answers: GuardianAskUserAnswer[] = [];
	for (let index = 0; index < values.length; index++) {
		const answer = validateSelectedAnswer(values[index], questions[index]!);
		if (!answer) return undefined;
		answers.push(answer);
	}
	return answers;
}

function validateCancellationSentinel(
	value: unknown,
	question: GuardianAskUserQuestion,
): GuardianAskUserAnswer | undefined {
	if (!isRecord(value) || value.id !== question.id || value.question !== question.question) return undefined;
	if (value.answer !== null || value.cancelled !== true || "index" in value || "notes" in value) return undefined;
	return { id: question.id, question: question.question, answer: null, cancelled: true };
}

function validateErrorAnswers(
	details: unknown,
	questions: readonly GuardianAskUserQuestion[],
): GuardianAskUserAnswer[] {
	if (!isRecord(details) || typeof details.cancelled !== "boolean" || !Array.isArray(details.answers)) return [];
	return validateSelectedAnswers(details.answers, questions) ?? [];
}

function validateNonErrorResult(
	result: GuardianSourceMessage,
	questions: readonly GuardianAskUserQuestion[],
): GuardianAskUserInteraction | undefined {
	if (!isRecord(result.details) || typeof result.details.cancelled !== "boolean" || !Array.isArray(result.details.answers)) {
		return undefined;
	}
	const values = result.details.answers;
	if (result.details.cancelled === false) {
		if (values.length !== questions.length) return undefined;
		const answers = validateSelectedAnswers(values, questions);
		return answers ? { questions, answers, outcome: "completed" } : undefined;
	}

	if (values.length < 1 || values.length > questions.length) return undefined;
	const sentinelQuestion = questions[values.length - 1]!;
	const sentinel = validateCancellationSentinel(values.at(-1), sentinelQuestion);
	if (!sentinel) return undefined;
	const prefix = validateSelectedAnswers(values.slice(0, -1), questions);
	if (!prefix) return undefined;
	return { questions, answers: [...prefix, sentinel], outcome: "cancelled" };
}

function extractAskUserInteractions(
	messages: readonly GuardianSourceMessage[],
	firstRetainedUserIndex: number | undefined,
): PairedAskUserInteraction[] {
	if (firstRetainedUserIndex === undefined) return [];
	const candidates: ToolCallCandidate[] = [];
	for (let index = firstRetainedUserIndex; index < messages.length; index++) {
		for (const part of toolCallParts(messages[index]!)) {
			if (part.name === "ask_user") candidates.push({ index, part });
		}
	}

	const paired: PairedAskUserInteraction[] = [];
	for (const candidate of candidates) {
		const id = candidate.part.id;
		if (typeof id !== "string" || !id.trim()) continue;
		const matchingCalls: ToolCallCandidate[] = [];
		const matchingResults: Array<{ index: number; message: GuardianSourceMessage }> = [];
		for (let index = firstRetainedUserIndex; index < messages.length; index++) {
			const message = messages[index]!;
			for (const part of toolCallParts(message)) {
				if (part.id === id) matchingCalls.push({ index, part });
			}
			if (message.role === "toolResult" && message.toolCallId === id) matchingResults.push({ index, message });
		}
		if (matchingCalls.length !== 1 || matchingResults.length !== 1) continue;
		const call = matchingCalls[0]!;
		const { index: resultIndex, message: result } = matchingResults[0]!;
		if (call.index !== candidate.index || call.part !== candidate.part || resultIndex <= call.index) continue;
		if (result.toolName !== "ask_user" || typeof result.isError !== "boolean") continue;

		const questions = validateQuestions(call.part.arguments);
		if (!questions) continue;
		const interaction = result.isError === true
			? {
				questions,
				answers: validateErrorAnswers(result.details, questions),
				outcome: "error" as const,
			}
			: validateNonErrorResult(result, questions);
		if (interaction) paired.push({ interaction, resultIndex });
	}
	return paired.sort((a, b) => b.resultIndex - a.resultIndex);
}

/**
 * Build a branch-projected authorization window. The newest user turn spends
 * the shared budget first; older turns and their preceding assistant replies
 * consume only what remains. Assistant prose after the newest user turn is
 * deliberately excluded because it cannot authorize its own tool call; paired
 * ask_user records are added as separate, validated evidence.
 */
export function buildGuardianConversationEvidence(
	messages: readonly GuardianSourceMessage[],
	options: { maxUserTurns?: number; maxCharacters?: number } = {},
): GuardianConversationEvidence {
	const maxUserTurns = Math.max(1, options.maxUserTurns ?? DEFAULT_MAX_USER_TURNS);
	const maxCharacters = Math.max(1, options.maxCharacters ?? DEFAULT_MAX_CHARACTERS);
	const recent = recentConversationMessages(messages, maxUserTurns);
	const candidateInteractions = extractAskUserInteractions(messages, recent.firstRetainedUserIndex)
		.map(({ interaction }) => interaction);
	const retainedByIndex = new Map<number, GuardianConversationMessage>();
	const newestUserMessageIndex = recent.newestRetainedUserMessage
		? recent.messages.indexOf(recent.newestRetainedUserMessage)
		: -1;

	let remaining = maxCharacters;
	let budgetTruncated = false;
	if (newestUserMessageIndex >= 0) {
		const bounded = boundGuardianEvidence(recent.messages[newestUserMessageIndex]!.text, remaining);
		retainedByIndex.set(newestUserMessageIndex, { role: "user", ...bounded });
		remaining -= bounded.text.length;
		budgetTruncated ||= bounded.truncated;
	}

	const askUserInteractions: GuardianAskUserInteraction[] = [];
	for (const interaction of candidateInteractions) {
		const interactionLength = JSON.stringify(interaction).length;
		if (interactionLength > remaining) {
			budgetTruncated = true;
			break;
		}
		askUserInteractions.push(interaction);
		remaining -= interactionLength;
	}

	for (let index = recent.messages.length - 1; index >= 0; index--) {
		if (index === newestUserMessageIndex) continue;
		const message = recent.messages[index]!;
		if (remaining <= 0) {
			budgetTruncated = true;
			break;
		}
		const bounded = boundGuardianEvidence(message.text, remaining);
		retainedByIndex.set(index, { role: message.role, ...bounded });
		remaining -= bounded.text.length;
		if (bounded.truncated) {
			budgetTruncated = true;
			break;
		}
	}

	const retained = recent.messages.flatMap((_message, index) => {
		const message = retainedByIndex.get(index);
		return message ? [message] : [];
	});
	const omittedByBudget = retained.length < recent.messages.length || askUserInteractions.length < candidateInteractions.length;
	return {
		messages: retained,
		askUserInteractions,
		omittedEarlierUserTurns: recent.omittedEarlierUserTurns,
		truncated: budgetTruncated || omittedByBudget,
	};
}

export function buildGuardianReviewRequest(
	context: GuardianContextSnapshot,
	actionInput: GuardianReviewActionInput,
): GuardianReviewRequest {
	const action = boundGuardianEvidence(actionInput.description, 8_000);
	return {
		conversation: {
			messages: context.conversation.messages.map((message) => ({
				role: message.role,
				text: message.text,
				truncated: message.truncated,
			})),
			askUserInteractions: context.conversation.askUserInteractions.map((interaction) => ({
				questions: interaction.questions.map((question) => ({
					id: question.id,
					question: question.question,
					...(question.recommended !== undefined ? { recommended: question.recommended } : {}),
					options: question.options.map((option) => ({
						label: option.label,
						...(option.description !== undefined ? { description: option.description } : {}),
					})),
				})),
				answers: interaction.answers.map((answer) => ({
					id: answer.id,
					question: answer.question,
					answer: answer.answer,
					...(answer.index !== undefined ? { index: answer.index } : {}),
					...(answer.notes !== undefined ? { notes: answer.notes } : {}),
					...(answer.cancelled !== undefined ? { cancelled: answer.cancelled } : {}),
				})),
				outcome: interaction.outcome,
			})),
			omittedEarlierUserTurns: context.conversation.omittedEarlierUserTurns,
			truncated: context.conversation.truncated,
		},
		...(context.invokedSkill ? {
			invokedSkill: {
				name: context.invokedSkill.name,
				source: context.invokedSkill.source,
			},
		} : {}),
		action: {
			title: actionInput.title,
			description: action.text,
			descriptionTruncated: action.truncated,
			triggers: [...actionInput.triggers],
		},
	};
}
