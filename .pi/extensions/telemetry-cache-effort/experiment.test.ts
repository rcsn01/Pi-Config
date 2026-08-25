import { describe, expect, it, vi } from "vitest";
import { analyzeExperiment, analyzeServerTrial } from "./analysis.ts";
import {
	buildTrialPlans,
	plannedCallCount,
	runExperiment,
	type ExperimentConfig,
	type TokenUsage,
	type TrialResult,
	type TrialSpec,
} from "./experiment.ts";

const config: ExperimentConfig = {
	provider: "openai-codex",
	modelId: "gpt-test",
	modelName: "GPT Test",
	api: "openai-codex-responses",
	effortA: "medium",
	effortB: "max",
	runSize: "balanced",
	prefixCharacters: 3000,
};

function usage(prompt: number, cacheRead = 0): TokenUsage {
	return {
		input: prompt - cacheRead,
		output: 1,
		cacheRead,
		cacheWrite: 0,
		totalTokens: prompt + 1,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function trial(options: {
	transport?: "sse" | "auto";
	orientation?: "aabb" | "bbaa";
	reads?: [number, number, number, number];
	wire?: Array<"full" | "delta" | "sse-fallback" | "unknown">;
	payloadValid?: boolean;
} = {}): TrialResult {
	const orientation = options.orientation ?? "aabb";
	const efforts = orientation === "aabb" ? ["medium", "medium", "max", "max"] : ["max", "max", "medium", "medium"];
	const spec = {
		id: `trial-${orientation}-${options.transport ?? "sse"}`,
		transport: options.transport ?? "sse",
		orientation,
		efforts: efforts as TrialSpec["efforts"],
	};
	const reads = options.reads ?? [0, 3500, 3500, 3500];
	return {
		spec,
		payloadValid: options.payloadValid ?? true,
		payloadIssues: [],
		turns: reads.map((read, index) => ({
			index,
			effort: efforts[index] as any,
			usage: usage(4000, read),
			stopReason: "stop",
			latencyMs: 10,
			wireMode: options.wire?.[index],
		})),
	};
}

describe("cache effort experiment planning", () => {
	it("builds balanced, counterbalanced plans for SSE and auto", () => {
		const plans = buildTrialPlans(config, "fixed-id");
		expect(plans).toHaveLength(4);
		expect(new Set(plans.map((plan) => plan.transport))).toEqual(new Set(["sse", "auto"]));
		expect(plans.filter((plan) => plan.orientation === "aabb")).toHaveLength(2);
		expect(plans.filter((plan) => plan.orientation === "bbaa")).toHaveLength(2);
		expect(plans.every((plan) => plan.prompts[0].length >= 3000)).toBe(true);
		expect(new Set(plans.map((plan) => plan.id)).size).toBe(plans.length);
		expect(plannedCallCount("openai-codex", "balanced")).toBe(16);
		expect(plannedCallCount("openai", "balanced")).toBe(8);
	});

	it("runs trials sequentially and reports progress without provider code", async () => {
		let active = 0;
		let maximumActive = 0;
		const progress = vi.fn();
		const result = await runExperiment(
			{ ...config, provider: "openai", runSize: "quick" },
			{
				createId: () => "experiment",
				now: () => 123,
				onProgress: progress,
				runTrial: async (spec) => {
					active++;
					maximumActive = Math.max(maximumActive, active);
					await Promise.resolve();
					active--;
					return { ...trial(), spec: { id: spec.id, transport: spec.transport, orientation: spec.orientation, efforts: spec.efforts } };
				},
			},
		);
		expect(maximumActive).toBe(1);
		expect(result.plannedCalls).toBe(4);
		expect(result.analysis.completedCalls).toBe(4);
		expect(progress).toHaveBeenCalledWith(4, 4, expect.any(Object));
	});

	it("stops the experiment after the first failed child trial", async () => {
		const runTrial = vi.fn(async (spec: TrialSpec) => ({
			spec: { id: spec.id, transport: spec.transport, orientation: spec.orientation, efforts: spec.efforts },
			turns: [],
			payloadValid: false,
			payloadIssues: [],
			error: "provider failed",
		}));
		const result = await runExperiment(config, { runTrial, createId: () => "failed" });
		expect(runTrial).toHaveBeenCalledOnce();
		expect(result.trials).toHaveLength(1);
		expect(result.analysis.serverCache.conclusion).toBe("inconclusive");
		expect(result.analysis.complete).toBe(false);
	});
});

describe("cache effort conclusions", () => {
	it("supports the theory only when both controls and the changed turn cover the anchor", () => {
		const result = analyzeServerTrial(trial());
		expect(result).toMatchObject({ outcome: "hit", anchorTokens: 4000, changeCacheRead: 3500 });
	});

	it("contradicts the theory when controls hit but the changed turn misses", () => {
		const result = analyzeServerTrial(trial({ reads: [0, 3500, 0, 3500] }));
		expect(result.outcome).toBe("miss");
		const aggregate = analyzeExperiment({ config, trials: [trial({ reads: [0, 3500, 0, 3500] })] });
		expect(aggregate.serverCache.conclusion).toBe("contradicts");
	});

	it("is inconclusive when a same-effort control fails", () => {
		expect(analyzeServerTrial(trial({ reads: [0, 0, 3500, 3500] })).outcome).toBe("inconclusive");
	});

	it("separates WebSocket continuation invalidation from server-cache evidence", () => {
		const auto = trial({ transport: "auto", wire: ["full", "delta", "full", "delta"] });
		const aggregate = analyzeExperiment({ config, trials: [trial(), auto] });
		expect(aggregate.serverCache.conclusion).toBe("supports");
		expect(aggregate.continuation?.conclusion).toBe("invalidated-on-change");
	});
});
