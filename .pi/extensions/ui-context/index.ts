import {
	getAgentDir,
	SettingsManager,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type KeybindingsManager,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	truncateToWidth,
	visibleWidth,
	type Component,
} from "@earendil-works/pi-tui";
import { collectSessionUsage, collectSubagentUsage } from "../_shared/usage.ts";
import {
	allocateMeter,
	calculateContextDiagnostics,
	formatExactTokenCount,
	formatPercent,
	formatTokenCount,
	type ContextDiagnostics,
} from "./context-model.ts";

const LABELS = [
	["System prompt", "systemPrompt"],
	["Built-in tools", "builtinTools"],
	["Extension tools", "extensionTools"],
	["Context files", "contextFiles"],
	["Skill catalogue", "skills"],
	["Messages", "messages"],
] as const;

function fit(line: string, width: number): string {
	const safeWidth = Math.max(0, width);
	// Calling both helpers here makes the width invariant explicit for every line.
	return visibleWidth(line) <= safeWidth ? line : truncateToWidth(line, safeWidth, "");
}

function pad(line: string, width: number): string {
	const clipped = fit(line, width);
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function meterCells(diagnostics: ContextDiagnostics, theme: Theme): string[] {
	const allocation = allocateMeter(diagnostics, 100);
	const crossedThreshold = diagnostics.compactionEnabled &&
		diagnostics.usedTokens > diagnostics.compactionThreshold;
	const usedColor = crossedThreshold ? "error" : "accent";
	return [
		...Array.from({ length: allocation.used }, () => theme.fg(usedColor, "█")),
		...Array.from({ length: allocation.free }, () => theme.fg("dim", "░")),
		...Array.from({ length: allocation.reserve }, () => theme.fg("warning", "▒")),
	];
}

function renderMeter(
	diagnostics: ContextDiagnostics,
	theme: Theme,
	columns: number,
): string[] {
	const cells = meterCells(diagnostics, theme);
	const safeColumns = Math.max(1, Math.min(100, columns));
	const lines: string[] = [];
	for (let index = 0; index < cells.length; index += safeColumns) {
		lines.push(cells.slice(index, index + safeColumns).join(""));
	}
	return lines.length > 0 ? lines : [""];
}

export function formatBreakdownValue(tokens: number, contextWindow: number): string {
	const percent = contextWindow > 0
		? formatPercent(tokens / contextWindow * 100)
		: "n/a";
	return `${formatTokenCount(tokens)} (${percent})`;
}

function usageBlockLines(
	title: string,
	usage: ContextDiagnostics["sessionUsage"],
	theme: Theme,
): string[] {
	return [
		theme.fg("muted", title),
		`  ${"Input".padEnd(12)} ${formatExactTokenCount(usage.input)}`,
		`  ${"Cache input".padEnd(12)} ${formatExactTokenCount(usage.cacheRead)}`,
		`  ${"Output".padEnd(12)} ${formatExactTokenCount(usage.output)}`,
	];
}

function cumulativeUsageLines(
	diagnostics: ContextDiagnostics,
	theme: Theme,
	width: number,
): string[] {
	const session = usageBlockLines("Current context token usage", diagnostics.sessionUsage, theme);
	const subagents = usageBlockLines("Subagent usage in context", diagnostics.subagentUsage, theme);
	if (width < 72) return [...session, "", ...subagents];

	const gap = 3;
	const leftWidth = Math.floor((width - gap) / 2);
	const rightWidth = Math.max(1, width - gap - leftWidth);
	return session.map((line, index) =>
		`${pad(line, leftWidth)}${" ".repeat(gap)}${fit(subagents[index] ?? "", rightWidth)}`,
	);
}

function breakdownLines(
	diagnostics: ContextDiagnostics,
	theme: Theme,
	selectedIndex: number,
	width: number,
): string[] {
	const window = diagnostics.contextWindow > 0 ? formatTokenCount(diagnostics.contextWindow) : "unknown";
	const estimated = diagnostics.usedIsEstimated ? " estimated" : "";
	const value = (tokens: number) => formatBreakdownValue(tokens, diagnostics.contextWindow);
	return [
		theme.fg("muted", diagnostics.modelId),
		`${theme.fg("accent", formatTokenCount(diagnostics.usedTokens))} / ${window} tokens (${formatPercent(diagnostics.percent)})${theme.fg("warning", estimated)}`,
		"",
		theme.fg("muted", "Estimated breakdown (% of full context window)"),
		...LABELS.map(([label, key], index) => {
			const marker = index === selectedIndex ? theme.fg("accent", "› ") : "  ";
			const row = `${label.padEnd(18)} ${value(diagnostics.categories[key])}`;
			return marker + (index === selectedIndex ? theme.fg("accent", row) : row);
		}),
		"",
		`  ${"Free space".padEnd(18)} ${value(diagnostics.freeSpace)}`,
		`  ${"Compaction buffer".padEnd(18)} ${value(diagnostics.compactionReserve)}${diagnostics.compactionEnabled ? "" : " (disabled)"}`,
		"",
		...cumulativeUsageLines(diagnostics, theme, width),
	];
}

const DEFAULT_DETAIL_VISIBLE_ROWS = 8;

type ContextView = "summary" | "systemPrompt" | "extensionTools";

export class ContextDiagnosticsComponent implements Component {
	private view: ContextView = "summary";
	private summarySelection = LABELS.findIndex(([, key]) => key === "extensionTools");
	private systemPromptSelection = 0;
	private toolSelection = 0;

	constructor(
		private readonly diagnostics: ContextDiagnostics,
		private readonly theme: Theme,
		private readonly keybindings: Pick<KeybindingsManager, "matches">,
		private readonly onClose: () => void,
		private readonly requestRender: () => void,
		private readonly getTargetRows?: () => number,
	) {}

	private detailLines(innerWidth: number, availableRows: number): string[] {
		const isSystemPrompt = this.view === "systemPrompt";
		const items = isSystemPrompt
			? this.diagnostics.systemPromptDetails.map((detail) => ({
				name: detail.label,
				tokens: detail.tokens,
				source: detail.description,
			}))
			: this.diagnostics.extensionTools.map((tool) => ({
				name: tool.name,
				tokens: tool.tokens,
				source: tool.sourcePath,
			}));
		if (items.length === 0) {
			return [this.theme.fg("muted", isSystemPrompt ? "No system prompt details" : "No active extension tools")];
		}
		const selection = isSystemPrompt ? this.systemPromptSelection : this.toolSelection;
		const visibleRows = Math.max(
			1,
			availableRows - (items.length > availableRows ? 1 : 0),
		);
		const start = Math.max(
			0,
			Math.min(selection - visibleRows + 1, items.length - visibleRows),
		);
		const visible = items.slice(start, start + visibleRows);
		const rows = visible.map((item, offset) => {
			const index = start + offset;
			const marker = index === selection ? this.theme.fg("accent", "› ") : "  ";
			const usage = formatBreakdownValue(item.tokens, this.diagnostics.contextWindow);
			let text: string;
			if (innerWidth >= 72) {
				const usageWidth = 15;
				const available = Math.max(1, innerWidth - 2 - usageWidth - 4);
				const nameWidth = Math.max(12, Math.min(28, Math.floor(available * 0.4)));
				const sourceWidth = Math.max(1, available - nameWidth);
				text = `${pad(item.name, nameWidth)}  ${pad(usage, usageWidth)}  ${fit(item.source, sourceWidth)}`;
			} else {
				const usageWidth = Math.min(15, Math.max(1, innerWidth - 2));
				const available = Math.max(1, innerWidth - 2 - usageWidth - 2);
				const nameWidth = Math.max(1, Math.floor(available * 0.45));
				const sourceWidth = Math.max(1, available - nameWidth - 2);
				text = `${pad(item.name, nameWidth)}  ${pad(usage, usageWidth)}  ${fit(item.source, sourceWidth)}`;
			}
			return marker + (index === selection ? this.theme.fg("accent", text) : text);
		});
		if (items.length > visibleRows) {
			rows.push(this.theme.fg("dim", `${start + 1}-${start + visible.length} of ${items.length}`));
		}
		return rows;
	}

	render(width: number): string[] {
		const outerWidth = Math.max(1, width);
		const innerWidth = Math.max(1, outerWidth - 4);
		const requestedRows = Math.max(0, Math.floor(this.getTargetRows?.() ?? 0));
		const detailRows = requestedRows > 0
			? Math.max(1, requestedRows - 6)
			: DEFAULT_DETAIL_VISIBLE_ROWS;
		const titleText = this.view === "summary"
			? "Context Usage"
			: this.view === "systemPrompt" ? "System Prompt" : "Extension Tools";
		const title = this.theme.fg("accent", this.theme.bold(titleText));
		const border = this.theme.fg("borderAccent", "─".repeat(outerWidth));
		let body: string[];

		if (this.view !== "summary") {
			body = this.detailLines(innerWidth, detailRows).map((line) => `  ${line}`);
		} else if (innerWidth >= 72) {
			const meterWidth = 10;
			const gap = 3;
			const detailWidth = Math.max(1, innerWidth - meterWidth - gap);
			const details = breakdownLines(this.diagnostics, this.theme, this.summarySelection, detailWidth);
			const meter = renderMeter(this.diagnostics, this.theme, meterWidth);
			const rows = Math.max(meter.length, details.length);
			body = Array.from({ length: rows }, (_, index) => {
				const left = pad(meter[index] ?? "", meterWidth);
				const right = fit(details[index] ?? "", detailWidth);
				return `  ${left}${" ".repeat(gap)}${right}`;
			});
		} else {
			const meterWidth = Math.max(1, Math.min(100, innerWidth));
			const details = breakdownLines(this.diagnostics, this.theme, this.summarySelection, innerWidth);
			body = [
				...renderMeter(this.diagnostics, this.theme, meterWidth).map((line) => `  ${line}`),
				"",
				...details.map((line) => `  ${line}`),
			];
		}

		const hintText = this.view === "summary"
			? "↑↓ select · Enter details · Esc/q close"
			: "↑↓ browse · Esc back · q close";
		const hint = this.theme.fg("dim", hintText);
		const fixedRows = 6;
		const padding = Array.from(
			{ length: Math.max(0, requestedRows - body.length - fixedRows) },
			() => "",
		);
		return [border, `  ${title}`, "", ...body, ...padding, "", `  ${hint}`, border]
			.map((line) => fit(line, outerWidth));
	}

	handleInput(data: string): void {
		if (data === "q" || data === "Q") {
			this.onClose();
			return;
		}
		if (this.keybindings.matches(data, "tui.select.cancel")) {
			if (this.view !== "summary") {
				this.view = "summary";
				this.requestRender();
			} else {
				this.onClose();
			}
			return;
		}
		if (this.keybindings.matches(data, "tui.select.up")) {
			if (this.view === "summary") this.summarySelection = Math.max(0, this.summarySelection - 1);
			else if (this.view === "systemPrompt") {
				this.systemPromptSelection = Math.max(0, this.systemPromptSelection - 1);
			} else this.toolSelection = Math.max(0, this.toolSelection - 1);
			this.requestRender();
			return;
		}
		if (this.keybindings.matches(data, "tui.select.down")) {
			if (this.view === "summary") this.summarySelection = Math.min(LABELS.length - 1, this.summarySelection + 1);
			else if (this.view === "systemPrompt") {
				this.systemPromptSelection = Math.max(
					0,
					Math.min(this.diagnostics.systemPromptDetails.length - 1, this.systemPromptSelection + 1),
				);
			} else this.toolSelection = Math.max(
				0,
				Math.min(this.diagnostics.extensionTools.length - 1, this.toolSelection + 1),
			);
			this.requestRender();
			return;
		}
		if (this.view === "summary" && this.keybindings.matches(data, "tui.select.confirm")) {
			const selected = LABELS[this.summarySelection]?.[1];
			if (selected === "systemPrompt" || selected === "extensionTools") {
				this.view = selected;
				this.requestRender();
			}
		}
	}

	invalidate(): void {
		// Rendering is stateless and reads the live theme on each pass.
	}
}

function loadCompactionSettings(ctx: ExtensionCommandContext): { enabled: boolean; reserveTokens: number } {
	try {
		return SettingsManager.create(ctx.cwd, getAgentDir(), {
			projectTrusted: ctx.isProjectTrusted(),
		}).getCompactionSettings();
	} catch {
		// These are Pi's public defaults; diagnostics should remain available if a
		// settings file is temporarily unreadable.
		return { enabled: true, reserveTokens: 16_384 };
	}
}

export function collectCurrentContextUsage(
	sessionManager: Pick<ExtensionCommandContext["sessionManager"], "buildContextEntries">,
) {
	// Use Pi's active, compaction-aware branch rather than the append-only
	// session history. Summarized and abandoned subagent calls are not present in
	// the model's current context and must not contribute to these diagnostics.
	const contextEntries = sessionManager.buildContextEntries();
	return {
		contextEntries,
		sessionUsage: collectSessionUsage(contextEntries),
		subagentUsage: collectSubagentUsage(contextEntries),
	};
}

function collectDiagnostics(pi: ExtensionAPI, ctx: ExtensionCommandContext): ContextDiagnostics {
	const options = ctx.getSystemPromptOptions();
	const { contextEntries, sessionUsage, subagentUsage } = collectCurrentContextUsage(ctx.sessionManager);
	return calculateContextDiagnostics({
		model: ctx.model,
		usage: ctx.getContextUsage(),
		systemPrompt: ctx.getSystemPrompt(),
		systemPromptOptions: options,
		contextFiles: options.contextFiles,
		skills: options.skills,
		activeToolNames: pi.getActiveTools(),
		allTools: pi.getAllTools(),
		contextEntries,
		sessionUsage: {
			input: sessionUsage.input,
			cacheRead: sessionUsage.cacheRead,
			output: sessionUsage.output,
		},
		subagentUsage: {
			input: subagentUsage.input,
			cacheRead: subagentUsage.cacheRead,
			output: subagentUsage.output,
		},
		compaction: loadCompactionSettings(ctx),
	});
}

export function textualSummary(diagnostics: ContextDiagnostics): string {
	const marker = diagnostics.usedIsEstimated ? "estimated " : "";
	const window = diagnostics.contextWindow > 0 ? formatTokenCount(diagnostics.contextWindow) : "unknown";
	const usage = diagnostics.sessionUsage;
	const subagents = diagnostics.subagentUsage;
	return [
		`${diagnostics.modelId}: ${marker}${formatTokenCount(diagnostics.usedTokens)} / ${window} tokens (${formatPercent(diagnostics.percent)})`,
		`Current context token usage: Input ${formatExactTokenCount(usage.input)} · Cache input ${formatExactTokenCount(usage.cacheRead)} · Output ${formatExactTokenCount(usage.output)}`,
		`Subagent usage in context: Input ${formatExactTokenCount(subagents.input)} · Cache input ${formatExactTokenCount(subagents.cacheRead)} · Output ${formatExactTokenCount(subagents.output)}`,
	].join("\n");
}

export default function contextDiagnosticsExtension(pi: ExtensionAPI): void {
	pi.registerCommand("context", {
		description: "show model context usage and estimated breakdown",
		handler: async (_args, ctx) => {
			const diagnostics = collectDiagnostics(pi, ctx);
			if (ctx.mode !== "tui") {
				const summary = textualSummary(diagnostics);
				if (ctx.hasUI) ctx.ui.notify(summary, "info");
				else process.stderr.write(`${summary}\n`);
				return;
			}

			await ctx.ui.custom<void>(
				(tui, theme, keybindings, done) =>
					new ContextDiagnosticsComponent(
						diagnostics,
						theme,
						keybindings,
						() => done(undefined),
						() => tui.requestRender(),
						() => tui.terminal.rows * 0.88,
					),
				{
					overlay: true,
					overlayOptions: {
						anchor: "center",
						width: "94%",
						maxHeight: "90%",
						margin: 1,
					},
				},
			);
		},
	});
}
