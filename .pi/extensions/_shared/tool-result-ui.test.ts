import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import {
	registerToolErrorHandler,
	renderToolMarkdown,
	renderToolSummary,
	toolStateGlyph,
	truncateToolLine,
} from "./tool-result-ui.ts";

function theme() {
	const fg = vi.fn((_color: string, text: string) => text);
	return {
		fg,
		bold: (text: string) => text,
		italic: (text: string) => text,
		strikethrough: (text: string) => text,
		underline: (text: string) => text,
	};
}

describe("tool result UI helpers", () => {
	it("bridges semantic failures to Pi's tool-result error flag", () => {
		let handler: ((event: any) => unknown) | undefined;
		registerToolErrorHandler({ on: vi.fn((_type: string, next: any) => { handler = next; }) } as any, ["example"], (event) =>
			event.content[0]?.text === "failed",
		);
		expect(handler?.({ toolName: "example", content: [{ type: "text", text: "failed" }], details: {}, isError: false }))
			.toEqual({ isError: true });
		expect(handler?.({ toolName: "other", content: [{ type: "text", text: "failed" }], details: {}, isError: false }))
			.toBeUndefined();
	});

	it("uses the shared semantic state glyphs", () => {
		expect(toolStateGlyph("pending")).toBe("○");
		expect(toolStateGlyph("running")).toBe("⟳");
		expect(toolStateGlyph("success")).toBe("✓");
		expect(toolStateGlyph("error")).toBe("✗");
	});

	it("styles summaries with the matching semantic token", () => {
		const th = theme();
		const output = renderToolSummary(th as any, "success", "Done", true).render(80).join("\n");
		expect(output).toContain("✓ Done · expand to view");
		expect(th.fg).toHaveBeenCalledWith("success", expect.any(String));
		expect(th.fg).toHaveBeenCalledWith("toolOutput", "Done");
	});

	it("renders expanded Markdown with tool output colors", () => {
		const th = theme();
		const output = renderToolMarkdown("# Result\n\nA **document**.", th as any).render(80).join("\n");
		expect(output).toContain("Result");
		expect(output).toContain("document");
		expect(th.fg).toHaveBeenCalledWith("toolOutput", expect.any(String));
	});

	it("truncates ANSI-aware previews to the requested width", () => {
		for (const width of [20, 40, 80, 120]) {
			const line = truncateToolLine("A very long preview that must fit the terminal width", width);
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});
});
