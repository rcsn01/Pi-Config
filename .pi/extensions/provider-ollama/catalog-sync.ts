/**
 * Catalog sync: mirror the Ollama Cloud catalog into ~/.pi/agent/models.json.
 *
 * Why: pi resolves `--model ollama-cloud/...` against the providers visible in
 * the target process. Subagent children are spawned with `--no-extensions`
 * (tools-subagents builds an explicit extension list), so the provider this
 * extension registers via `pi.registerProvider` does not exist there and model
 * resolution fails with "Model not found". models.json, however, is read by
 * every pi process regardless of extension loading, so a synced static entry
 * makes children resolvable.
 *
 * Composition (verified against pi's composeModelProvider): when both layers
 * exist, the extension-registered models replace the models.json models inside
 * sessions that load this extension, so live refresh keeps winning in the main
 * session. Only extension-less processes fall back to the synced static list.
 *
 * Safety properties:
 *   - Never writes credentials: auth stays in auth.json (provider-level key).
 *   - Merge, not clobber: unknown fields on the existing entry (name, compat,
 *     headers, modelOverrides, apiKey overrides) are preserved; only baseUrl,
 *     api, and models are managed here.
 *   - Never destructively rewrites an unparseable models.json; it warns and
 *     skips instead.
 *   - Atomic write (temp file + rename) so a crash cannot truncate the config.
 */

import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";

export const OLLAMA_PROVIDER_ID = "ollama-cloud";
export const OLLAMA_MODELS_BASE_URL = "https://ollama.com/v1";

/** Result of a sync attempt against models.json. */
export type SyncResult = "written" | "unchanged" | "skipped";

/**
 * Where the sync writes. Module-level so tests can redirect it to a temp dir;
 * production code never needs to change it.
 */
let modelsJsonPath: string = join(getAgentDir(), "models.json");

/** Point the sync at a custom models.json path (test isolation). */
export function setModelsJsonPathForTesting(modelsPath: string): void {
  modelsJsonPath = modelsPath;
}

/** Current sync target (exposed for assertions and diagnostics). */
export function getModelsJsonPath(): string {
  return modelsJsonPath;
}

/**
 * Single-flight the whole read-merge-write cycle. pi can invoke refreshModels
 * twice nearly simultaneously (restore + cooldown phases), and two upserts
 * racing on one temp file name caused a spurious rename ENOENT. Chaining keeps
 * each read-modify-write pair atomic with respect to the other.
 */
let writeChain: Promise<unknown> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = writeChain.then(task, task);
  writeChain = run.catch(() => undefined);
  return run;
}

/** Strip runtime-only fields pi derives when loading models.json. */
function toModelDefinition(model: ProviderModelConfig): Record<string, unknown> {
  return {
    id: model.id,
    ...(model.name ? { name: model.name } : {}),
    reasoning: model.reasoning,
    ...(model.thinkingLevelMap ? { thinkingLevelMap: model.thinkingLevelMap } : {}),
    input: model.input,
    cost: model.cost,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    ...((model as { samplingParams?: Record<string, unknown> }).samplingParams
      ? { samplingParams: (model as { samplingParams?: Record<string, unknown> }).samplingParams }
      : {}),
    ...(model.compat ? { compat: model.compat } : {}),
  };
}

/** Does the parsed models.json already carry a usable ollama-cloud catalog? */
function hasUsableEntry(doc: Record<string, unknown>): boolean {
  const providers = doc.providers as Record<string, unknown> | undefined;
  if (!providers || typeof providers !== "object" || Array.isArray(providers)) return false;
  const entry = providers[OLLAMA_PROVIDER_ID];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
  const models = (entry as Record<string, unknown>).models;
  return Array.isArray(models) && models.length > 0;
}

/**
 * Upsert the ollama-cloud provider entry with the given models. Preserves
 * every other document field and every unmanaged field of an existing entry.
 */
export async function syncOllamaCatalogToModelsJson(
  models: readonly ProviderModelConfig[],
): Promise<SyncResult> {
  return upsertOllamaEntry(models, { overwriteExisting: true });
}

/**
 * Write the entry only when it is missing or unusable (no model list). Used on
 * the no-network restore path so an offline first launch still produces a
 * static entry (from GENERATED_MODELS / the stored catalog) without ever
 * overwriting a newer synced catalog with stale data.
 */
export async function ensureOllamaCatalogInModelsJson(
  models: readonly ProviderModelConfig[],
): Promise<SyncResult> {
  return upsertOllamaEntry(models, { overwriteExisting: false });
}

async function upsertOllamaEntry(
  models: readonly ProviderModelConfig[],
  options: { overwriteExisting: boolean },
): Promise<SyncResult> {
  // Serialize concurrent invocations (pi can trigger overlapping refreshes).
  return enqueue(() => performUpsert(models, options));
}

async function performUpsert(
  models: readonly ProviderModelConfig[],
  options: { overwriteExisting: boolean },
): Promise<SyncResult> {
  // An empty catalog would disable the provider for children; never write one.
  if (models.length === 0) return "skipped";

  let raw: string | undefined;
  try {
    raw = await readFile(modelsJsonPath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`[pi-ollama-cloud] Could not read ${modelsJsonPath}: ${(error as Error).message}`);
      return "skipped";
    }
  }

  let doc: Record<string, unknown> = {};
  if (raw !== undefined) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not a JSON object");
      doc = parsed as Record<string, unknown>;
    } catch (error) {
      // Unparseable user config: never clobber it. The registerProvider-based
      // in-memory catalog still works for sessions that load this extension.
      console.warn(
        `[pi-ollama-cloud] ${modelsJsonPath} is not valid JSON (${(error as Error).message}); skipping catalog sync.`,
      );
      return "skipped";
    }
  }

  if (!doc.providers || typeof doc.providers !== "object" || Array.isArray(doc.providers)) {
    // Only create the providers object when absent; a non-object shape is user
    // config we do not understand, so leave the file alone.
    if (doc.providers !== undefined) {
      console.warn(`[pi-ollama-cloud] Unexpected "providers" shape in ${modelsJsonPath}; skipping catalog sync.`);
      return "skipped";
    }
    doc.providers = {};
  }
  const providers = doc.providers as Record<string, unknown>;

  const existing = providers[OLLAMA_PROVIDER_ID];
  if (existing !== undefined && (typeof existing !== "object" || Array.isArray(existing))) {
    console.warn(`[pi-ollama-cloud] Existing models.json entry for "${OLLAMA_PROVIDER_ID}" has an unexpected shape; skipping catalog sync.`);
    return "skipped";
  }
  const existingEntry = (existing ?? {}) as Record<string, unknown>;

  if (!options.overwriteExisting && hasUsableEntry(doc)) return "unchanged";

  const entry: Record<string, unknown> = {
    ...existingEntry,
    // Managed fields. No apiKey here on purpose: credentials live in
    // auth.json and are resolved per provider id by every pi process.
    baseUrl: OLLAMA_MODELS_BASE_URL,
    api: "openai-completions",
    models: models.map(toModelDefinition),
  };
  providers[OLLAMA_PROVIDER_ID] = entry;

  if (JSON.stringify(existingEntry) === JSON.stringify(entry)) return "unchanged";

  const serialized = `${JSON.stringify(doc, null, "\t")}\n`;
  await mkdir(path.dirname(modelsJsonPath), { recursive: true });
  const tempPath = path.join(
    path.dirname(modelsJsonPath),
    `${path.basename(modelsJsonPath)}.tmp-${process.pid}-${randomUUID()}`,
  );
  // Preserve the existing file's permissions; default to owner-only for a
  // freshly created config file.
  let mode: number | undefined;
  try {
    mode = (await stat(modelsJsonPath)).mode & 0o777;
  } catch {
    mode = undefined;
  }
  await writeFile(tempPath, serialized, { encoding: "utf-8", mode: mode ?? 0o600 });
  await rename(tempPath, modelsJsonPath);
  return "written";
}
