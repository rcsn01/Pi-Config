import { defineWorkflow } from "../lib/definition.ts";

export default defineWorkflow({
	name: "deep-verification",
	description: "Extract factual claims from a document or prompt and verify them against authoritative web sources or the local codebase.",
	version: "0.1.0",
	inputs: { subject: "string" },
	phases: [
		{ name: "extract", description: "Extract checkable claims" },
		{ name: "verify", description: "Verify claims in parallel" },
		{ name: "report", description: "Produce verification report" },
	],
	budget: { maxAgents: 14, maxConcurrent: 4, estimatedCost: "heavy" },
	canEditFiles: false,
	async run(ctx) {
		const subject = String(ctx.args || "").trim();
		if (!subject) ctx.fail("Provide a file path, topic, or text to verify, for example: /workflow deep-verification workflows-plan.md");

		const claims = await ctx.phase("extract", async () => ctx.agent<{ claims: Array<{ id: string; text: string; sourceType?: "repo" | "web" | "mixed"; importance?: string }> }>({
			key: "extract-claims",
			agent: "explorer",
			output: "json",
			prompt: `Extract up to 8 concrete, checkable factual claims from this input. If the input names a local file, read it first.\n\nInput:\n${subject}\n\nReturn strict JSON only with this shape:\n{\n  "claims": [\n    { "id": "C1", "text": "claim text", "sourceType": "repo|web|mixed", "importance": "low|medium|high" }\n  ]\n}\n\nPrefer claims that matter for correctness. If there are no factual claims, return { "claims": [] }.`,
		}));

		const items = Array.isArray(claims?.claims) ? claims.claims.slice(0, 8) : [];
		if (items.length === 0) {
			return `No concrete factual claims were extracted from: ${subject}`;
		}

		const verifications = await ctx.phase("verify", async () => ctx.parallel(items, async (claim, index) => {
			const id = String(claim.id || `C${index + 1}`).replace(/[^A-Za-z0-9_-]/g, "") || `C${index + 1}`;
			const sourceType = claim.sourceType || "mixed";
			const agent = sourceType === "web" ? "researcher" : sourceType === "repo" ? "explorer" : "researcher";
			return ctx.agent({
				key: `verify-${id}`,
				agent,
				output: "json",
				prompt: `Verify this claim.\n\nOriginal subject:\n${subject}\n\nClaim ${id}: ${claim.text}\nImportance: ${claim.importance || "medium"}\nLikely source type: ${sourceType}\n\nReturn strict JSON only with this shape:\n{\n  "claimId": "${id}",\n  "claim": ${JSON.stringify(claim.text)},\n  "status": "supported|refuted|unclear",\n  "confidence": "low|medium|high",\n  "evidence": [ { "source": "URL or file:line", "summary": "what this evidence says" } ],\n  "notes": "brief caveats"\n}\n\nUse authoritative/primary sources when available. If using repo evidence, cite file paths and line numbers.`,
			});
		}, { key: "verify-claims", concurrency: 4, stopOnError: false }));

		await ctx.artifact("verification-results.json", { subject, claims: items, verifications });

		return ctx.phase("report", async () => ctx.agent({
			key: "verification-report",
			agent: "default",
			prompt: `Write a verification report for the user.\n\nSubject:\n${subject}\n\nExtracted claims:\n${JSON.stringify(items, null, 2)}\n\nVerification results:\n${JSON.stringify(verifications, null, 2)}\n\nReport format:\n## Summary\n- counts of supported/refuted/unclear\n\n## Findings\nFor each claim: status, confidence, evidence, caveats.\n\nDo not synthesize unsupported claims. Mark uncertainty explicitly.`,
		}));
	},
});
