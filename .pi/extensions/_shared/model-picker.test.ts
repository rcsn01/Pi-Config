import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	contextWindowChoices,
	findExactModel,
	filterModels,
	formatTokenCount,
	listSelectableModels,
	pickModelConfiguration,
} from "./model-picker.ts";

const qwen = {
	provider: "ollama",
	id: "qwen3.8:27b",
	name: "Qwen 3.8",
	api: "openai-completions",
	baseUrl: "https://example.invalid",
	reasoning: true,
	input: ["text"],
	contextWindow: 512_000,
	maxTokens: 4096,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

const sonnet = {
	provider: "anthropic",
	id: "claude-sonnet",
	name: "Claude Sonnet",
	api: "anthropic-messages",
	baseUrl: "https://example.invalid",
	reasoning: true,
	input: ["text"],
	contextWindow: 1_000_000,
	maxTokens: 4096,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

const choiceModels = [
	{
		provider: "github-copilot",
		id: "gpt-5.6-sol",
		name: "GPT 5.6 Sol",
		contextWindow: 1_050_000,
		reasoning: true,
	},
	{
		provider: "anthropic",
		id: "claude-sonnet-4.6",
		name: "Claude Sonnet 4.6",
		contextWindow: 1_000_000,
		reasoning: true,
	},
];

function makeContext(options: {
	models?: any[];
	scopedModels?: any[];
	authenticated?: Set<string>;
	customResults?: Array<string | undefined>;
	thinking?: ModelThinkingLevel;
	context?: number;
	aborted?: boolean;
} = {}): any {
	const models = options.models ?? [qwen, sonnet];
	const customResults = [...(options.customResults ?? ["anthropic/claude-sonnet"])] as Array<string | undefined>;
	const authenticated = options.authenticated ?? new Set(models.map((model) => `${model.provider}/${model.id}`));
	let signal: AbortSignal | undefined;
	if (options.aborted) {
		const controller = new AbortController();
		controller.abort();
		signal = controller.signal;
	}
	const thinking = options.thinking ?? "medium";
	const select = vi.fn(async (title: string, choices: string[]) => {
		if (title.startsWith("Thinking")) {
			return choices.find((choice) => choice.includes(" high —")) ?? choices[0];
		}
		if (options.context !== undefined) {
			return choices.find((choice) => choice.includes(String(options.context! / 1000))) ?? choices[0];
		}
		return choices[0];
	});
	const ctx = {
		mode: "tui",
		signal,
		model: undefined,
		scopedModels: options.scopedModels ?? [],
		modelRegistry: {
			refresh: vi.fn(async () => ({ aborted: false, errors: new Map() })),
			getAvailable: vi.fn(() => models),
			find: vi.fn((provider: string, id: string) => models.find((model) => model.provider === provider && model.id === id)),
			hasConfiguredAuth: vi.fn((model: any) => authenticated.has(`${model.provider}/${model.id}`)),
		},
		ui: {
			custom: vi.fn(async () => customResults.shift()),
			select,
		},
	};
	return { ctx, select, thinking };
}

afterEach(() => vi.restoreAllMocks());

describe("shared model picker", () => {
	it("refreshes, scopes, authenticates, deduplicates, and normalizes catalogue models", async () => {
		const duplicate = { ...qwen, name: "Duplicate" };
		const context = makeContext({
			models: [qwen, duplicate, sonnet],
			scopedModels: [{ model: qwen }, { model: sonnet }],
			authenticated: new Set(["ollama/qwen3.8:27b", "anthropic/claude-sonnet"]),
		});
		const models = await listSelectableModels(context.ctx);

		expect(context.ctx.modelRegistry.refresh).toHaveBeenCalledWith(expect.objectContaining({ allowNetwork: false }));
		expect(models.map((model: any) => `${model.provider}/${model.id}`)).toEqual([
			"ollama/qwen3.8:27b",
			"anthropic/claude-sonnet",
		]);
		expect(models[0].thinkingLevelMap).toBeDefined();
	});

	it("skips the model screen for an exact query and uses the selected thinking and context", async () => {
		const context = makeContext();
		const selection = await pickModelConfiguration(context.ctx, {
			initialQuery: "anthropic/claude-sonnet",
		});

		expect(context.ctx.ui.custom).not.toHaveBeenCalled();
		expect(context.select).toHaveBeenCalledTimes(2);
		expect(selection).toMatchObject({
			model: expect.objectContaining({ provider: "anthropic", id: "claude-sonnet", contextWindow: 1_000_000 }),
			thinkingLevel: "high",
			contextWindow: 1_000_000,
		});
	});

	it("seeds the saved thinking and context only when the same model is selected", async () => {
		const context = makeContext({ customResults: ["anthropic/claude-sonnet"] });
		const selection = await pickModelConfiguration(context.ctx, {
			previous: {
				provider: "anthropic",
				modelId: "claude-sonnet",
				thinkingLevel: "low",
				contextWindow: 500_000,
			},
		});
		expect(selection?.contextWindow).toBe(500_000);
	});

	it("does not seed a saved context window for a different model", async () => {
		const context = makeContext({ customResults: ["anthropic/claude-sonnet"] });
		const selection = await pickModelConfiguration(context.ctx, {
			previous: {
				provider: "ollama",
				modelId: "qwen3.8:27b",
				thinkingLevel: "low",
				contextWindow: 400_000,
			},
		});
		const contextChoices = context.select.mock.calls.find((call: [string, string[]]) => call[0].startsWith("Context"))?.[1] as string[];

		expect(contextChoices.some((choice) => choice.includes("400K"))).toBe(false);
		expect(contextChoices[0]).toContain("1M");
		expect(selection?.contextWindow).toBe(1_000_000);
	});

	it("falls back to off without opening an empty thinking selector", async () => {
		const noSupportedLevels = {
			...qwen,
			thinkingLevelMap: {
				off: null,
				minimal: null,
				low: null,
				medium: null,
				high: null,
				xhigh: null,
				max: null,
			},
		};
		const context = makeContext({ models: [noSupportedLevels] });
		const selection = await pickModelConfiguration(context.ctx, {
			initialQuery: "ollama/qwen3.8:27b",
		});

		expect(context.select).toHaveBeenCalledOnce();
		expect(context.select.mock.calls[0][0]).toBe("Context · ollama/qwen3.8:27b");
		expect(selection).toMatchObject({ thinkingLevel: "off", contextWindow: 512_000 });
	});

	it("uses medium as the initial thinking level without a prior selection", async () => {
		const context = makeContext({ customResults: ["anthropic/claude-sonnet"] });
		await pickModelConfiguration(context.ctx);
		const thinkingChoices = context.select.mock.calls[0][1] as string[];
		expect(thinkingChoices[0]).toContain(" medium —");
	});

	it("returns no selection when the model, thinking, or context step is cancelled", async () => {
		for (const customResults of [[undefined], ["anthropic/claude-sonnet"]]) {
			const context = makeContext({ customResults });
			if (customResults[0] !== undefined) context.select.mockResolvedValueOnce(undefined);
			const selection = await pickModelConfiguration(context.ctx);
			expect(selection).toBeUndefined();
		}

		const aborted = makeContext({ aborted: true });
		expect(await pickModelConfiguration(aborted.ctx)).toBeUndefined();
	});
});

describe("shared context presets", () => {
	it("keeps catalogue-first descending presets and the 128K floor", () => {
		expect(contextWindowChoices(1_048_576)).toEqual([1_048_576, 524_288, 393_216, 262_144]);
		expect(contextWindowChoices(1_000_000)).toEqual([1_000_000, 500_000, 375_000, 250_000]);
		expect(contextWindowChoices(512_000)).toEqual([512_000, 256_000, 192_000, 128_000]);
		expect(contextWindowChoices(500_000)).toEqual([500_000, 250_000, 187_500]);
		expect(contextWindowChoices(128_000)).toEqual([128_000]);
		expect(contextWindowChoices(2)).toEqual([]);
	});

	it("formats token counts", () => {
		expect(formatTokenCount(999)).toBe("999");
		expect(formatTokenCount(128_000)).toBe("128K");
		expect(formatTokenCount(1_050_000)).toBe("1.05M");
	});
});

describe("model selection helpers", () => {
	it("finds canonical references and filters by model name", () => {
		expect(findExactModel(choiceModels, "github-copilot/gpt-5.6-sol")).toBe(choiceModels[0]);
		expect(filterModels(choiceModels, "sonnet")).toEqual([choiceModels[1]]);
	});
});
