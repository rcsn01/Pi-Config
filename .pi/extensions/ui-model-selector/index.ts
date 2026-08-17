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
import { Input, SelectList, truncateToWidth } from "@earendil-works/pi-tui";
import {
	installModelCommandHandler,
	ModelCommandRoutingEditor,
} from "../_shared/model-command-routing.ts";
import {
	calculateCompactionReserveTokens,
	filterModels,
	findExactModel,
	formatTokenCount,
	resolveContextWindow,
	resolveModelContext,
	shouldOpenStartupModelSelector,
	type ModelSelectionMode,
	type ModelSelectionSettings,
} from "./model-config.ts";
import {
	createProjectSettingsStore,
	type ProjectSettingsStore,
} from "./settings-store.ts";

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

export function selectionModeFromEntries(entries: readonly unknown[]): ModelSelectionMode {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index] as { type?: unknown; customType?: unknown; data?: unknown };
		if (entry?.type !== "custom" || entry.customType !== "plan-mode-state") continue;
		const data = entry.data as { active?: unknown } | undefined;
		return data?.active === true ? "plan" : "normal";
	}
	return "normal";
}

function currentSelectionMode(ctx: ExtensionContext): ModelSelectionMode {
	return selectionModeFromEntries(ctx.sessionManager.getBranch());
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

	return ctx.ui.custom<Model<Api> | undefined>((tui, theme, keybindings, done) => {
		const search = new Input();
		search.setValue(initialQuery);
		let list: SelectList;
		let displayed = new Map<string, Model<Api>>();

		const rebuildList = () => {
			const filtered = filterModels(models, search.getValue());
			displayed = new Map(filtered.map((model) => [modelKey(model), model]));
			list = new SelectList(
				filtered.map((model) => ({
					value: modelKey(model),
					label: modelKey(model),
					description: `${model.name} · ${formatTokenCount(model.contextWindow)} · ${model.reasoning ? "thinking" : "no thinking"}`,
				})),
				Math.min(Math.max(filtered.length, 1), 12),
				{
					selectedPrefix: (text) => theme.fg("accent", text),
					selectedText: (text) => theme.fg("accent", text),
					description: (text) => theme.fg("muted", text),
					scrollInfo: (text) => theme.fg("dim", text),
					noMatch: (text) => theme.fg("warning", text),
				},
				{ minPrimaryColumnWidth: 28, maxPrimaryColumnWidth: 44 },
			);
			list.onSelect = (item) => done(displayed.get(item.value));
			list.onCancel = () => done(undefined);

			if (!search.getValue() && ctx.model) {
				const activeIndex = filtered.findIndex((model) => modelKey(model) === modelKey(ctx.model!));
				if (activeIndex >= 0) list.setSelectedIndex(activeIndex);
			}
		};

		rebuildList();

		return {
			get focused() {
				return search.focused;
			},
			set focused(value: boolean) {
				search.focused = value;
			},
			render(width: number) {
				const border = theme.fg("accent", "─".repeat(Math.max(0, width)));
				return [
					border,
					truncateToWidth(theme.fg("accent", theme.bold("Select Model")), width),
					...search.render(width),
					"",
					...list.render(width),
					"",
					truncateToWidth(theme.fg("dim", "Type to filter · ↑↓ navigate · Enter select · Esc cancel"), width),
					border,
				];
			},
			invalidate() {
				search.invalidate();
				list.invalidate();
			},
			handleInput(data: string) {
				if (
					keybindings.matches(data, "tui.select.up") ||
					keybindings.matches(data, "tui.select.down") ||
					keybindings.matches(data, "tui.select.confirm") ||
					keybindings.matches(data, "tui.select.cancel")
				) {
					list.handleInput(data);
				} else {
					const before = search.getValue();
					search.handleInput(data);
					if (search.getValue() !== before) rebuildList();
				}
				tui.requestRender();
			},
		};
	});
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

async function applyStoredProfile(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	profile: ModelSelectionSettings,
	settingsStore: ProjectSettingsStore,
): Promise<void> {
	const refresh = await ctx.modelRegistry.refresh({ allowNetwork: false, providers: [profile.provider] });
	if (refresh.aborted) throw new Error(`Refreshing ${profile.provider} was aborted.`);
	const refreshError = refresh.errors.get(profile.provider);
	if (refreshError) throw refreshError;
	const catalogueModel = ctx.modelRegistry.find(profile.provider, profile.modelId);
	if (!catalogueModel) throw new Error(`Normal profile model ${profile.provider}/${profile.modelId} is unavailable.`);
	if (
		ctx.scopedModels.length > 0 &&
		!ctx.scopedModels.some((entry) => entry.model.provider === profile.provider && entry.model.id === profile.modelId)
	) {
		throw new Error(`Normal profile model ${profile.provider}/${profile.modelId} is outside this session's model scope.`);
	}
	// Honor the profile's configured context window; the catalogue value is only
	// a fallback when the profile does not pin one.
	const model = {
		...resolveModelContext(catalogueModel),
		contextWindow: resolveContextWindow(profile.contextWindow),
	};
	if (!(await pi.setModel(model))) {
		throw new Error(`No configured authentication for ${profile.provider}/${profile.modelId}.`);
	}
	pi.setThinkingLevel(profile.thinkingLevel);
	await settingsStore.syncCompaction(model.contextWindow);
}

async function applySelection(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	selectedModel: Model<Api>,
	thinkingLevel: ModelThinkingLevel,
	contextWindow: number,
	compactionThreshold: number,
	mode: ModelSelectionMode,
	settingsStore: ProjectSettingsStore,
): Promise<void> {
	const compactionReserve = calculateCompactionReserveTokens(contextWindow, compactionThreshold);
	const usage = ctx.getContextUsage();
	const needsCompaction = usage?.tokens !== null && usage?.tokens !== undefined &&
		usage.tokens > Math.max(1, contextWindow - compactionReserve);

	if (needsCompaction) {
		const approved = await ctx.ui.confirm(
			"Context window reduction",
			`This session uses about ${formatTokenCount(usage.tokens!)} tokens, above the safe ${formatTokenCount(contextWindow)} window. Apply the selection and compact now?`,
		);
		if (!approved) return;
	}

	const model = { ...selectedModel, contextWindow };
	const changed = await pi.setModel(model);
	if (!changed) {
		ctx.ui.notify(`No configured authentication for ${modelKey(model)}`, "error");
		return;
	}

	pi.setThinkingLevel(thinkingLevel);
	const effectiveThinking = pi.getThinkingLevel() as ModelThinkingLevel;
	await settingsStore.save(mode, {
		provider: model.provider,
		modelId: model.id,
		thinkingLevel: effectiveThinking,
		contextWindow: model.contextWindow,
	});
	if (needsCompaction) ctx.compact();

	const thinkingNote = effectiveThinking === thinkingLevel
		? effectiveThinking
		: `${effectiveThinking} (requested ${thinkingLevel})`;
	ctx.ui.notify(
		`${modelKey(model)} · thinking ${thinkingNote} · context ${formatTokenCount(model.contextWindow)}`,
		effectiveThinking === thinkingLevel ? "info" : "warning",
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

	const contextWindow = resolveContextWindow(selectedModel.contextWindow);

	try {
		await applySelection(
			pi,
			ctx,
			selectedModel,
			thinkingLevel,
			contextWindow,
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
	return function modelSelectorExtension(pi: ExtensionAPI) {
		let uninstallModelCommandHandler: (() => void) | undefined;

		pi.on("session_start", async (event, ctx) => {
			uninstallModelCommandHandler?.();
			uninstallModelCommandHandler = undefined;
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
						await applyStoredProfile(pi, ctx, preferences.profiles.normal, settingsStore);
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
					const profileContext = profile && ctx.model.provider === profile.provider && ctx.model.id === profile.modelId
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
