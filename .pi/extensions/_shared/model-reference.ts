/**
 * Model reference — the shared vocabulary for designating a model: parsing
 * qualified (`provider/model`), bare-id, and `provider/model:thinking`
 * references, resolving them against a model lookup with refresh and the
 * scoped-models invariant, typed resolution errors, and shared context-window
 * validation.
 *
 * Adapters catch `ModelReferenceError` and render their own user-facing text;
 * the module's messages are diagnostics, not user copy. Symbolic vocabularies
 * ("main", "default" sentinels) stay domain-owned — callers resolve them
 * before or after parsing.
 */

import type { Model } from "@earendil-works/pi-ai";
import { MODEL_THINKING_LEVELS, type SupportedModelThinkingLevel } from "./model-thinking.ts";

/**
 * Suffix vocabulary for `provider/model:thinking` references: a suffix is
 * recognized only when the segment after the last `:` is a valid thinking
 * level; any other colon is part of the model id (pi-ai models may carry
 * colon-suffixed ids like OpenRouter's `deepseek-r1:free`).
 */
export const THINKING_SUFFIX_PATTERN = new RegExp(`^(.*):(${MODEL_THINKING_LEVELS.join("|")})$`, "i");

export type ModelReferenceErrorReason =
	| "invalid"
	| "unavailable"
	| "out-of-scope"
	| "aborted"
	| "refresh"
	| "no-provider";

/** One parsed model reference. */
export type ParsedModelReference =
	| { kind: "qualified"; provider: string; modelId: string; thinkingLevel?: SupportedModelThinkingLevel }
	| { kind: "bare-id"; modelId: string };

/**
 * Structural registry face: ExtensionContext satisfies it directly, because
 * `find`/`refresh` are nested under `modelRegistry` here (not flat), matching
 * ExtensionContext's actual shape — it has no top-level `find`/`refresh` of
 * its own, only `ctx.modelRegistry.find`/`.refresh`, while `scopedModels` is
 * flat on ctx. A flat `find`/`refresh` here would make `ctx` fail structural
 * assignment, and the obvious compile-driven fix (passing `ctx.modelRegistry`
 * instead of `ctx`) would silently drop `scopedModels` and disable scope
 * enforcement. Guardian adapts ModelRuntime to it inline (find only; no
 * refresh, no scopedModels — ModelRuntime has neither concept).
 */
export interface RefreshableModelLookup {
	modelRegistry: {
		find(provider: string, modelId: string): Model<any> | undefined;
		refresh?(options: { allowNetwork: false; providers: [string] }): Promise<{
			aborted: boolean;
			errors: ReadonlyMap<string, Error>;
		}>;
	};
	/** Present-but-empty means "no scoping configured" and must NOT enforce;
	 *  ExtensionContext.scopedModels is always a defined array, empty when the
	 *  session has no `--models`/`enabledModels` restriction. Enforcement keys
	 *  on non-empty, exactly like the historical
	 *  `ctx.scopedModels.length > 0 && !ctx.scopedModels.some(...)` guards. */
	readonly scopedModels?: readonly { model: { provider: string; id: string } }[];
}

export class ModelReferenceError extends Error {
	readonly reason: ModelReferenceErrorReason;
	readonly label?: string;
	readonly provider?: string;
	readonly modelId?: string;
	readonly cause?: unknown;

	constructor(
		reason: ModelReferenceErrorReason,
		message: string,
		details: { label?: string; provider?: string; modelId?: string; cause?: unknown } = {},
	) {
		super(message);
		this.name = "ModelReferenceError";
		this.reason = reason;
		this.label = details.label;
		this.provider = details.provider;
		this.modelId = details.modelId;
		this.cause = details.cause;
	}
}

export interface ModelReferenceOptions {
	/** Error-message prefix, e.g. "Advisor model", "Plan Mode profile". */
	label?: string;
	/** Accept "provider/model:thinking". Default false. */
	allowThinkingSuffix?: boolean;
	/** Accept a bare id (resolution needs bareIdFallback). Default false. */
	allowBareId?: boolean;
	/** Default "enforce" when the lookup's scopedModels is present AND
	 *  non-empty; present-but-empty never enforces. */
	scope?: "enforce" | "ignore";
	/** Refresh the provider before lookup. Default false. */
	refresh?: boolean;
	/** For bare ids: supply a provider, or undefined to fail "no-provider".
	 *  Sync or async — the caller awaits the result either way. */
	bareIdFallback?: (modelId: string) => string | undefined | Promise<string | undefined>;
	/** Resolve "unavailable"/"out-of-scope" to undefined. Default false. */
	optional?: boolean;
}

/** Parse-relevant subset of ModelReferenceOptions. */
export interface ModelReferenceParseOptions {
	label?: string;
	allowThinkingSuffix?: boolean;
	allowBareId?: boolean;
}

const DEFAULT_PARSE_LABEL = "Model reference";
const REFERENCE_SHAPE = 'must be "provider/model[:thinking]".';

function invalidReference(label?: string): ModelReferenceError {
	return new ModelReferenceError("invalid", `${label ?? DEFAULT_PARSE_LABEL} ${REFERENCE_SHAPE}`, { label });
}

/**
 * Parse a qualified or bare-id reference. The first `/` splits
 * provider/modelId (the model id may contain further `/`); leading or
 * trailing `/`, whitespace, or empty segments are invalid. A `:thinking`
 * suffix is extracted only when `allowThinkingSuffix` is set and the segment
 * after the last `:` is a valid thinking level (lowercased); any other colon
 * stays part of the model id.
 */
export function parseModelReference(value: string, options?: ModelReferenceParseOptions): ParsedModelReference {
	const label = options?.label;
	const fail = (): never => {
		throw invalidReference(label);
	};
	if (typeof value !== "string" || value.length === 0 || /\s/.test(value)) fail();

	const slash = value.indexOf("/");
	if (slash < 0) {
		if (!options?.allowBareId) fail();
		return { kind: "bare-id", modelId: value };
	}

	const provider = value.slice(0, slash);
	let modelId = value.slice(slash + 1);
	let thinkingLevel: SupportedModelThinkingLevel | undefined;
	if (options?.allowThinkingSuffix) {
		const match = modelId.match(THINKING_SUFFIX_PATTERN);
		if (match) {
			modelId = match[1]!;
			thinkingLevel = match[2]!.toLowerCase() as SupportedModelThinkingLevel;
		}
	}
	if (!provider || !modelId || modelId.split("/").some((segment) => !segment)) fail();
	return { kind: "qualified", provider, modelId, ...(thinkingLevel ? { thinkingLevel } : {}) };
}

function unavailableMessage(label: string | undefined, provider: string, modelId: string): string {
	return `${label ?? "Model"} model ${provider}/${modelId} is unavailable.`;
}

function outOfScopeMessage(label: string | undefined, provider: string, modelId: string): string {
	return `${label ?? "Model"} model ${provider}/${modelId} is outside this session's model scope.`;
}

/**
 * Parse (when string) and resolve against the lookup: optional refresh,
 * bare-id provider fallback, registry find, and the scoped-models invariant
 * (default enforce). Throws one typed `ModelReferenceError`; under
 * `optional`, only "unavailable" and "out-of-scope" resolve to undefined —
 * "invalid", "no-provider", "aborted", and "refresh" always throw.
 */
export async function resolveModelReference(
	lookup: RefreshableModelLookup,
	reference: string | { provider: string; modelId: string },
	options: ModelReferenceOptions & { optional?: false },
): Promise<Model<any>>;
export async function resolveModelReference(
	lookup: RefreshableModelLookup,
	reference: string | { provider: string; modelId: string },
	options?: ModelReferenceOptions,
): Promise<Model<any> | undefined>;
export async function resolveModelReference(
	lookup: RefreshableModelLookup,
	reference: string | { provider: string; modelId: string },
	options: ModelReferenceOptions = {},
): Promise<Model<any> | undefined> {
	const label = options.label;
	const parsed: ParsedModelReference = typeof reference === "string"
		? parseModelReference(reference, {
			label,
			allowThinkingSuffix: options.allowThinkingSuffix,
			allowBareId: options.allowBareId,
		})
		: { kind: "qualified", provider: reference.provider, modelId: reference.modelId };

	let provider: string;
	let modelId: string;
	if (parsed.kind === "qualified") {
		provider = parsed.provider;
		modelId = parsed.modelId;
	} else {
		modelId = parsed.modelId;
		const fallback = await options.bareIdFallback?.(modelId);
		if (!fallback) {
			throw new ModelReferenceError(
				"no-provider",
				`No provider is configured for model id "${modelId}".`,
				{ label, modelId },
			);
		}
		provider = fallback;
	}

	if (options.refresh && lookup.modelRegistry.refresh) {
		const refresh = await lookup.modelRegistry.refresh({ allowNetwork: false, providers: [provider] });
		if (refresh.aborted) {
			throw new ModelReferenceError("aborted", `Refreshing ${provider} was aborted.`, { label, provider, modelId });
		}
		const refreshError = refresh.errors.get(provider);
		if (refreshError) {
			throw new ModelReferenceError("refresh", `Refreshing ${provider} failed: ${refreshError.message}`, {
				label,
				provider,
				modelId,
				cause: refreshError,
			});
		}
	}

	const model = lookup.modelRegistry.find(provider, modelId);
	if (!model) {
		if (options.optional) return undefined;
		throw new ModelReferenceError("unavailable", unavailableMessage(label, provider, modelId), {
			label,
			provider,
			modelId,
		});
	}
	if (
		options.scope !== "ignore" &&
		lookup.scopedModels?.length &&
		!lookup.scopedModels.some((entry) => entry.model.provider === provider && entry.model.id === modelId)
	) {
		if (options.optional) return undefined;
		throw new ModelReferenceError("out-of-scope", outOfScopeMessage(label, provider, modelId), {
			label,
			provider,
			modelId,
		});
	}
	return model;
}

/** Shared positive-integer context-window validation. */
export function validateContextWindow(value: unknown, label = "Context window"): number {
	if (!Number.isInteger(value) || (value as number) <= 0) {
		throw new Error(`${label} must be a positive integer.`);
	}
	return value as number;
}