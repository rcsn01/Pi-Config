/** Resolve model defaults from Pi's global native settings. */

import {
	getAgentDir,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

export const DEFAULT_SENTINEL = "default" as const;

export interface PiNativeDefaults {
	provider: string;
	modelId: string;
	thinkingLevel?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read only Pi's global settings, not the project settings merged on top.
 * The optional agent directory is an internal seam for tests and alternate Pi
 * configuration directories.
 */
export function readPiNativeDefaults(agentDir = getAgentDir()): PiNativeDefaults {
	const settings = SettingsManager.create(process.cwd(), agentDir).getGlobalSettings();
	if (!isRecord(settings)) {
		throw new Error("Pi's native global settings must contain a JSON object.");
	}

	const provider = settings.defaultProvider;
	const modelId = settings.defaultModel;
	if (typeof provider !== "string" || !provider.trim() || typeof modelId !== "string" || !modelId.trim()) {
		throw new Error("Pi's native defaultProvider and defaultModel must be configured.");
	}

	return {
		provider,
		modelId,
		thinkingLevel: typeof settings.defaultThinkingLevel === "string"
			? settings.defaultThinkingLevel
			: undefined,
	};
}

/**
 * Read Pi's configured default provider, or undefined when unset. The optional
 * agent directory is an internal seam for tests and alternate Pi configuration
 * directories.
 */
export function readDefaultProvider(agentDir = getAgentDir()): string | undefined {
	const provider = SettingsManager.create(process.cwd(), agentDir).getDefaultProvider();
	return typeof provider === "string" && provider.trim() ? provider : undefined;
}

/**
 * Write Pi's global native defaults (provider, model, and optionally the
 * thinking level). This is a global-scope, cwd-independent write, so there is
 * no cwd parameter. Throws the joined drain-errors message on failure; callers
 * rewrap with their own prefix.
 */
export async function writePiNativeDefaults(
	agentDir: string | undefined,
	defaults: { provider: string; modelId: string; thinkingLevel?: string },
): Promise<void> {
	const settings = SettingsManager.create(process.cwd(), agentDir ?? getAgentDir());
	settings.setDefaultModelAndProvider(defaults.provider, defaults.modelId);
	if (defaults.thinkingLevel !== undefined) {
		settings.setDefaultThinkingLevel(defaults.thinkingLevel as ModelThinkingLevel);
	}
	await settings.flush();
	const errors = settings.drainErrors();
	if (errors.length > 0) {
		throw new Error(errors.map(({ scope, error }) => `${scope}: ${error.message}`).join("; "));
	}
}
