import type { ModelsPublication, RefreshModelsContext } from "@earendil-works/pi-ai";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
  createOllamaCatalogPublication,
  type StaticCatalogAdapter,
} from "../catalog-publication.ts";

function model(id: string): ProviderModelConfig {
  return {
    id,
    name: id,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 32768,
    provider: "ollama-cloud",
    api: "openai-completions",
    baseUrl: "https://ollama.com/v1",
  } as ProviderModelConfig;
}

function adapters(nativeResult: boolean | Error = true) {
  const calls: string[] = [];
  const publishNative = vi.fn(async (_publication: ModelsPublication) => {
    calls.push("native");
    if (nativeResult instanceof Error) throw nativeResult;
    return nativeResult;
  });
  const staticCatalog: StaticCatalogAdapter = {
    ensure: vi.fn(async () => { calls.push("ensure"); }),
    sync: vi.fn(async () => { calls.push("sync"); }),
  };
  return { publishNative, staticCatalog, calls };
}

type NativeCatalogModel = NonNullable<RefreshModelsContext["stored"]>["models"][number];

function nativeModel(id: string): NativeCatalogModel {
  return model(id) as unknown as NativeCatalogModel;
}

function stored(models: NativeCatalogModel[]): RefreshModelsContext["stored"] {
  return { models, checkedAt: 100 };
}

describe("Ollama catalog publication", () => {
  it("bootstraps only the static catalog and returns the baseline", async () => {
    const deps = adapters();
    const publication = createOllamaCatalogPublication(deps);
    const baseline = [model("stored")];

    const result = await publication.apply({ kind: "bootstrap", models: baseline });

    expect(result).toBe(baseline);
    expect(deps.publishNative).not.toHaveBeenCalled();
    expect(deps.staticCatalog.ensure).toHaveBeenCalledWith(baseline);
    expect(deps.staticCatalog.sync).not.toHaveBeenCalled();
  });

  it("publishes a complete catalog to native storage before the static catalog", async () => {
    const deps = adapters();
    const publication = createOllamaCatalogPublication({ ...deps, now: () => 1234 });
    const models = [nativeModel("fresh")];

    const result = await publication.apply({ kind: "complete", models });

    expect(result).toEqual(models);
    expect(deps.calls).toEqual(["native", "sync"]);
    expect(deps.publishNative).toHaveBeenCalledWith({ persist: { models, checkedAt: 1234 } });
    expect(deps.staticCatalog.sync).toHaveBeenCalledWith(models);
  });

  it("does not mirror a complete catalog after explicit supersession", async () => {
    const deps = adapters(false);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const publication = createOllamaCatalogPublication(deps);

    const result = await publication.apply({ kind: "complete", models: [nativeModel("stale")] });

    expect(result[0].id).toBe("stale");
    expect(deps.staticCatalog.sync).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      "[pi-ollama-cloud] Catalog persist rejected (generation check failed or refresh superseded).",
    );
    warn.mockRestore();
  });

  it("mirrors a complete catalog after an unclassified native write error", async () => {
    const deps = adapters(new Error("store write failed"));
    const publication = createOllamaCatalogPublication(deps);

    const result = await publication.apply({ kind: "complete", models: [nativeModel("fresh")] });

    expect(result[0].id).toBe("fresh");
    expect(deps.calls).toEqual(["native", "sync"]);
  });

  it("keeps the stored baseline on partial refresh, advances checkedAt, ensures static fallback, then throws", async () => {
    const deps = adapters();
    const publication = createOllamaCatalogPublication({ ...deps, now: () => 5678 });
    const baseline = [nativeModel("stored")];

    await expect(publication.apply({
      kind: "partial",
      failed: 2,
      stored: stored(baseline),
      fallback: baseline,
    })).rejects.toThrow("Ollama Cloud catalog refresh incomplete: 2 model(s) failed");

    expect(deps.calls).toEqual(["native", "ensure"]);
    expect(deps.publishNative).toHaveBeenCalledWith({
      persist: { models: baseline, checkedAt: 5678 },
    });
    expect(deps.staticCatalog.ensure).toHaveBeenCalledWith(baseline);
  });

  it("ensures the static baseline after an unclassified partial native write error", async () => {
    const deps = adapters(new Error("store write failed"));
    const baseline = [nativeModel("stored")];
    const publication = createOllamaCatalogPublication(deps);

    await expect(publication.apply({
      kind: "partial",
      failed: 3,
      stored: stored(baseline),
      fallback: baseline,
    })).rejects.toThrow("Ollama Cloud catalog refresh incomplete: 3 model(s) failed");

    expect(deps.calls).toEqual(["native", "ensure"]);
    expect(deps.staticCatalog.ensure).toHaveBeenCalledWith(baseline);
  });

  it("does not touch the static catalog when partial native publication is superseded", async () => {
    const deps = adapters(false);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const baseline = [nativeModel("stored")];
    const publication = createOllamaCatalogPublication(deps);

    await expect(publication.apply({
      kind: "partial",
      failed: 1,
      stored: stored(baseline),
      fallback: baseline,
    })).rejects.toThrow("catalog refresh incomplete");

    expect(deps.staticCatalog.ensure).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      "[pi-ollama-cloud] Partial-failure persist rejected (generation check failed or refresh superseded).",
    );
    warn.mockRestore();
  });

  it("writes neither sink when a partial refresh has no stored baseline", async () => {
    const deps = adapters();
    const publication = createOllamaCatalogPublication(deps);

    await expect(publication.apply({
      kind: "partial",
      failed: 1,
      fallback: [model("generated")],
    })).rejects.toThrow("catalog refresh incomplete");

    expect(deps.publishNative).not.toHaveBeenCalled();
    expect(deps.staticCatalog.ensure).not.toHaveBeenCalled();
    expect(deps.staticCatalog.sync).not.toHaveBeenCalled();
  });

  it("returns an empty-list fallback without touching either sink", async () => {
    const deps = adapters();
    const publication = createOllamaCatalogPublication(deps);
    const fallback = [model("stored")];

    const result = await publication.apply({ kind: "empty", fallback });

    expect(result).toEqual(fallback);
    expect(deps.publishNative).not.toHaveBeenCalled();
    expect(deps.staticCatalog.ensure).not.toHaveBeenCalled();
    expect(deps.staticCatalog.sync).not.toHaveBeenCalled();
  });

  it("warns and returns the catalog when the static adapter throws", async () => {
    const deps = adapters();
    vi.mocked(deps.staticCatalog.sync).mockRejectedValue(new Error("disk full"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const publication = createOllamaCatalogPublication(deps);

    const result = await publication.apply({ kind: "complete", models: [nativeModel("fresh")] });

    expect(result[0].id).toBe("fresh");
    expect(warn).toHaveBeenCalledWith("[pi-ollama-cloud] models.json catalog sync failed: disk full");
    warn.mockRestore();
  });
});
