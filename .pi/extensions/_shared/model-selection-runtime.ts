/**
 * Model-selection runtime — the deep in-process module owning the
 * stored→runtime mapping and the runtime commits: sentinel resolution against
 * Pi's native defaults, the Model reference lookup, the verbatim
 * context-window contract, thinking survival across `setModel`, the commit
 * ordering and its read-back, the sync path, and the no-auth error mode.
 *
 * The stored format (parsing, validation, merging, sentinels, and pure
 * normalizers) stays in `model-selection.ts`; this module imports its types
 * and normalizers. Callers inject two dependencies: the `ModelRuntimeFacts`
 * port (the runtime facts and commits land on) and the model `catalogue` for
 * reference resolution. `createPiModelRuntime` binds both to Pi; tests inject
 * fakes, which is what makes the lifecycle's sync path testable without Pi.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	type ModelSelectionMode,
	type ModelSelectionSettings,
	type StoredModelSelectionSettings,
	parseProjectModelPreferences,
	resolveModelContext,
	selectionModeFromEntries,
} from "./model-selection.ts";
import {
	DEFAULT_SENTINEL,
	readPiNativeDefaults,
	type PiNativeDefaults,
} from "./pi-defaults.ts";
import {
	MODEL_THINKING_LEVELS,
	type SupportedModelThinkingLevel,
} from "./model-thinking.ts";
import {
	ModelReferenceError,
	resolveModelReference,
	type RefreshableModelLookup,
} from "./model-reference.ts";

type StoredThinkingLevel = SupportedModelThinkingLevel;

/** Narrow port for the runtime facts the stored→runtime mapping commits to. */
export interface ModelRuntimeFacts {
	currentModel(): Model<Api> | undefined;
	currentThinkingLevel(): StoredThinkingLevel | undefined;
	/** false = no configured authentication for that model. */
	setModel(model: Model<Api>): Promise<boolean>;
	setThinkingLevel(level: StoredThinkingLevel): void;
}

/** Narrow seam for persisting one mode's effective model selection. */
export interface ModelSelectionSaver {
	save(mode: ModelSelectionMode, selection: ModelSelectionSettings): Promise<void>;
}

/** A picked selection was applied live, but its effective settings did not fully persist. */
export class ModelSelectionNotSavedError extends Error {
	readonly appliedSelection: ModelSelectionSettings;

	constructor(appliedSelection: ModelSelectionSettings, cause: unknown) {
		super(
			`Model selection was applied, but settings were not fully saved: ${cause instanceof Error ? cause.message : String(cause)}`,
			{ cause },
		);
		this.name = "ModelSelectionNotSavedError";
		this.appliedSelection = appliedSelection;
	}
}

/** Result of reconciling the current model with a stored profile. */
export type ModelSynchronizationResult =
	| { kind: "unchanged" }
	| { kind: "synchronized"; model: Model<Api> };

/** The deep module: one instance per Session, constructed by the Pi adapter. */
export interface ModelSelectionRuntime {
	/** Stored → runtime. Resolves sentinels, may switch models via the catalogue.
	 *  `label` is required: it prefixes resolution error messages, as today. */
	applyStored(
		stored: StoredModelSelectionSettings,
		options: { label: string; nativeDefaults?: PiNativeDefaults },
	): Promise<ModelSelectionSettings>;
	/** Picked → commit → persist effective selection. Throws ModelSelectionNotSavedError. */
	applyPicked(
		model: Model<Api>,
		thinkingLevel: StoredThinkingLevel,
		options: { mode: ModelSelectionMode },
	): Promise<ModelSelectionSettings>;
	/** Sync path: reconcile the given current model with a stored profile. The derived target
	 *  always shares provider/modelId with `currentModel` (setModel still runs whenever the
	 *  derived target object differs), never queries the catalogue, and treats absent or sentinel
	 *  profile fields as "keep current". The current model and `preReadThinkingLevel` are
	 *  parameters, not port reads: the lifecycle has already read both in its single
	 *  `getRuntimeState` snapshot — taken *before* the profile load — and reusing that snapshot
	 *  keeps today's read pattern (one pre-load read, one fresh level read after `setModel`)
	 *  and leaves the no-model case with the caller, where it lives today. */
	synchronize(
		currentModel: Model<Api>,
		stored: StoredModelSelectionSettings | undefined,
		/** The caller's pre-read runtime level — the snapshot taken before the
		 *  profile load. Used verbatim when the derived target already matches;
		 *  the module re-reads through the port only after setModel. */
		preReadThinkingLevel: StoredThinkingLevel | undefined,
	): Promise<ModelSynchronizationResult>;
}

type ResolvedContextWindow =
	| { kind: "stored"; value: number }
	| { kind: "catalogue" }
	| { kind: "inherit" };

type ResolvedModelSelection = {
	provider: string;
	modelId: string;
	thinkingLevel: StoredThinkingLevel;
	contextWindow: ResolvedContextWindow;
};

function resolveStoredSelection(
	stored: StoredModelSelectionSettings,
	fallbackThinkingLevel: StoredThinkingLevel,
	nativeDefaults?: PiNativeDefaults,
): ResolvedModelSelection {
	const needsNativeDefaults = stored.provider === DEFAULT_SENTINEL ||
		stored.modelId === DEFAULT_SENTINEL ||
		stored.thinkingLevel === DEFAULT_SENTINEL;
	const defaults = needsNativeDefaults ? (nativeDefaults ?? readPiNativeDefaults()) : undefined;
	const thinkingLevel = stored.thinkingLevel === DEFAULT_SENTINEL
		? defaults?.thinkingLevel ?? fallbackThinkingLevel
		: stored.thinkingLevel;
	if (!MODEL_THINKING_LEVELS.includes(thinkingLevel as StoredThinkingLevel)) {
		throw new Error(`Pi's native defaultThinkingLevel is not supported: ${String(thinkingLevel)}.`);
	}

	return {
		provider: stored.provider === DEFAULT_SENTINEL ? defaults!.provider : stored.provider,
		modelId: stored.modelId === DEFAULT_SENTINEL ? defaults!.modelId : stored.modelId,
		thinkingLevel: thinkingLevel as StoredThinkingLevel,
		contextWindow: stored.contextWindow === DEFAULT_SENTINEL
			? { kind: "catalogue" }
			: stored.contextWindow === undefined
				? { kind: "inherit" }
				: { kind: "stored", value: stored.contextWindow },
	};
}

/**
 * The apply commit: resolve target → `setModel` iff provider/id/contextWindow
 * differ → re-apply thinking when pi's effective level differs → read back the
 * effective level (post-clamp) → return the effective selection.
 */
async function commitResolvedModel(
	facts: ModelRuntimeFacts,
	model: Model<Api>,
	thinkingLevel: StoredThinkingLevel,
): Promise<ModelSelectionSettings> {
	const currentModel = facts.currentModel();
	const modelChanged = currentModel?.provider !== model.provider ||
		currentModel.id !== model.id ||
		currentModel.contextWindow !== model.contextWindow;
	if (modelChanged && !(await facts.setModel(model))) {
		throw new Error(`No configured authentication for ${model.provider}/${model.id}.`);
	}

	const currentThinkingLevel = facts.currentThinkingLevel();
	if (currentThinkingLevel !== thinkingLevel) facts.setThinkingLevel(thinkingLevel);
	const effectiveThinkingLevel = facts.currentThinkingLevel() ?? thinkingLevel;

	return {
		provider: model.provider,
		modelId: model.id,
		thinkingLevel: effectiveThinkingLevel,
		contextWindow: model.contextWindow,
	};
}

export function createModelSelectionRuntime(deps: {
	facts: ModelRuntimeFacts;
	catalogue: RefreshableModelLookup;
	/** Consumed by `applyPicked` only; omitting it and calling `applyPicked` throws rather than
	 *  silently skipping persistence. */
	saver?: ModelSelectionSaver;
}): ModelSelectionRuntime {
	const { facts, catalogue } = deps;

	async function applyStored(
		stored: StoredModelSelectionSettings,
		options: {
			/** Label used in error messages, e.g. "Normal profile" or "Plan Mode profile". */
			label: string;
			nativeDefaults?: PiNativeDefaults;
		},
	): Promise<ModelSelectionSettings> {
		const fallbackThinkingLevel = facts.currentThinkingLevel() ?? "medium";
		const resolved = resolveStoredSelection(stored, fallbackThinkingLevel, options.nativeDefaults);
		const currentModel = facts.currentModel();
		const sameModel = currentModel?.provider === resolved.provider && currentModel.id === resolved.modelId;
		const context = resolved.contextWindow;

		let model: Model<Api>;
		if (sameModel && context.kind !== "catalogue") {
			if (context.kind === "inherit") {
				// Legacy selections without a context: keep the current window.
				model = currentModel;
			} else {
				// Stored context windows are explicit user choices — 128000 is a
				// legitimate selection, not pi's undeclared-context sentinel.
				model = context.value === currentModel.contextWindow
					? currentModel
					: { ...currentModel, contextWindow: context.value };
			}
		} else {
			let catalogueModel: Model<Api>;
			try {
				catalogueModel = await resolveModelReference(catalogue, { provider: resolved.provider, modelId: resolved.modelId }, {
					label: options.label,
					refresh: true,
				});
			} catch (error) {
				// The raw provider error (message and identity) survives exactly as
				// the previous inline implementation's re-throw.
				if (error instanceof ModelReferenceError && error.reason === "refresh" && error.cause instanceof Error) {
					throw error.cause;
				}
				throw error;
			}
			const normalized = resolveModelContext(catalogueModel);
			model = context.kind === "stored"
				? { ...normalized, contextWindow: context.value }
				: normalized;
		}

		return commitResolvedModel(facts, model, resolved.thinkingLevel);
	}

	async function applyPicked(
		model: Model<Api>,
		thinkingLevel: StoredThinkingLevel,
		options: { mode: ModelSelectionMode },
	): Promise<ModelSelectionSettings> {
		if (!deps.saver) {
			throw new Error("applyPicked requires an injected ModelSelectionSaver.");
		}
		// Persistence runs strictly after the live commit; failures surface as a
		// typed partial failure without rolling the runtime model back.
		const selection = await commitResolvedModel(facts, model, thinkingLevel);
		try {
			await deps.saver.save(options.mode, selection);
		} catch (cause) {
			throw new ModelSelectionNotSavedError(selection, cause);
		}
		return selection;
	}

	async function synchronize(
		currentModel: Model<Api>,
		profile: StoredModelSelectionSettings | undefined,
		preReadThinkingLevel: StoredThinkingLevel | undefined,
	): Promise<ModelSynchronizationResult> {
		const restoredModel = resolveModelContext(currentModel);
		const profileContext = profile && typeof profile.contextWindow === "number" &&
				currentModel.provider === profile.provider && currentModel.id === profile.modelId
			? // Stored context windows are explicit user choices; apply them
				// verbatim instead of re-resolving pi's 128K undeclared-context
				// sentinel, which would silently rewrite a 128K selection to 256K.
				profile.contextWindow
			: restoredModel.contextWindow;
		const targetModel = profileContext !== restoredModel.contextWindow
			? { ...restoredModel, contextWindow: profileContext }
			: restoredModel;
		// A concrete profile thinking level must survive the model sync: pi's
		// setModel imperatively applies per-model overrides or the global
		// default, which would otherwise win over the profile's effort level.
		const profileThinkingLevel = profile && profile.thinkingLevel !== DEFAULT_SENTINEL
			? profile.thinkingLevel
			: undefined;
		if (targetModel === currentModel) {
			if (profileThinkingLevel !== undefined && preReadThinkingLevel !== undefined &&
					preReadThinkingLevel !== profileThinkingLevel) {
				facts.setThinkingLevel(profileThinkingLevel);
				return { kind: "synchronized", model: currentModel };
			}
			return { kind: "unchanged" };
		}
		if (!(await facts.setModel(targetModel))) {
			throw new Error(`No configured authentication for ${targetModel.provider}/${targetModel.id}`);
		}
		const afterThinkingLevel = facts.currentThinkingLevel();
		if (profileThinkingLevel !== undefined && afterThinkingLevel !== undefined &&
				afterThinkingLevel !== profileThinkingLevel) {
			facts.setThinkingLevel(profileThinkingLevel);
		}
		return { kind: "synchronized", model: targetModel };
	}

	return { applyStored, applyPicked, synchronize };
}

/** Pi binding for external (pi, ctx) callers; passes `ctx` itself as the catalogue. */
export function createPiModelRuntime(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	deps: { saver?: ModelSelectionSaver } = {},
): ModelSelectionRuntime {
	return createModelSelectionRuntime({
		facts: {
			currentModel: () => ctx.model,
			currentThinkingLevel: () => typeof pi.getThinkingLevel === "function"
				? pi.getThinkingLevel() as StoredThinkingLevel
				: undefined,
			setModel: (model) => pi.setModel(model),
			setThinkingLevel: (level) => pi.setThinkingLevel(level),
		},
		catalogue: ctx,
		saver: deps.saver,
	});
}

/**
 * Apply a stored selection to the live session: resolve default sentinels,
 * refresh and look up the model when needed, and commit the resolved model
 * and thinking level. The stored profile itself is not persisted.
 *
 * The context-window contract preserves legacy plan-mode reads: an explicit
 * sentinel resolves through the catalogue; a stored numeric window is applied
 * verbatim (128000 is a legitimate user choice, not pi's undeclared-context
 * sentinel — only catalogue values get that normalization); a missing window
 * inherits the current model's window when the model already matches.
 */
export async function applyModelSelection(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	stored: StoredModelSelectionSettings,
	options: {
		/** Label used in error messages, e.g. "Normal profile" or "Plan Mode profile". */
		label: string;
		nativeDefaults?: PiNativeDefaults;
	},
): Promise<ModelSelectionSettings> {
	return createPiModelRuntime(pi, ctx).applyStored(stored, options);
}

/**
 * Apply the model selection saved for the current mode (normal or plan) in a
 * settings document — typically the profile that was just switched to.
 * Returns the applied selection, or undefined when the document has no
 * selection for the current mode (the session model is kept unchanged).
 */
export async function applySelectionFromDocument(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	document: Record<string, unknown>,
	nativeDefaults?: PiNativeDefaults,
): Promise<ModelSelectionSettings | undefined> {
	const mode = selectionModeFromEntries(ctx.sessionManager.getBranch());
	const selection = parseProjectModelPreferences(document).profiles[mode];
	if (!selection) return undefined;
	return createPiModelRuntime(pi, ctx).applyStored(selection, {
		label: "Profile",
		nativeDefaults,
	});
}
