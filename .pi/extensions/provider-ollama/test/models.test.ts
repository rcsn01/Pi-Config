import type { OpenAICompletionsCompat } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { GENERATED_MODELS } from "../models.generated.ts";
import { assembleModels, fetchModelDetails, fetchModelIds } from "../models.ts";
import { MODEL_PRICING } from "../pricing.generated.ts";
import { resolve } from "../thinking-levels.ts";
import { getContextLength } from "../utils.ts";

// --- Helpers ---

/** Minimal valid /api/show response matching the real Ollama Cloud API shape. */
function rawModel(
  overrides: {
    capabilities?: string[];
    modelInfo?: Record<string, unknown>;
    details?: Partial<{
      parent_model: string;
      format: string;
      family: string;
      families: string[] | null;
      parameter_size: string;
      quantization_level: string;
    }>;
  } = {},
) {
  return {
    details: {
      parent_model: "",
      format: "",
      family: "test",
      families: null,
      parameter_size: "7000000000",
      quantization_level: "Q4_K_M",
      ...overrides.details,
    },
    model_info: overrides.modelInfo ?? {},
    // Real API always includes "completion"; we omit it since
    // assembleModels only checks for "tools", "thinking", and "vision".
    capabilities: overrides.capabilities ?? ["tools"],
    modified_at: new Date().toISOString(),
  };
}

// ============================================================================
// assembleModels
// ============================================================================

describe("assembleModels", () => {
  it("filters out models without tools capability", () => {
    const raw = {
      "no-tools": rawModel({ capabilities: ["thinking"] }),
      "has-tools": rawModel(),
    };
    const models = assembleModels(raw);
    expect(models).toHaveLength(1);
    expect(models[0].id).toBe("has-tools");
  });

  it("sets id and name from the model key", () => {
    const raw = { "glm-5.1": rawModel() };
    const models = assembleModels(raw);
    expect(models[0].id).toBe("glm-5.1");
    expect(models[0].name).toBe("glm-5.1");
  });

  it("defaults reasoning to false when thinking capability is absent", () => {
    const models = assembleModels({ m: rawModel() });
    expect(models[0].reasoning).toBe(false);
    expect(models[0].thinkingLevelMap).toBeUndefined();
  });

  it("sets reasoning to true and assigns DEFAULT map when thinking is present", () => {
    const models = assembleModels({ m: rawModel({ capabilities: ["tools", "thinking"] }) });
    expect(models[0].reasoning).toBe(true);
    expect(models[0].thinkingLevelMap).toEqual({
      off: "none",
      minimal: null,
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "max",
    });
  });

  it("defaults input to text-only", () => {
    const models = assembleModels({ m: rawModel() });
    expect(models[0].input).toEqual(["text"]);
  });

  it("adds image to input when vision capability is present", () => {
    const models = assembleModels({ m: rawModel({ capabilities: ["tools", "vision"] }) });
    expect(models[0].input).toEqual(["text", "image"]);
  });

  it("sets all compat flags explicitly on every model", () => {
    const models = assembleModels({ m: rawModel() });
    // assembleModels always emits an OpenAICompletionsCompat (see buildCompat);
    // the static type is a union over all APIs, so narrow it for the assertions.
    const compat = models[0].compat as OpenAICompletionsCompat | undefined;

    // Tested against the live API (think-experiment.md, docs/openai.md):
    expect(compat?.supportsDeveloperRole).toBe(false);
    expect(compat?.supportsReasoningEffort).toBe(true);
    expect(compat?.thinkingFormat).toBe("openai");

    // Verified against docs/openai.md:
    // "store" is not listed, Ollama lists "max_tokens" not "max_completion_tokens",
    // stream_options.include_usage is supported, tool_choice is not supported.
    expect(compat?.supportsStore).toBe(false);
    expect(compat?.maxTokensField).toBe("max_tokens");
    expect(compat?.supportsUsageInStreaming).toBe(true);
    expect(compat?.supportsStrictMode).toBe(false);

    // Verified against docs/anthropic.md: prompt caching is "Not supported".
    expect(compat?.cacheControlFormat).toBeUndefined();

    // Standard OpenAI-compatible defaults:
    expect(compat?.requiresToolResultName).toBe(false);
    expect(compat?.requiresAssistantAfterToolResult).toBe(false);
    expect(compat?.requiresThinkingAsText).toBe(false);
    expect(compat?.requiresReasoningContentOnAssistantMessages).toBe(false);
    expect(compat?.sendSessionAffinityHeaders).toBe(false);
    expect(compat?.supportsLongCacheRetention).toBe(false);
    expect(compat?.zaiToolStream).toBe(false);
    expect(compat?.openRouterRouting).toEqual({});
    expect(compat?.vercelGatewayRouting).toEqual({});
  });

  it("zeros cost for models with no models.dev pricing mapping", () => {
    const models = assembleModels({ m: rawModel() });
    expect(models[0].cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });

  it("prices mapped models from the generated models.dev table", () => {
    const models = assembleModels({ "glm-5.1": rawModel({ capabilities: ["tools", "thinking"] }) });
    expect(models[0].cost).toEqual(MODEL_PRICING["glm-5.1"]);
    expect(models[0].cost.input).toBeGreaterThan(0);
  });

  it("extracts contextWindow from model_info using .context_length suffix", () => {
    const models = assembleModels({
      m: rawModel({ modelInfo: { "test.context_length": 262144 } }),
    });
    expect(models[0].contextWindow).toBe(262144);
  });

  it("falls back to 128000 when context_length is missing from model_info", () => {
    // Default from getContextLength(), documented in README table.
    const models = assembleModels({ m: rawModel() });
    expect(models[0].contextWindow).toBe(128000);
  });

  it("sets maxTokens to 32768 (no per-model limit exposed by API)", () => {
    const models = assembleModels({ m: rawModel() });
    expect(models[0].maxTokens).toBe(32768);
  });

  it("attaches the resolved family map to thinking-capable models", () => {
    const models = assembleModels({
      "qwen3.8:27b": rawModel({ capabilities: ["tools", "thinking", "vision"] }),
      "glm-5.3-flash": rawModel({ capabilities: ["tools", "thinking", "vision"] }),
      "unknown-model": rawModel({ capabilities: ["tools", "thinking"] }),
    });

    expect(models[0].thinkingLevelMap).toEqual({
      off: "none",
      minimal: null,
      low: "low",
      medium: "medium",
      high: null,
      xhigh: "xhigh",
      max: null,
    });
    expect(models[1].thinkingLevelMap).toEqual({
      off: null,
      minimal: null,
      low: "low",
      medium: null,
      high: "high",
      xhigh: null,
      max: "max",
    });
    expect(models[2].thinkingLevelMap).toEqual({
      off: "none",
      minimal: null,
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "max",
    });
  });
});

// ============================================================================
// GENERATED_MODELS (baked-in cold-start list)
// ============================================================================

describe("GENERATED_MODELS", () => {
  it("ships at least one model", () => {
    expect(GENERATED_MODELS.length).toBeGreaterThan(0);
  });

  it("keeps generated thinking maps in sync with the resolver", () => {
    for (const model of GENERATED_MODELS) {
      const capabilities = model.reasoning ? ["thinking"] : [];
      expect(model.thinkingLevelMap, model.id).toEqual(resolve(model.id, capabilities));
    }
  });

  it("ships the full explicit compat shape from buildCompat", () => {
    // The baked-in list must match assembleModels output so cold-start
    // users get the same compat contract as native refreshModels users.
    for (const m of GENERATED_MODELS) {
      expect(m.compat).toMatchObject({
        supportsDeveloperRole: false,
        supportsReasoningEffort: true,
        supportsStore: false,
        maxTokensField: "max_tokens",
        supportsUsageInStreaming: true,
        requiresToolResultName: false,
        requiresAssistantAfterToolResult: false,
        requiresThinkingAsText: false,
        requiresReasoningContentOnAssistantMessages: false,
        thinkingFormat: "openai",
        supportsStrictMode: false,
        sendSessionAffinityHeaders: false,
        supportsLongCacheRetention: false,
        zaiToolStream: false,
        openRouterRouting: {},
        vercelGatewayRouting: {},
      });
    }
  });
});

// ============================================================================
// resolve (thinking level maps)
// ============================================================================

describe("resolve", () => {
  const thinking = ["tools", "thinking"];

  it("returns undefined for models without thinking capability", () => {
    expect(resolve("any-model", [])).toBeUndefined();
    expect(resolve("qwen3.8:27b", ["tools"])).toBeUndefined();
    expect(resolve("glm-5.3-flash", ["tools", "vision"])).toBeUndefined();
  });

  it.each([
    [
      "Qwen",
      ["qwen3.5:397b", "qwen3.6-27b", "qwen3.8-flash", "qwen3.8-max"],
      { off: "none", minimal: null, low: "low", medium: "medium", high: null, xhigh: "xhigh", max: null },
    ],
    [
      "DeepSeek",
      ["deepseek-r1", "deepseek-v4-flash:0731", "deepseek-v4-pro:0813"],
      { off: "none", minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max" },
    ],
    [
      "GLM",
      ["glm-5.1", "glm-5.2", "glm-5.3", "glm-5.3-flash"],
      { off: null, minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max" },
    ],
    [
      "Kimi",
      ["kimi-k2.6", "kimi-k2.7-code", "kimi-k3"],
      { off: null, minimal: null, low: null, medium: null, high: "high", xhigh: null, max: null },
    ],
    [
      "Nemotron",
      ["nemotron-3-nano:30b", "nemotron-3-super", "nemotron-3-ultra"],
      { off: "none", minimal: null, low: null, medium: "medium", high: "high", xhigh: null, max: null },
    ],
    [
      "Muse",
      ["muse-glimmer-30b", "muse-spark-1.1", "muse-spark-1.2"],
      { off: null, minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: null },
    ],
  ] as const)("uses one newest-generation map for the entire %s family", (_family, ids, expected) => {
    for (const id of ids) expect(resolve(id, thinking)).toEqual(expected);
  });

  it("matches family names case-insensitively", () => {
    expect(resolve("QWEN3.5:397B", thinking)).toEqual(resolve("qwen3.8-max", thinking));
  });

  it("returns DEFAULT for other thinking-capable models", () => {
    expect(resolve("unknown-model", thinking)).toEqual({
      off: "none",
      minimal: null,
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "max",
    });
  });
});

// ============================================================================
// getContextLength
// ============================================================================

describe("getContextLength", () => {
  it("extracts context length from any key ending in .context_length", () => {
    expect(getContextLength({ "test.context_length": 262144 })).toBe(262144);
    expect(getContextLength({ "some-prefix.context_length": 128000 })).toBe(128000);
  });

  it("returns first match when multiple context_length keys exist", () => {
    expect(
      getContextLength({
        "a.context_length": 100000,
        "b.context_length": 200000,
      }),
    ).toBe(100000);
  });

  it("falls back to 128000 when no context_length key exists", () => {
    expect(getContextLength({})).toBe(128000);
    expect(getContextLength({ some_other_key: 42 })).toBe(128000);
  });

  it("ignores context_length values that are not numbers", () => {
    expect(getContextLength({ "test.context_length": "not-a-number" })).toBe(128000);
  });
});

// fetchModelIds error handling
// ============================================================================

describe("fetchModelIds", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("throws rate limit error on 429", async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({ error: "too many requests" }), { status: 429 });
    await expect(fetchModelIds()).rejects.toThrow("Ollama Cloud model list fetch rate limited");
  });

  it("throws generic error on other failures", async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({ error: "server error" }), { status: 500 });
    await expect(fetchModelIds()).rejects.toThrow("Failed to fetch model list");
  });

  it("returns model IDs on success", async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ data: [{ id: "qwen3" }, { id: "gemma3" }] }), {
        status: 200,
      });
    const ids = await fetchModelIds();
    expect(ids).toEqual(["qwen3", "gemma3"]);
  });
});

describe("fetchModelDetails", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("throws rate limit error on 429", async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({ error: "too many requests" }), { status: 429 });
    await expect(fetchModelDetails("qwen3")).rejects.toThrow("Ollama Cloud /api/show rate limited");
  });

  it("throws generic error on other failures", async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({ error: "not found" }), { status: 404 });
    await expect(fetchModelDetails("unknown")).rejects.toThrow("Failed to fetch /api/show");
  });

  it("returns model details on success", async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          capabilities: ["tools"],
          model_info: { "test.context_length": 131072 },
        }),
        { status: 200 },
      );
    const details = await fetchModelDetails("qwen3");
    expect(details.capabilities).toContain("tools");
    expect(details.model_info).toBeDefined();
  });
});
