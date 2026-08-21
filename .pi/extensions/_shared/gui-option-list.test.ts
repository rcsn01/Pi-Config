import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { pickGuiOption, pickGuiOptions } from "./gui-option-list.ts";

function theme() {
	return {
		fg: vi.fn((_color: string, text: string) => text),
		bold: vi.fn((text: string) => text),
	} as any;
}

function keybindings() {
	const bindings: Record<string, string> = {
		k: "tui.select.up",
		j: "tui.select.down",
		y: "tui.select.confirm",
		x: "tui.select.cancel",
	};
	return {
		matches: (data: string, id: string) => bindings[data] === id,
		getKeys: (id: string) => Object.entries(bindings)
			.filter(([, binding]) => binding === id)
			.map(([key]) => key),
	} as any;
}

function tuiHarness(script: (component: any) => void) {
	const currentTheme = theme();
	const ctx = {
		hasUI: true,
		mode: "tui",
		ui: {
			custom: vi.fn((builder: any) => new Promise((resolve) => {
				const component = builder({ requestRender: vi.fn() }, currentTheme, keybindings(), resolve);
				script(component);
			})),
			notify: vi.fn(),
		},
	} as any;
	return { ctx, theme: currentTheme };
}

const options = [
	{ value: "alpha", label: "Alpha", checked: true },
	{ value: "beta", label: "Beta" },
	{ value: "locked", label: "Locked", disabled: true },
] as const;

describe("GUI option list", () => {
	it("uses the shared frame and configured checklist controls", async () => {
		const h = tuiHarness((component) => {
			const lines = component.render(80);
			expect(lines).toContain("→ ● Alpha");
			expect(lines.join("\n")).toContain("k/j navigate · y toggle · x cancel · space also toggles");
			for (const width of [1, 8, 20, 40, 80, 120]) {
				expect(component.render(width).every((line: string) => visibleWidth(line) <= width)).toBe(true);
			}
			component.handleInput("y");
			component.handleInput("j");
			component.handleInput("y");
			component.handleInput("j");
			component.handleInput("j");
			component.handleInput("y");
		});
		await expect(pickGuiOptions(h.ctx, { title: "Choose options", options: [...options] }))
			.resolves.toEqual(["beta"]);
		expect(h.theme.fg).toHaveBeenCalledWith("border", expect.any(String));
	});

	it("does not toggle disabled checklist options", async () => {
		const h = tuiHarness((component) => {
			component.handleInput("j");
			component.handleInput("j");
			component.handleInput("y");
			component.handleInput("j");
			component.handleInput("y");
		});
		await expect(pickGuiOptions(h.ctx, { title: "Choose options", options: [...options] }))
			.resolves.toEqual(["alpha"]);
	});

	it("renders a non-selectable spacer before a single-choice option group", async () => {
		const h = tuiHarness((component) => {
			const lines = component.render(80);
			const addIndex = lines.indexOf("    Add profile");
			expect(addIndex).toBeGreaterThan(0);
			expect(lines[addIndex - 1]).toBe("");
			for (const width of [1, 8, 20, 40, 80, 120]) {
				expect(component.render(width).every((line: string) => visibleWidth(line) <= width)).toBe(true);
			}

			component.handleInput("j");
			component.handleInput("j");
			component.handleInput("y");
		});
		await expect(pickGuiOption(h.ctx, {
			title: "Choose profile",
			options: [
				{ value: "default", label: "default", checked: true },
				{ value: "focused", label: "focused" },
				{ value: "add", label: "Add profile", spacerBefore: true },
				{ value: "delete", label: "Delete profile" },
			],
		})).resolves.toBe("add");
	});

	it("uses native select for RPC checklists", async () => {
		const select = vi.fn(async (_title: string, choices: string[]) => choices[choices.length - 2]!);
		const custom = vi.fn();
		const ctx = {
			hasUI: true,
			mode: "rpc",
			ui: { select, custom, notify: vi.fn() },
		} as any;
		await expect(pickGuiOptions(ctx, { title: "Choose options", options: [...options] }))
			.resolves.toEqual(["alpha"]);
		expect(select).toHaveBeenCalled();
		expect(custom).not.toHaveBeenCalled();
	});

	it("uses native select for single-choice selection", async () => {
		const select = vi.fn(async (_title: string, choices: string[]) => choices[1]!);
		const ctx = {
			hasUI: true,
			mode: "rpc",
			ui: { select },
		} as any;
		await expect(pickGuiOption(ctx, { title: "Choose one", options: [...options] }))
			.resolves.toBe("beta");
		expect(select).toHaveBeenCalledWith("Choose one", ["● Alpha (current)", "  Beta"]);
	});

	it("renders disabled rows dim and refreshes cached lines after invalidation", async () => {
		const currentTheme = theme();
		const ctx = {
			hasUI: true,
			mode: "tui",
			ui: {
				custom: vi.fn((builder: any) => new Promise((resolve) => {
					const component = builder({ requestRender: vi.fn() }, currentTheme, keybindings(), resolve);
					currentTheme.fg.mockImplementation((color: string, text: string) => `${color}<${text}>`);
					const first = component.render(80).join("\n");
					expect(first).toContain("dim<  ○ Locked (disabled)>");
					expect(first).toContain("accent<→ ● Alpha>");

					currentTheme.fg.mockImplementation((color: string, text: string) => `[${color}]${text}`);
					component.invalidate();
					const second = component.render(80).join("\n");
					expect(second).toContain("[dim]  ○ Locked (disabled)");
					expect(second).not.toContain("dim<  ○ Locked (disabled)>");

					component.handleInput("x");
				})),
				notify: vi.fn(),
			},
		} as any;
		await expect(pickGuiOptions(ctx, { title: "Choose options", options: [...options] }))
			.resolves.toBeUndefined();
	});
});
