import type { Theme } from "@earendil-works/pi-coding-agent";
import { Box, Markdown, Text, type MarkdownTheme } from "@earendil-works/pi-tui";
import { UI_GLYPHS } from "./ui-style.ts";

export type TranscriptCardState = "neutral" | "success" | "warning" | "error";

export interface TranscriptCardRequest {
	title: string;
	state?: TranscriptCardState;
	body?: string;
	summary?: string;
	metadata?: readonly string[];
	expanded?: boolean;
}

/** Normalize Pi custom-message content without stringifying text blocks. */
export function normalizeTranscriptContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((part): part is { type: "text"; text: string } =>
				Boolean(part) && typeof part === "object" && "type" in part && "text" in part &&
					part.type === "text" && typeof part.text === "string")
			.map((part) => part.text)
			.join("\n");
	}
	return "";
}

function stateGlyph(state: TranscriptCardState): string {
	switch (state) {
		case "success": return UI_GLYPHS.confirm;
		case "warning": return UI_GLYPHS.warning;
		case "error": return UI_GLYPHS.cancel;
		case "neutral": return "";
	}
}

function stateColor(state: TranscriptCardState): "success" | "warning" | "error" | "accent" {
	if (state === "success") return "success";
	if (state === "warning") return "warning";
	if (state === "error") return "error";
	return "accent";
}

/** Build the Pi-native Markdown token mapping for a transcript or tool body. */
export function createSemanticMarkdownTheme(theme: Theme): MarkdownTheme {
	return {
		heading: (text) => theme.fg("mdHeading", text),
		link: (text) => theme.fg("mdLink", text),
		linkUrl: (text) => theme.fg("mdLinkUrl", text),
		code: (text) => theme.fg("mdCode", text),
		codeBlock: (text) => theme.fg("mdCodeBlock", text),
		codeBlockBorder: (text) => theme.fg("mdCodeBlockBorder", text),
		quote: (text) => theme.fg("mdQuote", text),
		quoteBorder: (text) => theme.fg("mdQuoteBorder", text),
		hr: (text) => theme.fg("mdHr", text),
		listBullet: (text) => theme.fg("mdListBullet", text),
		bold: (text) => theme.bold(text),
		italic: (text) => theme.italic(text),
		strikethrough: (text) => theme.strikethrough(text),
		underline: (text) => theme.underline(text),
	};
}

/**
 * Render a transcript-only card. The card owns its transcript background; tool
 * result renderers should use tool-result-ui instead so Pi's outer shell remains
 * the only tool background.
 */
export function renderTranscriptCard(theme: Theme, request: TranscriptCardRequest): Box {
	const state = request.state ?? "neutral";
	const glyph = stateGlyph(state);
	const title = `${glyph ? `${theme.fg(stateColor(state), glyph)} ` : ""}${theme.fg("accent", theme.bold(request.title))}`;
	const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
	box.addChild(new Text(title, 0, 0));

	if (request.expanded) {
		if (request.body) {
			box.addChild(new Markdown(
				request.body,
				0,
				0,
				createSemanticMarkdownTheme(theme),
				{ color: (text) => theme.fg("customMessageText", text) },
			));
		}
		if (request.metadata?.length) {
			box.addChild(new Text(theme.fg("dim", request.metadata.join("\n")), 0, 0));
		}
	} else {
		box.addChild(new Text(theme.fg("muted", request.summary ?? "Expand to view"), 0, 0));
	}

	return box;
}
