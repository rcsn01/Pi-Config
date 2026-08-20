import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type Keybinding } from "@earendil-works/pi-tui";

export const UI_GLYPHS = {
	cursor: "→",
	checked: "●",
	unchecked: "○",
	confirm: "✓",
	cancel: "✗",
	pending: "○",
	running: "⟳",
	success: "✓",
	warning: "!",
	error: "✗",
} as const;

export interface SelectorHintAction {
	keybindings: Keybinding | readonly Keybinding[];
	description: string;
	fallback: string;
}

export interface SelectorFrameOptions {
	title: string | readonly string[];
	subtitle?: string | readonly string[];
	body: readonly string[];
	hint: string;
}

function frameTextLines(value: string | readonly string[] | undefined): string[] {
	if (!value) return [];
	return typeof value === "string" ? value.split("\n") : [...value];
}

function firstConfiguredKey(
	keybindings: Pick<KeybindingsManager, "getKeys">,
	id: Keybinding,
	fallback: string,
): string {
	return keybindings.getKeys(id)[0] ?? fallback;
}

function displayKey(key: string): string {
	return key
		.split("+")
		.map((part) => process.platform === "darwin" && part.toLowerCase() === "alt" ? "option" : part)
		.join("+");
}

export function formatSelectorHint(
	keybindings: Pick<KeybindingsManager, "getKeys">,
	actions: readonly SelectorHintAction[],
): string {
	return actions.map((action) => {
		const ids = typeof action.keybindings === "string" ? [action.keybindings] : action.keybindings;
		const fallbackKeys = action.fallback.split("/");
		const keys = ids.map((id, index) =>
			displayKey(firstConfiguredKey(keybindings, id, fallbackKeys[index] ?? action.fallback)));
		return `${keys.join("/")} ${action.description}`;
	}).join(" · ");
}

export function selectorHint(
	keybindings: Pick<KeybindingsManager, "getKeys">,
	options: {
		searchable?: boolean;
		confirmVerb?: "select" | "next" | "apply";
		cancelVerb?: "cancel" | "back" | "close";
	},
): string {
	const actions: SelectorHintAction[] = [];
	if (options.searchable) {
		actions.push({ keybindings: [], description: "type to filter", fallback: "" });
	}
	actions.push(
		{ keybindings: ["tui.select.up", "tui.select.down"], description: "navigate", fallback: "up/down" },
		{ keybindings: "tui.select.confirm", description: options.confirmVerb ?? "select", fallback: "enter" },
		{ keybindings: "tui.select.cancel", description: options.cancelVerb ?? "cancel", fallback: "escape" },
	);
	return actions.map((action) => {
		if (Array.isArray(action.keybindings) && action.keybindings.length === 0) return action.description;
		return formatSelectorHint(keybindings, [action]);
	}).join(" · ");
}

export function createSelectListTheme(theme: Theme) {
	return {
		selectedPrefix: (text: string) => theme.fg("accent", text),
		selectedText: (text: string) => theme.fg("accent", text),
		description: (text: string) => theme.fg("muted", text),
		scrollInfo: (text: string) => theme.fg("dim", text),
		noMatch: (text: string) => theme.fg("muted", text),
	};
}

export function fitUiLines(lines: readonly string[], width: number): string[] {
	const safeWidth = Math.max(0, width);
	return lines.map((line) => truncateToWidth(line, safeWidth, ""));
}

export function renderSelectorFrame(
	theme: Theme,
	width: number,
	options: SelectorFrameOptions,
): string[] {
	const safeWidth = Math.max(0, width);
	const rule = theme.fg("border", "─".repeat(safeWidth));
	const titles = frameTextLines(options.title).map((line) => theme.fg("accent", theme.bold(line)));
	const subtitles = frameTextLines(options.subtitle).map((line) => theme.fg("dim", line));
	return fitUiLines([
		rule,
		...titles,
		...subtitles,
		"",
		...options.body,
		"",
		theme.fg("dim", options.hint),
		rule,
	], safeWidth);
}
