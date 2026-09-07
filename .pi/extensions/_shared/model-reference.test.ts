import { describe, expect, it, vi } from "vitest";
import {
	ModelReferenceError,
	parseModelReference,
	resolveModelReference,
	validateContextWindow,
	type RefreshableModelLookup,
} from "./model-reference.ts";

type CatalogueModel = {
	provider: string;
	id: string;
	name: string;
	contextWindow: number;
	reasoning: boolean;
};

function catalogueModel(provider = "openai", id = "gpt-5.6"): CatalogueModel {
	return { provider, id, name: id, contextWindow: 256_000, reasoning: true };
}

function createLookup(options: {
	find?: (provider: string, modelId: string) => CatalogueModel | undefined;
	scopedModels?: readonly { model: { provider: string; id: string } }[];
	refreshResult?: { aborted?: boolean; errors?: ReadonlyMap<string, Error> };
} = {}) {
	const find = vi.fn((provider: string, modelId: string): CatalogueModel | undefined =>
		options.find ? options.find(provider, modelId) : catalogueModel(provider, modelId));
	const refresh = options.refreshResult
		? vi.fn(async () => ({
			aborted: options.refreshResult?.aborted ?? false,
			errors: options.refreshResult?.errors ?? new Map<string, Error>(),
		}))
		: undefined;
	const lookup = {
		modelRegistry: { find, ...(refresh ? { refresh } : {}) },
		...(options.scopedModels !== undefined ? { scopedModels: options.scopedModels } : {}),
	} as unknown as RefreshableModelLookup;
	return { lookup, find, refresh };
}

describe("parseModelReference", () => {
	it("parses qualified references", () => {
		expect(parseModelReference("openai/gpt-5.6")).toEqual({ kind: "qualified", provider: "openai", modelId: "gpt-5.6" });
	});

	it("keeps further slashes in the model id", () => {
		expect(parseModelReference("openai/gpt/5.6")).toEqual({ kind: "qualified", provider: "openai", modelId: "gpt/5.6" });
	});

	it("parses bare ids only when allowed", () => {
		expect(parseModelReference("gpt-5.6", { allowBareId: true })).toEqual({ kind: "bare-id", modelId: "gpt-5.6" });
		expect(() => parseModelReference("gpt-5.6")).toThrow(ModelReferenceError);
	});

	it("extracts a thinking suffix only under allowThinkingSuffix", () => {
		expect(parseModelReference("openai/gpt-5.6:high", { allowThinkingSuffix: true })).toEqual({
			kind: "qualified",
			provider: "openai",
			modelId: "gpt-5.6",
			thinkingLevel: "high",
		});
		const withoutSuffix = parseModelReference("openai/gpt-5.6:high");
		expect(withoutSuffix).toEqual({ kind: "qualified", provider: "openai", modelId: "gpt-5.6:high" });
		expect("thinkingLevel" in withoutSuffix).toBe(false);
	});

	it("lowercases an extracted suffix level", () => {
		expect(parseModelReference("openai/gpt-5.6:XHIGH", { allowThinkingSuffix: true })).toMatchObject({
			modelId: "gpt-5.6",
			thinkingLevel: "xhigh",
		});
	});

	it("keeps non-level colon suffixes in the model id", () => {
		expect(parseModelReference("openrouter/deepseek-r1:free", { allowThinkingSuffix: true })).toEqual({
			kind: "qualified",
			provider: "openrouter",
			modelId: "deepseek-r1:free",
		});
		expect(parseModelReference("openai/model:turbo")).toEqual({
			kind: "qualified",
			provider: "openai",
			modelId: "model:turbo",
		});
	});

	it("extracts the rightmost thinking-level suffix", () => {
		expect(parseModelReference("openai/gpt:free:high", { allowThinkingSuffix: true })).toEqual({
			kind: "qualified",
			provider: "openai",
			modelId: "gpt:free",
			thinkingLevel: "high",
		});
	});

	it.each([
		"",
		" ",
		"openai/gpt 5",
		" openai/gpt",
		"openai/gpt ",
		"/model",
		"openai/",
		"openai//model",
	])("rejects invalid references %#", (value) => {
		expect(() => parseModelReference(value)).toThrow(ModelReferenceError);
	});

	it("rejects an empty model segment under the thinking suffix", () => {
		expect(() => parseModelReference("openai/:high", { allowThinkingSuffix: true })).toThrow(ModelReferenceError);
		// Without the suffix flag the colon stays part of the model id.
		expect(parseModelReference("openai/:high")).toEqual({ kind: "qualified", provider: "openai", modelId: ":high" });
	});

	it("labels parse errors", () => {
		try {
			parseModelReference("garbage", { label: "Advisor model" });
			throw new Error("expected parseModelReference to throw");
		} catch (error) {
			expect(error).toBeInstanceOf(ModelReferenceError);
			const referenceError = error as ModelReferenceError;
			expect(referenceError.reason).toBe("invalid");
			expect(referenceError.label).toBe("Advisor model");
			expect(referenceError.message).toBe('Advisor model must be "provider/model[:thinking]".');
		}
	});

	it("uses a default label when none is given", () => {
		expect(() => parseModelReference("garbage")).toThrow('Model reference must be "provider/model[:thinking]".');
	});
});

describe("resolveModelReference", () => {
	it("resolves a structured reference without parsing", async () => {
		const { lookup, find } = createLookup();
		const model = await resolveModelReference(lookup, { provider: "openai", modelId: "gpt-5.6" });
		expect(find).toHaveBeenCalledWith("openai", "gpt-5.6");
		expect(model).toEqual(catalogueModel());
	});

	it("resolves a string reference", async () => {
		const { lookup, find } = createLookup();
		await resolveModelReference(lookup, "openai/gpt-5.6");
		expect(find).toHaveBeenCalledWith("openai", "gpt-5.6");
	});

	it("passes non-level colon ids to the registry untouched", async () => {
		const { lookup, find } = createLookup();
		await resolveModelReference(lookup, "openrouter/deepseek-r1:free");
		expect(find).toHaveBeenCalledWith("openrouter", "deepseek-r1:free");
	});

	it("extracts the thinking suffix only under allowThinkingSuffix", async () => {
		const { lookup, find } = createLookup();
		await resolveModelReference(lookup, "openai/gpt-5.6:high");
		expect(find).toHaveBeenCalledWith("openai", "gpt-5.6:high");
		await resolveModelReference(lookup, "openai/gpt-5.6:high", { allowThinkingSuffix: true });
		expect(find).toHaveBeenCalledWith("openai", "gpt-5.6");
	});

	describe("scope policy", () => {
		const scoped = [{ model: { provider: "openai", id: "gpt-5.6" } }];
		const other = [{ model: { provider: "other", id: "x" } }];

		it("does not enforce when scopedModels is absent", async () => {
			const { lookup } = createLookup();
			await expect(resolveModelReference(lookup, "openai/gpt-5.6")).resolves.toBeDefined();
		});

		it("does not enforce when scopedModels is present but empty", async () => {
			const { lookup } = createLookup({ scopedModels: [] });
			await expect(resolveModelReference(lookup, "openai/gpt-5.6")).resolves.toBeDefined();
		});

		it("enforces when scopedModels is present and non-empty", async () => {
			const inside = createLookup({ scopedModels: scoped });
			await expect(resolveModelReference(inside.lookup, "openai/gpt-5.6")).resolves.toBeDefined();

			const outside = createLookup({ scopedModels: other });
			await expect(resolveModelReference(outside.lookup, "openai/gpt-5.6", { label: "Plan Mode profile" }))
				.rejects.toThrow("Plan Mode profile model openai/gpt-5.6 is outside this session's model scope.");
		});

		it("ignores scope when scope is 'ignore'", async () => {
			const { lookup } = createLookup({ scopedModels: other });
			await expect(resolveModelReference(lookup, "openai/gpt-5.6", { scope: "ignore" })).resolves.toBeDefined();
		});
	});

	describe("refresh", () => {
		it("refreshes the provider before lookup", async () => {
			const { lookup, refresh, find } = createLookup({ refreshResult: {} });
			await resolveModelReference(lookup, "openai/gpt-5.6", { refresh: true });
			expect(refresh).toHaveBeenCalledWith({ allowNetwork: false, providers: ["openai"] });
			expect(find).toHaveBeenCalledWith("openai", "gpt-5.6");
		});

		it("skips refresh when the lookup has no refresh", async () => {
			const { lookup, find } = createLookup();
			await resolveModelReference(lookup, "openai/gpt-5.6", { refresh: true });
			expect(find).toHaveBeenCalledOnce();
		});

		it("throws the abort message regardless of optional", async () => {
			const { lookup } = createLookup({ refreshResult: { aborted: true } });
			await expect(resolveModelReference(lookup, "openai/gpt-5.6", { refresh: true }))
				.rejects.toThrow("Refreshing openai was aborted.");
			await expect(resolveModelReference(lookup, "openai/gpt-5.6", { refresh: true, optional: true }))
				.rejects.toThrow("Refreshing openai was aborted.");
		});

		it("wraps provider refresh errors with the cause attached", async () => {
			const cause = new Error("catalogue offline");
			const { lookup } = createLookup({ refreshResult: { errors: new Map([["openai", cause]]) } });
			try {
				await resolveModelReference(lookup, "openai/gpt-5.6", { refresh: true, label: "Normal profile" });
				throw new Error("expected resolveModelReference to throw");
			} catch (error) {
				expect(error).toBeInstanceOf(ModelReferenceError);
				const referenceError = error as ModelReferenceError;
				expect(referenceError.reason).toBe("refresh");
				expect(referenceError.cause).toBe(cause);
				expect(referenceError.provider).toBe("openai");
				expect(referenceError.message).toContain("Refreshing openai failed: catalogue offline");
			}
		});
	});

	describe("optional", () => {
		it("resolves unavailable models to undefined", async () => {
			const { lookup } = createLookup({ find: () => undefined });
			await expect(resolveModelReference(lookup, "openai/gpt-5.6", { optional: true })).resolves.toBeUndefined();
		});

		it("resolves out-of-scope models to undefined", async () => {
			const { lookup } = createLookup({ scopedModels: [{ model: { provider: "other", id: "x" } }] });
			await expect(resolveModelReference(lookup, "openai/gpt-5.6", { optional: true })).resolves.toBeUndefined();
		});

		it("still throws for invalid references and missing providers", async () => {
			const { lookup } = createLookup();
			await expect(resolveModelReference(lookup, "garbage", { optional: true, allowBareId: true, bareIdFallback: () => undefined }))
				.rejects.toMatchObject({ reason: "no-provider" });
			await expect(resolveModelReference(lookup, "garbage", { optional: true })).rejects.toMatchObject({ reason: "invalid" });
		});
	});

	describe("bareIdFallback", () => {
		it("resolves bare ids through a sync fallback", async () => {
			const { lookup, find } = createLookup();
			const model = await resolveModelReference(lookup, "gpt-5.6", {
				allowBareId: true,
				bareIdFallback: () => "openai",
			});
			expect(find).toHaveBeenCalledWith("openai", "gpt-5.6");
			expect(model).toEqual(catalogueModel());
		});

		it("awaits an async fallback", async () => {
			const { lookup, find } = createLookup();
			await resolveModelReference(lookup, "gpt-5.6", {
				allowBareId: true,
				bareIdFallback: () => Promise.resolve("openai"),
			});
			expect(find).toHaveBeenCalledWith("openai", "gpt-5.6");
		});

		it("throws no-provider when the fallback misses", async () => {
			const { lookup, find } = createLookup();
			await expect(resolveModelReference(lookup, "gpt-5.6", {
				allowBareId: true,
				bareIdFallback: () => undefined,
			})).rejects.toMatchObject({
				reason: "no-provider",
				modelId: "gpt-5.6",
			});
			expect(find).not.toHaveBeenCalled();
		});

		it("throws no-provider without a fallback", async () => {
			const { lookup } = createLookup();
			await expect(resolveModelReference(lookup, "gpt-5.6", { allowBareId: true }))
				.rejects.toMatchObject({ reason: "no-provider" });
		});
	});

	it("labels unavailable models", async () => {
		const { lookup } = createLookup({ find: () => undefined });
		try {
			await resolveModelReference(lookup, "openai/gpt-5.6", { label: "Profile" });
			throw new Error("expected resolveModelReference to throw");
		} catch (error) {
			expect(error).toBeInstanceOf(ModelReferenceError);
			const referenceError = error as ModelReferenceError;
			expect(referenceError.reason).toBe("unavailable");
			expect(referenceError.provider).toBe("openai");
			expect(referenceError.modelId).toBe("gpt-5.6");
			expect(referenceError.message).toBe("Profile model openai/gpt-5.6 is unavailable.");
		}
	});
});

describe("validateContextWindow", () => {
	it("accepts positive integers", () => {
		expect(validateContextWindow(256_000)).toBe(256_000);
		expect(validateContextWindow(1)).toBe(1);
	});

	it.each([0, -1, 1.5, "100", undefined, null])("rejects %s", (value) => {
		expect(() => validateContextWindow(value)).toThrow("Context window must be a positive integer.");
	});

	it("prefixes errors with the label", () => {
		expect(() => validateContextWindow(0, "Subagent context window")).toThrow("Subagent context window must be a positive integer.");
	});
});