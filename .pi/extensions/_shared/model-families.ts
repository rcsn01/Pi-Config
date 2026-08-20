import type { ThinkingLevelMap } from "@earendil-works/pi-ai";

/**
 * Provider thinking levels for model families that do not declare their own
 * thinkingLevelMap. Keys are pi picker levels; values are provider level
 * strings, or null when the family does not support that level.
 *
 * Order matters: the first family whose name appears in the model id wins.
 */
export const FAMILY_THINKING_LEVELS: ReadonlyArray<{
	family: string;
	levels: ThinkingLevelMap;
}> = [
	{
		// Listed before qwen so deepseek models served through a
		// qwen-token-plan still match deepseek first.
		family: "deepseek",
		levels: { off: "none", minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max" },
	},
	{
		family: "qwen",
		levels: { off: "none", minimal: null, low: "low", medium: "medium", high: null, xhigh: "xhigh", max: null },
	},
	{
		// Follows the official z.ai catalogue entry for glm-5.2.
		family: "glm",
		levels: { off: "none", minimal: null, low: "high", medium: "high", high: "high", xhigh: null, max: "max" },
	},
];

/** Match a model id against the family table; first case-insensitive substring match wins. */
export function matchFamily(modelId: string): ThinkingLevelMap | undefined {
	const normalized = modelId.toLowerCase();
	return FAMILY_THINKING_LEVELS.find(({ family }) => normalized.includes(family))?.levels;
}
