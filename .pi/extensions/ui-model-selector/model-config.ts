export interface ModelChoiceLike {
	provider: string;
	id: string;
	name: string;
	contextWindow: number;
	reasoning: boolean;
}

export interface ContextWindowChoice {
	label: string;
	value: number;
	description: string;
}

export type SessionStartReason = "startup" | "reload" | "new" | "resume" | "fork";

export const MODEL_THINKING_LEVELS = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const;

export type StoredThinkingLevel = typeof MODEL_THINKING_LEVELS[number];

export type ModelSelectionMode = "normal" | "plan";

/** Fraction of each model context window reserved for the response before compaction. */
export const DEFAULT_COMPACTION_THRESHOLD = 0.1;

export interface ModelSelectionSettings {
	provider: string;
	modelId: string;
	thinkingLevel: StoredThinkingLevel;
	contextWindow: number;
}

export interface ProjectModelPreferences {
	profiles: Partial<Record<ModelSelectionMode, ModelSelectionSettings>>;
	/** Legacy model-keyed contexts, read only as a migration fallback. */
	contextWindows: Record<string, number>;
	/** Fraction of the active context window reserved for the model response. */
	compactionThreshold: number;
}

export const GPT_56_SHORT_CONTEXT = 272_000;
export const GPT_56_LONG_CONTEXT = 1_050_000;

const GPT_56_DUAL_CONTEXT_IDS = new Set([
	"gpt-5.6-sol",
	"gpt-5.6-terra",
	"gpt-5.6-luna",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nestedRecord(
	parent: Record<string, unknown>,
	key: string,
	label: string,
): Record<string, unknown> {
	const value = parent[key];
	if (value === undefined) return {};
	if (!isRecord(value)) throw new Error(`${label} must be a JSON object.`);
	return value;
}

export function formatTokenCount(tokens: number): string {
	if (tokens >= 1_000_000) {
		const millions = tokens / 1_000_000;
		return `${Number.isInteger(millions) ? millions.toFixed(0) : millions.toFixed(2)}M`;
	}
	if (tokens >= 1_000) {
		const thousands = tokens / 1_000;
		return `${Number.isInteger(thousands) ? thousands.toFixed(0) : thousands.toFixed(1)}K`;
	}
	return String(tokens);
}

export function supportsContextProfiles(modelId: string): boolean {
	return GPT_56_DUAL_CONTEXT_IDS.has(modelId.toLowerCase());
}

export function hasExplicitModelArgument(argv: readonly string[]): boolean {
	return argv.some((argument) => argument === "--model" || argument.startsWith("--model="));
}

export function shouldOpenStartupModelSelector(
	reason: SessionStartReason,
	hasConversationHistory: boolean,
	argv: readonly string[],
): boolean {
	if (hasExplicitModelArgument(argv)) return false;
	if (reason === "new") return true;
	return reason === "startup" && !hasConversationHistory;
}

export function getContextWindowChoices(model: Pick<ModelChoiceLike, "id" | "contextWindow">): ContextWindowChoice[] {
	if (!supportsContextProfiles(model.id)) {
		return [{
			label: formatTokenCount(model.contextWindow),
			value: model.contextWindow,
			description: "Context window supplied by the model catalogue",
		}];
	}

	return [
		{
			label: "272K",
			value: GPT_56_SHORT_CONTEXT,
			description: "Short-context profile; compacts before the long-context range",
		},
		{
			label: "1.05M",
			value: GPT_56_LONG_CONTEXT,
			description: "Long-context profile; allows up to 1.05M tokens",
		},
	];
}

export function findExactModel<T extends ModelChoiceLike>(models: readonly T[], reference: string): T | undefined {
	const normalized = reference.trim().toLowerCase();
	if (!normalized) return undefined;

	const canonical = models.find(
		(model) => `${model.provider}/${model.id}`.toLowerCase() === normalized,
	);
	if (canonical) return canonical;

	const idMatches = models.filter((model) => model.id.toLowerCase() === normalized);
	return idMatches.length === 1 ? idMatches[0] : undefined;
}

export function filterModels<T extends ModelChoiceLike>(models: readonly T[], query: string): T[] {
	const normalized = query.trim().toLowerCase();
	const terms = normalized.split(/\s+/).filter(Boolean);

	return models
		.map((model) => {
			const canonical = `${model.provider}/${model.id}`.toLowerCase();
			const id = model.id.toLowerCase();
			const name = model.name.toLowerCase();
			const searchText = `${canonical} ${name}`;
			if (!terms.every((term) => searchText.includes(term))) return undefined;

			let score = 100;
			if (!normalized) score = 0;
			else if (canonical === normalized) score = -100;
			else if (id === normalized) score = -90;
			else if (canonical.startsWith(normalized)) score = -70;
			else if (id.startsWith(normalized)) score = -60;
			else if (name.startsWith(normalized)) score = -50;
			else score = terms.reduce((total, term) => total + searchText.indexOf(term), 0);

			return { model, canonical, score };
		})
		.filter((entry): entry is { model: T; canonical: string; score: number } => entry !== undefined)
		.sort((left, right) => left.score - right.score || left.canonical.localeCompare(right.canonical))
		.map((entry) => entry.model);
}

function requiredNonEmptyString(value: unknown, label: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string.`);
	return value;
}

function validateContextWindow(value: unknown, label: string): number {
	if (!Number.isInteger(value) || (value as number) <= 0) {
		throw new Error(`${label} must be a positive integer.`);
	}
	return value as number;
}

function validateContextWindows(value: unknown): Record<string, number> {
	if (value === undefined) return {};
	if (!isRecord(value)) throw new Error("uiModelSelector.contextWindows must be a JSON object.");

	const result: Record<string, number> = {};
	for (const [key, contextWindow] of Object.entries(value)) {
		if (!key.trim()) throw new Error("uiModelSelector.contextWindows keys must not be empty.");
		result[key] = validateContextWindow(contextWindow, `Context window for ${key}`);
	}
	return result;
}

function validateCompactionThreshold(value: unknown): number {
	if (value === undefined) return DEFAULT_COMPACTION_THRESHOLD;
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value >= 1) {
		throw new Error("compaction.threshold must be a finite number greater than 0 and less than 1.");
	}
	return value;
}

export function calculateCompactionReserveTokens(
	contextWindow: number,
	threshold = DEFAULT_COMPACTION_THRESHOLD,
): number {
	const validatedContextWindow = validateContextWindow(contextWindow, "contextWindow");
	const validatedThreshold = validateCompactionThreshold(threshold);
	return Math.ceil(validatedContextWindow * validatedThreshold);
}

function validateSelection(value: unknown, label: string): ModelSelectionSettings {
	if (!isRecord(value)) throw new Error(`${label} must be a JSON object.`);
	const thinkingLevel = value.thinkingLevel;
	if (typeof thinkingLevel !== "string" || !MODEL_THINKING_LEVELS.includes(thinkingLevel as StoredThinkingLevel)) {
		throw new Error(`${label}.thinkingLevel is not supported.`);
	}
	return {
		provider: requiredNonEmptyString(value.provider, `${label}.provider`),
		modelId: requiredNonEmptyString(value.modelId, `${label}.modelId`),
		thinkingLevel: thinkingLevel as StoredThinkingLevel,
		contextWindow: validateContextWindow(value.contextWindow, `${label}.contextWindow`),
	};
}

function validateProfiles(value: unknown): Partial<Record<ModelSelectionMode, ModelSelectionSettings>> {
	if (value === undefined) return {};
	if (!isRecord(value)) throw new Error("uiModelSelector.profiles must be a JSON object.");
	for (const key of Object.keys(value)) {
		if (key !== "normal" && key !== "plan") throw new Error(`Unsupported uiModelSelector profile: ${key}.`);
	}
	return {
		normal: value.normal === undefined ? undefined : validateSelection(value.normal, "uiModelSelector.profiles.normal"),
		plan: value.plan === undefined ? undefined : validateSelection(value.plan, "uiModelSelector.profiles.plan"),
	};
}

export function parseProjectModelPreferences(settings: unknown): ProjectModelPreferences {
	if (!isRecord(settings)) throw new Error("Project settings must contain a JSON object.");
	const selector = nestedRecord(settings, "uiModelSelector", "uiModelSelector");
	const compaction = nestedRecord(settings, "compaction", "compaction");
	return {
		profiles: validateProfiles(selector.profiles),
		contextWindows: validateContextWindows(selector.contextWindows),
		compactionThreshold: validateCompactionThreshold(compaction.threshold),
	};
}

/** Return a cloned project settings document with one mode's complete model selection merged in. */
export function mergeProjectModelSelection(
	settings: unknown,
	mode: ModelSelectionMode,
	selection: ModelSelectionSettings,
): Record<string, unknown> {
	if (!isRecord(settings)) throw new Error("Project settings must contain a JSON object.");
	parseProjectModelPreferences(settings);
	const provider = requiredNonEmptyString(selection.provider, "provider");
	const modelId = requiredNonEmptyString(selection.modelId, "modelId");
	if (!MODEL_THINKING_LEVELS.includes(selection.thinkingLevel)) {
		throw new Error("thinkingLevel is not supported.");
	}
	if (!Number.isInteger(selection.contextWindow) || selection.contextWindow <= 0) {
		throw new Error("contextWindow must be a positive integer.");
	}

	const selector = nestedRecord(settings, "uiModelSelector", "uiModelSelector");
	const profiles = validateProfiles(selector.profiles);
	const {
		defaultProvider: _legacyDefaultProvider,
		defaultModel: _legacyDefaultModel,
		defaultThinkingLevel: _legacyDefaultThinkingLevel,
		...settingsWithoutLegacyDefaults
	} = settings;
	return {
		...settingsWithoutLegacyDefaults,
		uiModelSelector: {
			...selector,
			profiles: {
				...profiles,
				[mode]: { provider, modelId, thinkingLevel: selection.thinkingLevel, contextWindow: selection.contextWindow },
			},
		},
	};
}

/** Return a cloned project settings document with compaction aligned to a context window. */
export function mergeProjectCompactionSettings(
	settings: unknown,
	contextWindow: number,
): Record<string, unknown> {
	if (!isRecord(settings)) throw new Error("Project settings must contain a JSON object.");
	const preferences = parseProjectModelPreferences(settings);
	const compaction = nestedRecord(settings, "compaction", "compaction");
	return {
		...settings,
		compaction: {
			...compaction,
			threshold: preferences.compactionThreshold,
			reserveTokens: calculateCompactionReserveTokens(contextWindow, preferences.compactionThreshold),
		},
	};
}

export function applySavedContext<T extends ModelChoiceLike>(
	model: T,
	mode: ModelSelectionMode,
	preferences: Pick<ProjectModelPreferences, "profiles" | "contextWindows">,
): T {
	const profile = preferences.profiles[mode];
	const contextWindow = profile?.provider === model.provider && profile.modelId === model.id
		? profile.contextWindow
		: preferences.contextWindows[`${model.provider}/${model.id}`];
	return contextWindow === undefined || contextWindow === model.contextWindow
		? model
		: { ...model, contextWindow };
}
