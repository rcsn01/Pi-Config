import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { Markdown, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { createSemanticMarkdownTheme } from "./transcript-card.ts";
import { UI_GLYPHS } from "./ui-style.ts";

export type ToolResultState = "pending" | "running" | "success" | "warning" | "error";

type ToolResultEventLike = {
	toolName: string;
	content: Array<{ type: string; text?: string }>;
	details: unknown;
	isError: boolean;
};

/** Bridge semantic extension failures to Pi's native tool shell/protocol flag. */
export function registerToolErrorHandler(
	pi: ExtensionAPI,
	toolNames: readonly string[],
	isFailure: (event: ToolResultEventLike) => boolean,
): void {
	pi.on("tool_result", (event) => {
		if (event.isError || !toolNames.includes(event.toolName) || !isFailure(event)) return;
		return { isError: true };
	});
}

const TOOL_STATE_GLYPHS: Record<ToolResultState, string> = {
	pending: UI_GLYPHS.pending,
	running: UI_GLYPHS.running,
	success: UI_GLYPHS.success,
	warning: UI_GLYPHS.warning,
	error: UI_GLYPHS.error,
};

const TOOL_STATE_COLORS: Record<ToolResultState, "dim" | "warning" | "success" | "error"> = {
	pending: "dim",
	running: "warning",
	success: "success",
	warning: "warning",
	error: "error",
};

export function toolStateGlyph(state: ToolResultState): string {
	return TOOL_STATE_GLYPHS[state];
}

export function toolStateMarker(theme: Theme, state: ToolResultState): string {
	return theme.fg(TOOL_STATE_COLORS[state], TOOL_STATE_GLYPHS[state]);
}

export function renderToolSummary(
	theme: Theme,
	state: ToolResultState,
	text: string,
	expandable = false,
): Text {
	const suffix = expandable ? theme.fg("dim", " · expand to view") : "";
	const prefix = theme.fg(TOOL_STATE_COLORS[state], `${TOOL_STATE_GLYPHS[state]} `);
	const bodyColor = state === "error" || state === "warning" ? TOOL_STATE_COLORS[state] : "toolOutput";
	return new Text(`${prefix}${theme.fg(bodyColor, text)}${suffix}`, 0, 0);
}

export function renderToolMarkdown(markdown: string, theme: Theme): Markdown {
	return new Markdown(
		markdown,
		0,
		0,
		createSemanticMarkdownTheme(theme),
		{ color: (text) => theme.fg("toolOutput", text) },
	);
}

export function truncateToolLine(text: string, width: number): string {
	return truncateToWidth(text, Math.max(1, width), "…");
}
