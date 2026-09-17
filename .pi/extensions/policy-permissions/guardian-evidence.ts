const DEFAULT_MAX_USER_TURNS = 3;
const DEFAULT_MAX_CHARACTERS = 16_000;

export interface BoundedGuardianEvidence {
	text: string;
	truncated: boolean;
}

export interface GuardianConversationMessage extends BoundedGuardianEvidence {
	role: "user" | "assistant";
}

export interface GuardianConversationEvidence {
	messages: GuardianConversationMessage[];
	omittedEarlierUserTurns: number;
	truncated: boolean;
}

export interface GuardianSkillInvocation {
	name: string;
	source: string;
}

export interface GuardianSourceMessage {
	role: string;
	content?: unknown;
}

export interface GuardianContextSnapshot {
	conversation: GuardianConversationEvidence;
	invokedSkill?: GuardianSkillInvocation;
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
): { messages: GuardianConversationMessage[]; omittedEarlierUserTurns: number } {
	const userIndices = messages
		.map((message, index) => message.role === "user" ? index : -1)
		.filter((index) => index >= 0);
	const selectedUserIndices = userIndices.slice(-maxUserTurns);
	const selected: GuardianConversationMessage[] = [];

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
		if (text) selected.push({ role: "user", text, truncated: false });
	}

	return {
		messages: selected,
		omittedEarlierUserTurns: Math.max(0, userIndices.length - selectedUserIndices.length),
	};
}

/**
 * Build a branch-projected authorization window. The newest user turn spends
 * the shared budget first; older turns and their preceding assistant replies
 * consume only what remains. Assistant output after the newest user turn is
 * deliberately excluded because it cannot authorize its own tool call.
 */
export function buildGuardianConversationEvidence(
	messages: readonly GuardianSourceMessage[],
	options: { maxUserTurns?: number; maxCharacters?: number } = {},
): GuardianConversationEvidence {
	const maxUserTurns = Math.max(1, options.maxUserTurns ?? DEFAULT_MAX_USER_TURNS);
	const maxCharacters = Math.max(1, options.maxCharacters ?? DEFAULT_MAX_CHARACTERS);
	const recent = recentConversationMessages(messages, maxUserTurns);
	const retained: GuardianConversationMessage[] = [];
	let remaining = maxCharacters;
	let budgetTruncated = false;

	for (let index = recent.messages.length - 1; index >= 0; index--) {
		const message = recent.messages[index]!;
		if (remaining <= 0) {
			budgetTruncated = true;
			break;
		}
		const bounded = boundGuardianEvidence(message.text, remaining);
		retained.unshift({ role: message.role, ...bounded });
		remaining -= bounded.text.length;
		if (bounded.truncated) {
			budgetTruncated = true;
			break;
		}
	}

	const omittedByBudget = retained.length < recent.messages.length;
	return {
		messages: retained,
		omittedEarlierUserTurns: recent.omittedEarlierUserTurns,
		truncated: budgetTruncated || omittedByBudget,
	};
}

export function buildGuardianEvaluationMessage(
	context: GuardianContextSnapshot,
	title: string,
	actionDescription: string,
	triggers: readonly string[],
): string {
	const action = boundGuardianEvidence(actionDescription, 8_000);
	return JSON.stringify({
		schema_version: 2,
		conversation: {
			messages: context.conversation.messages,
			omitted_earlier_user_turns: context.conversation.omittedEarlierUserTurns,
			truncated: context.conversation.truncated,
		},
		...(context.invokedSkill ? {
			invoked_skill: {
				name: context.invokedSkill.name,
				source: context.invokedSkill.source,
			},
		} : {}),
		action: {
			title,
			description: action.text,
			description_truncated: action.truncated,
			triggers: [...triggers],
		},
	});
}
