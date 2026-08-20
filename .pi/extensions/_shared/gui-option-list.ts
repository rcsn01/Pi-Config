import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import {
	formatSelectorHint,
	renderSelectorFrame,
	UI_GLYPHS,
} from "./ui-style.ts";

export type GuiOptionListSelectionMode = "single" | "multiple";

export interface GuiOptionListOption<T extends string = string> {
	label: string;
	value: T;
	description?: string;
	checked?: boolean;
	disabled?: boolean;
}

export interface GuiOptionListRequest<T extends string = string> {
	title: string;
	message?: string;
	selectionMode?: GuiOptionListSelectionMode;
	options: Array<GuiOptionListOption<T>>;
}

type UiContext = Pick<ExtensionContext, "hasUI" | "mode" | "ui">;

function fallbackLabel(option: GuiOptionListOption): string {
	const prefix = option.checked ? "● " : "  ";
	const suffix = option.checked ? " (current)" : "";
	const description = option.description ? ` — ${option.description}` : "";
	return `${prefix}${option.label}${description}${suffix}`;
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

function splitMessage(message: string | undefined): string[] {
	return message ? message.split("\n") : [];
}

function requestCustomChecklist<T extends string>(
	ctx: UiContext,
	request: Omit<GuiOptionListRequest<T>, "selectionMode">,
): Promise<T[] | undefined> | undefined {
	const custom = ctx.ui.custom;
	if (!ctx.hasUI || ctx.mode !== "tui" || typeof custom !== "function") return undefined;

	return custom<T[] | undefined>((tui, theme, keybindings, done) => {
		const options = request.options;
		const selected = new Set<T>(options.filter((option) => option.checked).map((option) => option.value));
		let cursor = 0;
		let scroll = 0;
		let cachedWidth: number | undefined;
		let cachedLines: string[] | undefined;

		const totalRows = options.length + 2;
		const saveIndex = options.length;
		const cancelIndex = options.length + 1;
		const maxVisibleOptions = Math.max(6, Math.min(12, totalRows));
		const invalidate = () => {
			cachedWidth = undefined;
			cachedLines = undefined;
		};
		const renderRow = (index: number, width: number): string => {
			const active = index === cursor;
			let text: string;
			let disabled = false;

			if (index === saveIndex) {
				text = `${UI_GLYPHS.confirm} Save selected`;
			} else if (index === cancelIndex) {
				text = `${UI_GLYPHS.cancel} Cancel`;
			} else {
				const option = options[index]!;
				disabled = Boolean(option.disabled);
				const mark = selected.has(option.value) ? UI_GLYPHS.checked : UI_GLYPHS.unchecked;
				const description = option.description ? ` — ${option.description}` : "";
				text = `${mark} ${option.label}${description}${disabled ? " (disabled)" : ""}`;
			}

			const prefix = active ? `${UI_GLYPHS.cursor} ` : "  ";
			let line = truncateToWidth(prefix + text, width);
			if (disabled) line = theme.fg("dim", line);
			else if (active) line = theme.fg("accent", line);
			return line;
		};
		const toggleCurrent = () => {
			if (cursor === saveIndex) {
				done(Array.from(selected));
				return;
			}
			if (cursor === cancelIndex) {
				done(undefined);
				return;
			}

			const option = options[cursor];
			if (!option || option.disabled) return;
			if (selected.has(option.value)) selected.delete(option.value);
			else selected.add(option.value);
			invalidate();
			tui.requestRender();
		};
		const moveCursor = (next: number) => {
			cursor = clamp(next, 0, totalRows - 1);
			if (cursor < scroll) scroll = cursor;
			if (cursor >= scroll + maxVisibleOptions) scroll = cursor - maxVisibleOptions + 1;
			invalidate();
			tui.requestRender();
		};

		return {
			render: (width: number) => {
				if (cachedLines && cachedWidth === width) return cachedLines;
				const body: string[] = [];
				const end = Math.min(totalRows, scroll + maxVisibleOptions);
				for (let index = scroll; index < end; index++) {
					body.push(renderRow(index, width));
				}
				if (totalRows > maxVisibleOptions) {
					body.push(truncateToWidth(theme.fg("dim", `${scroll + 1}-${end} of ${totalRows}`), width));
				}
				const hint = formatSelectorHint(keybindings, [
					{ keybindings: ["tui.select.up", "tui.select.down"], description: "navigate", fallback: "up/down" },
					{ keybindings: "tui.select.confirm", description: "toggle", fallback: "enter" },
					{ keybindings: "tui.select.cancel", description: "cancel", fallback: "escape" },
				]);
				const lines = renderSelectorFrame(theme, width, {
					title: request.title,
					subtitle: splitMessage(request.message),
					body,
					hint: `${hint} · space also toggles`,
				});
				cachedWidth = width;
				cachedLines = lines;
				return lines;
			},
			handleInput: (data: string) => {
				if (keybindings.matches(data, "tui.select.up")) moveCursor(cursor - 1);
				else if (keybindings.matches(data, "tui.select.down")) moveCursor(cursor + 1);
				else if (matchesKey(data, Key.home)) moveCursor(0);
				else if (matchesKey(data, Key.end)) moveCursor(totalRows - 1);
				else if (keybindings.matches(data, "tui.select.confirm") || matchesKey(data, Key.space) || data === " ") toggleCurrent();
				else if (keybindings.matches(data, "tui.select.cancel")) done(undefined);
			},
			invalidate,
		};
	});
}

export async function pickGuiOption<T extends string>(
	ctx: UiContext,
	request: Omit<GuiOptionListRequest<T>, "selectionMode">,
): Promise<T | undefined> {
	const select = ctx.ui.select;
	if (typeof select !== "function") return undefined;
	const enabledOptions = request.options.filter((option) => !option.disabled);
	const labels = enabledOptions.map(fallbackLabel);
	const choice = await select(request.title, labels);
	if (!choice) return undefined;
	return enabledOptions[labels.indexOf(choice)]?.value;
}

export async function pickGuiOptions<T extends string>(
	ctx: UiContext,
	request: Omit<GuiOptionListRequest<T>, "selectionMode">,
): Promise<T[] | undefined> {
	const customChecklist = requestCustomChecklist(ctx, request);
	if (customChecklist) return customChecklist;

	const select = ctx.ui.select;
	if (typeof select !== "function") {
		ctx.ui.notify("This UI does not support multiple-choice option lists.", "warning");
		return undefined;
	}

	const enabledOptions = request.options.filter((option) => !option.disabled);
	const selected = new Set<T>(enabledOptions.filter((option) => option.checked).map((option) => option.value));
	while (true) {
		const labels = [
			...enabledOptions.map((option) => fallbackLabel({ ...option, checked: selected.has(option.value) })),
			"✓ Save selected",
			"✗ Cancel",
		];
		const choice = await select(request.title, labels);
		if (!choice) return undefined;
		const saveIndex = enabledOptions.length;
		const cancelIndex = enabledOptions.length + 1;
		const index = labels.indexOf(choice);
		if (index === saveIndex) return Array.from(selected);
		if (index === cancelIndex) return undefined;
		const option = enabledOptions[index];
		if (!option) continue;
		if (selected.has(option.value)) selected.delete(option.value);
		else selected.add(option.value);
	}
}
