import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { makeThemeSpy, stripResets } from "./theme-spy.ts";
import {
	registerToolErrorHandler,
	renderToolMarkdown,
	renderToolSummary,
	toolStateGlyph,
	toolStateMarker,
	truncateToolLine,
	type ToolResultState,
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

	it("maps every state to the matching glyph and semantic token", () => {
		const expectations: Array<[ToolResultState, string, string]> = [
			["pending", "○", "dim"],
			["running", "⟳", "warning"],
			["success", "✓", "success"],
			["warning", "!", "warning"],
			["error", "✗", "error"],
		];
		for (const [state, glyph, token] of expectations) {
			const th = makeThemeSpy("dark");
			expect(toolStateMarker(th, state)).toBe(`${token}d(${glyph})`);
			const summary = renderToolSummary(th, state, "Message").render(80).join("\n");
			expect(summary).toContain(`${token}d(${glyph} )`);
			// Error/warning bodies use their state color; other states use tool output.
			const bodyToken = state === "error" || state === "warning" ? token : "toolOutput";
			expect(summary).toContain(`${bodyToken}d(Message)`);
		}
	});

	it("renders summaries and expanded Markdown without ANSI escapes", () => {
		const th = makeThemeSpy("light");
		const empty = renderToolSummary(th, "pending", "").render(40).join("\n");
		expect(empty).toContain("diml(○ )");
		const expandable = renderToolSummary(th, "success", "Done", true).render(80).join("\n");
		expect(expandable).toContain("successl(✓ )");
		expect(expandable).toContain("diml( · expand to view)");
		const markdown = renderToolMarkdown("# Result\n\nA **document**.", th).render(80).join("\n");
		expect(markdown).toContain("Result");
		expect(markdown).toContain("toolOutputl(");
		expect(stripResets(markdown)).not.toMatch(/\x1b\[/);
	});
});
