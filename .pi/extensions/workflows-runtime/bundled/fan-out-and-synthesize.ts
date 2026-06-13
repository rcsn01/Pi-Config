import { defineWorkflow } from "../lib/definition.ts";

export default defineWorkflow({
	name: "fan-out-and-synthesize",
	description: "Split a task into independent sub-agent investigations, run them in parallel, and synthesize a final answer.",
	version: "0.1.0",
	inputs: { task: "string" },
	phases: [
		{ name: "plan", description: "Break the request into independent work items" },
		{ name: "fan-out", description: "Run bounded sub-agents in parallel" },
		{ name: "synthesize", description: "Combine findings into one response" },
	],
	budget: { maxAgents: 8, maxConcurrent: 4, estimatedCost: "medium" },
	canEditFiles: false,
	async run(ctx) {
		const task = String(ctx.args || "").trim();
		if (!task) ctx.fail("Provide a task, for example: /workflow fan-out-and-synthesize compare these options...");

		const plan = await ctx.phase("plan", async () => ctx.agent<{ tasks: Array<{ id: string; title: string; prompt: string; agent?: string }> }>({
			key: "plan-work-items",
			agent: "default",
			output: "json",
			prompt: `Split the user's task into 2-4 independent sub-agent tasks.\n\nUser task:\n${task}\n\nReturn strict JSON only, with this shape:\n{\n  "tasks": [\n    { "id": "short-kebab-id", "title": "short title", "agent": "explorer|researcher|default", "prompt": "complete standalone task prompt" }\n  ]\n}\n\nUse explorer for local repo inspection, researcher for web research, and default otherwise. Each prompt must include all necessary context because sub-agents do not share context.`,
		}));

		const workItems = Array.isArray(plan?.tasks) ? plan.tasks.slice(0, 4) : [];
		if (workItems.length === 0) ctx.fail("Planner did not return any work items.");

		const results = await ctx.phase("fan-out", async () => ctx.parallel(workItems, async (item, index) => {
			const id = String(item.id || `task-${index + 1}`).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || `task-${index + 1}`;
			const requestedAgent = item.agent === "explorer" || item.agent === "researcher" || item.agent === "default" ? item.agent : "default";
			return ctx.agent({
				key: `worker-${id}`,
				agent: requestedAgent,
				prompt: `You are one worker in a fan-out workflow. Complete only this assigned subtask and return concise, useful findings.\n\nOverall user task:\n${task}\n\nSubtask title: ${item.title || id}\n\nSubtask prompt:\n${item.prompt || item.title || task}\n\nReturn:\n- direct findings\n- evidence/sources or files inspected, if any\n- uncertainty or gaps`,
			});
		}, { key: "fan-out-workers", concurrency: 4, stopOnError: false }));

		await ctx.artifact("worker-results.json", { task, plan, results });

		return ctx.phase("synthesize", async () => ctx.agent({
			key: "synthesize-final",
			agent: "default",
			prompt: `Synthesize a final answer for the user from these fan-out worker results.\n\nOriginal user task:\n${task}\n\nWorker results JSON:\n${JSON.stringify(results, null, 2)}\n\nWrite a coherent final response. Do not invent facts not supported by worker results. Mark uncertainty explicitly.`,
		}));
	},
});
