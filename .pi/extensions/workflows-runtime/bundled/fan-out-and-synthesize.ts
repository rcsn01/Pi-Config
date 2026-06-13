import { defineWorkflow } from "../lib/definition.ts";

function stableId(input: string, fallback: string): string {
	return String(input || fallback).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || fallback;
}

export default defineWorkflow({
	name: "fan-out-and-synthesize",
	description: "Split a task into independent sub-agent investigations, run them in parallel, and synthesize a final answer.",
	version: "0.2.0",
	inputs: { task: "string" },
	phases: [
		{ name: "plan", description: "Break the request into independent work items with strict JSON" },
		{ name: "fan-out", description: "Run bounded sub-agents in parallel" },
		{ name: "verify", description: "Optionally verify high-impact or uncertain worker findings" },
		{ name: "synthesize", description: "Combine findings, decisions, evidence, verification, and risks" },
	],
	budget: { maxAgents: 16, maxConcurrent: 4, maxTokens: 200000, estimatedCost: "medium" },
	capabilities: { canEditFiles: true, readsFiles: true, usesWeb: true, worktrees: true },
	async run(ctx) {
		const task = String(ctx.args || "").trim();
		if (!task) ctx.fail("Provide a task, for example: /workflow fan-out-and-synthesize compare these options...");

		const plan = await ctx.phase("plan", async () => ctx.agent<{ tasks: Array<{ id: string; title: string; prompt: string; agent?: string; mayEdit?: boolean; fileOwnership?: string[]; verificationNeeded?: boolean }> }>({
			key: "plan-work-items",
			agent: "default",
			output: "json",
			prompt: `Split the user's task into 2-4 independent sub-agent tasks. Return strict JSON only; no markdown.\n\nUser task:\n${task}\n\nSchema:\n{\n  "tasks": [\n    {\n      "id": "stable-short-kebab-id",\n      "title": "short title",\n      "agent": "explorer|researcher|worker|default",\n      "prompt": "complete standalone task prompt",\n      "mayEdit": false,\n      "fileOwnership": ["path/glob if editing"],\n      "verificationNeeded": true\n    }\n  ]\n}\n\nRules:\n- IDs must be deterministic from the task/title, lowercase kebab-case, and stable across resume/restart.\n- Use explorer for local repo inspection, researcher for web research, worker for implementation/editing, and default otherwise.\n- Set mayEdit=true only for editing subtasks; include disjoint fileOwnership when possible. Editing workers run in isolated worktrees and are not merged automatically.\n- Each prompt must include all necessary context because sub-agents do not share context.\n- Mark verificationNeeded for high-impact, uncertain, or source-sensitive subtasks.`,
		}));

		const workItems = await ctx.step("normalize-plan", () => {
			const raw = Array.isArray(plan?.tasks) ? plan.tasks.slice(0, 4) : [];
			return raw.map((item, index) => ({
				...item,
				id: stableId(item.id || item.title, `task-${index + 1}`),
				agent: item.agent === "explorer" || item.agent === "researcher" || item.agent === "worker" || item.agent === "default" ? item.agent : "default",
				mayEdit: !!item.mayEdit || item.agent === "worker",
				fileOwnership: Array.isArray(item.fileOwnership) ? item.fileOwnership.filter((f) => typeof f === "string" && f.trim()) : [],
				verificationNeeded: !!item.verificationNeeded,
			}));
		});
		if (workItems.length === 0) ctx.fail("Planner did not return any work items.");

		const results = await ctx.phase("fan-out", async () => ctx.parallel(workItems, async (item) => ctx.agent({
			key: `worker-${item.id}`,
			agent: item.agent,
			output: item.mayEdit ? "json" : "text",
			worktree: item.mayEdit ? { branchId: `workflow-${ctx.runId}-${item.id}`, fileOwnership: item.fileOwnership, preserve: true } : false,
			prompt: `You are one worker in a fan-out workflow. Complete only this assigned subtask and return concise, useful findings.\n\nOverall user task:\n${task}\n\nSubtask title: ${item.title || item.id}\nEditing allowed: ${item.mayEdit ? "yes, in your isolated worktree only" : "no"}\nFile ownership: ${(item.fileOwnership || []).join(", ") || "not declared"}\n\nSubtask prompt:\n${item.prompt || item.title || task}\n\n${item.mayEdit ? "Return strict JSON with filesChanged, testsRun, diffSummary, risks, and notes. Do not merge changes to the main checkout." : "Return:\n- direct findings\n- decisions or recommendations, if any\n- evidence/sources or files inspected, if any\n- uncertainty, assumptions, and risks"}`,
		}), { key: "fan-out-workers", concurrency: 4, stopOnError: false }));

		const needsVerification = task.includes("--verify") || task.toLowerCase().includes("verify") || workItems.some((item) => item.verificationNeeded);
		const verification = await ctx.phase("verify", async () => {
			if (!needsVerification) return { skipped: true, reason: "No verification requested or marked necessary." };
			return ctx.agent({
				key: "verify-worker-results",
				agent: "default",
				output: "json",
				prompt: `Review these worker results for unsupported claims, contradictions, and missing evidence. Return strict JSON only.\n\nOriginal task:\n${task}\n\nWorker results JSON:\n${JSON.stringify(results, null, 2)}\n\nSchema:\n{\n  "verified": true,\n  "issues": [ { "itemId": "worker id", "severity": "low|medium|high", "finding": "issue", "evidence": "source or rationale" } ],\n  "confidence": "low|medium|high"\n}`,
			});
		});

		await ctx.artifact("worker-results.json", { task, plan: workItems, results, verification });

		return ctx.phase("synthesize", async () => ctx.agent({
			key: "synthesize-final",
			agent: "default",
			prompt: `Synthesize a final answer for the user from these fan-out worker results.\n\nOriginal user task:\n${task}\n\nWorker plan JSON:\n${JSON.stringify(workItems, null, 2)}\n\nWorker results JSON:\n${JSON.stringify(results, null, 2)}\n\nVerification JSON:\n${JSON.stringify(verification, null, 2)}\n\nWrite a coherent final response with these sections when applicable:\n- Decisions / answer\n- Files changed / worktrees requiring explicit integration\n- Evidence\n- Verification notes\n- Risks, uncertainty, and unresolved gaps\n\nDo not invent facts not supported by worker results. Mark uncertainty explicitly.`,
		}));
	},
});
