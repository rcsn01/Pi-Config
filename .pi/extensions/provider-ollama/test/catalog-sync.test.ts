import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ensureOllamaCatalogInModelsJson,
  getModelsJsonPath,
  setModelsJsonPathForTesting,
  syncOllamaCatalogToModelsJson,
} from "../catalog-sync.ts";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";

// --- Helpers ---

let testDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(path.join(tmpdir(), "pi-ollama-sync-"));
  setModelsJsonPathForTesting(path.join(testDir, "models.json"));
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

function makeModel(id: string, overrides: Partial<ProviderModelConfig> = {}): ProviderModelConfig {
  return {
    id,
    name: id,
    reasoning: false,
    input: ["text"],
    cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 262144,
    maxTokens: 32768,
    compat: { supportsDeveloperRole: false, thinkingFormat: "openai" },
    ...overrides,
  } as ProviderModelConfig;
}

async function readDoc(): Promise<Record<string, any>> {
  return JSON.parse(await readFile(getModelsJsonPath(), "utf-8"));
}

// ============================================================================
// syncOllamaCatalogToModelsJson
// ============================================================================

describe("syncOllamaCatalogToModelsJson", () => {
  it("creates models.json with a provider entry when the file is missing", async () => {
    const result = await syncOllamaCatalogToModelsJson([makeModel("glm-5.3-flash")]);

    expect(result).toBe("written");
    const doc = await readDoc();
    const entry = doc.providers["ollama-cloud"];
    expect(entry.baseUrl).toBe("https://ollama.com/v1");
    expect(entry.api).toBe("openai-completions");
    expect(entry.models).toHaveLength(1);
    expect(entry.models[0].id).toBe("glm-5.3-flash");
    // No credentials in models.json: auth resolves from auth.json per provider id.
    expect(entry.apiKey).toBeUndefined();
  });

  it("preserves unrelated providers and unmanaged fields of the existing entry", async () => {
    await writeFile(
      getModelsJsonPath(),
      JSON.stringify(
        {
          providers: {
            "github-copilot": { modelOverrides: { "gpt-5.6-sol": { contextWindow: 272000 } } },
            "ollama-cloud": {
              name: "Custom Ollama",
              compat: { supportsStrictMode: true },
              modelOverrides: { "glm-5.1": { contextWindow: 111111 } },
            },
          },
        },
        null,
        "\t",
      ),
    );

    const result = await syncOllamaCatalogToModelsJson([makeModel("glm-5.3-flash")]);

    expect(result).toBe("written");
    const doc = await readDoc();
    expect(doc.providers["github-copilot"]).toEqual({
      modelOverrides: { "gpt-5.6-sol": { contextWindow: 272000 } },
    });
    const entry = doc.providers["ollama-cloud"];
    expect(entry.name).toBe("Custom Ollama"); // unmanaged field survives
    expect(entry.compat).toEqual({ supportsStrictMode: true }); // unmanaged field survives
    expect(entry.modelOverrides).toEqual({ "glm-5.1": { contextWindow: 111111 } });
    expect(entry.models[0].id).toBe("glm-5.3-flash");
  });

  it("carries full model metadata (reasoning, thinkingLevelMap, compat) into definitions", async () => {
    await syncOllamaCatalogToModelsJson([
      makeModel("thinking-model", {
        reasoning: true,
        thinkingLevelMap: { off: "none", minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max" },
        input: ["text", "image"],
      }),
    ]);

    const doc = await readDoc();
    const model = doc.providers["ollama-cloud"].models[0];
    expect(model).toMatchObject({
      id: "thinking-model",
      reasoning: true,
      thinkingLevelMap: { off: "none", low: "low", high: "high", max: "max" },
      input: ["text", "image"],
      contextWindow: 262144,
      maxTokens: 32768,
      compat: { supportsDeveloperRole: false, thinkingFormat: "openai" },
    });
    // Runtime-only fields pi derives at load time are not written.
    expect(model.provider).toBeUndefined();
    expect(model.api).toBeUndefined();
    expect(model.baseUrl).toBeUndefined();
    expect(model.headers).toBeUndefined();
  });

  it("is a no-op when the entry already matches", async () => {
    await syncOllamaCatalogToModelsJson([makeModel("glm-5.3-flash")]);
    const before = await readFile(getModelsJsonPath(), "utf-8");

    const result = await syncOllamaCatalogToModelsJson([makeModel("glm-5.3-flash")]);

    expect(result).toBe("unchanged");
    expect(await readFile(getModelsJsonPath(), "utf-8")).toBe(before);
  });

  it("skips and warns on an unparseable models.json without touching it", async () => {
    await writeFile(getModelsJsonPath(), "{ not json ]");

    const result = await syncOllamaCatalogToModelsJson([makeModel("glm-5.3-flash")]);

    expect(result).toBe("skipped");
    expect(await readFile(getModelsJsonPath(), "utf-8")).toBe("{ not json ]");
  });

  it("skips when the providers key is not an object", async () => {
    await writeFile(getModelsJsonPath(), JSON.stringify({ providers: "nope" }));

    const result = await syncOllamaCatalogToModelsJson([makeModel("m")]);

    expect(result).toBe("skipped");
    expect(JSON.parse(await readFile(getModelsJsonPath(), "utf-8")).providers).toBe("nope");
  });

  it("skips when the existing ollama-cloud entry is not an object", async () => {
    await writeFile(getModelsJsonPath(), JSON.stringify({ providers: { "ollama-cloud": 42 } }));

    const result = await syncOllamaCatalogToModelsJson([makeModel("m")]);

    expect(result).toBe("skipped");
    expect(JSON.parse(await readFile(getModelsJsonPath(), "utf-8")).providers["ollama-cloud"]).toBe(42);
  });

  it("skips when the model list is empty (an empty catalog would disable the provider)", async () => {
    const result = await syncOllamaCatalogToModelsJson([]);
    expect(result).toBe("skipped");
    await expect(readFile(getModelsJsonPath(), "utf-8")).rejects.toThrow("ENOENT");
  });

  it("creates the entry when the document root exists but providers is absent", async () => {
    await writeFile(getModelsJsonPath(), JSON.stringify({ someOtherTopLevelKey: true }));

    const result = await syncOllamaCatalogToModelsJson([makeModel("m")]);

    expect(result).toBe("written");
    const doc = await readDoc();
    expect(doc.someOtherTopLevelKey).toBe(true);
    expect(doc.providers["ollama-cloud"].models[0].id).toBe("m");
  });

  it("writes atomically: no temp file remains and content is complete", async () => {
    await syncOllamaCatalogToModelsJson([makeModel("glm-5.3-flash")]);

    const doc = await readDoc(); // full parse succeeds => no truncated write
    expect(doc.providers["ollama-cloud"].api).toBe("openai-completions");
  });
});

// ============================================================================
// ensureOllamaCatalogInModelsJson (bootstrap-only semantics)
// ============================================================================

describe("ensureOllamaCatalogInModelsJson", () => {
  it("writes when there is no entry yet (offline first-launch bootstrap)", async () => {
    const result = await ensureOllamaCatalogInModelsJson([makeModel("glm-5.1")]);

    expect(result).toBe("written");
    const doc = await readDoc();
    expect(doc.providers["ollama-cloud"].models[0].id).toBe("glm-5.1");
  });

  it("leaves an existing usable entry untouched (never overwrites with stale data)", async () => {
    await syncOllamaCatalogToModelsJson([makeModel("fresh-from-network")]);
    const before = await readFile(getModelsJsonPath(), "utf-8");

    const result = await ensureOllamaCatalogInModelsJson([makeModel("stale-baked-in")]);

    expect(result).toBe("unchanged");
    expect(await readFile(getModelsJsonPath(), "utf-8")).toBe(before);
    const doc = await readDoc();
    expect(doc.providers["ollama-cloud"].models[0].id).toBe("fresh-from-network");
  });

  it("fills an entry whose models list is empty or missing", async () => {
    await writeFile(
      getModelsJsonPath(),
      JSON.stringify({ providers: { "ollama-cloud": { baseUrl: "https://ollama.com/v1" } } }),
    );

    const result = await ensureOllamaCatalogInModelsJson([makeModel("glm-5.2")]);

    expect(result).toBe("written");
    const doc = await readDoc();
    expect(doc.providers["ollama-cloud"].models[0].id).toBe("glm-5.2");
  });
});