import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import {
	createSelectListTheme,
	formatSelectorHint,
	renderSelectorFrame,
	selectorHint,
} from "./ui-style.ts";

function testTheme() {
	const fg = vi.fn((_color: string, text: string) => text);
	return {
		fg,
		bold: vi.fn((text: string) => text),
	} as any;
}

const keybindings = {
	getKeys: (id: string) => ({
		"tui.select.up": ["k"],
		"tui.select.down": ["j"],
		"tui.select.confirm": ["y"],
		"tui.select.cancel": ["x"],
	}[id] ?? []),
} as any;

describe("shared UI style", () => {
	it("uses semantic selector colors", () => {
		const theme = testTheme();
		const listTheme = createSelectListTheme(theme);
		listTheme.selectedText("selected");
		listTheme.description("description");
		listTheme.scrollInfo("scroll");
		listTheme.noMatch("empty");
		expect(theme.fg).toHaveBeenCalledWith("accent", "selected");
		expect(theme.fg).toHaveBeenCalledWith("muted", "description");
		expect(theme.fg).toHaveBeenCalledWith("dim", "scroll");
		expect(theme.fg).toHaveBeenCalledWith("muted", "empty");
	});

	it("renders a neutral width-safe selector frame", () => {
		const theme = testTheme();
		for (const width of [1, 8, 20, 40, 80, 120]) {
			const lines = renderSelectorFrame(theme, width, {
				title: "A long selector title",
				subtitle: "A long selector subtitle",
				body: ["A body line that may be too long"],
				hint: "k/j navigate · y select · x cancel",
			});
			expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
		}
		expect(theme.fg).toHaveBeenCalledWith("border", expect.any(String));
		expect(theme.fg).not.toHaveBeenCalledWith("accent", expect.stringMatching(/^─+$/));
		expect(theme.bold).toHaveBeenCalledWith("A long selector title");
	});

	it("formats hints from configured keybindings", () => {
		expect(formatSelectorHint(keybindings, [
			{ keybindings: ["tui.select.up", "tui.select.down"], description: "navigate", fallback: "up/down" },
			{ keybindings: "tui.select.confirm", description: "apply", fallback: "enter" },
		])).toBe("k/j navigate · y apply");
		expect(selectorHint(keybindings, { searchable: true, confirmVerb: "next", cancelVerb: "back" }))
			.toBe("type to filter · k/j navigate · y next · x back");
	});
});
