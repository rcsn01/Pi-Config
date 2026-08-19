/** Resolve model defaults from Pi's global native settings. */

import {
	getAgentDir,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

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
