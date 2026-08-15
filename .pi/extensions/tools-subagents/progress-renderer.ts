import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import type { AgentResult } from "../_shared/subagent-service.ts";
import { formatDuration, formatTokens, truncateDisplayLine } from "./formatting.ts";

export interface SubagentRenderDetails {
	mode: "single" | "parallel";
	results: AgentResult[];
}

type Theme = ExtensionContext["ui"]["theme"];

function getTermWidth(): number {
	return process.stdout.columns || 120;
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

	// Header: icon + agent + stats (always one line, truncated)
	const icon = isRunning
		? theme.fg("warning", "⟳")
		: isPending
			? theme.fg("dim", "○")
			: r.exitCode === 0
				? theme.fg("success", "✓")
				: theme.fg("error", "✗");
	const stats = `${prog.toolCount} tools · ${formatTokens(prog.tokens)} tok · ${formatDuration(prog.durationMs)}`;
	const configuration = [r.model, r.thinkingLevel ? `thinking ${r.thinkingLevel}` : undefined].filter(Boolean).join(" · ");
	const configurationStr = configuration ? theme.fg("dim", ` (${configuration})`) : "";
	c.addChild(
		new Text(
			truncateDisplayLine(`${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${configurationStr} — ${theme.fg("dim", stats)}`, w),
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
			new Text(truncateDisplayLine(theme.fg("dim", `Task: ${flat}`), w), 0, 0),
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
			c.addChild(new Text(truncateDisplayLine(theme.fg("warning", `▸ ${toolLine}`), w), 0, 0));
		}
	}

	// Recent tools (always all)
	const toolsToShow = prog.recentTools;
	for (const t of toolsToShow) {
		const line = `  ${t.tool}: ${t.args}`;
		if (expanded) {
			c.addChild(new Text(theme.fg("muted", line), 0, 0));
		} else {
			c.addChild(new Text(truncateDisplayLine(theme.fg("muted", line), w), 0, 0));
		}
	}

	// Latest assistant message — the prose "thinking" text, always visible
	if (prog.lastMessage) {
		c.addChild(new Spacer(1));
		if (expanded) {
			c.addChild(new Text(theme.fg("text", prog.lastMessage), 0, 0));
		} else {
			c.addChild(new Text(truncateDisplayLine(theme.fg("text", prog.lastMessage), w), 0, 0));
		}
	}

	// Expanded: full final output
	if (!isRunning && r.output && expanded) {
		c.addChild(new Spacer(1));
		const mdTheme = getMarkdownTheme();
		c.addChild(new Markdown(r.output, 0, 0, mdTheme));
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
	

	// Error
	if (prog.error) {
		if (expanded) {
			c.addChild(new Text(theme.fg("error", `Error: ${prog.error}`), 0, 0));
		} else {
			c.addChild(new Text(truncateDisplayLine(theme.fg("error", `Error: ${prog.error}`), w), 0, 0));
		}
	}

	return c;
}

export function renderSubagentCall(args: any, theme: Theme): Text {
	if (args.tasks && args.tasks.length > 0) {
		const agentNames = args.tasks.map((task: any) => task.agent).join(", ");
		return new Text(
			`${theme.fg("toolTitle", theme.bold("subagent"))} ${theme.fg("accent", "parallel")} ${theme.fg("dim", `(${args.tasks.length} tasks: ${agentNames})`)}`,
			0, 0,
		);
	}
	if (args.agent) {
		const taskPreview = args.task
			? (args.task.length > 60 ? `${args.task.slice(0, 60)}…` : args.task).replace(/\n/g, " ")
			: "";
		return new Text(
			`${theme.fg("toolTitle", theme.bold("subagent"))} ${theme.fg("accent", args.agent)} ${theme.fg("dim", taskPreview)}`,
			0, 0,
		);
	}
	return new Text(theme.fg("toolTitle", theme.bold("subagent")), 0, 0);
}

export function renderSubagentResult(
	result: { content: Array<{ type: string; text?: string }>; details?: unknown },
	options: { expanded: boolean },
	theme: Theme,
	terminalWidth: () => number = getTermWidth,
): Text | Container {
	const details = result.details as SubagentRenderDetails | undefined;
	if (!details?.results?.length) {
		const content = result.content[0];
		const text = content?.type === "text" ? content.text ?? "" : "(no output)";
		return new Text(text.slice(0, 200), 0, 0);
	}

	const width = terminalWidth() - 4;
	const expanded = options.expanded;
	const container = new Container();

	if (details.mode === "parallel") {
		const completed = details.results.filter((agentResult) => agentResult.exitCode === 0).length;
		const running = details.results.filter((agentResult) => agentResult.progress?.status === "running").length;
		const icon = running > 0
			? theme.fg("warning", "⟳")
			: completed === details.results.length
				? theme.fg("success", "✓")
				: theme.fg("error", "✗");
		const duration = Math.max(...details.results.map((agentResult) => agentResult.progress?.durationMs || 0));
		const tokens = details.results.reduce((sum, agentResult) => sum + (agentResult.progress?.tokens || 0), 0);
		container.addChild(new Text(
			truncateDisplayLine(
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
