import { truncateHead, type ExtensionAPI, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import type { SubagentRunSnapshot } from "./subagent-runs.ts";
import type { SubagentRunControl } from "./session-execution.ts";
import { renderSubagentResult } from "./progress-renderer.ts";

export const RunSnapshotSchema = Type.Object({
	runId: Type.String(), sessionId: Type.String(), agent: Type.String(), task: Type.String(),
	cwd: Type.String(), model: Type.String(), thinkingLevel: Type.Optional(Type.String()),
	cacheSessionId: Type.Optional(Type.String()),
	status: Type.Union(["queued", "running", "cancelling", "completed", "failed", "cancelled"].map((s) => Type.Literal(s))),
	createdAt: Type.Number(), startedAt: Type.Optional(Type.Number()), finishedAt: Type.Optional(Type.Number()),
	progress: Type.Optional(Type.Unknown()), result: Type.Optional(Type.Unknown()), error: Type.Optional(Type.String()),
});
const RunSummarySchema = Type.Object({ runId: Type.String(), agent: Type.String(), model: Type.String(), status: RunSnapshotSchema.properties.status, createdAt: Type.Number(), finishedAt: Type.Optional(Type.Number()) });
export const RunDetailsSchema = Type.Object({ mode: Type.Literal("background"), runs: Type.Array(Type.Union([RunSnapshotSchema, RunSummarySchema])), truncated: Type.Optional(Type.Boolean()) });
type RunReport = Pick<SubagentRunSnapshot, "runId" | "agent" | "model" | "status"> & Partial<SubagentRunSnapshot>;
export function formatRunReports(runs: readonly RunReport[], includeOutput = true, includeProgress = false): string {
	if (!runs.length) return "No retained background subagent runs.";
	const label = (value: string) => truncateHead(value.replace(/\n/g, " "), { maxBytes: 64, maxLines: 1 }).content;
	const headings = runs.map((r) => `### ${r.runId} · ${label(r.agent)} · ${r.status} · ${label(r.model)}`);
	const blocks = runs.map((r, i) => {
		const error = r.error || r.result?.progress.error;
		const body = includeOutput ? [r.result?.output, error ? `Reason: ${error}` : undefined].filter(Boolean).join("\n") : "";
		const progress = includeProgress && r.progress ? `Progress: ${r.progress.toolCount} tools · ${r.progress.tokens} tokens · ${r.progress.durationMs}ms${r.progress.currentTool ? ` · ${r.progress.currentTool}: ${r.progress.currentToolArgs ?? ""}` : ""}` : "";
		return `${headings[i]}\n${progress}\n${body}`;
	});
	const text = blocks.join("\n\n");
	const limited = truncateHead(text, { maxBytes: 50 * 1024, maxLines: 2000 });
	if (!limited.truncated) return text;
	// Preserve every run heading even when an early output consumes the budget.
	const notice = "\n\n[Output truncated. Use subagent_status with an individual runId for its result.]";
	const prefix = headings.join("\n") + "\n\n";
	return prefix + truncateHead(text, { maxBytes: 50 * 1024 - Buffer.byteLength(prefix + notice), maxLines: 2000 - headings.length - 6 }).content + notice;
}
/** Keep machine-facing retrieval bounded too. Full snapshots remain in renderer details and the manager. */
function structuredRunDetails(runs: SubagentRunSnapshot[]) {
	const details = { mode: "background" as const, runs };
	const fits = (value: unknown) => Buffer.byteLength(JSON.stringify(value)) <= 50 * 1024;
	if (fits(details) && runs.reduce((sum, run) => sum + (run.result?.output.split("\n").length ?? 0), 0) <= 2000) return details;
	const clip = (text: string) => truncateHead(text, { maxBytes: 128, maxLines: 4 }).content;
	const summaries = runs.map((run) => ({
		...run, agent: clip(run.agent), task: clip(run.task), cwd: clip(run.cwd), model: clip(run.model),
		...(run.error ? { error: clip(run.error) } : {}), result: undefined, progress: undefined,
	}));
	const limited = { mode: "background" as const, runs: summaries as SubagentRunSnapshot[], truncated: true };
	// Allocate output fairly instead of letting the first run hide all later results.
	const budget = Math.max(0, Math.floor((50 * 1024 - Buffer.byteLength(JSON.stringify(limited))) / Math.max(1, runs.length)));
	for (let index = 0; index < runs.length; index++) {
		const result = runs[index].result;
		if (!result) continue;
		const output = truncateHead(result.output, { maxBytes: Math.floor(budget / 6), maxLines: Math.floor(1900 / runs.length) });
		const candidate = {
			...result, task: clip(result.task), output: output.content, truncated: true,
			progress: { ...result.progress, task: clip(result.progress.task), lastMessage: clip(result.progress.lastMessage), recentTools: [] },
		};
		limited.runs[index] = { ...limited.runs[index], result: candidate };
		if (!fits(limited)) limited.runs[index] = { ...limited.runs[index], result: undefined };
	}
	return limited;
}
export function runToolResult(runs: SubagentRunSnapshot[], includeOutput = true) {
	const details = { mode: "background" as const, runs };
	return {
		content: [{ type: "text" as const, text: formatRunReports(runs, includeOutput, true) }],
		details, structuredContent: structuredRunDetails(runs),
		isError: includeOutput && runs.some((r) => r.status === "failed" || r.status === "cancelled"),
	};
}
// Pi 0.87 declarations predate outputSchema; newer hosts consume these fields.
export function registerStructuredTool<P extends TSchema, D>(pi: ExtensionAPI, tool: ToolDefinition<P, D> & { outputSchema: TSchema }) {
	pi.registerTool(tool);
}
export function registerSubagentRunTools(pi: ExtensionAPI, runs: SubagentRunControl) {
	const renderResult: NonNullable<Parameters<ExtensionAPI["registerTool"]>[0]["renderResult"]> =
		(result, options, theme, context) => renderSubagentResult(result, options, theme, undefined, context);
	const ids = Type.Array(Type.String(), { minItems: 1, maxItems: 32, uniqueItems: true });
	registerStructuredTool(pi, {
		name: "subagent_status", label: "Subagent status",
		description: "List retained background runs without output bodies, or retrieve progress and terminal output for one runId.",
		parameters: Type.Object({ runId: Type.Optional(Type.String()) }), outputSchema: RunDetailsSchema,
		async execute(_id, params) {
			if (params.runId) return runToolResult([runs.get(params.runId)]);
			const summaries = runs.list().map(({ runId, agent, model, status, createdAt, finishedAt }) => ({ runId, agent: truncateHead(agent, { maxBytes: 64, maxLines: 1 }).content, model: truncateHead(model, { maxBytes: 64, maxLines: 1 }).content, status, createdAt, finishedAt }));
			const details = { mode: "background" as const, runs: summaries };
			return { content: [{ type: "text" as const, text: formatRunReports(summaries, false) }], details, structuredContent: details, isError: false };
		}, renderResult,
	});
	registerStructuredTool(pi, {
		name: "subagent_wait", label: "Wait for subagents",
		description: "Wait for all selected background runs, in caller order. Timeout or abort does not cancel children. timeoutMs defaults to 30000; zero polls current state.",
		parameters: Type.Object({ runIds: ids, timeoutMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 300000 })) }),
		outputSchema: RunDetailsSchema,
		async execute(_id, params, signal) { return runToolResult(await runs.wait(params.runIds, params.timeoutMs, signal)); }, renderResult,
	});
	registerStructuredTool(pi, {
		name: "subagent_cancel", label: "Cancel subagents",
		description: "Cancel selected background runs without affecting the parent or other children. Validate all IDs before cancelling any.",
		parameters: Type.Object({ runIds: ids }), outputSchema: RunDetailsSchema,
		async execute(_id, params) { return runToolResult(runs.cancel(params.runIds), false); }, renderResult,
	});
}
