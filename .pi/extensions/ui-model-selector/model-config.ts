import type { ThinkingLevelMap } from "@earendil-works/pi-ai";
import { DEFAULT_SENTINEL } from "../_shared/pi-defaults.ts";
import { matchFamily } from "./model-families.ts";

export interface ModelChoiceLike {
	provider: string;
	id: string;
	name: string;
	contextWindow: number;
	reasoning: boolean;
	thinkingLevelMap?: ThinkingLevelMap;
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
export type StoredProfileValue = typeof DEFAULT_SENTINEL;

export type ModelSelectionMode = "normal" | "plan";

/** Fraction of each model context window reserved for the response before compaction. */
export const DEFAULT_COMPACTION_THRESHOLD = 0.1;

/** A fully resolved selection suitable for Pi's runtime APIs and persistence. */
export interface ModelSelectionSettings {
	provider: string;
	modelId: string;
	thinkingLevel: StoredThinkingLevel;
	contextWindow: number;
}

/** A profile selection as stored on disk; fields may defer to Pi's defaults. */
export interface StoredModelSelectionSettings {
	provider: string;
	modelId: string;
	thinkingLevel: StoredThinkingLevel | StoredProfileValue;
	contextWindow: number | StoredProfileValue;
}

export interface ProjectModelPreferences {
	profiles: Partial<Record<ModelSelectionMode, StoredModelSelectionSettings>>;
	/** Legacy model-keyed contexts, read only as a migration fallback. */
	contextWindows: Record<string, number>;
	/** Fraction of the active context window reserved for the model response. */
	compactionThreshold: number;
}

/** Default context window applied when a model entry declares none. */
export const DEFAULT_CONTEXT_WINDOW = 256_000;

/** pi's fallback context window applied when a model entry declares none. */
export const PI_DEFAULT_CONTEXT_WINDOW = 128_000;

export function resolveContextWindow(contextWindow: number): number {
	// pi assigns this sentinel when a model declares no contextWindow; treat that
	// as "unspecified" and default it to DEFAULT_CONTEXT_WINDOW instead of 128K.
	if (contextWindow === PI_DEFAULT_CONTEXT_WINDOW) {
		return DEFAULT_CONTEXT_WINDOW;
	}
	return contextWindow;
}

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

function validateStoredContextWindow(value: unknown, label: string): number | StoredProfileValue {
	if (value === DEFAULT_SENTINEL) return DEFAULT_SENTINEL;
	return validateContextWindow(value, label);
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

function validateStoredThinkingLevel(value: unknown, label: string): StoredThinkingLevel | StoredProfileValue {
	if (value === DEFAULT_SENTINEL) return DEFAULT_SENTINEL;
	if (typeof value !== "string" || !MODEL_THINKING_LEVELS.includes(value as StoredThinkingLevel)) {
		throw new Error(`${label} is not supported.`);
	}
	return value as StoredThinkingLevel;
}

function validateSelection(value: unknown, label: string): StoredModelSelectionSettings {
	if (!isRecord(value)) throw new Error(`${label} must be a JSON object.`);
	return {
		provider: requiredNonEmptyString(value.provider, `${label}.provider`),
		modelId: requiredNonEmptyString(value.modelId, `${label}.modelId`),
		thinkingLevel: validateStoredThinkingLevel(value.thinkingLevel, `${label}.thinkingLevel`),
		contextWindow: validateStoredContextWindow(value.contextWindow, `${label}.contextWindow`),
	};
}

function validateProfiles(value: unknown): Partial<Record<ModelSelectionMode, StoredModelSelectionSettings>> {
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

/**
 * Apply a family-level thinkingLevelMap when a reasoning model declares none of
 * its own. Models reporting their own levels (even an empty-looking map) are
 * left untouched, as are non-reasoning models.
 */
export function applyFamilyThinkingLevel<T extends ModelChoiceLike>(model: T): T {
	if (!model.reasoning) return model;
	if (model.thinkingLevelMap && Object.keys(model.thinkingLevelMap).length > 0) return model;
	const familyLevels = matchFamily(model.id);
	if (!familyLevels) return model;
	return { ...model, thinkingLevelMap: familyLevels };
}

export function resolveModelContext<T extends ModelChoiceLike>(model: T): T {
	const withFamilyLevels = applyFamilyThinkingLevel(model);
	const contextWindow = resolveContextWindow(withFamilyLevels.contextWindow);
	return contextWindow === withFamilyLevels.contextWindow
		? withFamilyLevels
		: { ...withFamilyLevels, contextWindow };
}
