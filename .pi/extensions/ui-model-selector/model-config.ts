export interface ModelChoiceLike {
	provider: string;
	id: string;
	name: string;
	contextWindow: number;
	reasoning: boolean;
}

export interface ContextWindowChoice {
	label: string;
	value: number;
	description: string;
}

export const GPT_56_SHORT_CONTEXT = 272_000;
export const GPT_56_LONG_CONTEXT = 1_050_000;

const GPT_56_DUAL_CONTEXT_IDS = new Set([
	"gpt-5.6-sol",
	"gpt-5.6-terra",
	"gpt-5.6-luna",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nestedRecord(
	parent: Record<string, unknown>,
	key: string,
	label: string,
): Record<string, unknown> {
	const value = parent[key];
	if (value === undefined) return {};
	if (!isRecord(value)) throw new Error(`${label} must be a JSON object.`);
	return value;
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

export function supportsContextProfiles(modelId: string): boolean {
	return GPT_56_DUAL_CONTEXT_IDS.has(modelId.toLowerCase());
}

export function getContextWindowChoices(model: Pick<ModelChoiceLike, "id" | "contextWindow">): ContextWindowChoice[] {
	if (!supportsContextProfiles(model.id)) {
		return [{
			label: formatTokenCount(model.contextWindow),
			value: model.contextWindow,
			description: "Context window supplied by the model catalogue",
		}];
	}

	return [
		{
			label: "272K",
			value: GPT_56_SHORT_CONTEXT,
			description: "Short-context profile; compacts before the long-context range",
		},
		{
			label: "1.05M",
			value: GPT_56_LONG_CONTEXT,
			description: "Long-context profile; allows up to 1.05M tokens",
		},
	];
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

/** Return a cloned models.json document with one contextWindow override changed. */
export function mergeContextWindowOverride(
	config: unknown,
	providerId: string,
	modelId: string,
	contextWindow: number,
): Record<string, unknown> {
	if (!Number.isInteger(contextWindow) || contextWindow <= 0) {
		throw new Error("contextWindow must be a positive integer.");
	}
	if (!isRecord(config)) throw new Error("models.json must contain a JSON object.");

	const providers = nestedRecord(config, "providers", "models.json providers");
	const provider = nestedRecord(providers, providerId, `Provider ${providerId}`);
	const overrides = nestedRecord(provider, "modelOverrides", `Provider ${providerId} modelOverrides`);
	const existingOverride = nestedRecord(overrides, modelId, `Override for ${providerId}/${modelId}`);

	return {
		...config,
		providers: {
			...providers,
			[providerId]: {
				...provider,
				modelOverrides: {
					...overrides,
					[modelId]: {
						...existingOverride,
						contextWindow,
					},
				},
			},
		},
	};
}
