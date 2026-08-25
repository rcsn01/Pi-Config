import { describe, expect, it } from "vitest";
import { analyzeExperiment } from "./analysis.ts";
import type { ExperimentResult, TrialResult } from "./experiment.ts";
import { compactReportSummary, formatExpandedReport, isExperimentResult } from "./report.ts";
import { effectiveEffort, eligibleModels } from "./selection.ts";

function model(overrides: Record<string, unknown> = {}): any {
	return {
		provider: "openai-codex",
		id: "gpt-test",
		name: "GPT Test",
		api: "openai-codex-responses",
		baseUrl: "https://example.invalid",
		reasoning: true,
		thinkingLevelMap: { max: "max" },
		input: ["text"],
		contextWindow: 100_000,
		maxTokens: 1000,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		...overrides,
	};
}

function report(): ExperimentResult {
	const config: any = {
		provider: "openai-codex",
		modelId: "gpt-test",
		modelName: "GPT Test",
		api: "openai-codex-responses",
		effortA: "medium",
		effortB: "max",
		runSize: "quick",
	};
	const trial: TrialResult = {
		spec: {
			id: "cacheeffort-test",
			transport: "sse",
			orientation: "aabb",
			efforts: ["medium", "medium", "max", "max"],
		},
		payloadValid: true,
		payloadIssues: [],
		turns: [0, 3500, 3500, 3500].map((cacheRead, index) => ({
			index,
			effort: (["medium", "medium", "max", "max"] as const)[index]!,
			usage: {
				input: 4000 - cacheRead,
				cacheRead,
				cacheWrite: 0,
				output: 1,
				totalTokens: 4001,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			latencyMs: 20,
		})),
	};
	const base = {
		schemaVersion: 1 as const,
		experimentId: "experiment",
		config,
		startedAt: 1,
		finishedAt: 2,
		cancelled: false,
		plannedCalls: 4,
		trials: [trial],
	};
	return { ...base, analysis: analyzeExperiment(base) };
}

describe("eligible cache-test models", () => {
	it("accepts only reasoning-capable OpenAI Responses paths with distinct effective levels", () => {
		const accepted = model();
		expect(eligibleModels([
			accepted,
			model({ provider: "anthropic", api: "anthropic-messages" }),
			model({ reasoning: false }),
			model({ provider: "openai", api: "openai-completions" }),
		])).toEqual([accepted]);
		expect(effectiveEffort(model({ thinkingLevelMap: { max: "xhigh" } }), "max")).toBe("xhigh");
	});
});

describe("session report formatting", () => {
	it("stores a concise conclusion and expandable evidence without prompt contents", () => {
		const result = report();
		expect(isExperimentResult(result)).toBe(true);
		expect(compactReportSummary(result)).toContain("supports no effort-induced miss");
		const expanded = formatExpandedReport(result);
		expect(expanded).toContain("OpenAI server prompt cache");
		expect(expanded).toContain("cacheeffort-test");
		expect(expanded).not.toContain("Synthetic cache probe material");
	});
});
