import { describe, expect, it, vi } from "vitest";
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
