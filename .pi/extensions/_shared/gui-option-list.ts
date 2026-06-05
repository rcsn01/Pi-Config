import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

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

type CustomUiFactory<T> = (
	tui: { requestRender?: () => void },
	theme: {
		fg?: (color: string, text: string) => string;
		bg?: (color: string, text: string) => string;
		bold?: (text: string) => string;
	},
	keybindings: unknown,
	done: (value: T) => void,
) => { render: (width: number) => string[]; handleInput?: (data: string) => void; invalidate: () => void };

type UiContext = {
	hasUI?: boolean;
	ui: {
		custom?: <T>(factory: CustomUiFactory<T>, options?: unknown) => Promise<T>;
		select?: (title: string, options: string[]) => Promise<string | undefined>;
		notify?: (message: string, level?: string) => void;
		[key: string]: unknown;
	};
};

type GuiOptionListResponse<T extends string = string> =
	| { value?: T; values?: T[]; cancelled?: boolean }
	| T
	| T[]
	| undefined;

function normalizeResponse<T extends string>(response: GuiOptionListResponse<T>): T | T[] | undefined {
	if (!response) return undefined;
	if (typeof response === "string") return response as T;
	if (Array.isArray(response)) return response;
	if (response.cancelled) return undefined;
	if (Array.isArray(response.values)) return response.values;
	if (typeof response.value === "string") return response.value as T;
	return undefined;
}

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
	if (!ctx.hasUI || typeof custom !== "function") return undefined;

	return custom<T[] | undefined>((tui, theme, _keybindings, done) => {
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
		const style = (color: string, text: string) => theme.fg?.(color, text) ?? text;
		const bold = (text: string) => theme.bold?.(text) ?? text;
		const invalidate = () => {
			cachedWidth = undefined;
			cachedLines = undefined;
		};
		const renderRow = (index: number, width: number): string => {
			const active = index === cursor;
			let text: string;
			let disabled = false;

			if (index === saveIndex) {
				text = "✓ Save selected";
			} else if (index === cancelIndex) {
				text = "✗ Cancel";
			} else {
				const option = options[index]!;
				disabled = Boolean(option.disabled);
				const mark = selected.has(option.value) ? "●" : "○";
				const description = option.description ? ` — ${option.description}` : "";
				text = `${mark} ${option.label}${description}${disabled ? " (disabled)" : ""}`;
			}

			const prefix = active ? "› " : "  ";
			let line = truncateToWidth(prefix + text, width);
			if (disabled) line = style("dim", line);
			else if (active) line = style("accent", line);
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
			// Keep cursor unchanged so toggling does not jump back to the first item.
			invalidate();
			tui.requestRender?.();
		};
		const moveCursor = (next: number) => {
			cursor = clamp(next, 0, totalRows - 1);
			if (cursor < scroll) scroll = cursor;
			if (cursor >= scroll + maxVisibleOptions) scroll = cursor - maxVisibleOptions + 1;
			invalidate();
			tui.requestRender?.();
		};

		return {
			render: (width: number) => {
				if (cachedLines && cachedWidth === width) return cachedLines;
				const lines: string[] = [truncateToWidth(style("accent", bold(request.title)), width)];
				for (const line of splitMessage(request.message)) {
					lines.push(truncateToWidth(style("dim", line), width));
				}
				lines.push("");

				const end = Math.min(totalRows, scroll + maxVisibleOptions);
				for (let index = scroll; index < end; index++) {
					lines.push(renderRow(index, width));
				}
				if (totalRows > maxVisibleOptions) {
					lines.push(truncateToWidth(style("dim", `${scroll + 1}-${end} of ${totalRows}`), width));
				}
				lines.push("", truncateToWidth(style("dim", "↑↓ navigate • Space/Enter toggle • Save selected to apply • Esc cancel"), width));
				cachedWidth = width;
				cachedLines = lines;
				return lines;
			},
			handleInput: (data: string) => {
				if (matchesKey(data, Key.up)) moveCursor(cursor - 1);
				else if (matchesKey(data, Key.down)) moveCursor(cursor + 1);
				else if (matchesKey(data, Key.home)) moveCursor(0);
				else if (matchesKey(data, Key.end)) moveCursor(totalRows - 1);
				else if (matchesKey(data, Key.enter) || matchesKey(data, Key.space) || data === " ") toggleCurrent();
				else if (matchesKey(data, Key.escape)) done(undefined);
			},
			invalidate,
		};
	});
}

async function requestStructuredOptionList<T extends string>(
	ctx: UiContext,
	request: Required<Pick<GuiOptionListRequest<T>, "selectionMode">> & GuiOptionListRequest<T>,
): Promise<{ supported: boolean; result: T | T[] | undefined }> {
	const ui = ctx.ui as Record<string, unknown>;
	const payload = {
		method: request.selectionMode === "multiple" ? "checklist" : "optionList",
		title: request.title,
		message: request.message,
		selectionMode: request.selectionMode,
		options: request.options,
	};

	for (const methodName of ["request", "customRequest", "sendRequest"]) {
		const method = ui[methodName];
		if (typeof method !== "function") continue;
		const response = await (method as (payload: unknown) => Promise<GuiOptionListResponse<T>>)(payload);
		return { supported: true, result: normalizeResponse(response) };
	}

	return { supported: false, result: undefined };
}

export async function pickGuiOption<T extends string>(
	ctx: UiContext,
	request: Omit<GuiOptionListRequest<T>, "selectionMode">,
): Promise<T | undefined> {
	const structured = await requestStructuredOptionList(ctx, { ...request, selectionMode: "single" });
	if (structured.supported) {
		if (typeof structured.result === "string") return structured.result;
		if (Array.isArray(structured.result)) return structured.result[0];
		return undefined;
	}

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

	const structured = await requestStructuredOptionList(ctx, { ...request, selectionMode: "multiple" });
	if (structured.supported) {
		if (Array.isArray(structured.result)) return structured.result;
		if (typeof structured.result === "string") return [structured.result];
		return undefined;
	}

	const select = ctx.ui.select;
	if (typeof select !== "function") {
		ctx.ui.notify?.("This UI does not support multiple-choice option lists.", "warning");
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
