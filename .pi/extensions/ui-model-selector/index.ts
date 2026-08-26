/**
 * Custom /model selector.
 *
 * Applies the saved normal profile silently on fresh-session startup and routes
 * the built-in command through a searchable model picker with thinking and
 * context-window choices. The context window comes from a preset derived from
 * the model's catalogue value, or the saved profile's contextWindow when a
 * startup profile is applied. On reload and resume, the session model's
 * context window is refreshed from the profile without switching models.
 * Explicit --model startup overrides and resumed sessions preserve their session
 * profile. Normal and Plan Mode selections are persisted separately in
 * .pi/settings.json.
 */

import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildSessionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_SENTINEL } from "../_shared/pi-defaults.ts";
import { createSessionProfileResolver, PROFILES_DIRECTORY } from "../_shared/active-profile.ts";
import {
	installModelCommandHandler,
	ModelCommandRoutingEditor,
} from "../_shared/model-command-routing.ts";
import { COMPACT_THRESHOLD, SEMANTIC_COMPACTION_FOCUS } from "../_shared/auto-compact.ts";
import {
	applyModelSelection,
	applyPickedModelSelection,
	currentSelectionMode,
	ModelSelectionPersistenceError,
	resolveContextWindow,
	resolveModelContext,
	type ModelSelectionMode,
	type ModelSelectionSettings,
} from "../_shared/model-selection.ts";
import {
	createProjectSettingsStore,
	PROJECT_SETTINGS_PATH,
	type ProjectSettingsStore,
} from "../_shared/model-selection-store.ts";
import {
	formatTokenCount,
	modelKey,
	pickModelConfiguration,
	type ModelPickerPreviousSelection,
} from "../_shared/model-picker.ts";
import { shouldOpenStartupModelSelector } from "./model-config.ts";

/**
 * Compact after a context-window reduction. Only kick compaction off while the
 * agent is idle; mid-run the auto-compact extension's turn_end and
 * before_agent_start hooks will compact and resume on their own.
 */
function compactWithHandoffFocus(ctx: ExtensionContext): void {
	if (!ctx.isIdle()) {
		ctx.ui.notify(
			"The agent is busy; auto-compact will compact and resume this turn.",
			"info",
		);
		return;
	}
	ctx.compact({
		customInstructions: SEMANTIC_COMPACTION_FOCUS,
		onError: (error) => {
			ctx.ui.notify(`Compaction failed: ${error.message}`, "error");
		},
	});
}

async function confirmAndApplySelection(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	selectedModel: Model<Api>,
	thinkingLevel: ModelThinkingLevel,
	mode: ModelSelectionMode,
	settingsStore: ProjectSettingsStore,
): Promise<void> {
	const contextWindow = selectedModel.contextWindow;
	const usage = ctx.getContextUsage();
	const isContextReduction = ctx.model !== undefined && contextWindow < ctx.model.contextWindow;
	const needsCompaction = isContextReduction &&
		usage?.tokens !== null && usage?.tokens !== undefined &&
		usage.tokens >= contextWindow * COMPACT_THRESHOLD;

	if (needsCompaction) {
		const approved = await ctx.ui.confirm(
			"Context window reduction",
			`This session uses about ${formatTokenCount(usage.tokens!)} tokens, at or above the auto-compact threshold of the ${formatTokenCount(contextWindow)} window. Apply the selection and compact now?`,
		);
		if (!approved) return;
	}

	let selection: ModelSelectionSettings;
	try {
		selection = await applyPickedModelSelection(pi, ctx, selectedModel, thinkingLevel, {
			mode,
			persistence: settingsStore,
		});
	} catch (error) {
		if (!(error instanceof ModelSelectionPersistenceError)) throw error;
		if (needsCompaction) compactWithHandoffFocus(ctx);
		const cause = error.cause instanceof Error ? error.cause.message : String(error.cause);
		ctx.ui.notify(
			`${error.appliedSelection.provider}/${error.appliedSelection.modelId} was applied, but settings were not fully saved: ${cause}`,
			"warning",
		);
		return;
	}

	if (needsCompaction) compactWithHandoffFocus(ctx);
	const thinkingNote = selection.thinkingLevel === thinkingLevel
		? selection.thinkingLevel
		: `${selection.thinkingLevel} (requested ${thinkingLevel})`;
	ctx.ui.notify(
		`${selection.provider}/${selection.modelId} · thinking ${thinkingNote} · context ${formatTokenCount(selection.contextWindow)}`,
		selection.thinkingLevel === thinkingLevel ? "info" : "warning",
	);
}

async function runModelControl(
	pi: ExtensionAPI,
	args: string,
	ctx: ExtensionContext,
	settingsStore: ProjectSettingsStore,
): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("The custom /model selector requires TUI mode.", "error");
		return;
	}

	const mode = currentSelectionMode(ctx);
	const liveThinking = typeof pi.getThinkingLevel === "function"
		? pi.getThinkingLevel() as ModelThinkingLevel
		: undefined;
	let previous: ModelPickerPreviousSelection | undefined;
	try {
		const preferences = await settingsStore.load();
		const profile = preferences.profiles[mode];
		previous = profile && profile.provider !== DEFAULT_SENTINEL && profile.modelId !== DEFAULT_SENTINEL
			? {
				provider: profile.provider,
				modelId: profile.modelId,
				thinkingLevel: profile.thinkingLevel !== DEFAULT_SENTINEL ? profile.thinkingLevel : liveThinking,
				contextWindow: typeof profile.contextWindow === "number" ? resolveContextWindow(profile.contextWindow) : undefined,
			}
			: undefined;
	} catch (error) {
		ctx.ui.notify(`Could not read the saved model selection: ${error instanceof Error ? error.message : String(error)}. Using picker defaults.`, "warning");
		previous = undefined;
	}

	const pickerSelection = await pickModelConfiguration(ctx, {
		initialQuery: args.trim(),
		previous: previous ?? {
			provider: ctx.model?.provider,
			modelId: ctx.model?.id,
			thinkingLevel: liveThinking,
		},
		currentModel: ctx.model,
	});
	if (!pickerSelection) return;

	try {
		await confirmAndApplySelection(
			pi,
			ctx,
			pickerSelection.model,
			pickerSelection.thinkingLevel,
			mode,
			settingsStore,
		);
	} catch (error) {
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
	}
}

export function createModelSelectorExtension(
	settingsStore: ProjectSettingsStore = createProjectSettingsStore(),
) {
	const resolver = createSessionProfileResolver({
		settingsPath: PROJECT_SETTINGS_PATH,
		profilesDirectory: PROFILES_DIRECTORY,
	});
	return function modelSelectorExtension(pi: ExtensionAPI) {
		let uninstallModelCommandHandler: (() => void) | undefined;

		pi.on("session_start", async (event, ctx) => {
			uninstallModelCommandHandler?.();
			uninstallModelCommandHandler = undefined;
			// Point the store at the session's profile file; no profile means
			// settings.json.
			settingsStore.setPath(
				resolver.resolve(ctx.sessionManager.getBranch(), event.reason, event.previousSessionFile),
			);
			if (ctx.mode !== "tui") return;

			const handler = async (args: string): Promise<void> => {
				try {
					await runModelControl(pi, args, ctx, settingsStore);
				} catch (error) {
					ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				}
			};
			uninstallModelCommandHandler = installModelCommandHandler(handler);
			ctx.ui.setEditorComponent((tui, theme, keybindings) =>
				new ModelCommandRoutingEditor(tui, theme, keybindings, handler));

			const hasConversationHistory = buildSessionContext(
				ctx.sessionManager.getEntries(),
				ctx.sessionManager.getLeafId(),
			).messages.length > 0;
			const shouldOpen = shouldOpenStartupModelSelector(
				event.reason,
				hasConversationHistory,
				process.argv.slice(2),
			);
			if (shouldOpen) {
				let appliedNormalProfile = false;
				try {
					const preferences = await settingsStore.load();
					if (preferences.profiles.normal) {
						await applyModelSelection(pi, ctx, preferences.profiles.normal, {
							label: "Normal profile",
						});
						appliedNormalProfile = true;
					}
				} catch (error) {
					ctx.ui.notify(
						`Could not apply the normal startup profile: ${error instanceof Error ? error.message : String(error)}`,
						"error",
					);
				}
				// A configured normal profile is the startup default. Only prompt on
				// first run or after an invalid profile fails to apply.
				if (!appliedNormalProfile) await handler("");
			} else if (ctx.model && (hasConversationHistory || ["reload", "resume", "fork"].includes(event.reason))) {
				try {
					const restoredModel = resolveModelContext(ctx.model);
					// Keep the session model's context window in sync with the saved
					// profile for the active mode (settings.json edits take effect on
					// reload) without switching models.
					const preferences = await settingsStore.load();
					const profile = preferences.profiles[currentSelectionMode(ctx)];
					const profileContext = profile && profile.contextWindow !== DEFAULT_SENTINEL &&
						profile.contextWindow !== undefined &&
						ctx.model.provider === profile.provider && ctx.model.id === profile.modelId
						? resolveContextWindow(profile.contextWindow)
						: restoredModel.contextWindow;
					const targetModel = profileContext !== restoredModel.contextWindow
						? { ...restoredModel, contextWindow: profileContext }
						: restoredModel;
					if (targetModel !== ctx.model && !(await pi.setModel(targetModel))) {
						ctx.ui.notify(`No configured authentication for ${modelKey(targetModel)}`, "error");
					}
				} catch (error) {
					ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				}
			}
		});

		pi.on("session_shutdown", (_event, ctx) => {
			uninstallModelCommandHandler?.();
			uninstallModelCommandHandler = undefined;
			if (ctx.mode === "tui") ctx.ui.setEditorComponent(undefined);
		});
	};
}

export default createModelSelectorExtension();
