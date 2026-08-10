import { describe, expect, it } from "vitest";
import {
	getModelCommandHandler,
	installModelCommandHandler,
	parseModelCommand,
} from "../_shared/model-command-routing.ts";
import {
	filterModels,
	findExactModel,
	getContextWindowChoices,
	GPT_56_LONG_CONTEXT,
	GPT_56_SHORT_CONTEXT,
	hasExplicitModelArgument,
	mergeContextWindowOverride,
	shouldOpenStartupModelSelector,
} from "./model-config.ts";

const models = [
	{
		provider: "github-copilot",
		id: "gpt-5.6-sol",
		name: "GPT 5.6 Sol",
		contextWindow: GPT_56_LONG_CONTEXT,
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

describe("model command routing", () => {
	it("parses exact /model commands and preserves arguments", () => {
		expect(parseModelCommand("/model")).toBe("");
		expect(parseModelCommand("/model github-copilot/gpt-5.6-sol")).toBe(
			"github-copilot/gpt-5.6-sol",
		);
		expect(parseModelCommand("  /model  \n")).toBe("");
	});

	it("ignores similarly named commands, prose, and multiline prompts", () => {
		expect(parseModelCommand("/models")).toBeUndefined();
		expect(parseModelCommand("please run /model")).toBeUndefined();
		expect(parseModelCommand("/model\nthen continue")).toBeUndefined();
	});

	it("does not let stale cleanup remove a newer active handler", () => {
		const first = async () => {};
		const second = async () => {};
		const uninstallFirst = installModelCommandHandler(first);
		const uninstallSecond = installModelCommandHandler(second);
		uninstallFirst();
		expect(getModelCommandHandler()).toBe(second);
		uninstallSecond();
		expect(getModelCommandHandler()).toBeUndefined();
	});
});

describe("startup model selection", () => {
	it("opens for a fresh startup and /new", () => {
		expect(shouldOpenStartupModelSelector("startup", false, [])).toBe(true);
		expect(shouldOpenStartupModelSelector("new", false, [])).toBe(true);
	});

	it("does not open when startup restores conversation history", () => {
		expect(shouldOpenStartupModelSelector("startup", true, [])).toBe(false);
	});

	it.each(["reload", "resume", "fork"] as const)("does not open for %s", (reason) => {
		expect(shouldOpenStartupModelSelector(reason, false, [])).toBe(false);
	});

	it("recognizes explicit --model forms and bypasses automatic selection", () => {
		expect(hasExplicitModelArgument(["--model", "anthropic/claude-sonnet-4.6"])).toBe(true);
		expect(hasExplicitModelArgument(["--model=anthropic/claude-sonnet-4.6"])).toBe(true);
		expect(shouldOpenStartupModelSelector("startup", false, ["--model", "gpt-5.6-sol"])).toBe(false);
		expect(shouldOpenStartupModelSelector("new", false, ["--model=gpt-5.6-sol"])).toBe(false);
	});

	it("does not mistake model scoping or prompt text for an explicit model", () => {
		expect(hasExplicitModelArgument(["--models", "gpt-*", "explain --model selection"])).toBe(false);
	});
});

describe("model selection helpers", () => {
	it("offers short and long context profiles for GPT-5.6", () => {
		expect(getContextWindowChoices(models[0]!).map((choice) => choice.value)).toEqual([
			GPT_56_SHORT_CONTEXT,
			GPT_56_LONG_CONTEXT,
		]);
	});

	it("keeps catalogue context fixed for other models", () => {
		expect(getContextWindowChoices(models[1]!)).toEqual([
			expect.objectContaining({ value: 1_000_000 }),
		]);
	});

	it("finds canonical references and filters by model name", () => {
		expect(findExactModel(models, "github-copilot/gpt-5.6-sol")).toBe(models[0]);
		expect(filterModels(models, "sonnet")).toEqual([models[1]]);
	});
});

describe("models.json context overrides", () => {
	it("merges an override without discarding existing provider settings", () => {
		const result = mergeContextWindowOverride(
			{
				providers: {
					"github-copilot": {
						headers: { "x-test": "kept" },
						modelOverrides: {
							"gpt-5.6-sol": { name: "Sol custom" },
						},
					},
					anthropic: { baseUrl: "https://example.test" },
				},
			},
			"github-copilot",
			"gpt-5.6-sol",
			GPT_56_SHORT_CONTEXT,
		);

		expect(result).toEqual({
			providers: {
				"github-copilot": {
					headers: { "x-test": "kept" },
					modelOverrides: {
						"gpt-5.6-sol": {
							name: "Sol custom",
							contextWindow: GPT_56_SHORT_CONTEXT,
						},
					},
				},
				anthropic: { baseUrl: "https://example.test" },
			},
		});
	});

	it("rejects malformed structures instead of overwriting them", () => {
		expect(() => mergeContextWindowOverride(
			{ providers: { "github-copilot": [] } },
			"github-copilot",
			"gpt-5.6-sol",
			GPT_56_SHORT_CONTEXT,
		)).toThrow("Provider github-copilot must be a JSON object");
	});
});
