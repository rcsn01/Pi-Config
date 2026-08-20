import {
	type ExtensionAPI,
	type ExtensionCommandContext,
	type KeybindingsManager,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	truncateToWidth,
	visibleWidth,
	type Component,
	type TUI,
} from "@earendil-works/pi-tui";
import { collectUsageSnapshot } from "../_shared/usage.ts";
import {
	GLOBAL_MODE_LABELS,
	buildGlobalUsageSnapshot,
	type GlobalModeModelRows,
	type GlobalModeTotals,
	type GlobalModelRow,
	type GlobalUsageSnapshot,
} from "../_shared/global-usage.ts";
import type { SessionUsageTotals } from "../_shared/usage.ts";
import { scanGlobalUsage } from "./global-usage-store.ts";
import {
	COMPACT_RESERVE_FRACTION,
} from "../_shared/auto-compact.ts";
import { installOverlayInputGuard } from "./overlay-input-guard.ts";
import {
	allocateMeter,
	calculateContextDiagnostics,
	formatExactTokenCount,
	formatPercent,
	formatTokenCount,
	type ContextDiagnostics,
	type SessionTokenUsage,
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

function rightAlign(line: string, width: number): string {
	const clipped = fit(line, width);
	return " ".repeat(Math.max(0, width - visibleWidth(clipped))) + clipped;
}

function totalTokenCount(usage: { input: number; cacheRead: number; output: number; cacheWrite?: number }): number {
	return usage.input + usage.cacheRead + usage.output + (usage.cacheWrite ?? 0);
}

function usageTableLines(
	title: string,
	rows: readonly { model: string; usage: { input: number; cacheRead: number; output: number; cacheWrite?: number } }[],
	theme: Theme,
	width: number,
): string[] {
	const safeWidth = Math.max(1, width);
	const border = (text: string) => theme.fg("borderMuted", text);
	const contentWidth = Math.max(1, safeWidth - 4);
	const empty = rows.length === 0;

	const topBorder = (): string => {
		const prefix = "┌─ ";
		const label = truncateToWidth(title, Math.max(1, safeWidth - 5), "…");
		const dashes = Math.max(0, safeWidth - visibleWidth(prefix + label) - 2);
		return border(prefix) + theme.fg("accent", theme.bold(label)) + border(` ${"─".repeat(dashes)}┐`);
	};
	const bottomBorder = (): string => border(`└${"─".repeat(safeWidth - 2)}┘`);
	const divider = (): string => border(`├${"─".repeat(safeWidth - 2)}┤`);
	const contentRow = (content: string): string => border("│ ") + pad(content, contentWidth) + border(" │");

	const numericHeaders = ["Input", "Cache input", "Output", "Total"];
	const numericValues = (usage: { input: number; cacheRead: number; output: number; cacheWrite?: number }): string[] => [
		formatExactTokenCount(usage.input),
		formatExactTokenCount(usage.cacheRead),
		formatExactTokenCount(usage.output),
		formatExactTokenCount(totalTokenCount(usage)),
	];
	const longestValue = (index: number): number =>
		empty ? 0 : Math.max(...rows.map((row) => numericValues(row.usage)[index]!.length));

	const headerTable = (headers: readonly string[]): string[] | undefined => {
		const numericWidths = headers.map((header, index) => Math.max(header.length, longestValue(index)));
		const modelWidth = contentWidth - headers.length * 2 - numericWidths.reduce((sum, w) => sum + w, 0);
		if (modelWidth < 8) return undefined;
		if (rows.some((row) => visibleWidth(row.model) > modelWidth)) return undefined;
		const headerRow = contentRow(theme.fg("muted", [
			pad("Model", modelWidth),
			...numericWidths.map((w, index) => rightAlign(headers[index]!, w)),
		].join("  ")));
		const modelRow = (model: string, usage: SessionTokenUsage): string => contentRow([
			pad(theme.bold(model), modelWidth),
			...numericValues(usage).map((value, index) => rightAlign(value, numericWidths[index]!)),
		].join("  "));
		return [
			topBorder(),
			headerRow,
			divider(),
			...rows.map(({ model, usage }) => modelRow(model, usage)),
			bottomBorder(),
		];
	};

	const labelTable = (): string[] => {
		const lines = [topBorder()];
		if (empty) {
			lines.push(contentRow(theme.fg("dim", "No usage recorded")));
		} else {
			for (const { model, usage } of rows) {
				lines.push(contentRow(theme.bold(truncateToWidth(model, contentWidth, "…"))));
				for (const [label, value] of [
					["Input", usage.input],
					["Cache input", usage.cacheRead],
					["Output", usage.output],
					["Total", totalTokenCount(usage)],
				] as const) {
					lines.push(contentRow(`  ${pad(label, 12)} ${formatExactTokenCount(value)}`));
				}
			}
		}
		lines.push(bottomBorder());
		return lines;
	};

	if (empty) return labelTable();
	return headerTable(numericHeaders) ?? headerTable(["Input", "Cache", "Output", "Total"]) ?? labelTable();
}

function sortedUsageRows(
	rows: readonly { model: string; usage: { input: number; cacheRead: number; output: number; cacheWrite?: number } }[],
): { model: string; usage: { input: number; cacheRead: number; output: number; cacheWrite?: number } }[] {
	return rows
		.filter(({ usage }) => totalTokenCount(usage) > 0)
		.sort((left, right) => {
			if (left.model === "unknown") return 1;
			if (right.model === "unknown") return -1;
			return totalTokenCount(right.usage) - totalTokenCount(left.usage) || left.model.localeCompare(right.model);
		});
}

function globalTotalsLines(
	totals: GlobalModeTotals,
	grandTotal: SessionUsageTotals,
	theme: Theme,
	width: number,
): string[] {
	const safeWidth = Math.max(1, width);
	const border = (text: string) => theme.fg("borderMuted", text);
	const contentWidth = Math.max(1, safeWidth - 4);
	const rows: { label: string; usage: SessionUsageTotals }[] = [
		...GLOBAL_MODE_LABELS.map(({ mode, label }) => ({ label, usage: totals[mode] })),
		{ label: "Total", usage: grandTotal },
	];
	const empty = rows.every((row) => row.usage.tokens === 0 && row.usage.cost === 0 && row.usage.turns === 0);

	const topBorder = (): string => {
		const prefix = "┌─ ";
		const label = truncateToWidth("Global token usage", Math.max(1, safeWidth - 5), "…");
		const dashes = Math.max(0, safeWidth - visibleWidth(prefix + label) - 2);
		return border(prefix) + theme.fg("accent", theme.bold(label)) + border(` ${"─".repeat(dashes)}┐`);
	};
	const bottomBorder = (): string => border(`└${"─".repeat(safeWidth - 2)}┘`);
	const divider = (): string => border(`├${"─".repeat(safeWidth - 2)}┤`);
	const contentRow = (content: string): string => border("│ ") + pad(content, contentWidth) + border(" │");

	const numericHeaders = ["Input", "Cache in", "Output", "Cost", "Turns"];
	const numericValues = (usage: SessionUsageTotals): string[] => [
		formatExactTokenCount(usage.input),
		formatExactTokenCount(usage.cacheRead),
		formatExactTokenCount(usage.output),
		`$${usage.cost.toFixed(3)}`,
		String(usage.turns),
	];
	const longestValue = (index: number): number =>
		empty ? 0 : Math.max(...rows.map((row) => numericValues(row.usage)[index]!.length));

	const headerTable = (): string[] | undefined => {
		const numericWidths = numericHeaders.map((header, index) => Math.max(header.length, longestValue(index)));
		const labelWidth = contentWidth - numericHeaders.length * 2 - numericWidths.reduce((sum, w) => sum + w, 0);
		if (labelWidth < 9) return undefined;
		if (rows.some((row) => visibleWidth(row.label) > labelWidth)) return undefined;
		const headerRow = contentRow(theme.fg("muted", [
			pad("Mode", labelWidth),
			...numericWidths.map((w, index) => rightAlign(numericHeaders[index]!, w)),
		].join("  ")));
		const valueRow = (label: string, usage: SessionUsageTotals): string => contentRow([
			pad(theme.bold(label), labelWidth),
			...numericValues(usage).map((value, index) => rightAlign(value, numericWidths[index]!)),
		].join("  "));
		return [
			topBorder(),
			headerRow,
			divider(),
			...rows.map(({ label, usage }) => valueRow(label, usage)),
			bottomBorder(),
		];
	};

	const labelTable = (): string[] => {
		const lines = [topBorder()];
		if (empty) {
			lines.push(contentRow(theme.fg("dim", "No usage recorded")));
		} else {
			for (const { label, usage } of rows) {
				lines.push(contentRow(theme.bold(truncateToWidth(label, contentWidth, "…"))));
				for (const [column, value] of [
					["Input", numericValues(usage)[0]!],
					["Cache in", numericValues(usage)[1]!],
					["Output", numericValues(usage)[2]!],
					["Cost", numericValues(usage)[3]!],
					["Turns", numericValues(usage)[4]!],
				] as const) {
					lines.push(contentRow(`  ${pad(column, 9)} ${value}`));
				}
			}
		}
		lines.push(bottomBorder());
		return lines;
	};

	if (empty) return labelTable();
	return headerTable() ?? labelTable();
}

function globalModelBlocks(models: GlobalModeModelRows, theme: Theme, width: number): string[] {
	const makeBlocks = (blockWidth: number): string[][] => GLOBAL_MODE_LABELS.map(({ mode, label }) =>
		usageTableLines(`${label} usage`, models[mode], theme, blockWidth)
	);
	if (width < 72) {
		const blocks = makeBlocks(width);
		return blocks.flatMap((block, index) => index === 0 ? block : ["", ...block]);
	}

	const gap = 3;
	const leftWidth = Math.floor((width - gap) / 2);
	const rightWidth = Math.max(1, width - gap - leftWidth);
	const leftBlocks = makeBlocks(leftWidth);
	const rightBlocks = makeBlocks(rightWidth);
	const lines: string[] = [];
	for (let index = 0; index < leftBlocks.length; index += 2) {
		const left = leftBlocks[index]!;
		const right = rightBlocks[index + 1] ?? [];
		const rows = Math.max(left.length, right.length);
		for (let row = 0; row < rows; row++) {
			lines.push(`${pad(left[row] ?? "", leftWidth)}${" ".repeat(gap)}${fit(right[row] ?? "", rightWidth)}`);
		}
		if (index + 2 < leftBlocks.length) lines.push("");
	}
	return lines;
}

function cumulativeUsageLines(
	diagnostics: ContextDiagnostics,
	theme: Theme,
	width: number,
): string[] {
	const rows = diagnostics.modelUsage;
	const makeBlocks = (blockWidth: number): string[][] => [
		usageTableLines("Current context token usage", sortedUsageRows(rows.map((row) => ({ model: row.model, usage: row.session }))), theme, blockWidth),
		usageTableLines("Subagent usage in context", sortedUsageRows(rows.map((row) => ({ model: row.model, usage: row.subagent }))), theme, blockWidth),
		usageTableLines("Advisor usage in context", sortedUsageRows(rows.map((row) => ({ model: row.model, usage: row.advisor }))), theme, blockWidth),
		usageTableLines("Guardian usage in context", sortedUsageRows(rows.map((row) => ({ model: row.model, usage: row.guardian }))), theme, blockWidth),
	];
	if (width < 72) {
		const blocks = makeBlocks(width);
		return blocks.flatMap((block, index) => index === 0 ? block : ["", ...block]);
	}

	const gap = 3;
	const leftWidth = Math.floor((width - gap) / 2);
	const rightWidth = Math.max(1, width - gap - leftWidth);
	const leftBlocks = makeBlocks(leftWidth);
	const rightBlocks = makeBlocks(rightWidth);
	const lines: string[] = [];
	for (let index = 0; index < leftBlocks.length; index += 2) {
		const left = leftBlocks[index]!;
		const right = rightBlocks[index + 1] ?? [];
		const rows = Math.max(left.length, right.length);
		for (let row = 0; row < rows; row++) {
			lines.push(`${pad(left[row] ?? "", leftWidth)}${" ".repeat(gap)}${fit(right[row] ?? "", rightWidth)}`);
		}
		if (index + 2 < leftBlocks.length) lines.push("");
	}
	return lines;
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

type ContextView = "summary" | "systemPrompt" | "extensionTools" | "global";

export class ContextDiagnosticsComponent implements Component {
	private view: ContextView = "summary";
	private summarySelection = LABELS.findIndex(([, key]) => key === "extensionTools");
	private systemPromptSelection = 0;
	private toolSelection = 0;
	private scrollOffset = 0;
	private maxScroll = 0;
	private pageSize = 1;
	private globalSnapshot: GlobalUsageSnapshot | undefined;
	private globalLoading = false;
	private globalProgress: { loaded: number; total: number } | undefined;
	private globalError: string | undefined;

	constructor(
		private readonly diagnostics: ContextDiagnostics,
		private readonly theme: Theme,
		private readonly keybindings: Pick<KeybindingsManager, "matches">,
		private readonly onClose: () => void,
		private readonly requestRender: () => void,
		private readonly getTargetRows?: () => number,
		private readonly loadGlobal: (onProgress?: (loaded: number, total: number) => void) => Promise<GlobalUsageSnapshot> = async () => buildGlobalUsageSnapshot([]),
		options: { initialView?: "summary" | "global" } = {},
	) {
		if (options.initialView === "global") {
			this.view = "global";
			queueMicrotask(() => void this.openGlobal());
		}
	}

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
			: this.view === "systemPrompt" ? "System Prompt"
			: this.view === "extensionTools" ? "Extension Tools"
			: "Global Usage";
		const title = this.theme.fg("accent", this.theme.bold(titleText));
		let body: string[];

		if (this.view === "systemPrompt" || this.view === "extensionTools") {
			body = this.detailLines(innerWidth, detailRows).map((line) => `  ${line}`);
		} else if (this.view === "global") {
			body = this.globalBody(innerWidth);
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
			? "↑↓ select · Enter details · g global · Esc/q close"
			: this.view === "systemPrompt" || this.view === "extensionTools"
				? "↑↓ browse · Esc back · q close"
				: "↑↓ scroll · r rescan · Esc back · q close";
		const fixedRows = 6;
		const availableBodyRows = requestedRows > 0
			? Math.max(1, requestedRows - fixedRows)
			: body.length;
		this.pageSize = Math.max(1, availableBodyRows);
		this.maxScroll = Math.max(0, body.length - availableBodyRows);
		this.scrollOffset = Math.min(this.scrollOffset, this.maxScroll);
		const scrollable = this.maxScroll > 0;
		const visibleBody = scrollable
			? body.slice(this.scrollOffset, this.scrollOffset + availableBodyRows)
			: body;
		const scrollHint = this.view === "summary"
			? "↑↓ select · PgUp/PgDn scroll · Enter details · Esc/q close"
			: this.view === "systemPrompt" || this.view === "extensionTools"
				? "↑↓ browse · Esc back · q close"
				: "↑↓ scroll · PgUp/PgDn scroll · r rescan · Esc back · q close";
		const position = scrollable
			? ` · ${this.scrollOffset + 1}-${Math.min(this.scrollOffset + availableBodyRows, body.length)} of ${body.length}`
			: "";
		const hint = this.theme.fg("dim", (scrollable ? scrollHint : hintText) + position);
		const padding = Array.from(
			{ length: Math.max(0, requestedRows - visibleBody.length - fixedRows) },
			() => "",
		);
		const boxed = (line: string): string => `│${pad(line, Math.max(0, outerWidth - 2))}│`;
		return [
			this.theme.fg("borderAccent", `┌${"─".repeat(Math.max(0, outerWidth - 2))}┐`),
			boxed(`  ${title}`),
			boxed(""),
			...visibleBody.map(boxed),
			...padding.map(boxed),
			boxed(""),
			boxed(`  ${hint}`),
			this.theme.fg("borderAccent", `└${"─".repeat(Math.max(0, outerWidth - 2))}┘`),
		].map((line) => fit(line, outerWidth));
	}

	handleInput(data: string): void {
		if (data === "q" || data === "Q") {
			this.onClose();
			return;
		}
		if (this.keybindings.matches(data, "tui.select.cancel")) {
			if (this.view === "summary") {
				this.onClose();
			} else {
				this.view = "summary";
				this.scrollOffset = 0;
				this.requestRender();
			}
			return;
		}
		if (this.view === "summary" && (data === "g" || data === "G")) {
			this.view = "global";
			this.scrollOffset = 0;
			this.requestRender();
			void this.openGlobal();
			return;
		}
		if (this.view === "global" && (data === "r" || data === "R")) {
			if (!this.globalLoading) {
				this.globalSnapshot = undefined;
				this.scrollOffset = 0;
				void this.openGlobal();
			}
			return;
		}
		if (this.keybindings.matches(data, "tui.select.up")) {
			if (this.view === "summary") {
				if (this.summarySelection > 0) {
					this.summarySelection -= 1;
				} else if (this.scrollOffset > 0) {
					this.scrollOffset -= 1;
				}
			} else if (this.view === "systemPrompt") {
				this.systemPromptSelection = Math.max(0, this.systemPromptSelection - 1);
			} else if (this.view === "extensionTools") {
				this.toolSelection = Math.max(0, this.toolSelection - 1);
			} else {
				this.scrollOffset = Math.max(0, this.scrollOffset - 1);
			}
			this.requestRender();
			return;
		}
		if (this.keybindings.matches(data, "tui.select.down")) {
			if (this.view === "summary") {
				if (this.summarySelection < LABELS.length - 1) {
					this.summarySelection += 1;
				} else if (this.scrollOffset < this.maxScroll) {
					this.scrollOffset += 1;
				}
			} else if (this.view === "systemPrompt") {
				this.systemPromptSelection = Math.max(
					0,
					Math.min(this.diagnostics.systemPromptDetails.length - 1, this.systemPromptSelection + 1),
				);
			} else if (this.view === "extensionTools") {
				this.toolSelection = Math.max(
					0,
					Math.min(this.diagnostics.extensionTools.length - 1, this.toolSelection + 1),
				);
			} else {
				this.scrollOffset = Math.min(this.maxScroll, this.scrollOffset + 1);
			}
			this.requestRender();
			return;
		}
		if (this.keybindings.matches(data, "tui.select.pageUp")) {
			if (this.view === "summary") {
				this.scrollOffset = Math.max(0, this.scrollOffset - this.pageSize);
			} else if (this.view === "systemPrompt") {
				this.systemPromptSelection = Math.max(0, this.systemPromptSelection - this.pageSize);
			} else if (this.view === "extensionTools") {
				this.toolSelection = Math.max(0, this.toolSelection - this.pageSize);
			} else {
				this.scrollOffset = Math.max(0, this.scrollOffset - this.pageSize);
			}
			this.requestRender();
			return;
		}
		if (this.keybindings.matches(data, "tui.select.pageDown")) {
			if (this.view === "summary") {
				this.scrollOffset = Math.min(this.maxScroll, this.scrollOffset + this.pageSize);
			} else if (this.view === "systemPrompt") {
				this.systemPromptSelection = Math.min(
					Math.max(0, this.diagnostics.systemPromptDetails.length - 1),
					this.systemPromptSelection + this.pageSize,
				);
			} else if (this.view === "extensionTools") {
				this.toolSelection = Math.min(
					Math.max(0, this.diagnostics.extensionTools.length - 1),
					this.toolSelection + this.pageSize,
				);
			} else {
				this.scrollOffset = Math.min(this.maxScroll, this.scrollOffset + this.pageSize);
			}
			this.requestRender();
			return;
		}
		if (this.view === "summary" && this.keybindings.matches(data, "tui.select.confirm")) {
			const selected = LABELS[this.summarySelection]?.[1];
			if (selected === "systemPrompt" || selected === "extensionTools") {
				this.view = selected;
				this.scrollOffset = 0;
				this.requestRender();
			}
		}
	}

	private async openGlobal(): Promise<void> {
		if (this.globalLoading) return;
		this.globalLoading = true;
		this.globalError = undefined;
		this.globalProgress = undefined;
		this.requestRender();
		try {
			const snapshot = await this.loadGlobal((loaded, total) => {
				this.globalProgress = { loaded, total };
				this.requestRender();
			});
			this.globalSnapshot = snapshot;
		} catch (error) {
			this.globalError = error instanceof Error ? error.message : String(error);
		} finally {
			this.globalLoading = false;
			this.globalProgress = undefined;
			this.requestRender();
		}
	}

	private globalBody(innerWidth: number): string[] {
		const theme = this.theme;
		const lines: string[] = [];
		if (this.globalLoading) {
			const progress = this.globalProgress
				? ` ${this.globalProgress.loaded}/${this.globalProgress.total}`
				: "";
			lines.push(theme.fg("warning", `Scanning sessions…${progress}`));
			if (!this.globalSnapshot && !this.globalError) return lines;
		}
		if (this.globalError) {
			lines.push(theme.fg("error", `Global usage unavailable: ${this.globalError}`));
			return lines;
		}
		const snapshot = this.globalSnapshot;
		if (!snapshot) return lines;
		const updated = new Date(snapshot.scannedAt).toLocaleTimeString();
		lines.push(theme.fg("muted", `${snapshot.sessions.length} sessions · ${snapshot.modelCount} models · updated ${updated}`));
		lines.push("");
		lines.push(...globalTotalsLines(snapshot.totals, snapshot.total, theme, innerWidth));
		lines.push("");
		lines.push(...globalModelBlocks(snapshot.models, theme, innerWidth));
		return lines;
	}

	invalidate(): void {
		// Rendering is stateless and reads the live theme on each pass.
	}
}

function loadCompactionSettings(ctx: ExtensionCommandContext): { enabled: boolean; reserveTokens: number } {
	// The auto-compact extension replaces Pi's native compaction (which it
	// disables in settings.json), so the diagram always reflects the
	// auto-compact buffer rather than the native, disabled one.
	const contextWindow = Math.max(
		0,
		ctx.model?.contextWindow ?? ctx.getContextUsage()?.contextWindow ?? 0,
	);
	return autoCompactCompactionSettings(contextWindow);
}

/**
 * The auto-compact extension's buffer: it compacts at {@link COMPACT_THRESHOLD}
 * of the model window, so the headroom kept for the response is the remaining
 * {@link COMPACT_RESERVE_FRACTION} of the window.
 */
export function autoCompactCompactionSettings(
	contextWindow: number,
): { enabled: boolean; reserveTokens: number } {
	return {
		enabled: true,
		reserveTokens: Math.round(Math.max(0, contextWindow) * COMPACT_RESERVE_FRACTION),
	};
}

export function collectCurrentContextUsage(
	sessionManager: Pick<ExtensionCommandContext["sessionManager"], "buildContextEntries">,
) {
	// Context-entry adapter: use Pi's active, compaction-aware branch rather than
	// the append-only session history. Summarized and abandoned subagent calls
	// are not present in the model's current context and must not contribute to
	// these diagnostics.
	const contextEntries = sessionManager.buildContextEntries();
	return { contextEntries, usage: collectUsageSnapshot(contextEntries) };
}

function collectDiagnostics(pi: ExtensionAPI, ctx: ExtensionCommandContext): ContextDiagnostics {
	const options = ctx.getSystemPromptOptions();
	const { contextEntries, usage } = collectCurrentContextUsage(ctx.sessionManager);
	const { session: sessionUsage, subagent: subagentUsage, advisor: advisorUsage, guardian: guardianUsage, models: modelUsage } = usage;
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
		advisorUsage: {
			input: advisorUsage.input,
			cacheRead: advisorUsage.cacheRead,
			output: advisorUsage.output,
		},
		guardianUsage: {
			input: guardianUsage.input,
			cacheRead: guardianUsage.cacheRead,
			output: guardianUsage.output,
		},
		modelUsage,
		compaction: loadCompactionSettings(ctx),
	});
}

export function textualSummary(diagnostics: ContextDiagnostics): string {
	const marker = diagnostics.usedIsEstimated ? "estimated " : "";
	const window = diagnostics.contextWindow > 0 ? formatTokenCount(diagnostics.contextWindow) : "unknown";
	const rows = diagnostics.modelUsage;
	const modelLines = (title: string, usage: readonly { model: string; usage: SessionTokenUsage }[]): string[] => {
		const active = sortedUsageRows(usage);
		if (active.length === 0) return [];
		return [
			`${title}:`,
			...active.map(({ model, usage: totals }) =>
				`  ${model}: Input ${formatExactTokenCount(totals.input)} · Cache input ${formatExactTokenCount(totals.cacheRead)} · Output ${formatExactTokenCount(totals.output)}`,
			),
		];
	};
	return [
		`${diagnostics.modelId}: ${marker}${formatTokenCount(diagnostics.usedTokens)} / ${window} tokens (${formatPercent(diagnostics.percent)})`,
		...modelLines("Current context token usage", rows.map((row) => ({ model: row.model, usage: row.session }))),
		...modelLines("Subagent usage in context", rows.map((row) => ({ model: row.model, usage: row.subagent }))),
		...modelLines("Advisor usage in context", rows.map((row) => ({ model: row.model, usage: row.advisor }))),
		...modelLines("Guardian usage in context", rows.map((row) => ({ model: row.model, usage: row.guardian }))),
	].join("\n");
}

export function textualGlobalSummary(snapshot: GlobalUsageSnapshot): string {
	const modeLines = (label: string, totals: SessionUsageTotals): string =>
		`  ${label}: ${formatTokenCount(totals.tokens)} tokens · $${totals.cost.toFixed(3)} · ${totals.turns} turns`;
	const modelLines = (title: string, rows: readonly GlobalModelRow[]): string[] =>
		rows.length === 0 ? [] : [
			`${title}:`,
			...rows.map(({ model, usage }) =>
				`  ${model}: ${formatTokenCount(usage.tokens)} tokens · $${usage.cost.toFixed(3)} · ${usage.turns} turns`,
			),
		];
	return [
		`${snapshot.sessions.length} sessions · ${snapshot.modelCount} models (updated ${new Date(snapshot.scannedAt).toLocaleString()})`,
		`Total: ${formatTokenCount(snapshot.total.tokens)} tokens · $${snapshot.total.cost.toFixed(3)} · ${snapshot.total.turns} turns`,
		...GLOBAL_MODE_LABELS.map(({ mode, label }) => modeLines(label, snapshot.totals[mode])),
		...GLOBAL_MODE_LABELS.flatMap(({ mode, label }) => modelLines(label, snapshot.models[mode])),
	].join("\n");
}

export default function contextDiagnosticsExtension(pi: ExtensionAPI): void {
	pi.registerCommand("context", {
		description: "show model context usage and estimated breakdown, or 'global' for usage across all sessions",
		getArgumentCompletions: (prefix: string) =>
			["global"].filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			const globalRequested = (args || "").trim().toLowerCase() === "global";
			const loadGlobal = (onProgress?: (loaded: number, total: number) => void) =>
				scanGlobalUsage({ onProgress });
			const diagnostics = collectDiagnostics(pi, ctx);
			if (ctx.mode !== "tui") {
				if (globalRequested) {
					const snapshot = await loadGlobal();
					const summary = textualGlobalSummary(snapshot);
					if (ctx.hasUI) ctx.ui.notify(summary, "info");
					else process.stderr.write(`${summary}\n`);
				} else {
					const summary = textualSummary(diagnostics);
					if (ctx.hasUI) ctx.ui.notify(summary, "info");
					else process.stderr.write(`${summary}\n`);
				}
				return;
			}

			let unsubscribe: (() => void) | undefined;
			let component: ContextDiagnosticsComponent | undefined;
			let tuiRef: TUI | undefined;
			try {
				await ctx.ui.custom<void>(
					(tui, theme, keybindings, done) => {
						tuiRef = tui;
						component = new ContextDiagnosticsComponent(
							diagnostics,
							theme,
							keybindings,
							() => {
								unsubscribe?.();
								done(undefined);
							},
							() => tui.requestRender(),
							() => tui.terminal.rows * 0.88,
							loadGlobal,
							{ initialView: globalRequested ? "global" : "summary" },
						);
						return component;
					},
					{
						overlay: true,
						overlayOptions: {
							anchor: "center",
							width: "94%",
							maxHeight: "90%",
							margin: 1,
						},
						onHandle: (handle) => {
							// Route input to this overlay while it is the topmost visible UI,
							// even when an independent non-overlay UI (e.g. plan mode's review
							// menu) stole focus from it.
							unsubscribe = installOverlayInputGuard({
								registerInputListener: (handler) => ctx.ui.onTerminalInput(handler),
								tui: tuiRef!,
								component: component!,
								handle,
							});
						},
					},
				);
			} finally {
				unsubscribe?.();
			}
		},
	});
}
