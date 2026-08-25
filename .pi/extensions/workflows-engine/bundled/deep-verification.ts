import { defineWorkflow } from "../lib/definition.ts";

export default defineWorkflow({
	name: "deep-verification",
	description: "Extract factual claims from a document or prompt and verify them against authoritative web sources or the local codebase.",
	version: "0.2.0",
	inputs: { subject: "string" },
	phases: [
		{ name: "extract", description: "Extract checkable claims" },
		{ name: "classify", description: "Normalize and classify claims by source and impact" },
		{ name: "verify", description: "Verify claims in parallel" },
		{ name: "double-check", description: "Double-check high-impact, refuted, disputed, or unclear claims" },
		{ name: "report", description: "Produce verification report" },
	],
	budget: { maxAgents: 18, maxConcurrent: 4, maxTokens: 220000, estimatedCost: "heavy" },
	canEditFiles: false,
	async run(ctx) {
		const subject = String(ctx.args || "").trim();
		if (!subject) ctx.fail("Provide a file path, topic, or text to verify, for example: /workflow deep-verification workflows-plan.md");

		const extracted = await ctx.phase("extract", async () => ctx.agent<{ claims: Array<{ id: string; text: string; sourceType?: "web" | "codebase" | "docs" | "tests" | "mixed"; importance?: "low" | "medium" | "high" }> }>({
			key: "extract-claims",
			agent: "explorer",
			output: "json",
			prompt: `Extract up to 8 concrete, checkable factual claims from this input. If the input names a local file, read it first. Return strict JSON only.\n\nInput:\n${subject}\n\nSchema:\n{\n  "claims": [\n    { "id": "C1", "text": "claim text", "sourceType": "web|codebase|docs|tests|mixed", "importance": "low|medium|high" }\n  ]\n}\n\nPrefer claims that matter for correctness. If there are no factual claims, return { "claims": [] }.`,
		}));

		const claims = await ctx.phase("classify", async () => ctx.step("classify-claims", () => {
			const items = Array.isArray(extracted?.claims) ? extracted.claims.slice(0, 8) : [];
			return items.map((claim, index) => ({
				id: String(claim.id || `C${index + 1}`).replace(/[^A-Za-z0-9_-]/g, "") || `C${index + 1}`,
				text: String(claim.text || "").trim(),
				sourceType: claim.sourceType === "codebase" || claim.sourceType === "docs" || claim.sourceType === "tests" || claim.sourceType === "web" || claim.sourceType === "mixed" ? claim.sourceType : "mixed",
				importance: claim.importance === "low" || claim.importance === "medium" || claim.importance === "high" ? claim.importance : "medium",
			})).filter((claim) => claim.text);
		}));

		if (claims.length === 0) {
			return `No concrete factual claims were extracted from: ${subject}`;
		}

		const verifications = await ctx.phase("verify", async () => ctx.parallel(claims, async (claim) => {
			const agent = claim.sourceType === "web" ? "researcher" : claim.sourceType === "codebase" || claim.sourceType === "docs" || claim.sourceType === "tests" ? "explorer" : "researcher";
			return ctx.agent({
				key: `verify-${claim.id}`,
				agent,
				output: "json",
				prompt: `Verify this claim. Return strict JSON only.\n\nOriginal subject:\n${subject}\n\nClaim ${claim.id}: ${claim.text}\nImportance: ${claim.importance}\nLikely source type: ${claim.sourceType}\n\nSchema:\n{\n  "claimId": "${claim.id}",\n  "claim": ${JSON.stringify(claim.text)},\n  "status": "confirmed|refuted|disputed|unverifiable",\n  "confidence": "low|medium|high",\n  "evidence": [ { "source": "URL or file:line", "summary": "what this evidence says" } ],\n  "correction": "corrected claim if refuted, else empty",\n  "notes": "brief caveats"\n}\n\nUse authoritative/primary sources when available. If using repo evidence, cite file paths and line numbers. Choose disputed when credible evidence conflicts; choose unverifiable when sources are insufficient.`,
			});
		}, { key: "verify-claims", concurrency: 4, stopOnError: false }));

		const doubleChecks = await ctx.phase("double-check", async () => {
			const candidates = claims.filter((claim, index) => {
				const result = verifications[index] as any;
				return claim.importance === "high" || result?.status === "refuted" || result?.status === "disputed" || result?.status === "unverifiable" || result?.confidence === "low" || result?.error;
			}).slice(0, 6);
			if (candidates.length === 0) return [];
			return ctx.parallel(candidates, async (claim) => ctx.agent({
				key: `double-check-${claim.id}`,
				agent: claim.sourceType === "codebase" || claim.sourceType === "docs" || claim.sourceType === "tests" ? "explorer" : "researcher",
				output: "json",
				prompt: `Double-check this verification result independently. Return strict JSON only.\n\nOriginal subject:\n${subject}\n\nClaim:\n${JSON.stringify(claim)}\n\nPrior verification:\n${JSON.stringify((verifications as any[]).find((v) => v?.claimId === claim.id) || null, null, 2)}\n\nSchema:\n{\n  "claimId": "${claim.id}",\n  "status": "confirmed|refuted|disputed|unverifiable",\n  "confidence": "low|medium|high",\n  "additionalEvidence": [ { "source": "URL or file:line", "summary": "what this evidence says" } ],\n  "correction": "corrected claim if needed",\n  "notes": "what changed or why prior result stands"\n}`,
			}), { key: "double-check-claims", concurrency: 3, stopOnError: false });
		});

		await ctx.artifact("verification-results.json", { subject, claims, verifications, doubleChecks });

		return ctx.phase("report", async () => ctx.agent({
			key: "verification-report",
			agent: "default",
			prompt: `Write a complete verification report for the user.\n\nSubject:\n${subject}\n\nExtracted/classified claims:\n${JSON.stringify(claims, null, 2)}\n\nVerification results:\n${JSON.stringify(verifications, null, 2)}\n\nDouble-check results:\n${JSON.stringify(doubleChecks, null, 2)}\n\nReport format:\n## Summary\n- counts of confirmed, refuted, disputed, and unverifiable claims\n- overall confidence\n\n## Claim Table\nFor each claim: ID, claim, status, confidence, key evidence/sources, correction if any.\n\n## Corrections\nList corrected claims for refuted/disputed items.\n\n## Sources and Evidence Notes\nCall out authoritative sources and weak/unavailable evidence.\n\n## Caveats\nUncertainty, stale data risk, and unverifiable claims.\n\nUse only the verification evidence. Mark confidence labels clearly.`,
		}));
	},
});
