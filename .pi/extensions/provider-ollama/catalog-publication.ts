import type { ModelsPublication, RefreshModelsContext } from "@earendil-works/pi-ai";
import { isModelType } from "@earendil-works/pi-ai";
import type { OllamaChatModelConfig } from "./thinking-levels.ts";
import {
  ensureOllamaCatalogInModelsJson,
  syncOllamaCatalogToModelsJson,
} from "./catalog-sync.ts";

type NativeCatalogModel = NonNullable<RefreshModelsContext["stored"]>["models"][number];

export type OllamaCatalogPublicationOutcome =
  | { kind: "bootstrap"; models: OllamaChatModelConfig[] }
  | { kind: "complete"; models: NativeCatalogModel[] }
  | {
      kind: "partial";
      failed: number;
      stored?: RefreshModelsContext["stored"];
      fallback: OllamaChatModelConfig[];
    }
  | { kind: "empty"; fallback: OllamaChatModelConfig[] };

export interface StaticCatalogAdapter {
  ensure(models: readonly OllamaChatModelConfig[]): Promise<unknown>;
  sync(models: readonly OllamaChatModelConfig[]): Promise<unknown>;
}

export interface OllamaCatalogPublication {
  apply(outcome: OllamaCatalogPublicationOutcome): Promise<OllamaChatModelConfig[]>;
}

interface CatalogPublicationAdapters {
  publishNative(publication: ModelsPublication): Promise<boolean>;
  staticCatalog?: StaticCatalogAdapter;
  now?: () => number;
}

const staticCatalogAdapter: StaticCatalogAdapter = {
  ensure: ensureOllamaCatalogInModelsJson,
  sync: syncOllamaCatalogToModelsJson,
};

async function writeStaticQuietly(write: () => Promise<unknown>): Promise<void> {
  try {
    await write();
  } catch (error) {
    console.warn(`[pi-ollama-cloud] models.json catalog sync failed: ${(error as Error).message}`);
  }
}

/**
 * Create one Ollama catalog publisher for a Pi refresh invocation.
 *
 * The returned deep module applies one semantic refresh outcome to Pi's native
 * catalog and the static models.json catalog used by extension-less children.
 * Fetching and model assembly remain outside this seam.
 */
export function createOllamaCatalogPublication(
  adapters: CatalogPublicationAdapters,
): OllamaCatalogPublication {
  const staticCatalog = adapters.staticCatalog ?? staticCatalogAdapter;
  const now = adapters.now ?? Date.now;

  async function publishNativeQuietly(
    publication: ModelsPublication,
    rejectedWarning: string,
  ): Promise<"accepted" | "rejected" | "error"> {
    try {
      const published = await adapters.publishNative(publication);
      if (!published) {
        console.warn(rejectedWarning);
        return "rejected";
      }
      return "accepted";
    } catch {
      return "error";
    }
  }

  return {
    async apply(outcome): Promise<OllamaChatModelConfig[]> {
      if (outcome.kind === "empty") {
        return outcome.fallback;
      }

      if (outcome.kind === "bootstrap") {
        await writeStaticQuietly(() => staticCatalog.ensure(outcome.models));
        return outcome.models;
      }

      if (outcome.kind === "partial") {
        if (outcome.stored?.models.length) {
          const nativeResult = await publishNativeQuietly(
            { persist: { ...outcome.stored, checkedAt: now() } },
            "[pi-ollama-cloud] Partial-failure persist rejected (generation check failed or refresh superseded).",
          );
          if (nativeResult !== "rejected") {
            await writeStaticQuietly(() => staticCatalog.ensure(outcome.fallback));
          }
        }
        throw new Error(`Ollama Cloud catalog refresh incomplete: ${outcome.failed} model(s) failed`);
      }

      const models = outcome.models;
      const nativeResult = await publishNativeQuietly(
        { persist: { models, checkedAt: now() } },
        "[pi-ollama-cloud] Catalog persist rejected (generation check failed or refresh superseded).",
      );
      if (nativeResult !== "rejected") {
        // The static catalog serves this provider's chat-only entries; pi's native
        // model union is narrowed with pi's own runtime check before the write.
        await writeStaticQuietly(() => staticCatalog.sync(models.filter((model) => isModelType(model, "chat"))));
      }
      return models.filter((model) => isModelType(model, "chat"));
    },
  };
}
