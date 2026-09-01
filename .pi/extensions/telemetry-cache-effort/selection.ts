import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { pickSelectScreen, type SelectScreenItem } from "../_shared/select-screen.ts";
import { THINKING_DESCRIPTIONS } from "../_shared/model-thinking.ts";
import {
	plannedCallCount,
	type ExperimentConfig,
	type RunSize,
} from "./experiment.ts";

const SUPPORTED_PROVIDER_APIS = new Map<string, string>([
	["openai-codex", "openai-codex-responses"],
	["openai", "openai-responses"],
]);

export function effectiveEffort(model: Model<Api>, level: ModelThinkingLevel): string {
	return model.thinkingLevelMap?.[level] ?? level;
}

export function eligibleModels(models: readonly Model<Api>[]): Model<Api>[] {
	return models.filter((model) => {
		const api = SUPPORTED_PROVIDER_APIS.get(model.provider);
		if (!api || model.api !== api || !model.reasoning) return false;
		const effective = new Set(getSupportedThinkingLevels(model).map((level) => effectiveEffort(model, level)));
		return effective.size >= 2;
	});
}

async function chooseProvider(
	ctx: ExtensionCommandContext,
	models: readonly Model<Api>[],
): Promise<"openai" | "openai-codex" | undefined> {
	const providers = [...new Set(models.map((model) => model.provider))]
		.filter((provider): provider is "openai" | "openai-codex" => SUPPORTED_PROVIDER_APIS.has(provider))
		.sort();
	const items: SelectScreenItem<"openai" | "openai-codex">[] = providers.map((provider) => ({
		value: provider,
		label: ctx.modelRegistry.getProviderDisplayName(provider),
		description: `${provider} · ${models.filter((model) => model.provider === provider).length} eligible model(s)`,
	}));
	const currentProvider = providers.find((provider) => provider === ctx.model?.provider);
	return pickSelectScreen(ctx, {
		title: "Prompt-cache test · provider",
		items,
		currentValue: currentProvider,
		showCurrentMarker: true,
		confirmVerb: "next",
	});
}

async function chooseModel(
	ctx: ExtensionCommandContext,
	models: readonly Model<Api>[],
	provider: string,
): Promise<Model<Api> | undefined> {
	const providerModels = models.filter((model) => model.provider === provider)
		.sort((left, right) => left.id.localeCompare(right.id));
	const selected = await pickSelectScreen(ctx, {
		title: `Prompt-cache test · model · ${provider}`,
		items: providerModels.map((model) => ({
			value: `${model.provider}/${model.id}`,
			label: model.id,
			description: `${model.name} · ${getSupportedThinkingLevels(model).join(", ")}`,
			searchText: model.name,
		})),
		currentValue: ctx.model?.provider === provider ? `${provider}/${ctx.model.id}` : undefined,
		showCurrentMarker: true,
		search: {},
		confirmVerb: "next",
	});
	return providerModels.find((model) => `${model.provider}/${model.id}` === selected);
}

async function chooseEffort(
	ctx: ExtensionCommandContext,
	model: Model<Api>,
	title: string,
	levels: readonly ModelThinkingLevel[],
	current?: ModelThinkingLevel,
): Promise<ModelThinkingLevel | undefined> {
	return pickSelectScreen(ctx, {
		title,
		items: levels.map((level) => ({
			value: level,
			label: level,
			description: `${THINKING_DESCRIPTIONS[level]} · provider value: ${effectiveEffort(model, level)}`,
		})),
		currentValue: current && levels.includes(current) ? current : undefined,
		showCurrentMarker: Boolean(current && levels.includes(current)),
		confirmVerb: "next",
	});
}

async function chooseRunSize(
	ctx: ExtensionCommandContext,
	provider: "openai" | "openai-codex",
): Promise<RunSize | undefined> {
	const sizes: Array<{ value: RunSize; label: string; description: string }> = [
		{ value: "quick", label: "Quick", description: "one A→B sequence per transport; observation only" },
		{ value: "balanced", label: "Balanced", description: "A→B and B→A counterbalanced; recommended" },
		{ value: "repeated", label: "Repeated", description: "two observations in each direction" },
	];
	return pickSelectScreen(ctx, {
		title: "Prompt-cache test · run size",
		items: sizes.map((size) => ({
			value: size.value,
			label: `${size.label} · ${plannedCallCount(provider, size.value)} calls`,
			description: size.description,
		})),
		currentValue: "balanced",
		showCurrentMarker: true,
		confirmVerb: "next",
	});
}

export async function selectExperimentConfig(ctx: ExtensionCommandContext): Promise<ExperimentConfig | undefined> {
	if (ctx.mode !== "tui") return undefined;
	const refresh = await ctx.modelRegistry.refresh({ allowNetwork: false, signal: ctx.signal });
	if (refresh.aborted) return undefined;
	const available = eligibleModels(ctx.modelRegistry.getAvailable())
		.filter((model) => ctx.modelRegistry.hasConfiguredAuth(model));
	if (available.length === 0) {
		throw new Error("No authenticated reasoning model is available through openai-codex or openai Responses.");
	}
	const provider = await chooseProvider(ctx, available);
	if (!provider) return undefined;
	const model = await chooseModel(ctx, available, provider);
	if (!model) return undefined;
	const levels = getSupportedThinkingLevels(model);
	const effortA = await chooseEffort(
		ctx,
		model,
		"Prompt-cache test · effort 1",
		levels,
		ctx.model?.provider === model.provider && ctx.model.id === model.id ? ctx.thinkingLevel : undefined,
	);
	if (!effortA) return undefined;
	const effortBLevels = levels.filter((level) => effectiveEffort(model, level) !== effectiveEffort(model, effortA));
	const effortB = await chooseEffort(ctx, model, "Prompt-cache test · effort 2", effortBLevels);
	if (!effortB) return undefined;
	const runSize = await chooseRunSize(ctx, provider);
	if (!runSize) return undefined;
	return {
		provider,
		modelId: model.id,
		modelName: model.name,
		api: model.api,
		effortA,
		effortB,
		runSize,
	};
}
