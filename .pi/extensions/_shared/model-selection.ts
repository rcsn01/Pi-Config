/**
 * Project model selection — the canonical home for `uiModelSelector` parsing,
 * validation, merging, sentinel resolution, and runtime model commits.
 *
 * Two focused entry points share one private runtime implementation:
 * - `applyModelSelection` resolves a stored Session/Plan profile and syncs its
 *   model-derived compaction settings without rewriting the stored selection.
 * - `applyPickedModelSelection` applies an already-refreshed picker model and
 *   persists the effective selection (including Pi's clamped thinking level).
 *
 * Stored selections preserve legacy context inheritance and default-sentinel
 * resolution. Picked selections trust the concrete model supplied by the
 * refreshed picker catalogue and never query the registry a second time.
 */

import type { Model, ThinkingLevelMap } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_SENTINEL,
	readPiNativeDefaults,
	type PiNativeDefaults,
} from "./pi-defaults.ts";
import { matchFamily } from "./model-families.ts";
import { PLAN_STATE_ENTRY_TYPE } from "./session-entries.ts";

export interface ModelChoiceLike {
	provider: string;
	id: string;
	name: string;
	contextWindow: number;
	reasoning: boolean;
	thinkingLevelMap?: ThinkingLevelMap;
}

const MODEL_THINKING_LEVELS = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const;

type StoredThinkingLevel = typeof MODEL_THINKING_LEVELS[number];
type StoredProfileValue = typeof DEFAULT_SENTINEL;

export type ModelSelectionMode = "normal" | "plan";

/** Fraction of each model context window reserved for the response before compaction. */
export const DEFAULT_COMPACTION_THRESHOLD = 0.1;

/** Recent tokens kept (not summarized) when compaction runs, when none is configured. */
export const DEFAULT_KEEP_RECENT_TOKENS = 25_600;

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

/** Narrow seam for synchronizing model-derived compaction settings. */
export interface ModelCompactionSynchronizer {
	syncCompaction(contextWindow: number): Promise<void>;
}

/** Narrow seam for persisting one mode's effective model selection. */
export interface ModelSelectionPersistence {
	save(mode: ModelSelectionMode, selection: ModelSelectionSettings): Promise<void>;
}

/** A picked selection was applied live, but its effective settings did not fully persist. */
export class ModelSelectionPersistenceError extends Error {
	readonly appliedSelection: ModelSelectionSettings;

	constructor(appliedSelection: ModelSelectionSettings, cause: unknown) {
		super(
		`Model selection was applied, but settings were not fully saved: ${cause instanceof Error ? cause.message : String(cause)}`,
		{ cause },
		);
		this.name = "ModelSelectionPersistenceError";
		this.appliedSelection = appliedSelection;
	}
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
	/** Fraction of the active context window reserved for the model response. */
	compactionThreshold: number;
	/** Recent tokens to keep (not summarized) when compaction runs. */
	keepRecentTokens: number;
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

function validateStoredContextWindow(value: unknown, label: string): number | StoredProfileValue | undefined {
	if (value === DEFAULT_SENTINEL) return DEFAULT_SENTINEL;
	if (value === undefined) return undefined;
	return validateContextWindow(value, label);
}

function validateCompactionThreshold(value: unknown): number {
	if (value === undefined) return DEFAULT_COMPACTION_THRESHOLD;
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value >= 1) {
		throw new Error("compaction.threshold must be a finite number greater than 0 and less than 1.");
	}
	return value;
}

function validateKeepRecentTokens(value: unknown): number {
	if (value === undefined) return DEFAULT_KEEP_RECENT_TOKENS;
	if (!Number.isInteger(value) || (value as number) <= 0) {
		throw new Error("compaction.keepRecentTokens must be a positive integer.");
	}
	return value as number;
}

export function calculateCompactionReserveTokens(
	contextWindow: number,
	threshold = DEFAULT_COMPACTION_THRESHOLD,
): number {
	const validatedContextWindow = validateContextWindow(contextWindow, "contextWindow");
	const validatedThreshold = validateCompactionThreshold(threshold);
	return Math.ceil(validatedContextWindow * validatedThreshold);
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
	const compaction = nestedRecord(settings, "compaction", "compaction");
	return {
		profiles: validateProfiles(selector.profiles),
		contextWindows: validateContextWindows(selector.contextWindows),
		compactionThreshold: validateCompactionThreshold(compaction.threshold),
		keepRecentTokens: validateKeepRecentTokens(compaction.keepRecentTokens),
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
			keepRecentTokens: preferences.keepRecentTokens,
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
		const data = entry.data as { active?: unknown } | undefined;
		return data?.active === true ? "plan" : "normal";
	}
	return "normal";
}

export function currentSelectionMode(ctx: ExtensionContext): ModelSelectionMode {
	return selectionModeFromEntries(ctx.sessionManager.getBranch());
}

type ResolvedContextWindow =
	| { kind: "stored"; value: number }
	| { kind: "catalogue" }
	| { kind: "inherit" };

type ResolvedModelSelection = {
	provider: string;
	modelId: string;
	thinkingLevel: StoredThinkingLevel;
	contextWindow: ResolvedContextWindow;
};

function resolveStoredSelection(
	stored: StoredModelSelectionSettings,
	fallbackThinkingLevel: StoredThinkingLevel,
	nativeDefaults?: PiNativeDefaults,
): ResolvedModelSelection {
	const needsNativeDefaults = stored.provider === DEFAULT_SENTINEL ||
		stored.modelId === DEFAULT_SENTINEL ||
		stored.thinkingLevel === DEFAULT_SENTINEL;
	const defaults = needsNativeDefaults ? (nativeDefaults ?? readPiNativeDefaults()) : undefined;
	const thinkingLevel = stored.thinkingLevel === DEFAULT_SENTINEL
		? defaults?.thinkingLevel ?? fallbackThinkingLevel
		: stored.thinkingLevel;
	if (!MODEL_THINKING_LEVELS.includes(thinkingLevel as StoredThinkingLevel)) {
		throw new Error(`Pi's native defaultThinkingLevel is not supported: ${String(thinkingLevel)}.`);
	}

	return {
		provider: stored.provider === DEFAULT_SENTINEL ? defaults!.provider : stored.provider,
		modelId: stored.modelId === DEFAULT_SENTINEL ? defaults!.modelId : stored.modelId,
		thinkingLevel: thinkingLevel as StoredThinkingLevel,
		contextWindow: stored.contextWindow === DEFAULT_SENTINEL
			? { kind: "catalogue" }
			: stored.contextWindow === undefined
				? { kind: "inherit" }
				: { kind: "stored", value: stored.contextWindow },
	};
}

/** Refresh the registry for one provider and return its catalogue model. */
async function resolveProfileModel(
	ctx: ExtensionContext,
	provider: string,
	modelId: string,
	label: string,
): Promise<Model<any>> {
	const refresh = await ctx.modelRegistry.refresh({ allowNetwork: false, providers: [provider] });
	if (refresh.aborted) throw new Error(`Refreshing ${provider} was aborted.`);
	const refreshError = refresh.errors.get(provider);
	if (refreshError) throw refreshError;
	const model = ctx.modelRegistry.find(provider, modelId);
	if (!model) throw new Error(`${label} model ${provider}/${modelId} is unavailable.`);
	if (
		ctx.scopedModels.length > 0 &&
		!ctx.scopedModels.some((entry) =>
			entry.model.provider === provider && entry.model.id === modelId
		)
	) {
		throw new Error(`${label} model ${provider}/${modelId} is outside this session's model scope.`);
	}
	return model;
}

async function applyResolvedModelSelection(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	model: Model<any>,
	thinkingLevel: StoredThinkingLevel,
): Promise<ModelSelectionSettings> {
	const currentModel = ctx.model;
	const modelChanged = currentModel?.provider !== model.provider ||
		currentModel.id !== model.id ||
		currentModel.contextWindow !== model.contextWindow;
	if (modelChanged && !(await pi.setModel(model))) {
		throw new Error(`No configured authentication for ${model.provider}/${model.id}.`);
	}

	const currentThinkingLevel = typeof pi.getThinkingLevel === "function"
		? pi.getThinkingLevel() as StoredThinkingLevel
		: undefined;
	if (currentThinkingLevel !== thinkingLevel) pi.setThinkingLevel(thinkingLevel);
	const effectiveThinkingLevel = typeof pi.getThinkingLevel === "function"
		? pi.getThinkingLevel() as StoredThinkingLevel
		: thinkingLevel;

	return {
		provider: model.provider,
		modelId: model.id,
		thinkingLevel: effectiveThinkingLevel,
		contextWindow: model.contextWindow,
	};
}

/**
 * Apply a stored selection to the live session: resolve default sentinels,
 * refresh and look up the model when needed, commit the resolved model and
 * thinking level, and sync model-derived compaction values. The stored profile
 * itself is not persisted.
 *
 * The context-window contract preserves legacy plan-mode reads: an explicit
 * sentinel resolves through the catalogue; a missing window inherits the
 * current model's window when the model already matches.
 */
export async function applyModelSelection(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	stored: StoredModelSelectionSettings,
	options: {
		/** Label used in error messages, e.g. "Normal profile" or "Plan Mode profile". */
		label: string;
		/** Receives the model-derived compaction sync. */
		compaction: ModelCompactionSynchronizer;
		nativeDefaults?: PiNativeDefaults;
	},
): Promise<ModelSelectionSettings> {
	const fallbackThinkingLevel = typeof pi.getThinkingLevel === "function"
		? pi.getThinkingLevel() as StoredThinkingLevel
		: "medium";
	const resolved = resolveStoredSelection(stored, fallbackThinkingLevel, options.nativeDefaults);
	const currentModel = ctx.model;
	const sameModel = currentModel?.provider === resolved.provider && currentModel.id === resolved.modelId;
	const context = resolved.contextWindow;

	let model: Model<any>;
	if (sameModel && context.kind !== "catalogue") {
		if (context.kind === "inherit") {
			// Legacy selections without a context: keep the current window.
			model = currentModel;
		} else {
			const contextWindow = resolveContextWindow(context.value);
			model = contextWindow === currentModel.contextWindow
				? currentModel
				: { ...currentModel, contextWindow };
		}
	} else {
		const catalogueModel = await resolveProfileModel(ctx, resolved.provider, resolved.modelId, options.label);
		const contextWindow = context.kind === "catalogue"
			? catalogueModel.contextWindow
			: context.kind === "stored"
				? resolveContextWindow(context.value)
				: catalogueModel.contextWindow;
		model = { ...resolveModelContext(catalogueModel), contextWindow };
	}

	const selection = await applyResolvedModelSelection(pi, ctx, model, resolved.thinkingLevel);
	await options.compaction.syncCompaction(selection.contextWindow);
	return selection;
}

/**
 * Apply a concrete model selected from an already-refreshed picker catalogue,
 * then persist Pi's effective selection. Persistence failures happen after the
 * live commit, so they are surfaced as a typed partial failure without rolling
 * the runtime model back.
 */
export async function applyPickedModelSelection(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	model: Model<any>,
	thinkingLevel: StoredThinkingLevel,
	options: {
		mode: ModelSelectionMode;
		persistence: ModelSelectionPersistence;
	},
): Promise<ModelSelectionSettings> {
	const selection = await applyResolvedModelSelection(pi, ctx, model, thinkingLevel);
	try {
		await options.persistence.save(options.mode, selection);
	} catch (cause) {
		throw new ModelSelectionPersistenceError(selection, cause);
	}
	return selection;
}

/**
 * Apply the model selection saved for the current mode (normal or plan) in a
 * settings document — typically the profile that was just switched to.
 * Returns the applied selection, or undefined when the document has no
 * selection for the current mode (the session model is kept unchanged).
 */
export async function applySelectionFromDocument(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	document: Record<string, unknown>,
	compaction: ModelCompactionSynchronizer,
	nativeDefaults?: PiNativeDefaults,
): Promise<ModelSelectionSettings | undefined> {
	const mode = selectionModeFromEntries(ctx.sessionManager.getBranch());
	const selection = parseProjectModelPreferences(document).profiles[mode];
	if (!selection) return undefined;
	return applyModelSelection(pi, ctx, selection, {
		label: "Profile",
		compaction,
		nativeDefaults,
	});
}
