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