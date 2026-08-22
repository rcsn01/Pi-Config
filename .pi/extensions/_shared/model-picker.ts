import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { pickSelectScreen, type SelectScreenItem } from "./select-screen.ts";
import { resolveModelContext, type ModelChoiceLike } from "./model-selection.ts";

const MIN_CONTEXT_WINDOW = 128_000;

export const THINKING_DESCRIPTIONS: Record<ModelThinkingLevel, string> = {
	off: "No extended thinking",
	minimal: "Fastest reasoning",
	low: "Light reasoning",
	medium: "Balanced reasoning",
	high: "Deep reasoning",
	xhigh: "Extra-high reasoning",
	max: "Maximum reasoning",
};

export interface ModelPickerPreviousSelection {
	provider?: string;
	modelId?: string;
	thinkingLevel?: ModelThinkingLevel;
	contextWindow?: number;
}

export interface ModelPickerSelection {
	model: Model<Api>;
	thinkingLevel: ModelThinkingLevel;
	contextWindow: number;
}

export interface ModelPickerOptions {
	/** An exact model reference skips the model screen; other text seeds its search. */
	initialQuery?: string;
	/** The selection used to mark the current model and seed later steps. */
	previous?: ModelPickerPreviousSelection;
	/** The live model is used only for the current marker when no previous model exists. */
	currentModel?: Model<Api>;
	modelTitle?: string;
	thinkingTitle?: (model: Model<Api>) => string;
	contextTitle?: (model: Model<Api>) => string;
}

function modelKey(model: Pick<Model<Api>, "provider" | "id">): string {
	return `${model.provider}/${model.id}`;
}

export function formatTokenCount(tokens: number): string {
	if (tokens >= 1_000_000) {
		const millions = tokens / 1_000_000;
		return `${Number.isInteger(millions) ? millions.toFixed(0) : millions.toFixed(2)}M`;
	}
	if (tokens >= 1_000) {
		const thousands = tokens / 1_000;
		return `${Number.isInteger(thousands) ? thousands.toFixed(0) : thousands.toFixed(1)}K`;
	}
	return String(tokens);
}

/** Context presets below 128K are not offered by the picker. */
export function contextWindowChoices(catalogueWindow: number): number[] {
	const fractions = [1, 1 / 2, 3 / 8, 1 / 4];
	const windows = fractions.map((fraction) => Math.round(catalogueWindow * fraction));
	return [...new Set(windows)]
		.filter((window) => window >= MIN_CONTEXT_WINDOW)
		.sort((left, right) => right - left);
}

export function findExactModel<T extends ModelChoiceLike>(models: readonly T[], reference: string): T | undefined {
	const normalized = reference.trim().toLowerCase();
	if (!normalized) return undefined;

	const canonical = models.find(
		(model) => `${model.provider}/${model.id}`.toLowerCase() === normalized,
	);
	if (canonical) return canonical;

	const idMatches = models.filter((model) => model.id.toLowerCase() === normalized);
	return idMatches.length === 1 ? idMatches[0] : undefined;
}

export function filterModels<T extends ModelChoiceLike>(models: readonly T[], query: string): T[] {
	const normalized = query.trim().toLowerCase();
	const terms = normalized.split(/\s+/).filter(Boolean);

	return models
		.map((model) => {
			const canonical = `${model.provider}/${model.id}`.toLowerCase();
			const id = model.id.toLowerCase();
			const name = model.name.toLowerCase();
			const searchText = `${canonical} ${name}`;
			if (!terms.every((term) => searchText.includes(term))) return undefined;

			let score = 100;
			if (!normalized) score = 0;
			else if (canonical === normalized) score = -100;
			else if (id === normalized) score = -90;
			else if (canonical.startsWith(normalized)) score = -70;
			else if (id.startsWith(normalized)) score = -60;
			else if (name.startsWith(normalized)) score = -50;
			else score = terms.reduce((total, term) => total + searchText.indexOf(term), 0);

			return { model, canonical, score };
		})
		.filter((entry): entry is { model: T; canonical: string; score: number } => entry !== undefined)
		.sort((left, right) => left.score - right.score || left.canonical.localeCompare(right.canonical))
		.map((entry) => entry.model);
}

function isAborted(ctx: ExtensionContext): boolean {
	return ctx.signal?.aborted === true;
}

function isAbortError(error: unknown): boolean {
	return typeof error === "object" && error !== null && "name" in error &&
		(error as { name?: unknown }).name === "AbortError";
}

function refreshErrorText(errors: ReadonlyMap<string, Error>): string {
	return [...errors.entries()]
		.map(([provider, error]) => `${provider}: ${error.message}`)
		.join("; ");
}

/** Refresh and return the authenticated, normalized model catalogue for a session. */
export async function getPickerModels(ctx: ExtensionContext): Promise<Model<Api>[]> {
	if (isAborted(ctx)) return [];
	let refresh;
	try {
		refresh = await ctx.modelRegistry.refresh({ allowNetwork: false, signal: ctx.signal });
	} catch (error) {
		if (isAborted(ctx) || isAbortError(error)) return [];
		throw error;
	}
	if (isAborted(ctx) || refresh.aborted) return [];
	if (refresh.errors.size > 0) throw new Error(refreshErrorText(refresh.errors));

	const source = ctx.scopedModels.length > 0
		? ctx.scopedModels.map((entry) =>
			ctx.modelRegistry.find(entry.model.provider, entry.model.id) ?? entry.model)
		: ctx.modelRegistry.getAvailable();
	const unique = new Map<string, Model<Api>>();
	for (const candidate of source) {
		if (typeof ctx.modelRegistry.hasConfiguredAuth === "function" &&
			!ctx.modelRegistry.hasConfiguredAuth(candidate)) continue;
		const model = resolveModelContext(candidate);
		unique.set(modelKey(model), model);
	}
	return [...unique.values()];
}

function previousModelKey(previous?: ModelPickerPreviousSelection): string | undefined {
	return previous?.provider && previous.modelId
		? `${previous.provider}/${previous.modelId}`
		: undefined;
}

function modelMarkerValue(
	previous: ModelPickerPreviousSelection | undefined,
	currentModel: Model<Api> | undefined,
): string | undefined {
	return previousModelKey(previous) ?? (currentModel ? modelKey(currentModel) : undefined);
}

async function selectModel(
	ctx: ExtensionContext,
	models: readonly Model<Api>[],
	query: string,
	options: ModelPickerOptions,
): Promise<Model<Api> | undefined> {
	const exact = findExactModel(models, query);
	if (exact) return exact;

	const items: SelectScreenItem[] = models.map((model) => ({
		value: modelKey(model),
		label: modelKey(model),
		description: `${model.name} · ${formatTokenCount(model.contextWindow)} · ${model.reasoning ? "thinking" : "no thinking"}`,
		searchText: model.name,
	}));
	const itemsByValue = new Map(items.map((item) => [item.value, item]));
	const selected = await pickSelectScreen(ctx, {
		title: options.modelTitle ?? "Select model",
		items,
		currentValue: modelMarkerValue(options.previous, options.currentModel),
		showCurrentMarker: Boolean(modelMarkerValue(options.previous, options.currentModel)),
		search: {
			initialQuery: query,
			filter: (_choices, nextQuery) => filterModels(models, nextQuery)
				.map((model) => itemsByValue.get(modelKey(model)))
				.filter((item): item is SelectScreenItem => Boolean(item)),
		},
		columns: { minPrimaryColumnWidth: 28, maxPrimaryColumnWidth: 44 },
	});
	return models.find((model) => modelKey(model) === selected);
}

function sameModel(model: Model<Api>, selection?: ModelPickerPreviousSelection): boolean {
	return Boolean(selection?.provider && selection.modelId &&
		model.provider === selection.provider && model.id === selection.modelId);
}

async function selectThinkingLevel(
	ctx: ExtensionContext,
	model: Model<Api>,
	previous?: ModelPickerPreviousSelection,
	options?: ModelPickerOptions,
): Promise<ModelThinkingLevel | undefined> {
	const supported = getSupportedThinkingLevels(model);
	if (supported.length === 0) return "off";
	const requested = previous?.thinkingLevel ?? "medium";
	const initial = clampThinkingLevel(model, requested);
	const ordered = [initial, ...supported.filter((level) => level !== initial)];
	const choices = ordered.map((level) =>
		`${level === initial ? "●" : "○"} ${level} — ${THINKING_DESCRIPTIONS[level]}${level === initial ? " (current)" : ""}`,
	);
	const selected = await ctx.ui.select(
		options?.thinkingTitle?.(model) ?? `Thinking · ${modelKey(model)}`,
		choices,
	);
	if (isAborted(ctx) || !selected) return undefined;
	return ordered[choices.indexOf(selected)];
}

async function selectContextWindow(
	ctx: ExtensionContext,
	model: Model<Api>,
	previous?: ModelPickerPreviousSelection,
	options?: ModelPickerOptions,
): Promise<number | undefined> {
	const catalogue = model.contextWindow;
	const choices = contextWindowChoices(catalogue);
	const saved = sameModel(model, previous) &&
		Number.isInteger(previous?.contextWindow) &&
		(previous?.contextWindow as number) > 0 &&
		(previous?.contextWindow as number) <= catalogue
		? previous?.contextWindow as number
		: undefined;
	const baseWindows = choices.length > 0 ? choices : [catalogue];
	const windows = saved !== undefined && !baseWindows.includes(saved)
		? [saved, ...baseWindows]
		: baseWindows;
	const ordered = saved !== undefined
		? [saved, ...windows.filter((window) => window !== saved)]
		: windows;
	const choicesWithLabels = ordered.map((window) => {
		const marker = window === (saved ?? catalogue) ? "●" : "○";
		const description = window === catalogue ? " — catalogue default" : "";
		const currentNote = window === (saved ?? catalogue) ? " (current)" : "";
		return `${marker} ${formatTokenCount(window)}${description}${currentNote}`;
	});
	const selected = await ctx.ui.select(
		options?.contextTitle?.(model) ?? `Context · ${modelKey(model)}`,
		choicesWithLabels,
	);
	if (isAborted(ctx) || !selected) return undefined;
	return ordered[choicesWithLabels.indexOf(selected)];
}

/**
 * Run the shared model, thinking, and context picker. It owns catalogue
 * refresh, model normalization, search, defaults, and cancellation. Callers
 * decide how to apply and persist the returned selection.
 */
export async function pickModelConfiguration(
	ctx: ExtensionContext,
	options: ModelPickerOptions = {},
): Promise<ModelPickerSelection | undefined> {
	if (ctx.mode !== "tui" || isAborted(ctx)) return undefined;
	const models = await getPickerModels(ctx);
	if (isAborted(ctx)) return undefined;
	if (models.length === 0) throw new Error("No authenticated models are available.");

	const selectedModel = await selectModel(ctx, models, options.initialQuery?.trim() ?? "", options);
	if (isAborted(ctx) || !selectedModel) return undefined;
	const thinkingLevel = await selectThinkingLevel(ctx, selectedModel, options.previous, options);
	if (isAborted(ctx) || thinkingLevel === undefined) return undefined;
	const contextWindow = await selectContextWindow(ctx, selectedModel, options.previous, options);
	if (isAborted(ctx) || contextWindow === undefined) return undefined;

	return {
		model: contextWindow === selectedModel.contextWindow
			? selectedModel
			: { ...selectedModel, contextWindow },
		thinkingLevel,
		contextWindow,
	};
}

export { modelKey };
