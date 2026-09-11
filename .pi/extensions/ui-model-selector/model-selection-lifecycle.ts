import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { DEFAULT_SENTINEL } from "../_shared/pi-defaults.ts";
import { COMPACT_THRESHOLD, SEMANTIC_COMPACTION_FOCUS } from "../_shared/auto-compact.ts";
import {
	type ModelSelectionMode,
	type ModelSelectionSettings,
	type StoredModelSelectionSettings,
} from "../_shared/model-selection.ts";
import {
	ModelSelectionNotSavedError,
	type ModelSelectionRuntime,
} from "../_shared/model-selection-runtime.ts";
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
	confirmContextReduction(reduction: ContextReduction): Promise<boolean>;
	isIdle(): boolean;
	requestCompaction(customInstructions: string): void;
	reportNotice(notice: ModelSelectionLifecycleNotice): void;
	reportOutcome(outcome: ModelSelectionLifecycleOutcome): void;
}

export class ModelSelectionSessionClosedError extends Error {
	constructor() {
		super("Model-selection Session is no longer active.");
		this.name = "ModelSelectionSessionClosedError";
	}
}

export interface ModelSelectionLifecycle {
	initializeSession(input: ModelSelectionSessionInput): Promise<ModelSelectionLifecycleOutcome>;
	selectInteractively(input: InteractiveModelSelectionInput): Promise<ModelSelectionLifecycleOutcome>;
	dispose(): Promise<void>;
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
			? profile.contextWindow
			: undefined,
	};
}

export interface ModelSelectionLifecycleDependencies {
	/** Session facts and policies: profile reads, picker, reduction confirmation,
	 *  compaction, notices, and outcomes. */
	adapter: ModelSelectionLifecycleAdapter;
	/** The model-selection runtime module: owns the stored→runtime mapping and
	 *  the runtime commits this lifecycle decides when to run. */
	runtime: ModelSelectionRuntime;
}

export function createModelSelectionLifecycle(
	dependencies: ModelSelectionLifecycleDependencies,
): ModelSelectionLifecycle {
	const { adapter, runtime: modelRuntime } = dependencies;
	let phase: "active" | "disposing" | "disposed" = "active";
	const operations = new Set<Promise<unknown>>();
	let disposal: Promise<void> | undefined;

	function runOperation(
		operation: () => Promise<ModelSelectionLifecycleOutcome>,
	): Promise<ModelSelectionLifecycleOutcome> {
		if (phase !== "active") return Promise.reject(new ModelSelectionSessionClosedError());
		const running = operation().then((outcome) => {
			adapter.reportOutcome(outcome);
			return outcome;
		});
		operations.add(running);
		void running.then(
			() => operations.delete(running),
			() => operations.delete(running),
		);
		return running;
	}

	function dispose(): Promise<void> {
		if (disposal) return disposal;
		phase = "disposing";
		disposal = Promise.allSettled([...operations]).then(() => {
			phase = "disposed";
		});
		return disposal;
	}

	function compactAfterReduction(required: boolean): ModelSelectionCompaction {
		if (!required) return "none";
		if (!adapter.isIdle()) return "deferred";
		adapter.requestCompaction(SEMANTIC_COMPACTION_FOCUS);
		return "started";
	}

	async function selectInteractivelyCore(
		input: InteractiveModelSelectionInput,
	): Promise<ModelSelectionLifecycleOutcome> {
		const state = adapter.getRuntimeState();
		let previous: ModelPickerPreviousSelection | undefined;
		try {
			previous = pickerPreviousSelection(await adapter.loadSelection(input.mode), state.thinkingLevel);
		} catch (cause) {
			adapter.reportNotice({ kind: "saved-selection-read-failed", cause });
		}

		const picked = await adapter.pick({
			initialQuery: input.initialQuery.trim(),
			previous: previous ?? {
				provider: state.model?.provider,
				modelId: state.model?.id,
				thinkingLevel: state.thinkingLevel,
			},
			currentModel: state.model,
		});
		if (!picked) return { kind: "unchanged", reason: "picker-cancelled" };

		const isReduction = state.model !== undefined &&
			picked.model.contextWindow < state.model.contextWindow;
		const needsCompaction = isReduction &&
			state.usageTokens !== null && state.usageTokens !== undefined &&
			state.usageTokens >= picked.model.contextWindow * COMPACT_THRESHOLD;
		if (needsCompaction) {
			const approved = await adapter.confirmContextReduction({
				usageTokens: state.usageTokens!,
				contextWindow: picked.model.contextWindow,
			});
			if (!approved) return { kind: "unchanged", reason: "context-reduction-declined" };
		}

		try {
			const selection = await modelRuntime.applyPicked(picked.model, picked.thinkingLevel, {
				mode: input.mode,
			});
			return {
				kind: "interactive-applied",
				selection,
				requestedThinkingLevel: picked.thinkingLevel,
				compaction: compactAfterReduction(needsCompaction),
			};
		} catch (error) {
			if (!(error instanceof ModelSelectionNotSavedError)) throw error;
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
		const state = adapter.getRuntimeState();
		const currentModel = state.model;
		if (!currentModel) return { kind: "unchanged", reason: "no-current-model" };

		const profile = await adapter.loadSelection(input.mode);
		const result = await modelRuntime.synchronize(currentModel, profile, state.thinkingLevel);
		if (result.kind === "unchanged") return { kind: "unchanged", reason: "context-current" };
		return { kind: "context-synchronized", model: result.model };
	}

	async function initializeSession(
		input: ModelSelectionSessionInput,
	): Promise<ModelSelectionLifecycleOutcome> {
		if (shouldOpenStartupModelSelector(input)) {
			try {
				const normalProfile = await adapter.loadSelection("normal");
				if (normalProfile) {
					const selection = await modelRuntime.applyStored(normalProfile, { label: "Normal profile" });
					return { kind: "startup-profile-applied", selection };
				}
			} catch (cause) {
				adapter.reportNotice({ kind: "startup-profile-apply-failed", cause });
			}
			return selectInteractivelyCore({ initialQuery: "", mode: input.mode });
		}

		const shouldSynchronize = input.hasConversationHistory ||
			input.reason === "reload" || input.reason === "resume" || input.reason === "fork";
		if (shouldSynchronize) return synchronizeContext(input);
		return { kind: "unchanged", reason: "startup-bypassed" };
	}

	return {
		initializeSession: (input) => runOperation(() => initializeSession(input)),
		selectInteractively: (input) => runOperation(() => selectInteractivelyCore(input)),
		dispose,
	};
}
