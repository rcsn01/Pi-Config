import { defineWorkflow } from "../lib/definition.ts";

function stableId(input: string, fallback: string): string {
	return String(input || fallback).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || fallback;
}

function pairs<T>(items: T[]): Array<[T, T]> {
	const out: Array<[T, T]> = [];
	for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) out.push([items[i], items[j]]);
	return out;
}

export default defineWorkflow({
	name: "generate-filter-tournament",
	description: "Generate candidates, filter/dedupe them, run pairwise judge comparisons, and present a ranked winner/bracket.",
	version: "0.1.0",
	inputs: { task: "string" },
	phases: [
		{ name: "rubric", description: "Derive an explicit judging rubric" },
		{ name: "generate", description: "Generate structured candidates" },
		{ name: "filter", description: "Filter invalid and duplicate candidates" },
		{ name: "tournament", description: "Run pairwise judge comparisons" },
		{ name: "rank", description: "Present winner, ranking, bracket, and uncertainty" },
	],
	budget: { maxAgents: 40, maxConcurrent: 6, maxTokens: 260000, estimatedCost: "heavy" },
	capabilities: { canEditFiles: false, usesWeb: false },
	async run(ctx) {
		const task = String(ctx.args || "").trim();
		if (!task) ctx.fail("Provide a candidate-generation task, for example: /workflow generate-filter-tournament propose API names with rubric...");

		const rubric = await ctx.phase("rubric", async () => ctx.agent({
			key: "derive-rubric",
			agent: "judge",
			output: "json",
			prompt: `Derive or confirm a judging rubric for this tournament. Return strict JSON only.\n\nTask:\n${task}\n\nSchema:\n{\n  "objective": "what candidates should optimize",\n  "criteria": [ { "name": "criterion", "weight": 1, "description": "how to judge" } ],\n  "hardConstraints": ["constraint"],\n  "scoringScale": "0-10"\n}`,
		}));

		const generatorPrompts = await ctx.step("prepare-generators", () => [
			{ id: "conservative", style: "safe, practical, low-risk candidates" },
			{ id: "creative", style: "diverse, creative candidates that still satisfy constraints" },
			{ id: "adversarial", style: "edge-case-aware candidates that avoid common failure modes" },
		]);

		const generated = await ctx.phase("generate", async () => ctx.parallel(generatorPrompts, async (gen) => ctx.agent({
			key: `generate-${gen.id}`,
			agent: "default",
			output: "json",
			prompt: `Generate 3-5 candidates. Return strict JSON only.\n\nTask:\n${task}\n\nRubric:\n${JSON.stringify(rubric, null, 2)}\n\nGenerator style: ${gen.style}\n\nSchema:\n{\n  "generator": "${gen.id}",\n  "candidates": [ { "id": "stable-short-id", "title": "candidate title", "content": "candidate", "rationale": "why it should score well", "risks": ["risk"] } ]\n}`,
		}), { key: "generate-candidates", concurrency: 3, stopOnError: false }));

		const filtered = await ctx.phase("filter", async () => ctx.agent<{ candidates: Array<{ id: string; title: string; content: string; rationale?: string; risks?: string[] }> }>({
			key: "filter-dedupe-candidates",
			agent: "judge",
			output: "json",
			prompt: `Filter invalid candidates, dedupe near-duplicates, and keep at most 8 finalists. Return strict JSON only.\n\nTask:\n${task}\n\nRubric:\n${JSON.stringify(rubric, null, 2)}\n\nGenerated candidates:\n${JSON.stringify(generated, null, 2)}\n\nSchema:\n{\n  "candidates": [ { "id": "stable-short-id", "title": "title", "content": "candidate", "rationale": "rationale", "risks": ["risk"] } ],\n  "removed": [ { "id": "id", "reason": "why removed" } ]\n}`,
		}));

		const candidates = await ctx.step("normalize-finalists", () => {
			const raw = Array.isArray(filtered?.candidates) ? filtered.candidates.slice(0, 8) : [];
			return raw.map((c, i) => ({ ...c, id: stableId(c.id || c.title || c.content, `candidate-${i + 1}`) })).filter((c) => c.content || c.title);
		});
		if (candidates.length < 2) ctx.fail("Tournament needs at least two valid finalists.");

		const pairings = pairs(candidates).slice(0, 28);
		const judgments = await ctx.phase("tournament", async () => ctx.parallel(pairings, async ([a, b], index) => ctx.agent({
			key: `judge-${a.id}-vs-${b.id}`,
			agent: "judge",
			output: "json",
			prompt: `Judge this pairwise matchup. Return strict JSON only.\n\nTask:\n${task}\n\nRubric:\n${JSON.stringify(rubric, null, 2)}\n\nCandidate A:\n${JSON.stringify(a, null, 2)}\n\nCandidate B:\n${JSON.stringify(b, null, 2)}\n\nSchema:\n{\n  "match": ${JSON.stringify(index)},\n  "aId": ${JSON.stringify(a.id)},\n  "bId": ${JSON.stringify(b.id)},\n  "winner": "A|B|tie",\n  "scores": { "A": 0, "B": 0 },\n  "rationale": "rubric-based rationale",\n  "uncertainty": "low|medium|high"\n}`,
		}), { key: "pairwise-tournament", concurrency: 6, stopOnError: false }));

		await ctx.artifact("tournament/bracket.json", { task, rubric, candidates, judgments });

		const ranking = await ctx.phase("rank", async () => ctx.agent({
			key: "rank-tournament-results",
			agent: "judge",
			output: "json",
			prompt: `Produce the final ranking from pairwise judgments. Return strict JSON only.\n\nTask:\n${task}\n\nRubric:\n${JSON.stringify(rubric, null, 2)}\n\nCandidates:\n${JSON.stringify(candidates, null, 2)}\n\nJudgments:\n${JSON.stringify(judgments, null, 2)}\n\nSchema:\n{\n  "winnerId": "candidate id",\n  "ranking": [ { "id": "candidate id", "rank": 1, "score": 0, "rationale": "why ranked here" } ],\n  "bracketSummary": "summary",\n  "dissentOrUncertainty": ["note"]\n}`,
		}));

		return ctx.agent({
			key: "present-tournament-final",
			agent: "default",
			dependsOn: ["rank-tournament-results"],
			prompt: `Write the final tournament result for the user.\n\nTask:\n${task}\n\nRubric:\n${JSON.stringify(rubric, null, 2)}\n\nCandidates:\n${JSON.stringify(candidates, null, 2)}\n\nRanking JSON:\n${JSON.stringify(ranking, null, 2)}\n\nInclude winner, ranked list, bracket summary, rubric, and dissent/uncertainty notes.`,
		});
	},
});
