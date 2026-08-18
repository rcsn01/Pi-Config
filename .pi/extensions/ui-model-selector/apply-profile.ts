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
	parseProjectModelPreferences,
	resolveContextWindow,
	resolveModelContext,
	type ModelSelectionMode,
	type ModelSelectionSettings,
} from "./model-config.ts";
import {
	createProjectSettingsStore,
	type ProjectSettingsStore,
} from "./settings-store.ts";

export type { ProjectSettingsStore } from "./settings-store.ts";
export { createProjectSettingsStore } from "./settings-store.ts";

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

export async function applyStoredProfile(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	profile: ModelSelectionSettings,
	settingsStore: ProjectSettingsStore,
	label = "Normal profile",
): Promise<void> {
	const refresh = await ctx.modelRegistry.refresh({ allowNetwork: false, providers: [profile.provider] });
	if (refresh.aborted) throw new Error(`Refreshing ${profile.provider} was aborted.`);
	const refreshError = refresh.errors.get(profile.provider);
	if (refreshError) throw refreshError;
	const catalogueModel = ctx.modelRegistry.find(profile.provider, profile.modelId);
	if (!catalogueModel) throw new Error(`${label} model ${profile.provider}/${profile.modelId} is unavailable.`);
	if (
		ctx.scopedModels.length > 0 &&
		!ctx.scopedModels.some((entry) => entry.model.provider === profile.provider && entry.model.id === profile.modelId)
	) {
		throw new Error(`${label} model ${profile.provider}/${profile.modelId} is outside this session's model scope.`);
	}
	// Honor the profile's configured context window; the catalogue value is only
	// a fallback when the profile does not pin one.
	const model = {
		...resolveModelContext(catalogueModel),
		contextWindow: resolveContextWindow(profile.contextWindow),
	};
	if (!(await pi.setModel(model))) {
		throw new Error(`No configured authentication for ${profile.provider}/${profile.modelId}.`);
	}
	pi.setThinkingLevel(profile.thinkingLevel);
	await settingsStore.syncCompaction(model.contextWindow);
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
): Promise<ModelSelectionSettings | undefined> {
	const mode = currentSelectionMode(ctx);
	const selection = parseProjectModelPreferences(document).profiles[mode];
	if (!selection) return undefined;
	await applyStoredProfile(pi, ctx, selection, settingsStore, "Profile");
	return selection;
}
