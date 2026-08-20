/**
 * Custom /model selector.
 *
 * Applies the saved normal profile silently on fresh-session startup and routes
 * the built-in command through a searchable model picker with thinking choices.
 * The context window comes from the model's catalogue value, or the saved
 * profile's contextWindow when a startup profile is applied. On reload and
 * resume, the session model's context window is refreshed from the profile
 * without switching models.
 * Explicit --model startup overrides and resumed sessions preserve their session
 * profile. Normal and Plan Mode selections are persisted separately in
 * .pi/settings.json.
 */

import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildSessionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_SENTINEL } from "../_shared/pi-defaults.ts";
import { pickSelectScreen, type SelectScreenItem } from "../_shared/select-screen.ts";
import { createSessionProfileResolver, PROFILES_DIRECTORY } from "../_shared/active-profile.ts";
import {
	installModelCommandHandler,
	ModelCommandRoutingEditor,
} from "../_shared/model-command-routing.ts";
import {
	applyModelSelection,
	applyPickedModelSelection,
	calculateCompactionReserveTokens,
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
	filterModels,
	findExactModel,
	formatTokenCount,
	shouldOpenStartupModelSelector,
} from "./model-config.ts";

const THINKING_DESCRIPTIONS: Record<ModelThinkingLevel, string> = {
	off: "No extended thinking",
	minimal: "Fastest reasoning",
	low: "Light reasoning",
	medium: "Balanced reasoning",
	high: "Deep reasoning",
	xhigh: "Extra-high reasoning",
	max: "Maximum reasoning",
};

function modelKey(model: Pick<Model<Api>, "provider" | "id">): string {
	return `${model.provider}/${model.id}`;
}

function availableModels(ctx: ExtensionContext): Model<Api>[] {
	const models = ctx.scopedModels.length > 0
		? ctx.scopedModels.map((entry) =>
			ctx.modelRegistry.find(entry.model.provider, entry.model.id) ?? entry.model)
		: ctx.modelRegistry.getAvailable();
	const unique = new Map<string, Model<Api>>();
	for (const model of models) {
		const configured = resolveModelContext(model);
		unique.set(modelKey(configured), configured);
	}
	return [...unique.values()];
}

async function selectModel(
	ctx: ExtensionContext,
	models: readonly Model<Api>[],
	initialQuery: string,
): Promise<Model<Api> | undefined> {
	if (ctx.mode !== "tui") return undefined;

	const items: SelectScreenItem[] = models.map((model) => ({
		value: modelKey(model),
		label: modelKey(model),
		description: `${model.name} · ${formatTokenCount(model.contextWindow)} · ${model.reasoning ? "thinking" : "no thinking"}`,
		searchText: model.name,
	}));
	const itemsByValue = new Map(items.map((item) => [item.value, item]));
	const selected = await pickSelectScreen(ctx, {
		title: "Select model",
		items,
		currentValue: ctx.model ? modelKey(ctx.model) : undefined,
		showCurrentMarker: Boolean(ctx.model),
		search: {
			initialQuery,
			filter: (_choices, query) => filterModels(models, query)
				.map((model) => itemsByValue.get(modelKey(model)))
				.filter((item): item is SelectScreenItem => Boolean(item)),
		},
		columns: { minPrimaryColumnWidth: 28, maxPrimaryColumnWidth: 44 },
	});
	return models.find((model) => modelKey(model) === selected);
}

async function selectThinkingLevel(
	ctx: ExtensionContext,
	model: Model<Api>,
	current: ModelThinkingLevel,
): Promise<ModelThinkingLevel | undefined> {
	const supported = getSupportedThinkingLevels(model);
	const ordered = supported.includes(current)
		? [current, ...supported.filter((level) => level !== current)]
		: supported;
	const choices = ordered.map((level) =>
		`${level === current ? "●" : "○"} ${level} — ${THINKING_DESCRIPTIONS[level]}${level === current ? " (current)" : ""}`,
	);
	const selected = await ctx.ui.select(`Thinking · ${modelKey(model)}`, choices);
	if (!selected) return undefined;
	return ordered[choices.indexOf(selected)];
}

async function confirmAndApplySelection(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	selectedModel: Model<Api>,
	thinkingLevel: ModelThinkingLevel,
	compactionThreshold: number,
	mode: ModelSelectionMode,
	settingsStore: ProjectSettingsStore,
): Promise<void> {
	const contextWindow = selectedModel.contextWindow;
	const compactionReserve = calculateCompactionReserveTokens(contextWindow, compactionThreshold);
	const usage = ctx.getContextUsage();
	const isContextReduction = ctx.model !== undefined && contextWindow < ctx.model.contextWindow;
	const needsCompaction = isContextReduction &&
		usage?.tokens !== null && usage?.tokens !== undefined &&
		usage.tokens > Math.max(1, contextWindow - compactionReserve);

	if (needsCompaction) {
		const approved = await ctx.ui.confirm(
			"Context window reduction",
			`This session uses about ${formatTokenCount(usage.tokens!)} tokens, above the safe ${formatTokenCount(contextWindow)} window. Apply the selection and compact now?`,
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
		if (needsCompaction) ctx.compact();
		const cause = error.cause instanceof Error ? error.cause.message : String(error.cause);
		ctx.ui.notify(
			`${error.appliedSelection.provider}/${error.appliedSelection.modelId} was applied, but settings were not fully saved: ${cause}`,
			"warning",
		);
		return;
	}

	if (needsCompaction) ctx.compact();
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

	try {
		const refresh = await ctx.modelRegistry.refresh({ allowNetwork: false });
		if (refresh.aborted) throw new Error("Model catalogue refresh was aborted.");
		if (refresh.errors.size > 0) {
			const details = [...refresh.errors.entries()]
				.map(([provider, error]) => `${provider}: ${error.message}`)
				.join("; ");
			throw new Error(details);
		}
	} catch (error) {
		ctx.ui.notify(
			`Could not reload the model catalogue: ${error instanceof Error ? error.message : String(error)}`,
			"error",
		);
		return;
	}

	const mode = currentSelectionMode(ctx);
	const preferences = await settingsStore.load();
	const models = availableModels(ctx);
	if (models.length === 0) {
		ctx.ui.notify("No authenticated models are available.", "error");
		return;
	}

	const query = args.trim();
	const selectedModel = findExactModel(models, query) ?? await selectModel(ctx, models, query);
	if (!selectedModel) return;

	const thinkingLevel = await selectThinkingLevel(
		ctx,
		selectedModel,
		pi.getThinkingLevel() as ModelThinkingLevel,
	);
	if (!thinkingLevel) return;

	try {
		await confirmAndApplySelection(
			pi,
			ctx,
			selectedModel,
			thinkingLevel,
			preferences.compactionThreshold,
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
			// Point the store at the session's profile file (uiModelSelector) while
			// compaction stays in settings.json; no profile means settings.json.
			settingsStore.setPaths(
				resolver.resolve(ctx.sessionManager.getBranch(), event.reason),
				PROJECT_SETTINGS_PATH,
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
							compaction: settingsStore,
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
					} else {
						await settingsStore.syncCompaction(targetModel.contextWindow);
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
