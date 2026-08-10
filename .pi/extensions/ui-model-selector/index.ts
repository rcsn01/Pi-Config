/**
 * Custom /model selector.
 *
 * Routes fresh-session startup and the built-in command through a searchable
 * model picker, then lets the user choose a supported thinking level and (for
 * GPT-5.6) 272K or 1.05M context. Explicit --model startup overrides and
 * resumed sessions skip the automatic picker. Context choices are persisted as
 * native models.json overrides.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildSessionContext, getAgentDir, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Input, SelectList, truncateToWidth } from "@earendil-works/pi-tui";
import {
	installModelCommandHandler,
	ModelCommandRoutingEditor,
} from "../_shared/model-command-routing.ts";
import {
	filterModels,
	findExactModel,
	formatTokenCount,
	getContextWindowChoices,
	mergeContextWindowOverride,
	shouldOpenStartupModelSelector,
	supportsContextProfiles,
} from "./model-config.ts";

const MODELS_PATH = join(getAgentDir(), "models.json");
const COMPACTION_RESERVE = 16_384;

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
	for (const model of models) unique.set(modelKey(model), model);
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

async function selectContextWindow(
	ctx: ExtensionContext,
	model: Model<Api>,
): Promise<number | undefined> {
	const options = getContextWindowChoices(model);
	if (options.length === 1) return options[0]?.value;

	const ordered = [
		...options.filter((option) => option.value === model.contextWindow),
		...options.filter((option) => option.value !== model.contextWindow),
	];
	const choices = ordered.map((option) =>
		`${option.value === model.contextWindow ? "●" : "○"} ${option.label} — ${option.description}${option.value === model.contextWindow ? " (current)" : ""}`,
	);
	const selected = await ctx.ui.select(`Context Window · ${modelKey(model)}`, choices);
	if (!selected) return undefined;
	return ordered[choices.indexOf(selected)]?.value;
}

function readModelsConfig(): Record<string, unknown> {
	if (!existsSync(MODELS_PATH)) return {};
	try {
		return JSON.parse(readFileSync(MODELS_PATH, "utf-8")) as Record<string, unknown>;
	} catch (error) {
		throw new Error(`Cannot update ${MODELS_PATH}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

async function saveContextOverride(model: Model<Api>, contextWindow: number): Promise<void> {
	await withFileMutationQueue(MODELS_PATH, async () => {
		const config = mergeContextWindowOverride(
			readModelsConfig(),
			model.provider,
			model.id,
			contextWindow,
		);
		mkdirSync(getAgentDir(), { recursive: true });
		const temporaryPath = `${MODELS_PATH}.${process.pid}.${Date.now()}.tmp`;
		try {
			writeFileSync(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
			renameSync(temporaryPath, MODELS_PATH);
		} finally {
			if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
		}
	});
}

async function applySelection(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	selectedModel: Model<Api>,
	thinkingLevel: ModelThinkingLevel,
	contextWindow: number,
): Promise<void> {
	const usage = ctx.getContextUsage();
	const needsCompaction = usage?.tokens !== null && usage?.tokens !== undefined &&
		usage.tokens > Math.max(1, contextWindow - COMPACTION_RESERVE);

	if (needsCompaction) {
		const approved = await ctx.ui.confirm(
			"Context window reduction",
			`This session uses about ${formatTokenCount(usage.tokens!)} tokens, above the safe ${formatTokenCount(contextWindow)} window. Apply the selection and compact now?`,
		);
		if (!approved) return;
	}

	let model = selectedModel;
	if (supportsContextProfiles(selectedModel.id)) {
		await saveContextOverride(selectedModel, contextWindow);
		const refresh = await ctx.modelRegistry.refresh({
			allowNetwork: false,
			providers: [selectedModel.provider],
		});
		const refreshError = refresh.errors.get(selectedModel.provider);
		if (refreshError) throw refreshError;
		model = ctx.modelRegistry.find(selectedModel.provider, selectedModel.id) ?? selectedModel;
		if (model.contextWindow !== contextWindow) {
			throw new Error(`Pi reloaded ${modelKey(model)} with ${formatTokenCount(model.contextWindow)} instead of ${formatTokenCount(contextWindow)}.`);
		}
	}

	const changed = await pi.setModel(model);
	if (!changed) {
		ctx.ui.notify(`No configured authentication for ${modelKey(model)}`, "error");
		return;
	}

	pi.setThinkingLevel(thinkingLevel);
	const effectiveThinking = pi.getThinkingLevel() as ModelThinkingLevel;
	if (needsCompaction) ctx.compact();

	const thinkingNote = effectiveThinking === thinkingLevel
		? effectiveThinking
		: `${effectiveThinking} (requested ${thinkingLevel})`;
	ctx.ui.notify(
		`${modelKey(model)} · thinking ${thinkingNote} · context ${formatTokenCount(model.contextWindow)}`,
		effectiveThinking === thinkingLevel ? "info" : "warning",
	);
}

async function runModelControl(pi: ExtensionAPI, args: string, ctx: ExtensionContext): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("The custom /model selector requires TUI mode.", "error");
		return;
	}

	try {
		await ctx.modelRegistry.refresh({ allowNetwork: false });
	} catch (error) {
		ctx.ui.notify(
			`Could not reload the model catalogue: ${error instanceof Error ? error.message : String(error)}`,
			"error",
		);
		return;
	}

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

	const contextWindow = await selectContextWindow(ctx, selectedModel);
	if (!contextWindow) return;

	try {
		await applySelection(pi, ctx, selectedModel, thinkingLevel, contextWindow);
	} catch (error) {
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
	}
}

export default function modelSelectorExtension(pi: ExtensionAPI) {
	let uninstallModelCommandHandler: (() => void) | undefined;

	pi.on("session_start", async (event, ctx) => {
		uninstallModelCommandHandler?.();
		uninstallModelCommandHandler = undefined;
		if (ctx.mode !== "tui") return;

		const handler = async (args: string): Promise<void> => {
			try {
				await runModelControl(pi, args, ctx);
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
		if (shouldOpenStartupModelSelector(event.reason, hasConversationHistory, process.argv.slice(2))) {
			await handler("");
		}
	});

	pi.on("session_shutdown", (_event, ctx) => {
		uninstallModelCommandHandler?.();
		uninstallModelCommandHandler = undefined;
		if (ctx.mode === "tui") ctx.ui.setEditorComponent(undefined);
	});
}
