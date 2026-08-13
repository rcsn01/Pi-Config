import {
	estimateTokens,
	formatSkillsForPrompt,
	sessionEntryToContextMessages,
	type ContextUsage,
	type SessionEntry,
	type Skill,
	type ToolInfo,
} from "@earendil-works/pi-coding-agent";

export const CATEGORY_KEYS = [
	"systemPrompt",
	"builtinTools",
	"extensionTools",
	"contextFiles",
	"skills",
	"messages",
] as const;

export type ContextCategory = (typeof CATEGORY_KEYS)[number];
export type CategoryTokens = Record<ContextCategory, number>;

export interface ContextModelInput {
	model?: { provider: string; id: string; contextWindow?: number };
	usage?: ContextUsage;
	systemPrompt: string;
	contextFiles?: readonly { path: string; content: string }[];
	skills?: readonly Skill[];
	activeToolNames: readonly string[];
	allTools: readonly ToolInfo[];
	contextEntries: readonly SessionEntry[];
	compaction: { enabled: boolean; reserveTokens: number };
}

export interface ContextDiagnostics {
	modelId: string;
	contextWindow: number;
	usedTokens: number;
	usedIsEstimated: boolean;
	percent: number;
	categories: CategoryTokens;
	freeSpace: number;
	compactionReserve: number;
	compactionThreshold: number;
	compactionEnabled: boolean;
}

export interface MeterAllocation {
	cells: number;
	used: number;
	free: number;
	reserve: number;
}

function emptyCategories(): CategoryTokens {
	return {
		systemPrompt: 0,
		builtinTools: 0,
		extensionTools: 0,
		contextFiles: 0,
		skills: 0,
		messages: 0,
	};
}

/** Pi's conservative chars/4 estimator, applied to non-message prompt material. */
export function estimateTextTokens(text: string): number {
	if (!text) return 0;
	return estimateTokens({ role: "user", content: text, timestamp: 0 });
}

export function formatContextFilesForPrompt(
	files: readonly { path: string; content: string }[],
): string {
	if (files.length === 0) return "";
	let text = "\n\n<project_context>\n\nProject-specific instructions and guidelines:\n\n";
	for (const file of files) {
		text += `<project_instructions path="${file.path}">\n${file.content}\n</project_instructions>\n\n`;
	}
	return `${text}</project_context>\n`;
}

export function estimateToolTokens(tool: ToolInfo): number {
	return estimateTextTokens(JSON.stringify({
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
		promptGuidelines: tool.promptGuidelines,
	}));
}

export function classifyActiveToolTokens(
	activeToolNames: readonly string[],
	allTools: readonly ToolInfo[],
): Pick<CategoryTokens, "builtinTools" | "extensionTools"> {
	const active = new Set(activeToolNames);
	let builtinTools = 0;
	let extensionTools = 0;
	for (const tool of allTools) {
		if (!active.has(tool.name)) continue;
		const tokens = estimateToolTokens(tool);
		if (tool.sourceInfo.source === "builtin") builtinTools += tokens;
		else extensionTools += tokens;
	}
	return { builtinTools, extensionTools };
}

export function estimateMessageTokens(entries: readonly SessionEntry[]): number {
	return entries
		.flatMap((entry) => sessionEntryToContextMessages(entry))
		.reduce((total, message) => total + estimateTokens(message), 0);
}

export function estimateRawCategories(input: ContextModelInput): CategoryTokens {
	const contextText = formatContextFilesForPrompt(input.contextFiles ?? []);
	const formattedSkills = formatSkillsForPrompt([...(input.skills ?? [])]);
	// Pi only inserts the skill catalogue when read is available. Checking the
	// effective prompt also handles custom prompts and future prompt changes.
	const skillText = formattedSkills && input.systemPrompt.includes(formattedSkills)
		? formattedSkills
		: "";
	const contextTokens = contextText && input.systemPrompt.includes(contextText)
		? estimateTextTokens(contextText)
		: 0;
	const skillTokens = estimateTextTokens(skillText);
	const fullSystemTokens = estimateTextTokens(input.systemPrompt);
	const tools = classifyActiveToolTokens(input.activeToolNames, input.allTools);

	return {
		systemPrompt: Math.max(0, fullSystemTokens - contextTokens - skillTokens),
		...tools,
		contextFiles: contextTokens,
		skills: skillTokens,
		messages: estimateMessageTokens(input.contextEntries),
	};
}

/** Reconcile estimates using largest remainders so integer categories sum exactly. */
export function reconcileCategories(raw: CategoryTokens, target: number): CategoryTokens {
	const safeTarget = Math.max(0, Math.round(Number.isFinite(target) ? target : 0));
	const rawTotal = CATEGORY_KEYS.reduce((sum, key) => sum + Math.max(0, raw[key]), 0);
	if (rawTotal === 0) return { ...emptyCategories(), systemPrompt: safeTarget };

	const scaled = CATEGORY_KEYS.map((key, index) => {
		const exact = Math.max(0, raw[key]) * safeTarget / rawTotal;
		return { key, index, value: Math.floor(exact), remainder: exact - Math.floor(exact) };
	});
	let missing = safeTarget - scaled.reduce((sum, item) => sum + item.value, 0);
	for (const item of [...scaled].sort((a, b) => b.remainder - a.remainder || a.index - b.index)) {
		if (missing-- <= 0) break;
		item.value++;
	}
	return Object.fromEntries(scaled.map(({ key, value }) => [key, value])) as CategoryTokens;
}

export function calculateCapacity(
	contextWindow: number,
	usedTokens: number,
	compaction: { enabled: boolean; reserveTokens: number },
): { freeSpace: number; compactionReserve: number } {
	const remaining = Math.max(0, contextWindow - usedTokens);
	const configured = compaction.enabled ? Math.max(0, compaction.reserveTokens) : 0;
	const compactionReserve = Math.min(configured, remaining);
	return { compactionReserve, freeSpace: remaining - compactionReserve };
}

export function calculateContextDiagnostics(input: ContextModelInput): ContextDiagnostics {
	const contextWindow = Math.max(0, input.model?.contextWindow ?? input.usage?.contextWindow ?? 0);
	const raw = estimateRawCategories(input);
	const rawTotal = CATEGORY_KEYS.reduce((sum, key) => sum + raw[key], 0);
	const exactUsed = input.usage?.tokens;
	const usedIsEstimated = exactUsed === null || exactUsed === undefined;
	const usedTokens = Math.max(0, Math.round(usedIsEstimated ? rawTotal : exactUsed));
	const categories = reconcileCategories(raw, usedTokens);
	const { freeSpace, compactionReserve } = calculateCapacity(contextWindow, usedTokens, input.compaction);
	return {
		modelId: input.model ? `${input.model.provider}/${input.model.id}` : "No active model",
		contextWindow,
		usedTokens,
		usedIsEstimated,
		percent: contextWindow > 0 ? usedTokens / contextWindow * 100 : 0,
		categories,
		freeSpace,
		compactionReserve,
		compactionThreshold: input.compaction.enabled
			? Math.max(0, contextWindow - Math.max(0, input.compaction.reserveTokens))
			: contextWindow,
		compactionEnabled: input.compaction.enabled,
	};
}

export function formatTokenCount(tokens: number): string {
	const value = Math.max(0, Number.isFinite(tokens) ? tokens : 0);
	if (value < 1_000) return Math.round(value).toLocaleString("en-US");
	if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}k`;
	return `${(value / 1_000_000).toFixed(value < 10_000_000 ? 2 : 1)}m`;
}

export function formatPercent(percent: number): string {
	const safe = Math.max(0, Number.isFinite(percent) ? percent : 0);
	return `${safe.toFixed(safe < 10 ? 1 : 0)}%`;
}

export function allocateMeter(
	diagnostics: Pick<ContextDiagnostics, "contextWindow" | "usedTokens" | "freeSpace" | "compactionReserve">,
	cells = 100,
): MeterAllocation {
	const count = Math.max(0, Math.min(100, Math.floor(cells)));
	if (count === 0) return { cells: 0, used: 0, free: 0, reserve: 0 };
	const total = diagnostics.contextWindow > 0
		? diagnostics.contextWindow
		: diagnostics.usedTokens + diagnostics.freeSpace + diagnostics.compactionReserve;
	if (total <= 0) return { cells: count, used: 0, free: count, reserve: 0 };

	const used = Math.min(total, Math.max(0, diagnostics.usedTokens));
	const reserve = Math.min(Math.max(0, total - used), Math.max(0, diagnostics.compactionReserve));
	const free = Math.max(0, total - used - reserve);
	const raw = [used, free, reserve]
		.map((value, index) => {
			const exact = value * count / total;
			return { index, value: Math.floor(exact), remainder: exact - Math.floor(exact) };
		});
	let missing = count - raw.reduce((sum, item) => sum + item.value, 0);
	for (const item of [...raw].sort((a, b) => b.remainder - a.remainder || a.index - b.index)) {
		if (missing-- <= 0) break;
		item.value++;
	}
	return { cells: count, used: raw[0]!.value, free: raw[1]!.value, reserve: raw[2]!.value };
}
