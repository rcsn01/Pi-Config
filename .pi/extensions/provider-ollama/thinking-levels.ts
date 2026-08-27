/**
 * Family-level thinking mappings for Ollama Cloud models.
 *
 * Each requested family uses one map based on its newest audited generation.
 * A null value hides that level in Pi's UI. Keep model-version checks out of
 * this resolver so every member of a family behaves consistently.
 *
 * Research and source links:
 * docs/family-thinking-mapping-research.md
 */

import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";

export type ThinkingLevelMap = NonNullable<ProviderModelConfig["thinkingLevelMap"]>;

/** Fallback for thinking-capable models outside the mapped families. */
export const DEFAULT: ThinkingLevelMap = {
  off: "none",
  minimal: null,
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "max",
};

/** Latest Qwen mapping, based on Qwen 3.8. */
export const QWEN: ThinkingLevelMap = {
  off: "none",
  minimal: null,
  low: "low",
  medium: "medium",
  high: null,
  xhigh: "xhigh",
  max: null,
};

/** Latest DeepSeek mapping, based on DeepSeek V4. */
export const DEEPSEEK: ThinkingLevelMap = {
  off: "none",
  minimal: null,
  low: "low",
  medium: null,
  high: "high",
  xhigh: null,
  max: "max",
};

/** Latest GLM mapping, based on forced-thinking GLM 5.3. */
export const GLM: ThinkingLevelMap = {
  off: null,
  minimal: null,
  low: "low",
  medium: null,
  high: "high",
  xhigh: null,
  max: "max",
};

/** Latest Kimi mapping, based on Kimi K3's documented enabled/default mode. */
export const KIMI: ThinkingLevelMap = {
  off: null,
  minimal: null,
  low: null,
  medium: null,
  high: "high",
  xhigh: null,
  max: null,
};

/** Latest Nemotron mapping, based on Ultra's off, medium, and full modes. */
export const NEMOTRON: ThinkingLevelMap = {
  off: "none",
  minimal: null,
  low: null,
  medium: "medium",
  high: "high",
  xhigh: null,
  max: null,
};

/** Latest Muse mapping, based on Muse Spark 1.2. */
export const MUSE: ThinkingLevelMap = {
  off: null,
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: null,
};

/** Resolve one case-insensitive mapping per model family. */
export function resolve(id: string, capabilities: string[]): ThinkingLevelMap | undefined {
  if (!capabilities.includes("thinking")) return undefined;

  const normalized = id.toLowerCase();
  if (normalized.includes("qwen")) return QWEN;
  if (normalized.includes("deepseek")) return DEEPSEEK;
  if (normalized.includes("glm")) return GLM;
  if (normalized.includes("kimi")) return KIMI;
  if (normalized.includes("nemotron")) return NEMOTRON;
  if (normalized.includes("muse")) return MUSE;
  return DEFAULT;
}
