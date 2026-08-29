/**
 * Plan-mode-specific model profile machinery.
 *
 * The shared parse/merge/validate/resolve/apply of project model selections
 * lives in `../_shared/model-selection.ts` (and its store in
 * `../_shared/model-selection-store.ts`). This module keeps only what is
 * genuinely plan-mode-specific: the PlanModeProfileStore adapter that reads
 * and writes `uiModelSelector.profiles.plan`, and the capture/restore of Pi's
 * normal global defaults while Plan Mode is active.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import {
	mutateSettingsDocument,
	readSettingsDocument,
} from "../_shared/settings-document.ts";
import {
	mergeProjectModelSelection,
	parseProjectModelPreferences,
	validateConcreteModelSelection,
	validateStoredModelSelection,
	type ConcreteModelSelection,
	type StoredModelSelectionSettings,
} from "../_shared/model-selection.ts";

export type { ModelSelectionSettings, StoredModelSelectionSettings } from "../_shared/model-selection.ts";

/** Plan-mode model profile; a fully resolved selection (legacy reads may lack a context window). */
export type ModeModelProfile = ConcreteModelSelection;

export interface PlanModeProfileStore {
	load(): Promise<StoredModelSelectionSettings | undefined>;
	save(selection: ModeModelProfile): Promise<void>;
	/** Repoint the store at the session's profile file (default: settings.json). */
	setPath(path: string): void;
}

export interface NormalDefaultsStore {
	capture(cwd: string, fallback: ModeModelProfile): Promise<ModeModelProfile>;
	restore(cwd: string, profile: ModeModelProfile): Promise<void>;
}

export function profileLabel(
	profile: Pick<ModeModelProfile, "provider" | "modelId" | "thinkingLevel" | "contextWindow">,
): string {
	const context = profile.contextWindow === undefined
		? "legacy context"
		: `${profile.contextWindow.toLocaleString()} ctx`;
	return `${profile.provider}/${profile.modelId} · ${profile.thinkingLevel} · ${context}`;
}

export function profileFromCurrentSession(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
): ModeModelProfile | undefined {
	if (!ctx.model) return undefined;
	return {
		provider: ctx.model.provider,
		modelId: ctx.model.id,
		thinkingLevel: pi.getThinkingLevel() as ConcreteModelSelection["thinkingLevel"],
		contextWindow: ctx.model.contextWindow,
	};
}

/**
 * Plan-mode profile store. Reads/writes `uiModelSelector.profiles.plan` in the
 * session's settings document (a profile file when one is bound, else
 * settings.json).
 */
export function createPlanModeProfileStore(path: string): PlanModeProfileStore {
	let currentPath = path;
	return {
		async load() {
			try {
				const profile = parseProjectModelPreferences(readSettingsDocument(currentPath)).profiles.plan;
				return profile ? validateStoredModelSelection(profile) : undefined;
			} catch (error) {
				throw new Error(`Cannot load the Plan Mode profile from ${currentPath}: ${error instanceof Error ? error.message : String(error)}`);
			}
		},

		async save(profile) {
			const validated = validateConcreteModelSelection(profile, "Plan Mode profile");
			const contextWindow = validated.contextWindow;
			if (contextWindow === undefined) {
				throw new Error("Plan Mode profile contextWindow must be a positive integer.");
			}
			await mutateSettingsDocument(currentPath, (settings) =>
				mergeProjectModelSelection(settings, "plan", {
					provider: validated.provider,
					modelId: validated.modelId,
					thinkingLevel: validated.thinkingLevel,
					contextWindow,
				}),
			);
		},

		setPath(nextPath) {
			currentPath = nextPath;
		},
	};
}

function settingsErrorMessage(errors: ReturnType<SettingsManager["drainErrors"]>): string | undefined {
	if (errors.length === 0) return undefined;
	return errors.map(({ scope, error }) => `${scope}: ${error.message}`).join("; ");
}

export function createNormalDefaultsStore(agentDir = getAgentDir()): NormalDefaultsStore {
	return {
		async capture(cwd, fallback) {
			const validatedFallback = validateConcreteModelSelection(fallback, "Normal profile fallback");
			const settings = SettingsManager.create(cwd, agentDir).getGlobalSettings();
			const hasConfiguredModel = typeof settings.defaultProvider === "string" && settings.defaultProvider.length > 0 &&
				typeof settings.defaultModel === "string" && settings.defaultModel.length > 0;
			return {
				provider: hasConfiguredModel ? settings.defaultProvider! : validatedFallback.provider,
				modelId: hasConfiguredModel ? settings.defaultModel! : validatedFallback.modelId,
				thinkingLevel: settings.defaultThinkingLevel ?? validatedFallback.thinkingLevel,
				contextWindow: validatedFallback.contextWindow,
			};
		},

		async restore(cwd, profile) {
			const validated = validateConcreteModelSelection(profile, "Normal global defaults");
			const settings = SettingsManager.create(cwd, agentDir);
			settings.setDefaultModelAndProvider(validated.provider, validated.modelId);
			settings.setDefaultThinkingLevel(validated.thinkingLevel);
			await settings.flush();
			const error = settingsErrorMessage(settings.drainErrors());
			if (error) throw new Error(`Could not restore Pi's normal defaults: ${error}`);
		},
	};
}

export async function preserveNormalGlobalDefaults(
	ctx: ExtensionContext,
	defaults: ModeModelProfile | undefined,
	waitForNativePersistence: () => Promise<void>,
	normalDefaultsStore: NormalDefaultsStore,
): Promise<void> {
	if (!defaults) return;
	await waitForNativePersistence();
	await normalDefaultsStore.restore(ctx.cwd, defaults);
}
