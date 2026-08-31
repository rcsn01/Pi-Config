/**
 * Pi adapter for the custom /model selector.
 *
 * Session profile binding, command routing, editor ownership, picker rendering,
 * notifications, and concrete Pi calls stay here. Selection ordering and
 * session initialization policy live in model-selection-lifecycle.ts.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildSessionContext } from "@earendil-works/pi-coding-agent";
import { reapplyThinkingBorder } from "../_shared/editor-border.ts";
import { registerSessionProfileBinding } from "../_shared/session-profile-binding.ts";
import {
	installModelCommandHandler,
	ModelCommandRoutingEditor,
} from "../_shared/model-command-routing.ts";
import {
	applyModelSelection,
	applyPickedModelSelection,
	currentSelectionMode,
} from "../_shared/model-selection.ts";
import {
	createModelSelectionPersistence,
	type CreateModelSelectionPersistence,
	type ModelSelectionPersistence,
} from "../_shared/model-selection-persistence.ts";
import { PROJECT_SETTINGS_PATH } from "../_shared/settings-document.ts";
import { formatTokenCount, pickModelConfiguration } from "../_shared/model-picker.ts";
import {
	createModelSelectionLifecycle,
	type ContextReduction,
	type ModelSelectionLifecycleAdapter,
	type ModelSelectionLifecycleNotice,
	type ModelSelectionLifecycleOutcome,
} from "./model-selection-lifecycle.ts";

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function renderModelSelectionLifecycleNotice(
	ctx: ExtensionContext,
	notice: ModelSelectionLifecycleNotice,
): void {
	if (notice.kind === "startup-profile-apply-failed") {
		ctx.ui.notify(`Could not apply the normal startup profile: ${errorText(notice.cause)}`, "error");
		return;
	}
	ctx.ui.notify(
		`Could not read the saved model selection: ${errorText(notice.cause)}. Using picker defaults.`,
		"warning",
	);
}

function renderModelSelectionLifecycleOutcome(
	ctx: ExtensionContext,
	outcome: ModelSelectionLifecycleOutcome,
): void {
	if (outcome.kind !== "interactive-applied" && outcome.kind !== "interactive-applied-not-saved") {
		return;
	}
	if (outcome.compaction === "deferred") {
		ctx.ui.notify(
			"The agent is busy; auto-compact will compact and resume this turn.",
			"info",
		);
	}
	if (outcome.kind === "interactive-applied-not-saved") {
		ctx.ui.notify(
			`${outcome.selection.provider}/${outcome.selection.modelId} was applied, but settings were not fully saved: ${errorText(outcome.cause)}`,
			"warning",
		);
		return;
	}

	const thinkingNote = outcome.selection.thinkingLevel === outcome.requestedThinkingLevel
		? outcome.selection.thinkingLevel
		: `${outcome.selection.thinkingLevel} (requested ${outcome.requestedThinkingLevel})`;
	ctx.ui.notify(
		`${outcome.selection.provider}/${outcome.selection.modelId} · thinking ${thinkingNote} · context ${formatTokenCount(outcome.selection.contextWindow)}`,
		outcome.selection.thinkingLevel === outcome.requestedThinkingLevel ? "info" : "warning",
	);
}

class StaleModelSelectionSessionError extends Error {}

function createPiModelSelectionLifecycleAdapter(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	persistence: ModelSelectionPersistence,
	isCurrent: () => boolean,
): ModelSelectionLifecycleAdapter {
	const assertCurrent = () => {
		if (!isCurrent()) throw new StaleModelSelectionSessionError();
	};
	return {
		loadSelection: async (mode) => {
			assertCurrent();
			const selection = await persistence.load(mode);
			assertCurrent();
			return selection;
		},
		getRuntimeState: () => ({
			model: ctx.model,
			thinkingLevel: typeof pi.getThinkingLevel === "function" ? pi.getThinkingLevel() : undefined,
			usageTokens: ctx.getContextUsage()?.tokens,
		}),
		pick: async (options) => {
			assertCurrent();
			const selection = await pickModelConfiguration(ctx, options);
			assertCurrent();
			return selection;
		},
		applyStoredSelection: async (selection, label) => {
			assertCurrent();
			const applied = await applyModelSelection(pi, ctx, selection, { label });
			assertCurrent();
			return applied;
		},
		applyPickedSelection: async (selection, mode) => {
			assertCurrent();
			const applied = await applyPickedModelSelection(pi, ctx, selection.model, selection.thinkingLevel, {
				mode,
				persistence,
			});
			assertCurrent();
			return applied;
		},
		setModel: async (model) => {
			assertCurrent();
			const applied = await pi.setModel(model);
			assertCurrent();
			return applied;
		},
		confirmContextReduction: async (reduction: ContextReduction) => {
			assertCurrent();
			const confirmed = await ctx.ui.confirm(
				"Context window reduction",
				`This session uses about ${formatTokenCount(reduction.usageTokens)} tokens, at or above the auto-compact threshold of the ${formatTokenCount(reduction.contextWindow)} window. Apply the selection and compact now?`,
			);
			assertCurrent();
			return confirmed;
		},
		isIdle: () => ctx.isIdle(),
		requestCompaction: (customInstructions) => {
			if (!isCurrent()) return;
			ctx.compact({
				customInstructions,
				onError: (error) => {
					ctx.ui.notify(`Compaction failed: ${error.message}`, "error");
				},
			});
		},
		reportNotice: (notice) => {
			if (isCurrent()) renderModelSelectionLifecycleNotice(ctx, notice);
		},
	};
}

export interface ModelSelectorExtensionDependencies {
	settingsPath?: string;
	createModelSelectionPersistence?: CreateModelSelectionPersistence;
}

export function createModelSelectorExtension(
	dependencies: ModelSelectorExtensionDependencies = {},
) {
	const settingsPath = dependencies.settingsPath ?? PROJECT_SETTINGS_PATH;
	const persistenceFactory = dependencies.createModelSelectionPersistence ?? createModelSelectionPersistence;
	return function modelSelectorExtension(pi: ExtensionAPI) {
		let uninstallModelCommandHandler: (() => void) | undefined;
		let activeSession: object | undefined;
		const inFlightSelections = new Set<Promise<void>>();
		const trackSelection = (operation: Promise<void>): Promise<void> => {
			inFlightSelections.add(operation);
			void operation.then(
				() => inFlightSelections.delete(operation),
				() => inFlightSelections.delete(operation),
			);
			return operation;
		};
		const waitForSelections = async () => {
			await Promise.allSettled([...inFlightSelections]);
		};

		const profileInitialization = registerSessionProfileBinding(
			{ settingsPath },
			{
				name: "ui-model-selector",
				initialize: async (binding, event, ctx) => {
					uninstallModelCommandHandler?.();
					uninstallModelCommandHandler = undefined;
					await waitForSelections();
					const persistence = persistenceFactory(binding.settingsPath);
					const session = { binding, persistence };
					activeSession = session;
					if (ctx.mode !== "tui") return;

					const lifecycle = createModelSelectionLifecycle(
						createPiModelSelectionLifecycleAdapter(pi, ctx, persistence, () => activeSession === session),
					);
					const handler = (args: string): Promise<void> => trackSelection((async () => {
						try {
							const outcome = await lifecycle.selectInteractively({
								initialQuery: args.trim(),
								mode: currentSelectionMode(ctx),
							});
							if (activeSession === session) renderModelSelectionLifecycleOutcome(ctx, outcome);
						} catch (error) {
							if (!(error instanceof StaleModelSelectionSessionError)) {
								ctx.ui.notify(errorText(error), "error");
							}
						}
					})());
					uninstallModelCommandHandler = installModelCommandHandler(handler);
					ctx.ui.setEditorComponent((tui, theme, keybindings) => {
						const editor = new ModelCommandRoutingEditor(tui, theme, keybindings, handler);
						reapplyThinkingBorder(ctx, editor, tui);
						return editor;
					});

					const hasConversationHistory = buildSessionContext(
						ctx.sessionManager.getEntries(),
						ctx.sessionManager.getLeafId(),
					).messages.length > 0;
					try {
						const outcome = await lifecycle.initializeSession({
							reason: event.reason,
							hasConversationHistory,
							argv: process.argv.slice(2),
							mode: currentSelectionMode(ctx),
						});
						renderModelSelectionLifecycleOutcome(ctx, outcome);
					} catch (error) {
						if (!(error instanceof StaleModelSelectionSessionError)) {
							ctx.ui.notify(errorText(error), "error");
						}
					}
				},
				dispose: async (_binding, ctx) => {
					await waitForSelections();
					activeSession = undefined;
					uninstallModelCommandHandler?.();
					uninstallModelCommandHandler = undefined;
					if (ctx.mode === "tui") ctx.ui.setEditorComponent(undefined);
				},
			},
		);

		pi.on("session_start", async (event, ctx) => {
			await profileInitialization.start(event, ctx);
		});
		pi.on("session_shutdown", async (event, ctx) => {
			try {
				await profileInitialization.stop(event, ctx);
			} finally {
				profileInitialization.unregister();
			}
		});
	};
}

export default createModelSelectorExtension();
