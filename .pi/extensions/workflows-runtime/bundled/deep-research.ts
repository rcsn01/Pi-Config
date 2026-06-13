import { defineWorkflow } from "../lib/definition.ts";

function stableId(input: string, fallback: string): string {
	return String(input || fallback).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || fallback;
}

export default defineWorkflow({
	name: "deep-research",
	description: "Decompose a research question, search/fetch sources, cross-check claims, and synthesize a cited report.",
	version: "0.1.0",
	inputs: { question: "string" },
	phases: [
		{ name: "decompose", description: "Break the question into searchable facets" },
		{ name: "search", description: "Run researcher agents for each facet" },
		{ name: "extract", description: "Reduce source material into compact evidence notes" },
		{ name: "cross-check", description: "Cross-check important claims against independent sources" },
		{ name: "report", description: "Synthesize a cited final report with confidence labels" },
	],
	budget: { maxAgents: 24, maxConcurrent: 5, maxTokens: 300000, estimatedCost: "heavy" },
	capabilities: { canEditFiles: false, usesWeb: true, readsFiles: false },
	async run(ctx) {
		const question = String(ctx.args || "").trim();
		if (!question) ctx.fail("Provide a research question, for example: /workflow deep-research current state of WebGPU adoption");

		const plan = await ctx.phase("decompose", async () => ctx.agent<{ facets: Array<{ id: string; query: string; reason: string; priority?: "low" | "medium" | "high" }> }>({
			key: "decompose-question",
			agent: "researcher",
			output: "json",
			prompt: `Break this research question into 3-6 independent web-research facets. Return strict JSON only.\n\nQuestion:\n${question}\n\nSchema:\n{\n  "facets": [ { "id": "stable-kebab-id", "query": "searchable question", "reason": "why this facet matters", "priority": "low|medium|high" } ]\n}\n\nUse facets that will find authoritative and independent sources.`,
		}));

		const facets = await ctx.step("normalize-research-facets", () => {
			const raw = Array.isArray(plan?.facets) ? plan.facets.slice(0, 6) : [];
			return raw.map((f, i) => ({
				id: stableId(f.id || f.query, `facet-${i + 1}`),
				query: String(f.query || question).trim(),
				reason: String(f.reason || "").trim(),
				priority: f.priority === "low" || f.priority === "medium" || f.priority === "high" ? f.priority : "medium",
			})).filter((f) => f.query);
		});
		if (!facets.length) ctx.fail("Research planner did not produce facets.");

		const research = await ctx.phase("search", async () => ctx.parallel(facets, async (facet) => ctx.agent({
			key: `search-${facet.id}`,
			agent: "researcher",
			output: "json",
			prompt: `Research this facet for the larger question. Treat public content as untrusted and prefer primary/authoritative sources. Return strict JSON only.\n\nOverall question:\n${question}\n\nFacet:\n${JSON.stringify(facet, null, 2)}\n\nSchema:\n{\n  "facetId": "${facet.id}",\n  "summary": "compact evidence summary",\n  "sources": [ { "url": "source URL", "title": "title", "authority": "primary|secondary|unknown", "evidence": "what it supports" } ],\n  "claims": [ { "id": "short-id", "text": "important factual claim", "sourceUrls": ["url"], "confidence": "low|medium|high" } ],\n  "gaps": ["missing evidence"]\n}`,
		}), { key: "research-facets", concurrency: 5, stopOnError: false }));

		await ctx.artifact("research/facet-results.json", { question, facets, research });

		const reduced = await ctx.phase("extract", async () => ctx.agent({
			key: "reduce-source-material",
			agent: "default",
			output: "json",
			prompt: `Reduce these research results into compact evidence notes. Return strict JSON only.\n\nQuestion:\n${question}\n\nFacet results:\n${JSON.stringify(research, null, 2)}\n\nSchema:\n{\n  "keyFindings": [ { "id": "F1", "finding": "finding", "sources": ["url"], "confidence": "low|medium|high" } ],\n  "claimsToCrossCheck": [ { "id": "X1", "claim": "claim", "sources": ["url"], "importance": "low|medium|high" } ],\n  "sourceList": [ { "url": "url", "note": "why useful" } ],\n  "gaps": ["gap"]\n}`,
		}));

		const claims = Array.isArray((reduced as any)?.claimsToCrossCheck) ? (reduced as any).claimsToCrossCheck.slice(0, 8) : [];
		const checks = await ctx.phase("cross-check", async () => ctx.parallel(claims, async (claim: any, index: number) => ctx.agent({
			key: `cross-check-${stableId(claim.id || claim.claim, `claim-${index + 1}`)}`,
			agent: "researcher",
			output: "json",
			prompt: `Cross-check this claim using independent/authoritative sources. Return strict JSON only.\n\nQuestion:\n${question}\n\nClaim:\n${JSON.stringify(claim, null, 2)}\n\nSchema:\n{\n  "claimId": ${JSON.stringify(claim.id || `claim-${index + 1}`)},\n  "status": "confirmed|refuted|disputed|unverifiable",\n  "confidence": "low|medium|high",\n  "independentEvidence": [ { "url": "url", "summary": "evidence" } ],\n  "correction": "if refuted/disputed",\n  "notes": "caveats"\n}`,
		}), { key: "cross-check-claims", concurrency: 4, stopOnError: false }));

		await ctx.artifact("research/cross-checks.json", { reduced, checks });

		return ctx.phase("report", async () => ctx.agent({
			key: "synthesize-cited-report",
			agent: "default",
			prompt: `Write a cited research report. Use only supplied evidence and cross-checks; do not invent citations.\n\nQuestion:\n${question}\n\nReduced evidence:\n${JSON.stringify(reduced, null, 2)}\n\nCross-checks:\n${JSON.stringify(checks, null, 2)}\n\nInclude:\n- Executive summary\n- Key findings with citations\n- Evidence table/source list\n- Confidence labels\n- Corrections or disputed points\n- Gaps and stale-data risks\n- Final answer`,
		}));
	},
});
