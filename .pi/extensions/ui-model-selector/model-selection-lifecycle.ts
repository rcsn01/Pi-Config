import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { DEFAULT_SENTINEL } from "../_shared/pi-defaults.ts";
import { COMPACT_THRESHOLD, SEMANTIC_COMPACTION_FOCUS } from "../_shared/auto-compact.ts";
import {
	ModelSelectionPersistenceError,
	resolveContextWindow,
	resolveModelContext,
	type ModelSelectionMode,
	type ModelSelectionSettings,
	type StoredModelSelectionSettings,
} from "../_shared/model-selection.ts";
import {
	type ModelPickerOptions,
	type ModelPickerSelection,
	type ModelPickerPreviousSelection,
} from "../_shared/model-picker.ts";

export type SessionStartReason = "startup" | "reload" | "new" | "resume" | "fork";

export interface ModelSelectionSessionInput {
	reason: SessionStartReason;
	hasConversationHistory: boolean;
	argv: readonly string[];
	mode: ModelSelectionMode;
}

export interface InteractiveModelSelectionInput {
	initialQuery: string;
	mode: ModelSelectionMode;
}

export interface ModelSelectionRuntimeState {
	model?: Model<Api>;
	thinkingLevel?: ModelThinkingLevel;
	usageTokens?: number | null;
}

export interface ContextReduction {
	usageTokens: number;
	contextWindow: number;
}

export type ModelSelectionCompaction = "none" | "started" | "deferred";

export type ModelSelectionLifecycleNotice =
	| { kind: "saved-selection-read-failed"; cause: unknown }
	| { kind: "startup-profile-apply-failed"; cause: unknown };

export type ModelSelectionLifecycleOutcome =
	| {
		kind: "unchanged";
		reason:
			| "startup-bypassed"
			| "no-current-model"
			| "context-current"
			| "picker-cancelled"
			| "context-reduction-declined";
	}
	| { kind: "startup-profile-applied"; selection: ModelSelectionSettings }
	| { kind: "context-synchronized"; model: Model<Api> }
	| {
		kind: "interactive-applied";
		selection: ModelSelectionSettings;
		requestedThinkingLevel: ModelThinkingLevel;
		compaction: ModelSelectionCompaction;
	}
	| {
		kind: "interactive-applied-not-saved";
		selection: ModelSelectionSettings;
		requestedThinkingLevel: ModelThinkingLevel;
		cause: unknown;
		compaction: ModelSelectionCompaction;
	};

export interface ModelSelectionLifecycleAdapter {
	loadSelection(mode: ModelSelectionMode): Promise<StoredModelSelectionSettings | undefined>;
	getRuntimeState(): ModelSelectionRuntimeState;
	pick(options: ModelPickerOptions): Promise<ModelPickerSelection | undefined>;
	applyStoredSelection(
		selection: StoredModelSelectionSettings,
		label: string,
	): Promise<ModelSelectionSettings>;
	applyPickedSelection(
		selection: ModelPickerSelection,
		mode: ModelSelectionMode,
	): Promise<ModelSelectionSettings>;
	setModel(model: Model<Api>): Promise<boolean>;
	confirmContextReduction(reduction: ContextReduction): Promise<boolean>;
	isIdle(): boolean;
	requestCompaction(customInstructions: string): void;
	reportNotice(notice: ModelSelectionLifecycleNotice): void;
}

export interface ModelSelectionLifecycle {
	initializeSession(input: ModelSelectionSessionInput): Promise<ModelSelectionLifecycleOutcome>;
	selectInteractively(input: InteractiveModelSelectionInput): Promise<ModelSelectionLifecycleOutcome>;
}

function hasExplicitModelArgument(argv: readonly string[]): boolean {
	return argv.some((argument) => argument === "--model" || argument.startsWith("--model="));
}

function shouldOpenStartupModelSelector(input: ModelSelectionSessionInput): boolean {
	if (hasExplicitModelArgument(input.argv)) return false;
	if (input.reason === "new") return true;
	return input.reason === "startup" && !input.hasConversationHistory;
}

function pickerPreviousSelection(
	profile: StoredModelSelectionSettings | undefined,
	thinkingLevel: ModelThinkingLevel | undefined,
): ModelPickerPreviousSelection | undefined {
	if (!profile || profile.provider === DEFAULT_SENTINEL || profile.modelId === DEFAULT_SENTINEL) {
		return undefined;
	}
	return {
		provider: profile.provider,
		modelId: profile.modelId,
		thinkingLevel: profile.thinkingLevel !== DEFAULT_SENTINEL ? profile.thinkingLevel : thinkingLevel,
		contextWindow: typeof profile.contextWindow === "number"
			? resolveContextWindow(profile.contextWindow)
			: undefined,
	};
}

export function createModelSelectionLifecycle(
	adapter: ModelSelectionLifecycleAdapter,
): ModelSelectionLifecycle {
	function compactAfterReduction(required: boolean): ModelSelectionCompaction {
		if (!required) return "none";
		if (!adapter.isIdle()) return "deferred";
		adapter.requestCompaction(SEMANTIC_COMPACTION_FOCUS);
		return "started";
	}

	async function selectInteractively(
		input: InteractiveModelSelectionInput,
	): Promise<ModelSelectionLifecycleOutcome> {
		const runtime = adapter.getRuntimeState();
		let previous: ModelPickerPreviousSelection | undefined;
		try {
			previous = pickerPreviousSelection(await adapter.loadSelection(input.mode), runtime.thinkingLevel);
		} catch (cause) {
			adapter.reportNotice({ kind: "saved-selection-read-failed", cause });
		}

		const picked = await adapter.pick({
			initialQuery: input.initialQuery.trim(),
			previous: previous ?? {
				provider: runtime.model?.provider,
				modelId: runtime.model?.id,
				thinkingLevel: runtime.thinkingLevel,
			},
			currentModel: runtime.model,
		});
		if (!picked) return { kind: "unchanged", reason: "picker-cancelled" };

		const isReduction = runtime.model !== undefined &&
			picked.model.contextWindow < runtime.model.contextWindow;
		const needsCompaction = isReduction &&
			runtime.usageTokens !== null && runtime.usageTokens !== undefined &&
			runtime.usageTokens >= picked.model.contextWindow * COMPACT_THRESHOLD;
		if (needsCompaction) {
			const approved = await adapter.confirmContextReduction({
				usageTokens: runtime.usageTokens!,
				contextWindow: picked.model.contextWindow,
			});
			if (!approved) return { kind: "unchanged", reason: "context-reduction-declined" };
		}

		try {
			const selection = await adapter.applyPickedSelection(picked, input.mode);
			return {
				kind: "interactive-applied",
				selection,
				requestedThinkingLevel: picked.thinkingLevel,
				compaction: compactAfterReduction(needsCompaction),
			};
		} catch (error) {
			if (!(error instanceof ModelSelectionPersistenceError)) throw error;
			return {
				kind: "interactive-applied-not-saved",
				selection: error.appliedSelection,
				requestedThinkingLevel: picked.thinkingLevel,
				cause: error.cause,
				compaction: compactAfterReduction(needsCompaction),
			};
		}
	}

	async function synchronizeContext(
		input: ModelSelectionSessionInput,
	): Promise<ModelSelectionLifecycleOutcome> {
		const currentModel = adapter.getRuntimeState().model;
		if (!currentModel) return { kind: "unchanged", reason: "no-current-model" };

		const restoredModel = resolveModelContext(currentModel);
		const profile = await adapter.loadSelection(input.mode);
		const profileContext = profile && profile.contextWindow !== DEFAULT_SENTINEL &&
			profile.contextWindow !== undefined &&
			currentModel.provider === profile.provider && currentModel.id === profile.modelId
			? resolveContextWindow(profile.contextWindow)
			: restoredModel.contextWindow;
		const targetModel = profileContext !== restoredModel.contextWindow
			? { ...restoredModel, contextWindow: profileContext }
			: restoredModel;
		if (targetModel === currentModel) return { kind: "unchanged", reason: "context-current" };
		if (!(await adapter.setModel(targetModel))) {
			throw new Error(`No configured authentication for ${targetModel.provider}/${targetModel.id}`);
		}
		return { kind: "context-synchronized", model: targetModel };
	}

	async function initializeSession(
		input: ModelSelectionSessionInput,
	): Promise<ModelSelectionLifecycleOutcome> {
		if (shouldOpenStartupModelSelector(input)) {
			try {
				const normalProfile = await adapter.loadSelection("normal");
				if (normalProfile) {
					const selection = await adapter.applyStoredSelection(normalProfile, "Normal profile");
					return { kind: "startup-profile-applied", selection };
				}
			} catch (cause) {
				adapter.reportNotice({ kind: "startup-profile-apply-failed", cause });
			}
			return selectInteractively({ initialQuery: "", mode: input.mode });
		}

		const shouldSynchronize = input.hasConversationHistory ||
			input.reason === "reload" || input.reason === "resume" || input.reason === "fork";
		if (shouldSynchronize) return synchronizeContext(input);
		return { kind: "unchanged", reason: "startup-bypassed" };
	}

	return { initializeSession, selectInteractively };
}
