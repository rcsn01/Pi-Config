import type { Api, Model, ThinkingLevelMap } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { matchFamily } from "./model-families.ts";
import { applyFamilyThinkingLevel, resolveModelContext } from "./model-selection.ts";

function familyModel(
	id: string,
	options: { reasoning?: boolean; thinkingLevelMap?: ThinkingLevelMap } = {},
): Model<Api> {
	return {
		provider: "ollama",
		id,
		name: id,
		api: "openai-completions",
		baseUrl: "http://localhost:11434/v1",
		reasoning: options.reasoning ?? true,
		thinkingLevelMap: options.thinkingLevelMap,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8_192,
	} as unknown as Model<Api>;
}

describe("matchFamily", () => {
	it("matches model ids case-insensitively", () => {
		expect(matchFamily("DeepSeek-V4-Pro")).toEqual(matchFamily("deepseek-v4-pro"));
		expect(matchFamily("QWEN3.8:27b-mlx")).toEqual(matchFamily("qwen3.8:27b-mlx"));
		expect(matchFamily("GLM-5.2")).toEqual(matchFamily("glm-5.2"));
	});

	it("lets the first matching family win", () => {
		// deepseek models served through a qwen-token-plan still match deepseek.
		expect(matchFamily("deepseek-v4-flash:0731-cloud")).toEqual(matchFamily("deepseek-v4-pro"));
		expect(matchFamily("deepseek-v4-flash:0731-cloud")).not.toEqual(matchFamily("qwen3.8:27b-mlx"));
	});

	it("returns undefined for unknown families", () => {
		expect(matchFamily("kimi-k2.7-code:cloud")).toBeUndefined();
		expect(matchFamily("claude-sonnet-4.6")).toBeUndefined();
	});
});

describe("applyFamilyThinkingLevel", () => {
	it("applies the family map to a reasoning model without its own", () => {
		const model = applyFamilyThinkingLevel(familyModel("deepseek-v4-flash:0731-cloud"));
		expect(model.thinkingLevelMap).toEqual(matchFamily("deepseek-v4-flash:0731-cloud"));
	});

	it("leaves non-reasoning models untouched", () => {
		const model = familyModel("deepseek-v4-flash:0731-cloud", { reasoning: false });
		expect(applyFamilyThinkingLevel(model)).toBe(model);
	});

	it("leaves models reporting their own levels untouched, even all-null maps", () => {
		const ownMap: ThinkingLevelMap = { max: null };
		const model = familyModel("deepseek-v4-flash:0731-cloud", { thinkingLevelMap: ownMap });
		expect(applyFamilyThinkingLevel(model)).toBe(model);
	});

	it("treats an empty map as unreported and applies the family", () => {
		const model = applyFamilyThinkingLevel(familyModel("qwen3.8:27b-mlx", { thinkingLevelMap: {} }));
		expect(model.thinkingLevelMap).toEqual(matchFamily("qwen3.8:27b-mlx"));
	});

	it("leaves unknown-family models untouched", () => {
		const model = familyModel("kimi-k2.7-code:cloud");
		expect(applyFamilyThinkingLevel(model)).toBe(model);
	});
});

describe("picker-visible thinking levels", () => {
	it.each([
		["deepseek-v4-flash:0731-cloud", ["off", "low", "high", "max"]],
		["qwen3.8:27b-mlx", ["off", "low", "medium", "xhigh"]],
		["glm-5.2", ["off", "low", "medium", "high", "max"]],
	] as const)("shows the family's supported levels for %s", (id, expected) => {
		const model = applyFamilyThinkingLevel(familyModel(id));
		expect(getSupportedThinkingLevels(model)).toEqual(expected);
	});

	it("keeps the model's own levels when it reports them", () => {
		const model = familyModel("deepseek-v4-pro", {
			thinkingLevelMap: { minimal: null, low: null, medium: null, high: "high", xhigh: null, max: "max" },
		});
		expect(getSupportedThinkingLevels(applyFamilyThinkingLevel(model))).toEqual(["off", "high", "max"]);
	});
});

describe("resolveModelContext", () => {
	it("applies family thinking levels alongside the context window", () => {
		const model = resolveModelContext({ ...familyModel("glm-5.2"), contextWindow: 100_000 });
		expect(model.thinkingLevelMap).toEqual(matchFamily("glm-5.2"));
		expect(model.contextWindow).toBe(100_000);
	});
});
