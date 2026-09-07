/**
 * The closed thinking-level vocabulary shared by every model settings domain:
 * stored selections, subagent configuration, the Guardian, the Advisor, the
 * interactive picker, and telemetry views.
 */

import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

export const MODEL_THINKING_LEVELS = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const satisfies readonly ModelThinkingLevel[];

export type SupportedModelThinkingLevel = (typeof MODEL_THINKING_LEVELS)[number];

export const THINKING_DESCRIPTIONS: Record<ModelThinkingLevel, string> = {
	off: "No extended thinking",
	minimal: "Fastest reasoning",
	low: "Light reasoning",
	medium: "Balanced reasoning",
	high: "Deep reasoning",
	xhigh: "Extra-high reasoning",
	max: "Maximum reasoning",
};

const THINKING_LEVEL_LIST = MODEL_THINKING_LEVELS.join(", ");

/**
 * Validate user-supplied thinking-level input: trims, lowercases, and checks
 * membership in the closed vocabulary. Throws
 * `${label} must be one of: ${THINKING_LEVEL_LIST}.` on anything else.
 */
export function normalizeThinkingLevel(value: unknown, options: { label: string }): ModelThinkingLevel {
	if (typeof value !== "string") {
		throw new Error(`${options.label} must be one of: ${THINKING_LEVEL_LIST}.`);
	}
	const normalized = value.trim().toLowerCase();
	if (!MODEL_THINKING_LEVELS.includes(normalized as SupportedModelThinkingLevel)) {
		throw new Error(`${options.label} must be one of: ${THINKING_LEVEL_LIST}.`);
	}
	return normalized as ModelThinkingLevel;
}