import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { pickSelectScreen } from "./select-screen.ts";

function theme() {
	return {
		fg: vi.fn((_color: string, text: string) => text),
		bold: vi.fn((text: string) => text),
	} as any;
}

function keybindings(bindings: Record<string, string> = {
	k: "tui.select.up",
	j: "tui.select.down",
	y: "tui.select.confirm",
	x: "tui.select.cancel",
}) {
	return {
		matches: (data: string, id: string) => bindings[data] === id,
		getKeys: (id: string) => Object.entries(bindings)
			.filter(([, binding]) => binding === id)
			.map(([key]) => key),
	} as any;
}

function harness() {
	let component: any;
	const tui = { requestRender: vi.fn() };
	const currentTheme = theme();
	const keys = keybindings();
	const ctx = {
		mode: "tui",
		ui: {
			custom: vi.fn((builder: any) => new Promise((resolve) => {
				component = builder(tui, currentTheme, keys, resolve);
			})),
		},
	} as any;
	return { ctx, tui, theme: currentTheme, keys, component: () => component };
}

const items = [
	{ value: "alpha", label: "Alpha", description: "First", searchText: "one" },
	{ value: "beta", label: "Beta", description: "Second", searchText: "two" },
	{ value: "gamma", label: "Gamma", description: "Third", searchText: "three" },
] as const;

describe("pickSelectScreen", () => {
	it("renders the shared frame, current marker, and configured hints", async () => {
		const h = harness();
		const pending = pickSelectScreen(h.ctx, {
			title: "Select item",
			items,
			currentValue: "beta",
			showCurrentMarker: true,
		});
		const component = h.component();
		const lines = component.render(80);
		expect(lines.some((line: string) => line.startsWith("→ ● Beta"))).toBe(true);
		expect(lines.join("\n")).toContain("k/j navigate · y select · x cancel");
		expect(h.theme.fg).toHaveBeenCalledWith("border", expect.any(String));
		component.handleInput("y");
		await expect(pending).resolves.toBe("beta");
	});

	it("supports navigation, cancellation, and wizard verbs", async () => {
		const selectedHarness = harness();
		const selected = pickSelectScreen(selectedHarness.ctx, {
			title: "Choose",
			items,
			confirmVerb: "next",
			cancelVerb: "back",
		});
		const component = selectedHarness.component();
		expect(component.render(60).join("\n")).toContain("y next · x back");
		component.handleInput("j");
		component.handleInput("y");
		await expect(selected).resolves.toBe("beta");

		const cancelledHarness = harness();
		const cancelled = pickSelectScreen(cancelledHarness.ctx, { title: "Choose", items });
		cancelledHarness.component().handleInput("x");
		await expect(cancelled).resolves.toBeUndefined();
	});

	it("filters, preserves selection when possible, and supports custom ordering", async () => {
		const h = harness();
		const pending = pickSelectScreen(h.ctx, {
			title: "Search",
			items,
			currentValue: "beta",
			search: {
				filter: (choices, query) => query === "g" ? [choices[2]!] : choices,
			},
		});
		const component = h.component();
		component.focused = true;
		component.handleInput("g");
		expect(component.render(40).join("\n")).toContain("Gamma");
		component.handleInput("y");
		await expect(pending).resolves.toBe("gamma");
	});

	it("keeps every line within narrow terminal widths", () => {
		for (const width of [1, 8, 20, 40, 80, 120]) {
			const h = harness();
			void pickSelectScreen(h.ctx, {
				title: "A long searchable selector title",
				subtitle: "A long subtitle",
				items,
				search: {},
			});
			expect(h.component().render(width).every((line: string) => visibleWidth(line) <= width)).toBe(true);
		}
	});

	it("does not open custom UI outside TUI mode", async () => {
		const custom = vi.fn();
		await expect(pickSelectScreen({ mode: "rpc", ui: { custom } } as any, {
			title: "Choose",
			items,
		})).resolves.toBeUndefined();
		expect(custom).not.toHaveBeenCalled();
	});
});
