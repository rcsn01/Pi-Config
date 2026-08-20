import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Input, SelectList, type SelectListLayoutOptions, truncateToWidth } from "@earendil-works/pi-tui";
import {
	createSelectListTheme,
	fitUiLines,
	renderSelectorFrame,
	selectorHint,
	UI_GLYPHS,
} from "./ui-style.ts";

export interface SelectScreenItem<T extends string = string> {
	value: T;
	label: string;
	description?: string;
	searchText?: string;
}

export interface SelectScreenRequest<T extends string = string> {
	title: string;
	subtitle?: string | readonly string[];
	items: readonly SelectScreenItem<T>[];
	currentValue?: T;
	showCurrentMarker?: boolean;
	search?: {
		initialQuery?: string;
		filter?: (
			items: readonly SelectScreenItem<T>[],
			query: string,
		) => readonly SelectScreenItem<T>[];
	};
	maxVisibleRows?: number;
	columns?: SelectListLayoutOptions;
	confirmVerb?: "select" | "next" | "apply";
	cancelVerb?: "cancel" | "back" | "close";
}

function defaultFilter<T extends string>(
	items: readonly SelectScreenItem<T>[],
	query: string,
): SelectScreenItem<T>[] {
	const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
	if (terms.length === 0) return [...items];
	return items.filter((item) => {
		const searchable = `${item.label} ${item.description ?? ""} ${item.searchText ?? ""}`.toLowerCase();
		return terms.every((term) => searchable.includes(term));
	});
}

export async function pickSelectScreen<T extends string>(
	ctx: Pick<ExtensionContext, "mode" | "ui">,
	request: SelectScreenRequest<T>,
): Promise<T | undefined> {
	if (ctx.mode !== "tui") return undefined;

	return ctx.ui.custom<T | undefined>((tui, theme, keybindings, done) => {
		const input = request.search ? new Input() : undefined;
		if (input) input.setValue(request.search?.initialQuery ?? "");
		let visibleItems: readonly SelectScreenItem<T>[] = [];
		let selectedIndex = 0;
		let list: SelectList;

		const displayItems = (items: readonly SelectScreenItem<T>[]) => items.map((item) => ({
			value: item.value,
			label: request.showCurrentMarker
				? `${item.value === request.currentValue ? UI_GLYPHS.checked : UI_GLYPHS.unchecked} ${item.label}`
				: item.label,
			description: item.description,
		}));

		const rebuildList = (preferredValue?: T) => {
			const query = input?.getValue() ?? "";
			const filter = request.search?.filter ?? defaultFilter<T>;
			visibleItems = request.search ? filter(request.items, query) : request.items;
			const preferredIndex = preferredValue === undefined
				? -1
				: visibleItems.findIndex((item) => item.value === preferredValue);
			const currentIndex = request.currentValue === undefined
				? -1
				: visibleItems.findIndex((item) => item.value === request.currentValue);
			selectedIndex = preferredIndex >= 0 ? preferredIndex : currentIndex >= 0 ? currentIndex : 0;
			list = new SelectList(
				displayItems(visibleItems),
				Math.min(Math.max(visibleItems.length, 1), request.maxVisibleRows ?? 12),
				createSelectListTheme(theme),
				request.columns,
			);
			list.setSelectedIndex(selectedIndex);
		};

		rebuildList(request.currentValue);

		const moveSelection = (offset: number) => {
			if (visibleItems.length === 0) return;
			selectedIndex = (selectedIndex + offset + visibleItems.length) % visibleItems.length;
			list.setSelectedIndex(selectedIndex);
			tui.requestRender();
		};

		return {
			get focused() {
				return input?.focused ?? false;
			},
			set focused(value: boolean) {
				if (input) input.focused = value;
			},
			render(width: number) {
				const safeWidth = Math.max(1, width);
				const body: string[] = [];
				if (input) {
					body.push(...fitUiLines(input.render(safeWidth), safeWidth), "");
				}
				if (visibleItems.length === 0 && request.search) {
					body.push(theme.fg("muted", "No matches"));
				} else {
					body.push(...fitUiLines(list.render(safeWidth), safeWidth));
				}
				return renderSelectorFrame(theme, safeWidth, {
					title: request.title,
					subtitle: request.subtitle,
					body,
					hint: selectorHint(keybindings, {
						searchable: Boolean(input),
						confirmVerb: request.confirmVerb,
						cancelVerb: request.cancelVerb,
					}),
				});
			},
			invalidate() {
				input?.invalidate();
				list.invalidate();
			},
			handleInput(data: string) {
				if (keybindings.matches(data, "tui.select.up")) {
					moveSelection(-1);
					return;
				}
				if (keybindings.matches(data, "tui.select.down")) {
					moveSelection(1);
					return;
				}
				if (keybindings.matches(data, "tui.select.confirm")) {
					const selected = visibleItems[selectedIndex];
					if (selected) done(selected.value);
					return;
				}
				if (keybindings.matches(data, "tui.select.cancel")) {
					done(undefined);
					return;
				}
				if (!input) return;
				const previousValue = visibleItems[selectedIndex]?.value;
				const before = input.getValue();
				input.handleInput(data);
				if (input.getValue() !== before) rebuildList(previousValue);
				tui.requestRender();
			},
		};
	});
}
