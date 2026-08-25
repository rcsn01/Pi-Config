export interface ProposedPlanDetails {
	createdAt: number;
	signature?: string;
}

// Kept for rendering/reconstructing messages written by older versions.
export const PROPOSED_PLAN_CUSTOM_TYPE = "proposed-plan";
export const PROPOSED_PLAN_ENTRY_TYPE = "proposed-plan-display";
export const PROPOSED_PLAN_OPEN = "<proposed_plan>";
export const PROPOSED_PLAN_CLOSE = "</proposed_plan>";

export function extractAssistantText(message: any): string {
	if (!Array.isArray(message.content)) return typeof message.content === "string" ? message.content : "";
	return message.content
		.filter((part: any) => part?.type === "text" && typeof part.text === "string")
		.map((part: any) => part.text)
		.join("");
}

export function extractProposedPlan(text: string): string | undefined {
	// If the model emits multiple blocks, the last complete block is the
	// authoritative replacement plan.
	let plan: string | undefined;
	const pattern = /<proposed_plan>\s*([\s\S]*?)\s*<\/proposed_plan>/g;
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(text)) !== null) plan = match[1].trim();
	return plan;
}

export function replaceProposedPlanBlocks(text: string, plan: string): string {
	// Keep only the authoritative final complete block. Keeping it in the
	// assistant message preserves it in model context without a second message.
	const pattern = /<proposed_plan>\s*[\s\S]*?\s*<\/proposed_plan>/g;
	const matches = [...text.matchAll(pattern)];
	if (matches.length === 0) return plan;

	let cursor = 0;
	let result = "";
	for (let index = 0; index < matches.length; index++) {
		const match = matches[index];
		const start = match.index;
		result += text.slice(cursor, start);
		if (index === matches.length - 1) result += plan;
		cursor = start + match[0].length;
	}
	result += text.slice(cursor);
	return result.replace(/\n{3,}/g, "\n\n").trim();
}

export function replaceAssistantText(message: any, text: string): any {
	if (!Array.isArray(message.content)) return message;

	let inserted = false;
	const content = [];
	for (const part of message.content) {
		if (part?.type === "text") {
			if (!inserted && text) {
				content.push({ ...part, text });
				inserted = true;
			}
			continue;
		}
		content.push(part);
	}

	if (!inserted && text) content.push({ type: "text", text });
	return { ...message, content };
}

export function discardAssistantMessage(message: any): any {
	return {
		...message,
		// Discard every stale part, including tool calls, rather than retaining
		// non-text content from a response produced under an older mode revision.
		content: [{
			type: "text",
			text: "Response discarded because the runtime mode changed while it was being generated.",
		}],
	};
}

export function planSignature(plan: string): string {
	let hash = 0;
	for (let index = 0; index < plan.length; index++) {
		hash = (hash * 31 + plan.charCodeAt(index)) | 0;
	}
	return `${plan.length}:${hash}`;
}

export function stripPlanTags(text: string): string {
	const extracted = extractProposedPlan(text);
	return (extracted ?? text)
		.replaceAll(PROPOSED_PLAN_OPEN, "")
		.replaceAll(PROPOSED_PLAN_CLOSE, "")
		.trim();
}

export function normalizeComparableText(text: string): string {
	return stripPlanTags(text)
		.toLowerCase()
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/[^a-z0-9]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function wordSet(text: string): Set<string> {
	return new Set(normalizeComparableText(text).split(" ").filter((word) => word.length > 2));
}

export function jaccardSimilarity(a: string, b: string): number {
	const left = wordSet(a);
	const right = wordSet(b);
	if (left.size === 0 || right.size === 0) return 0;
	let intersection = 0;
	for (const word of left) {
		if (right.has(word)) intersection++;
	}
	return intersection / (left.size + right.size - intersection);
}

export function isDuplicatePlanText(input: string, plan: string): boolean {
	const normalizedInput = normalizeComparableText(input);
	const normalizedPlan = normalizeComparableText(plan);
	if (!normalizedInput || !normalizedPlan) return false;
	if (normalizedInput === normalizedPlan) return true;
	if (
		normalizedInput.length > 500 &&
		(normalizedInput.includes(normalizedPlan) || normalizedPlan.includes(normalizedInput))
	) return true;
	return normalizedInput.length > 500 && jaccardSimilarity(normalizedInput, normalizedPlan) >= 0.82;
}

export function isAmbiguousPlanAcceptance(input: string): boolean {
	const normalized = normalizeComparableText(input);
	return /^(continue|ok|okay|yes|yep|yeah|sure|proceed|go ahead|do it|looks good|sounds good|approved|approve|accept|accepted|implement|ship it)$/.test(normalized);
}

export function customMessageFromEntry(entry: any): { customType: string; content: unknown; details?: any } | undefined {
	if (entry?.type === "custom_message" && typeof entry.customType === "string") {
		return { customType: entry.customType, content: entry.content, details: entry.details };
	}
	if (entry?.type === "message" && entry.message?.role === "custom" && typeof entry.message.customType === "string") {
		return {
			customType: entry.message.customType,
			content: entry.message.content,
			details: entry.message.details,
		};
	}
	return undefined;
}

export function extractLegacyCustomMessageContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((part: any) => part?.type === "text" && typeof part.text === "string")
			.map((part: any) => part.text)
			.join("\n");
	}
	return "";
}
