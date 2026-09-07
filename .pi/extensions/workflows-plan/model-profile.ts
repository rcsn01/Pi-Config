/**
 * Plan Mode model labels, current-session capture, and Pi native global-default
 * capture and restoration. Model-selection persistence lives in
 * `../_shared/model-selection-persistence.ts`.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import { writePiNativeDefaults } from "../_shared/pi-defaults.ts";
import {
	validateConcreteModelSelection,
	type ConcreteModelSelection,
} from "../_shared/model-selection.ts";

export type { ModelSelectionSettings, StoredModelSelectionSettings } from "../_shared/model-selection.ts";

/** Plan-mode model profile; a fully resolved selection (legacy reads may lack a context window). */
export type ModeModelProfile = ConcreteModelSelection;

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
			try {
				await writePiNativeDefaults(agentDir, {
					provider: validated.provider,
					modelId: validated.modelId,
					thinkingLevel: validated.thinkingLevel,
				});
			} catch (error) {
				throw new Error(`Could not restore Pi's normal defaults: ${error instanceof Error ? error.message : String(error)}`);
			}
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
