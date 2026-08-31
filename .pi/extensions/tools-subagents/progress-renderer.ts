import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text } from "@earendil-works/pi-tui";
import { renderToolMarkdown, renderToolSummary, toolStateMarker, truncateToolLine } from "../_shared/tool-result-ui.ts";
import type { AgentResult } from "../_shared/subagent-service.ts";
import { formatDuration, formatTokens } from "./formatting.ts";

export interface SubagentRenderDetails {
	mode: "single" | "parallel";
	results: AgentResult[];
}

type Theme = ExtensionContext["ui"]["theme"];

function getTermWidth(): number {
	return process.stdout.columns || 120;
}

function formatTiming(result: AgentResult): string | undefined {
	const timing = result.timing;
	if (!timing) return undefined;
	const parts = [
		`model/provider ${formatDuration(timing.modelPhaseMs)}`,
		`tools ${formatDuration(timing.toolWallMs)}`,
	];
	if (timing.repositoryQueries > 0) {
		parts.push(
			`repo_query ${formatDuration(timing.repoQueryWallMs)} (${timing.repositoryQueries} calls/${timing.repositoryOperations} ops)`,
		);
	}
	parts.push(timing.startupMs === undefined ? "startup unavailable" : `startup ${formatDuration(timing.startupMs)}`);
	parts.push(`unclassified ${formatDuration(timing.unclassifiedMs)}`);
	return `${timing.partial ? "timing ~ " : "timing "}${parts.join(" · ")}`;
}

export function renderAgentProgress(
	r: AgentResult,
	theme: Theme,
	expanded: boolean,
	w: number,
): Container {
	const c = new Container();
	const prog = r.progress;
	const isRunning = prog.status === "running";
	const isPending = prog.status === "pending";
	const state = isRunning
		? "running"
		: isPending
			? "pending"
			: prog.status === "failed" || r.exitCode !== 0 || Boolean(prog.error)
				? "error"
				: "success";

	// Header: icon + agent + stats (always one line, truncated)
	const icon = toolStateMarker(theme, state);
	const stats = `${prog.toolCount} tools · ${formatTokens(prog.tokens)} tok · ${formatDuration(prog.durationMs)}`;
	const configuration = [r.model, r.thinkingLevel ? `thinking ${r.thinkingLevel}` : undefined].filter(Boolean).join(" · ");
	const configurationStr = configuration ? theme.fg("dim", ` (${configuration})`) : "";
	c.addChild(
		new Text(
			truncateToolLine(`${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${configurationStr} — ${theme.fg("dim", stats)}`, w),
			0, 0,
		),
	);

	// Task
	if (expanded) {
		// Full task, Text wraps naturally
		c.addChild(new Text(theme.fg("dim", `Task: ${r.task}`), 0, 0));
	} else {
		// Truncate to one line
		const flat = r.task.replace(/\n/g, " ");
		c.addChild(
			new Text(truncateToolLine(theme.fg("dim", `Task: ${flat}`), w), 0, 0),
		);
	}

	// Current tool (running state)
	if (isRunning && prog.currentTool) {
		const toolLine = prog.currentToolArgs
			? `${prog.currentTool}: ${prog.currentToolArgs}`
			: prog.currentTool;
		if (expanded) {
			c.addChild(new Text(theme.fg("warning", `▸ ${toolLine}`), 0, 0));
		} else {
			c.addChild(new Text(truncateToolLine(theme.fg("warning", `▸ ${toolLine}`), w), 0, 0));
		}
	}

	// Recent tools (always all)
	const toolsToShow = prog.recentTools;
	for (const t of toolsToShow) {
		const line = `  ${t.tool}: ${t.args}`;
		if (expanded) {
			c.addChild(new Text(theme.fg("muted", line), 0, 0));
		} else {
			c.addChild(new Text(truncateToolLine(theme.fg("muted", line), w), 0, 0));
		}
	}

	// Latest assistant message — the prose "thinking" text, always visible
	if (prog.lastMessage) {
		c.addChild(new Spacer(1));
		if (expanded) {
			c.addChild(new Text(theme.fg("text", prog.lastMessage), 0, 0));
		} else {
			c.addChild(new Text(truncateToolLine(theme.fg("text", prog.lastMessage), w), 0, 0));
		}
	}

	// Expanded: full final output
	if (!isRunning && r.output && expanded) {
		c.addChild(new Spacer(1));
		c.addChild(renderToolMarkdown(r.output, theme));
	}

	// Usage breakdown
	c.addChild(new Spacer(1));
	const usageParts: string[] = [];
	if (r.usage.turns) usageParts.push(`${r.usage.turns} turn${r.usage.turns > 1 ? "s" : ""}`);
	if (r.usage.input) usageParts.push(`in:${formatTokens(r.usage.input)}`);
	if (r.usage.output) usageParts.push(`out:${formatTokens(r.usage.output)}`);
	if (r.usage.cacheRead) usageParts.push(`cR:${formatTokens(r.usage.cacheRead)}`);
	if (r.usage.cacheWrite) usageParts.push(`cW:${formatTokens(r.usage.cacheWrite)}`);
	if (r.usage.cost) usageParts.push(`$${r.usage.cost.toFixed(4)}`);
	if (usageParts.length) {
		c.addChild(new Text(theme.fg("dim", usageParts.join(" · ")), 0, 0));
	}
	const timing = formatTiming(r);
	if (timing) {
		const line = theme.fg("dim", timing);
		c.addChild(new Text(expanded ? line : truncateToolLine(line, w), 0, 0));
	}

	// Error
	if (prog.error) {
		if (expanded) {
			c.addChild(new Text(theme.fg("error", `Error: ${prog.error}`), 0, 0));
		} else {
			c.addChild(new Text(truncateToolLine(theme.fg("error", `Error: ${prog.error}`), w), 0, 0));
		}
	}

	return c;
}

export function renderSubagentCall(args: any, theme: Theme): Text {
	if (args.tasks?.length === 1) {
		const [task] = args.tasks;
		const taskPreview = task.task
			? truncateToolLine(String(task.task).replace(/\n/g, " "), 60)
			: "";
		return new Text(
			`${theme.fg("toolTitle", theme.bold("subagent"))} ${theme.fg("accent", task.agent)} ${theme.fg("dim", taskPreview)}`,
			0, 0,
		);
	}
	if (args.tasks?.length > 1) {
		const agentNames = args.tasks.map((task: any) => task.agent).join(", ");
		return new Text(
			`${theme.fg("toolTitle", theme.bold("subagent"))} ${theme.fg("accent", "parallel")} ${theme.fg("dim", `(${args.tasks.length} tasks: ${agentNames})`)}`,
			0, 0,
		);
	}
	return new Text(theme.fg("toolTitle", theme.bold("subagent")), 0, 0);
}

export function renderSubagentResult(
	result: { content: Array<{ type: string; text?: string }>; details?: unknown },
	options: { expanded: boolean; isPartial?: boolean },
	theme: Theme,
	terminalWidth: () => number = getTermWidth,
	context: { isError?: boolean } = {},
): Text | Container {
	const details = result.details as SubagentRenderDetails | undefined;
	if (!details?.results?.length) {
		const text = result.content
			.filter((content) => content.type === "text")
			.map((content) => content.text ?? "")
			.join("\n") || "(no output)";
		if (options.isPartial) return renderToolSummary(theme, "running", "Subagent running…");
		if (context.isError) return renderToolSummary(theme, "error", text || "Subagent failed.");
		if (options.expanded) {
			if (!text) return new Text("(no output)", 0, 0);
			const markdown = new Container();
			markdown.addChild(renderToolMarkdown(text, theme));
			return markdown;
		}
		return new Text(truncateToolLine(text || "(no output)", Math.max(1, terminalWidth() - 4)), 0, 0);
	}

	const width = Math.max(1, terminalWidth() - 4);
	const expanded = options.expanded;
	const container = new Container();

	if (details.mode === "parallel") {
		const completed = details.results.filter((agentResult) =>
			agentResult.exitCode === 0 && agentResult.progress?.status !== "failed" && !agentResult.progress?.error,
		).length;
		const running = details.results.filter((agentResult) => agentResult.progress?.status === "running").length;
		const pending = details.results.filter((agentResult) => agentResult.progress?.status === "pending").length;
		const failed = details.results.some((agentResult) =>
			agentResult.progress?.status === "failed" || agentResult.exitCode !== 0,
		);
		const state = running > 0 ? "running" : pending > 0 ? "pending" : failed ? "error" : "success";
		const icon = toolStateMarker(theme, state);
		const duration = Math.max(...details.results.map((agentResult) => agentResult.progress?.durationMs || 0));
		const tokens = details.results.reduce((sum, agentResult) => sum + (agentResult.progress?.tokens || 0), 0);
		container.addChild(new Text(
			truncateToolLine(
				`${icon} ${theme.fg("toolTitle", theme.bold("parallel"))} ${completed}/${details.results.length} completed · ${formatTokens(tokens)} tok · ${formatDuration(duration)}`,
				width,
			),
			0, 0,
		));
		container.addChild(new Spacer(1));
		for (let index = 0; index < details.results.length; index++) {
			container.addChild(renderAgentProgress(details.results[index], theme, expanded, width));
			if (index < details.results.length - 1) container.addChild(new Spacer(1));
		}
	} else {
		container.addChild(renderAgentProgress(details.results[0], theme, expanded, width));
	}

	return container;
}
