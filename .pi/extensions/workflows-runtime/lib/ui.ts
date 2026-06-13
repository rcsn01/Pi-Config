import type { RegistryEntry } from "./registry.ts";
import type { RunState } from "./run-store.ts";

function boolText(value: boolean | undefined): string {
	return value === undefined ? "unknown until import" : value ? "may edit" : "read-only";
}

function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
	const min = Math.floor(ms / 60000);
	const sec = Math.floor((ms % 60000) / 1000);
	return `${min}m${sec}s`;
}

export function summarizeWorkflow(entry: RegistryEntry): string {
	return `${entry.name} — ${entry.description} (${entry.trust}, ${entry.cost}, ${boolText(entry.canEditFiles)})`;
}

export function formatWorkflowList(entries: RegistryEntry[]): string {
	if (entries.length === 0) return "No workflows found.";
	return entries.map((entry) => [
		`- ${entry.name}`,
		`  ${entry.description}`,
		`  trust: ${entry.trust} · cost: ${entry.cost} · files: ${boolText(entry.canEditFiles)} · source: ${entry.sourceHash.slice(0, 12)}`,
	].join("\n")).join("\n");
}

export function formatApprovalPlan(entry: RegistryEntry, args: string): string {
	const workflow = entry.workflow;
	const phaseLines = workflow?.phases?.length ? workflow.phases.map((p) => `  - ${p.name}${p.description ? `: ${p.description}` : ""}`).join("\n") : "  (available after trusted import for project workflows)";
	const budget = workflow?.budget ? [
		workflow.budget.maxAgents ? `maxAgents=${workflow.budget.maxAgents}` : undefined,
		workflow.budget.maxConcurrent ? `maxConcurrent=${workflow.budget.maxConcurrent}` : undefined,
		workflow.budget.maxTokens ? `maxTokens=${workflow.budget.maxTokens}` : undefined,
		workflow.budget.estimatedCost ? `estimatedCost=${workflow.budget.estimatedCost}` : undefined,
	].filter(Boolean).join(", ") || "not declared" : `cost shape: ${entry.cost}`;
	return [
		`Workflow: ${entry.name}`,
		`Description: ${entry.description}`,
		`Input: ${args || "(none)"}`,
		`Trust: ${entry.trust}`,
		`Source hash: ${entry.sourceHash}`,
		`Files: ${boolText(entry.canEditFiles)}`,
		`Budget: ${budget}`,
		"Phases:",
		phaseLines,
	].join("\n");
}

export function formatRunList(states: RunState[]): string {
	if (states.length === 0) return "No workflow runs found.";
	return states.slice(0, 30).map((s) => {
		const phase = s.currentPhase ? ` · phase: ${s.currentPhase}` : "";
		const err = s.error ? ` · error: ${s.error.slice(0, 140)}` : "";
		const elapsed = formatDuration((s.completedAt || Date.now()) - s.startedAt);
		return `- ${s.runId}\n  ${s.workflowName} · ${s.status}${phase} · agents ${s.agentsCompleted}/${s.agentsStarted} (${s.agentsFailed} failed) · tokens ${s.tokens} · cost $${s.cost.toFixed(4)} · ${elapsed}${err}`;
	}).join("\n");
}

export function formatRunDetail(s: RunState, eventLogPath: string): string {
	const phaseLines = Object.entries(s.phases).map(([key, p]) => `- ${key}: ${p.status}${p.error ? ` — ${p.error}` : ""}`);
	const stepLines = Object.entries(s.steps).map(([key, st]) => `- ${key}: ${st.status}${st.error ? ` — ${st.error}` : ""}`);
	const agentLines = Object.entries(s.agents).map(([key, a]) => `- ${key}: ${a.agent} ${a.status}${a.error ? ` — ${a.error}` : ""}`);
	const parallelLines = Object.entries(s.parallel).map(([key, p]) => `- ${key}: ${p.status}${p.count !== undefined ? ` (${p.count} items, concurrency ${p.concurrency || "?"})` : ""}${p.error ? ` — ${p.error}` : ""}`);
	return [
		`# Workflow Run ${s.runId}`,
		`workflow: ${s.workflowName}`,
		`status: ${s.status}`,
		`args: ${s.args || "(none)"}`,
		`trust: ${s.trust}`,
		`source hash: ${s.sourceHash}`,
		s.sourceSnapshotPath ? `source snapshot: ${s.sourceSnapshotPath}` : undefined,
		s.currentPhase ? `current phase: ${s.currentPhase}` : undefined,
		`agents: ${s.agentsCompleted}/${s.agentsStarted} completed, ${s.agentsFailed} failed`,
		`tokens: input ${s.usage.inputTokens}, output ${s.usage.outputTokens}, cache read ${s.usage.cacheReadTokens}, cache write ${s.usage.cacheWriteTokens}, turns ${s.usage.turns}`,
		`cost: $${s.cost.toFixed(4)}`,
		s.error ? `error: ${s.error}` : undefined,
		phaseLines.length ? `\n## Phases\n${phaseLines.join("\n")}` : undefined,
		stepLines.length ? `\n## Steps\n${stepLines.join("\n")}` : undefined,
		agentLines.length ? `\n## Agents\n${agentLines.join("\n")}` : undefined,
		parallelLines.length ? `\n## Parallel Blocks\n${parallelLines.join("\n")}` : undefined,
		s.artifacts.length ? `\n## Artifacts\n${s.artifacts.map((a) => `- ${a}`).join("\n")}` : undefined,
		s.result !== undefined ? `\n## Final Output\n${typeof s.result === "string" ? s.result : JSON.stringify(s.result, null, 2)}` : undefined,
		`\n## Controls\n- Resume: /workflow resume ${s.runId}\n- Restart a durable key: /workflow restart ${s.runId} <step-or-agent-key>\n- Stop active foreground run: /workflow stop ${s.runId}`,
		`\n## Event Log\n${eventLogPath}`,
	].filter(Boolean).join("\n");
}
