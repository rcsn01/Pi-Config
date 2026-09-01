import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { MODEL_THINKING_LEVELS } from "../_shared/model-thinking.ts";
import {
	mutateSettingsDocument,
	readSettingsDocument,
} from "../_shared/settings-document.ts";
import type { ModelPickerSelection } from "../_shared/model-picker.ts";

export interface GuardianSettings {
	provider: string;
	modelId: string;
	thinkingLevel: ModelThinkingLevel;
	contextWindow: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, label: string): string {
	if (typeof value !== "string" || !value.trim()) {
		throw new Error(`guardian.${label} must be a non-empty string.`);
	}
	return value.trim();
}

/** Parse the optional guardian namespace from a complete profile document. */
export function parseGuardianSettings(document: unknown): GuardianSettings | undefined {
	if (!isRecord(document)) throw new Error("Settings document must be a JSON object.");
	if (document.guardian === undefined) return undefined;
	if (!isRecord(document.guardian)) throw new Error("guardian must be a JSON object.");

	const raw = document.guardian;
	const thinkingLevel = raw.thinkingLevel;
	if (typeof thinkingLevel !== "string" || !MODEL_THINKING_LEVELS.includes(thinkingLevel as ModelThinkingLevel)) {
		throw new Error("guardian.thinkingLevel must be one of off, minimal, low, medium, high, xhigh, or max.");
	}
	if (!Number.isInteger(raw.contextWindow) || (raw.contextWindow as number) <= 0) {
		throw new Error("guardian.contextWindow must be a positive integer.");
	}

	return {
		provider: requiredString(raw.provider, "provider"),
		modelId: requiredString(raw.modelId, "modelId"),
		thinkingLevel: thinkingLevel as ModelThinkingLevel,
		contextWindow: raw.contextWindow as number,
	};
}

export function loadGuardianSettings(path: string): GuardianSettings | undefined {
	return parseGuardianSettings(readSettingsDocument(path));
}

/** Atomically replace only the guardian namespace in a profile document. */
export async function saveGuardianSettings(
	path: string,
	selection: ModelPickerSelection,
): Promise<GuardianSettings> {
	const settings: GuardianSettings = {
		provider: selection.model.provider,
		modelId: selection.model.id,
		thinkingLevel: selection.thinkingLevel,
		contextWindow: selection.contextWindow,
	};
	await mutateSettingsDocument(path, (document) => ({ ...document, guardian: settings }));
	return settings;
}
