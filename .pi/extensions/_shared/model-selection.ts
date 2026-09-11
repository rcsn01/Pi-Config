/**
 * Project model selection — the stored format and its normalization: parsing,
 * validation, and merging of `uiModelSelector` settings, value types, and the
 * pure normalizers (`resolveContextWindow`, `resolveModelContext`,
 * `applyFamilyThinkingLevel`, mode detection).
 *
 * The runtime commits (sentinel resolution against Pi's native defaults, the
 * Model reference lookup, the verbatim context-window contract, thinking
 * survival across `setModel`, and the sync path) live in
 * `model-selection-runtime.ts`, which imports this module's types.
 */

import type { ThinkingLevelMap } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_SENTINEL } from "./pi-defaults.ts";
import { matchFamily } from "./model-families.ts";
import { validateContextWindow } from "./model-reference.ts";
import { MODEL_THINKING_LEVELS, type SupportedModelThinkingLevel } from "./model-thinking.ts";
import { PLAN_STATE_ENTRY_TYPE } from "./session-entries.ts";

export interface ModelChoiceLike {
	provider: string;
	id: string;
	name: string;
	contextWindow: number;
	reasoning: boolean;
	thinkingLevelMap?: ThinkingLevelMap;
}

type StoredThinkingLevel = SupportedModelThinkingLevel;
type StoredProfileValue = typeof DEFAULT_SENTINEL;

export type ModelSelectionMode = "normal" | "plan";

/** Default context window applied when a model entry declares none. */
export const DEFAULT_CONTEXT_WINDOW = 256_000;

/** pi's fallback context window applied when a model entry declares none. */
export const PI_DEFAULT_CONTEXT_WINDOW = 128_000;

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
	/** `default` resolves to the selected model's catalogue context window. */
	contextWindow?: number | StoredProfileValue;
}

/** A selection with all default sentinels resolved; context may be legacy-missing. */
export interface ConcreteModelSelection {
	provider: string;
	modelId: string;
	thinkingLevel: StoredThinkingLevel;
	/** Optional only while reading legacy v1/session state; newly captured selections include it. */
	contextWindow?: number;
}

export interface ProjectModelPreferences {
	profiles: Partial<Record<ModelSelectionMode, StoredModelSelectionSettings>>;
	/** Legacy model-keyed contexts, read only as a migration fallback. */
	contextWindows: Record<string, number>;
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

export function resolveContextWindow(contextWindow: number): number {
	// pi assigns this sentinel when a model declares no contextWindow; treat that
	// as "unspecified" and default it to DEFAULT_CONTEXT_WINDOW instead of 128K.
	if (contextWindow === PI_DEFAULT_CONTEXT_WINDOW) {
		return DEFAULT_CONTEXT_WINDOW;
	}
	return contextWindow;
}

function requiredNonEmptyString(value: unknown, label: string): string {
	if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string.`);
	return value;
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

function validateStoredContextWindow(value: unknown, label: string): number | StoredProfileValue | undefined {
	if (value === DEFAULT_SENTINEL) return DEFAULT_SENTINEL;
	if (value === undefined) return undefined;
	return validateContextWindow(value, label);
}

/**
 * Validate a stored selection: provider/modelId must be concrete non-empty
 * strings; thinkingLevel and contextWindow may be default sentinels, and a
 * legacy selection may omit contextWindow entirely.
 */
export function validateStoredModelSelection(value: unknown, label = "Model selection"): StoredModelSelectionSettings {
	if (!isRecord(value)) throw new Error(`${label} must be a JSON object.`);
	return {
		provider: requiredNonEmptyString(value.provider, `${label} provider`),
		modelId: requiredNonEmptyString(value.modelId, `${label} modelId`),
		thinkingLevel: validateStoredThinkingLevel(value.thinkingLevel, `${label} thinkingLevel`),
		contextWindow: validateStoredContextWindow(value.contextWindow, `${label} contextWindow`),
	};
}

/**
 * Validate a concrete selection: no default sentinels may remain. Legacy
 * selections without a context window are accepted and must be resolved by the
 * caller (e.g. from the catalogue or the current model) before persistence.
 */
export function validateConcreteModelSelection(value: unknown, label = "Model selection"): ConcreteModelSelection {
	const stored = validateStoredModelSelection(value, label);
	if (
		stored.provider === DEFAULT_SENTINEL ||
		stored.modelId === DEFAULT_SENTINEL ||
		stored.thinkingLevel === DEFAULT_SENTINEL ||
		stored.contextWindow === DEFAULT_SENTINEL
	) {
		throw new Error(`${label} must contain concrete model settings.`);
	}
	return {
		provider: stored.provider,
		modelId: stored.modelId,
		thinkingLevel: stored.thinkingLevel,
		contextWindow: stored.contextWindow,
	};
}

/** True when any field of a stored selection defers to Pi's native defaults. */
export function usesDefaultSentinel(selection: StoredModelSelectionSettings): boolean {
	return selection.provider === DEFAULT_SENTINEL ||
		selection.modelId === DEFAULT_SENTINEL ||
		selection.thinkingLevel === DEFAULT_SENTINEL ||
		selection.contextWindow === DEFAULT_SENTINEL;
}

function validateStoredThinkingLevel(value: unknown, label: string): StoredThinkingLevel | StoredProfileValue {
	if (value === DEFAULT_SENTINEL) return DEFAULT_SENTINEL;
	if (typeof value !== "string" || !MODEL_THINKING_LEVELS.includes(value as StoredThinkingLevel)) {
		throw new Error(`${label} is not supported.`);
	}
	return value as StoredThinkingLevel;
}

function validateProfiles(value: unknown): Partial<Record<ModelSelectionMode, StoredModelSelectionSettings>> {
	if (value === undefined) return {};
	if (!isRecord(value)) throw new Error("uiModelSelector.profiles must be a JSON object.");
	for (const key of Object.keys(value)) {
		if (key !== "normal" && key !== "plan") throw new Error(`Unsupported uiModelSelector profile: ${key}.`);
	}
	return {
		normal: value.normal === undefined ? undefined : validateStoredModelSelection(value.normal, "uiModelSelector.profiles.normal"),
		plan: value.plan === undefined ? undefined : validateStoredModelSelection(value.plan, "uiModelSelector.profiles.plan"),
	};
}

export function parseProjectModelPreferences(settings: unknown): ProjectModelPreferences {
	if (!isRecord(settings)) throw new Error("Project settings must contain a JSON object.");
	const selector = nestedRecord(settings, "uiModelSelector", "uiModelSelector");
	return {
		profiles: validateProfiles(selector.profiles),
		contextWindows: validateContextWindows(selector.contextWindows),
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

/** Which session mode (normal or plan) a selection applies to. */
export function selectionModeFromEntries(entries: readonly unknown[]): ModelSelectionMode {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index] as { type?: unknown; customType?: unknown; data?: unknown };
		if (entry?.type !== "custom" || entry.customType !== PLAN_STATE_ENTRY_TYPE) continue;
		const data = entry.data as { mode?: unknown; active?: unknown } | undefined;
		if (!data) return "normal";
		// Current workflows-plan entries record the mode; legacy entries recorded
		// a boolean. Read both so plan-mode picks land in the plan slot.
		if (data.mode === "plan") return "plan";
		if (data.mode === "default") return "normal";
		return data.active === true ? "plan" : "normal";
	}
	return "normal";
}

export function currentSelectionMode(ctx: ExtensionContext): ModelSelectionMode {
	return selectionModeFromEntries(ctx.sessionManager.getBranch());
}

