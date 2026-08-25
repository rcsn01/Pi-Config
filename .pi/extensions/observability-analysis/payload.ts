import { estimateTokens } from "@earendil-works/pi-coding-agent";

export type SectionKind = "instruction" | "tool" | "conversation" | "reasoning" | "option";

export interface PayloadSection {
	kind: SectionKind;
	label: string;
	pointer: string;
	estimatedTokens: number;
	allocatedTokens?: number;
	cachedTokens?: number;
}

export interface PayloadAnalysis {
	apiLabel: string;
	sections: PayloadSection[];
	prefixCache: boolean;
}

export interface UsageView {
	input: number;
	cacheRead: number;
	cacheWrite: number;
	output: number;
	reasoning?: number;
	totalTokens: number;
	cost: {
		input: number;
		cacheRead: number;
		cacheWrite: number;
		output: number;
		total: number;
	};
}

function pointerPart(value: string): string {
	return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function tokenEstimate(value: unknown): number {
	const text = typeof value === "string" ? value : JSON.stringify(value) ?? "";
	return text ? estimateTokens({ role: "user", content: text, timestamp: 0 }) : 0;
}

function object(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}

function add(
	sections: PayloadSection[],
	kind: SectionKind,
	label: string,
	pointer: string,
	value: unknown,
): void {
	sections.push({ kind, label, pointer, estimatedTokens: tokenEstimate(value) });
}

function itemLabel(value: unknown, index: number): string {
	const item = object(value);
	const role = typeof item?.role === "string" ? item.role : undefined;
	const type = typeof item?.type === "string" ? item.type : undefined;
	if (role) return `${role} item ${index + 1}`;
	if (type?.includes("reasoning")) return `reasoning state ${index + 1}`;
	if (type?.includes("tool") && type.includes("output")) return `tool result ${index + 1}`;
	if (type?.includes("tool") || type?.includes("function")) return `tool call ${index + 1}`;
	return `input item ${index + 1}`;
}

function itemKind(value: unknown): SectionKind {
	const item = object(value);
	const type = typeof item?.type === "string" ? item.type : "";
	if (type.includes("reasoning")) return "reasoning";
	return "conversation";
}

const OPTION_KEYS = new Set([
	"model", "reasoning", "reasoning_effort", "text", "verbosity", "temperature", "top_p",
	"top_k", "max_output_tokens", "max_tokens", "max_completion_tokens", "stop", "stop_sequences",
	"store", "stream", "parallel_tool_calls", "tool_choice", "prompt_cache_key",
	"prompt_cache_retention", "service_tier", "metadata", "include",
]);

const RESPONSE_APIS = new Set(["openai-responses", "openai-codex-responses", "azure-openai-responses"]);

function addTools(sections: PayloadSection[], root: Record<string, unknown>): void {
	if (!Array.isArray(root.tools)) return;
	root.tools.forEach((tool, index) => {
		const toolObject = object(tool);
		const name = toolObject && typeof toolObject.name === "string"
			? toolObject.name
			: object(toolObject?.function)?.name;
		add(sections, "tool", `tool: ${typeof name === "string" ? name : index + 1}`, `/tools/${index}`, tool);
	});
}

function addMessages(sections: PayloadSection[], root: Record<string, unknown>): void {
	if (!Array.isArray(root.messages)) return;
	root.messages.forEach((message, index) => {
		const role = object(message)?.role;
		add(sections, role === "system" || role === "developer" ? "instruction" : "conversation",
			`${typeof role === "string" ? role : "message"} ${index + 1}`, `/messages/${index}`, message);
	});
}

function addOptions(sections: PayloadSection[], root: Record<string, unknown>): void {
	for (const [key, value] of Object.entries(root)) {
		if (OPTION_KEYS.has(key)) add(sections, "option", key.replaceAll("_", " "), `/${pointerPart(key)}`, value);
	}
}

function completionsSections(root: Record<string, unknown>): PayloadSection[] {
	const sections: PayloadSection[] = [];
	addTools(sections, root);
	addMessages(sections, root);
	if (root.prompt !== undefined) add(sections, "conversation", "prompt", "/prompt", root.prompt);
	addOptions(sections, root);
	return sections;
}

function responsesSections(root: Record<string, unknown>): PayloadSection[] {
	const sections: PayloadSection[] = [];
	if (root.instructions !== undefined) add(sections, "instruction", "instructions", "/instructions", root.instructions);
	addTools(sections, root);
	if (Array.isArray(root.input)) {
		root.input.forEach((item, index) => add(sections, itemKind(item), itemLabel(item, index), `/input/${index}`, item));
	} else if (root.input !== undefined) {
		add(sections, "conversation", "input", "/input", root.input);
	}
	addOptions(sections, root);
	return sections;
}

function anthropicSections(root: Record<string, unknown>): PayloadSection[] {
	const sections: PayloadSection[] = [];
	addTools(sections, root);
	if (root.system !== undefined) add(sections, "instruction", "system instructions", "/system", root.system);
	addMessages(sections, root);
	addOptions(sections, root);
	return sections;
}

/** Build API-specific pointer labels. The raw payload remains the sole copy of captured content. */
export function analyzePayload(api: string, payload: unknown): PayloadAnalysis {
	const root = object(payload);
	if (!root) {
		return {
			apiLabel: "Generic payload",
			prefixCache: false,
			sections: [{ kind: "conversation", label: "complete request payload", pointer: "", estimatedTokens: tokenEstimate(payload) }],
		};
	}
	let apiLabel: string;
	let sections: PayloadSection[];
	if (api === "openai-completions") {
		apiLabel = "OpenAI Completions";
		sections = completionsSections(root);
	} else if (RESPONSE_APIS.has(api)) {
		apiLabel = "OpenAI Responses";
		sections = responsesSections(root);
	} else if (api === "anthropic-messages") {
		apiLabel = "Anthropic Messages";
		sections = anthropicSections(root);
	} else {
		return {
			apiLabel: "Generic payload",
			prefixCache: false,
			sections: [{ kind: "conversation", label: "complete request payload", pointer: "", estimatedTokens: tokenEstimate(payload) }],
		};
	}
	if (sections.length === 0) add(sections, "conversation", "complete request payload", "", payload);
	return { apiLabel, sections, prefixCache: true };
}

export function labelPayload(api: string, payload: unknown): PayloadSection[] {
	return analyzePayload(api, payload).sections;
}

export function supportsPrefixCacheEstimate(api: string): boolean {
	return api === "openai-completions" || RESPONSE_APIS.has(api) || api === "anthropic-messages";
}

export function reconcileCacheSections(
	sections: readonly PayloadSection[],
	promptTokens: number,
	cacheRead: number,
): PayloadSection[] {
	const target = Math.max(0, Math.round(Number.isFinite(promptTokens) ? promptTokens : 0));
	const weights = sections.map((section) => section.kind === "option" ? 0 : Math.max(0, section.estimatedTokens));
	const eligibleCount = sections.filter((section) => section.kind !== "option").length;
	const totalWeight = weights.reduce((sum, value) => sum + value, 0);
	const denominator = totalWeight || eligibleCount;
	const rows = sections.map((section, index) => {
		const fallbackWeight = section.kind === "option" ? 0 : 1;
		const exact = denominator ? (totalWeight ? weights[index]! : fallbackWeight) * target / denominator : 0;
		return { section, index, allocated: Math.floor(exact), remainder: exact - Math.floor(exact) };
	});
	let remainder = target - rows.reduce((sum, row) => sum + row.allocated, 0);
	for (const row of [...rows].sort((a, b) => b.remainder - a.remainder || a.index - b.index)) {
		if (remainder-- <= 0) break;
		row.allocated++;
	}
	let cacheLeft = Math.min(target, Math.max(0, Math.round(cacheRead)));
	return rows.map(({ section, allocated }) => {
		const cachedTokens = Math.min(cacheLeft, allocated);
		cacheLeft -= cachedTokens;
		return { ...section, allocatedTokens: allocated, cachedTokens };
	});
}

export function normalizeUsage(value: unknown): UsageView | undefined {
	const usage = object(value);
	if (!usage) return undefined;
	const number = (key: string) => typeof usage[key] === "number" && Number.isFinite(usage[key]) ? usage[key] as number : 0;
	const cost = object(usage.cost) ?? {};
	const costNumber = (key: string) => typeof cost[key] === "number" && Number.isFinite(cost[key]) ? cost[key] as number : 0;
	const reasoning = typeof usage.reasoning === "number" && Number.isFinite(usage.reasoning) ? usage.reasoning : undefined;
	return {
		input: number("input"), cacheRead: number("cacheRead"), cacheWrite: number("cacheWrite"),
		output: number("output"), reasoning, totalTokens: number("totalTokens"),
		cost: {
			input: costNumber("input"), cacheRead: costNumber("cacheRead"), cacheWrite: costNumber("cacheWrite"),
			output: costNumber("output"), total: costNumber("total"),
		},
	};
}

export function serializeJson(value: unknown): { json?: string; diagnostic?: string } {
	try {
		const json = JSON.stringify(value, null, 2);
		return json === undefined ? { diagnostic: "Value has no JSON representation." } : { json };
	} catch (error) {
		return { diagnostic: `JSON serialization failed: ${error instanceof Error ? error.message : String(error)}` };
	}
}
