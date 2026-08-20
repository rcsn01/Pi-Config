import { describe, expect, it, vi } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import todoExtension from "./index.ts";

function theme() {
	return {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
		italic: (text: string) => text,
		strikethrough: (text: string) => text,
		underline: (text: string) => text,
	};
}

function toolDefinition() {
	let tool: any;
	todoExtension({
		on: vi.fn(),
		registerTool: (definition: any) => { tool = definition; },
		registerCommand: vi.fn(),
	} as any);
	return tool;
}

describe("todo tool rendering", () => {
	it("marks invalid updates as errors", async () => {
		const tool = toolDefinition();
		const result = await tool.execute("call", {
			todos: [
				{ id: "1", text: "One", status: "in_progress" },
				{ id: "2", text: "Two", status: "in_progress" },
			],
		}, undefined, undefined, {} as any);
		expect(result).toMatchObject({ isError: true, details: { error: expect.stringContaining("at most one") } });
	});

	it("uses compact summaries and a single cancellation glyph", () => {
		const tool = toolDefinition();
		const result = {
			content: [{ type: "text", text: "+1 added (1 items)" }],
			details: {
				todos: [{ id: "1", text: "Cancelled item", status: "cancelled" }],
				nextId: "2",
				summary: "+1 added",
			},
		};
		const collapsed = tool.renderResult(result, { expanded: false, isPartial: false }, theme(), { isError: false });
		expect(collapsed.render(80).join("\n")).toContain("✓ +1 added · expand to view");
		const expanded = tool.renderResult(result, { expanded: true, isPartial: false }, theme(), { isError: false });
		const output = expanded.render(80).join("\n");
		expect(output).toContain("✗ #1 Cancelled item");
		expect(output).not.toContain("✗ #1 ✗");
	});
});

describe("todo widget", () => {
	it("renders a themed, width-safe summary while todos are active", async () => {
		const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
		let tool: any;
		const setWidget = vi.fn();
		todoExtension({
			on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(event, handler),
			registerTool: (definition: any) => { tool = definition; },
			registerCommand: vi.fn(),
		} as any);
		const ctx = {
			hasUI: true,
			ui: { setWidget },
			sessionManager: { getBranch: () => [] },
		} as any;

		await tool.execute("call", {
			todos: [
				{ id: "1", text: "A very long todo item that must be truncated when the terminal is narrow", status: "pending" },
				{ id: "2", text: "Second item", status: "in_progress" },
			],
		}, undefined, undefined, {} as any);

		await handlers.get("turn_end")!({}, ctx);
		expect(setWidget).toHaveBeenCalledWith("todo-list", expect.any(Function));

		const factory = setWidget.mock.calls.at(-1)?.[1];
		const widget = factory({}, theme());
		for (const width of [20, 40, 80]) {
			const lines = widget.render(width);
			expect(lines.length).toBeGreaterThan(0);
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}

		const output = widget.render(80).join("\n");
		expect(output).toContain("Todos");
		expect(output).toContain("1 pending");
		expect(output).toContain("1 active");
		expect(output).toContain("#1");
		expect(output).toContain("#2");
	});

	it("clears the widget when no todos are active", async () => {
		const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
		const setWidget = vi.fn();
		todoExtension({
			on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(event, handler),
			registerTool: vi.fn(),
			registerCommand: vi.fn(),
		} as any);
		const ctx = {
			hasUI: true,
			ui: { setWidget },
			sessionManager: { getBranch: () => [] },
		} as any;

		await handlers.get("turn_end")!({}, ctx);
		expect(setWidget).toHaveBeenCalledWith("todo-list", undefined);
	});
});
