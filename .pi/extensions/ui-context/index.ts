import {
	getAgentDir,
	SettingsManager,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	Key,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	type Component,
} from "@earendil-works/pi-tui";
import {
	allocateMeter,
	calculateContextDiagnostics,
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

function breakdownLines(diagnostics: ContextDiagnostics, theme: Theme): string[] {
	const window = diagnostics.contextWindow > 0 ? formatTokenCount(diagnostics.contextWindow) : "unknown";
	const estimated = diagnostics.usedIsEstimated ? " estimated" : "";
	const lines = [
		theme.fg("muted", diagnostics.modelId),
		`${theme.fg("accent", formatTokenCount(diagnostics.usedTokens))} / ${window} tokens (${formatPercent(diagnostics.percent)})${theme.fg("warning", estimated)}`,
		"",
		theme.fg("muted", "Estimated usage by category"),
		...LABELS.map(([label, key]) => `${label.padEnd(18)} ${formatTokenCount(diagnostics.categories[key])}`),
		"",
		`${"Free space".padEnd(18)} ${formatTokenCount(diagnostics.freeSpace)}`,
		`${"Compaction buffer".padEnd(18)} ${diagnostics.compactionEnabled ? formatTokenCount(diagnostics.compactionReserve) : "disabled"}`,
	];
	return lines;
}

export class ContextDiagnosticsComponent implements Component {
	constructor(
		private readonly diagnostics: ContextDiagnostics,
		private readonly theme: Theme,
		private readonly onClose: () => void,
	) {}

	render(width: number): string[] {
		const outerWidth = Math.max(1, width);
		const innerWidth = Math.max(1, outerWidth - 4);
		const title = this.theme.fg("accent", this.theme.bold("Context Usage"));
		const border = this.theme.fg("borderAccent", "─".repeat(outerWidth));
		const details = breakdownLines(this.diagnostics, this.theme);
		let body: string[];

		if (innerWidth >= 72) {
			const meterWidth = 10;
			const gap = 3;
			const detailWidth = Math.max(1, innerWidth - meterWidth - gap);
			const meter = renderMeter(this.diagnostics, this.theme, meterWidth);
			const rows = Math.max(meter.length, details.length);
			body = Array.from({ length: rows }, (_, index) => {
				const left = pad(meter[index] ?? "", meterWidth);
				const right = fit(details[index] ?? "", detailWidth);
				return `  ${left}${" ".repeat(gap)}${right}`;
			});
		} else {
			const meterWidth = Math.max(1, Math.min(100, innerWidth));
			body = [
				...renderMeter(this.diagnostics, this.theme, meterWidth).map((line) => `  ${line}`),
				"",
				...details.map((line) => `  ${line}`),
			];
		}

		const hint = this.theme.fg("dim", "Esc, Enter, or q to close");
		return [border, `  ${title}`, "", ...body, "", `  ${hint}`, border]
			.map((line) => fit(line, outerWidth));
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter) || data === "q" || data === "Q") {
			this.onClose();
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

function collectDiagnostics(pi: ExtensionAPI, ctx: ExtensionCommandContext): ContextDiagnostics {
	const options = ctx.getSystemPromptOptions();
	return calculateContextDiagnostics({
		model: ctx.model,
		usage: ctx.getContextUsage(),
		systemPrompt: ctx.getSystemPrompt(),
		contextFiles: options.contextFiles,
		skills: options.skills,
		activeToolNames: pi.getActiveTools(),
		allTools: pi.getAllTools(),
		contextEntries: ctx.sessionManager.buildContextEntries(),
		compaction: loadCompactionSettings(ctx),
	});
}

function textualSummary(diagnostics: ContextDiagnostics): string {
	const marker = diagnostics.usedIsEstimated ? "estimated " : "";
	const window = diagnostics.contextWindow > 0 ? formatTokenCount(diagnostics.contextWindow) : "unknown";
	return `${diagnostics.modelId}: ${marker}${formatTokenCount(diagnostics.usedTokens)} / ${window} tokens (${formatPercent(diagnostics.percent)})`;
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
				(_tui, theme, _keybindings, done) =>
					new ContextDiagnosticsComponent(diagnostics, theme, () => done(undefined)),
				{
					overlay: true,
					overlayOptions: {
						anchor: "center",
						width: "90%",
						maxHeight: "90%",
						margin: 1,
					},
				},
			);
		},
	});
}
