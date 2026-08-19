/**
 * Shared model-selection application for the ui-model-selector extension.
 *
 * `applyStoredProfile` is the single routine that turns a saved
 * `uiModelSelector.profiles.<mode>` selection into a live session model
 * (catalogue lookup, scoped-model check, context window resolution,
 * `pi.setModel`, thinking level, compaction sync). It is used by
 * ui-model-selector on startup and by config-profiles after a profile
 * switch, so a switched profile's model applies to the current session
 * instead of only to fresh sessions.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_SENTINEL,
	readPiNativeDefaults,
	type PiNativeDefaults,
} from "../_shared/pi-defaults.ts";
import {
	MODEL_THINKING_LEVELS,
	parseProjectModelPreferences,
	resolveContextWindow,
	resolveModelContext,
	type ModelSelectionMode,
	type ModelSelectionSettings,
	type StoredModelSelectionSettings,
	type StoredThinkingLevel,
} from "./model-config.ts";
import {
	createProjectSettingsStore,
	type ProjectSettingsStore,
} from "./settings-store.ts";

export type { ProjectSettingsStore } from "./settings-store.ts";
export { createProjectSettingsStore } from "./settings-store.ts";

type ResolvedStoredSelection = Omit<StoredModelSelectionSettings, "thinkingLevel"> & {
	thinkingLevel: StoredThinkingLevel;
};

export function selectionModeFromEntries(entries: readonly unknown[]): ModelSelectionMode {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index] as { type?: unknown; customType?: unknown; data?: unknown };
		if (entry?.type !== "custom" || entry.customType !== "plan-mode-state") continue;
		const data = entry.data as { active?: unknown } | undefined;
		return data?.active === true ? "plan" : "normal";
	}
	return "normal";
}

export function currentSelectionMode(ctx: ExtensionContext): ModelSelectionMode {
	return selectionModeFromEntries(ctx.sessionManager.getBranch());
}

function resolveStoredSelection(
	profile: StoredModelSelectionSettings,
	fallbackThinkingLevel: StoredThinkingLevel,
	nativeDefaults?: PiNativeDefaults,
): ResolvedStoredSelection {
	const needsNativeDefaults = profile.provider === DEFAULT_SENTINEL ||
		profile.modelId === DEFAULT_SENTINEL ||
		profile.thinkingLevel === DEFAULT_SENTINEL;
	const defaults = needsNativeDefaults ? (nativeDefaults ?? readPiNativeDefaults()) : undefined;
	const thinkingLevel = profile.thinkingLevel === DEFAULT_SENTINEL
		? defaults?.thinkingLevel ?? fallbackThinkingLevel
		: profile.thinkingLevel;
	if (!MODEL_THINKING_LEVELS.includes(thinkingLevel as StoredThinkingLevel)) {
		throw new Error(`Pi's native defaultThinkingLevel is not supported: ${String(thinkingLevel)}.`);
	}

	return {
		provider: profile.provider === DEFAULT_SENTINEL ? defaults!.provider : profile.provider,
		modelId: profile.modelId === DEFAULT_SENTINEL ? defaults!.modelId : profile.modelId,
		thinkingLevel: thinkingLevel as StoredThinkingLevel,
		contextWindow: profile.contextWindow,
	};
}

export async function applyStoredProfile(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	profile: StoredModelSelectionSettings,
	settingsStore: ProjectSettingsStore,
	label = "Normal profile",
	nativeDefaults?: PiNativeDefaults,
): Promise<ModelSelectionSettings> {
	const fallbackThinkingLevel = typeof pi.getThinkingLevel === "function"
		? pi.getThinkingLevel() as StoredThinkingLevel
		: "medium";
	const resolvedProfile = resolveStoredSelection(profile, fallbackThinkingLevel, nativeDefaults);
	const refresh = await ctx.modelRegistry.refresh({
		allowNetwork: false,
		providers: [resolvedProfile.provider],
	});
	if (refresh.aborted) throw new Error(`Refreshing ${resolvedProfile.provider} was aborted.`);
	const refreshError = refresh.errors.get(resolvedProfile.provider);
	if (refreshError) throw refreshError;
	const catalogueModel = ctx.modelRegistry.find(resolvedProfile.provider, resolvedProfile.modelId);
	if (!catalogueModel) {
		throw new Error(`${label} model ${resolvedProfile.provider}/${resolvedProfile.modelId} is unavailable.`);
	}
	if (
		ctx.scopedModels.length > 0 &&
		!ctx.scopedModels.some((entry) =>
			entry.model.provider === resolvedProfile.provider && entry.model.id === resolvedProfile.modelId
		)
	) {
		throw new Error(`${label} model ${resolvedProfile.provider}/${resolvedProfile.modelId} is outside this session's model scope.`);
	}
	const contextWindow = resolvedProfile.contextWindow === DEFAULT_SENTINEL
		? catalogueModel.contextWindow
		: resolveContextWindow(resolvedProfile.contextWindow);
	const model = {
		...resolveModelContext(catalogueModel),
		contextWindow,
	};
	if (!(await pi.setModel(model))) {
		throw new Error(`No configured authentication for ${resolvedProfile.provider}/${resolvedProfile.modelId}.`);
	}
	pi.setThinkingLevel(resolvedProfile.thinkingLevel);
	await settingsStore.syncCompaction(model.contextWindow);
	return {
		provider: resolvedProfile.provider,
		modelId: resolvedProfile.modelId,
		thinkingLevel: resolvedProfile.thinkingLevel,
		contextWindow: model.contextWindow,
	};
}

/**
 * Apply the model selection saved for the current mode (normal or plan) in a
 * settings document — typically the profile that was just switched to.
 * Returns the applied selection, or undefined when the document has no
 * selection for the current mode (the session model is kept unchanged).
 */
export async function applyProfileModelSelection(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	document: Record<string, unknown>,
	settingsStore: ProjectSettingsStore = createProjectSettingsStore(),
	nativeDefaults?: PiNativeDefaults,
): Promise<ModelSelectionSettings | undefined> {
	const mode = currentSelectionMode(ctx);
	const selection = parseProjectModelPreferences(document).profiles[mode];
	if (!selection) return undefined;
	return applyStoredProfile(pi, ctx, selection, settingsStore, "Profile", nativeDefaults);
}
