/**
 * Bordered usage-table renderers.
 *
 * Both renderers own their layout fallbacks (header table → shortened
 * headers → label list; empty state) behind a small interface: the two
 * functions the call sites already use. `fit`/`pad` are shared layout
 * helpers used broadly across the ui-context extension.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { formatExactTokenCount, type SessionTokenUsage } from "./context-model.ts";

export function fit(line: string, width: number): string {
	const safeWidth = Math.max(0, width);
	// Calling both helpers here makes the width invariant explicit for every line.
	return visibleWidth(line) <= safeWidth ? line : truncateToWidth(line, safeWidth, "");
}

export function pad(line: string, width: number): string {
	const clipped = fit(line, width);
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function rightAlign(line: string, width: number): string {
	const clipped = fit(line, width);
	return " ".repeat(Math.max(0, width - visibleWidth(clipped))) + clipped;
}

function totalTokenCount(usage: { input: number; cacheRead: number; output: number; cacheWrite?: number }): number {
	return usage.input + usage.cacheRead + usage.output + (usage.cacheWrite ?? 0);
}

export function usageTableLines(
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

export function sortedUsageRows(
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
