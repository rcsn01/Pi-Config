import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import workflowExtension from "./index.ts";

function theme() {
	return {
		fg: (_color: string, text: string) => text,
		bg: (_color: string, text: string) => text,
		bold: (text: string) => text,
		italic: (text: string) => text,
		strikethrough: (text: string) => text,
		underline: (text: string) => text,
	} as any;
}

function renderer() {
	let registered: any;
	workflowExtension({
		on: () => undefined,
		registerCommand: () => undefined,
		registerMessageRenderer: (_type: string, render: any) => { registered = render; },
	} as any);
	return registered;
}

describe("workflow transcript rendering", () => {
	it("renders a compact success summary and expanded metadata", () => {
		const render = renderer();
		const collapsed = render({
			content: "# Final output\n\nDone.",
			details: { workflow: "deep-research", runId: "run-1", background: true },
		}, { expanded: false }, theme());
		const expanded = render({
			content: "# Final output\n\nDone.",
			details: { workflow: "deep-research", runId: "run-1", background: true },
		}, { expanded: true }, theme());

		expect(collapsed.render(80).join("\n")).toContain("deep-research completed · expand to view");
		expect(collapsed.render(80).join("\n")).not.toContain("Final output");
		expect(expanded.render(80).join("\n")).toContain("Final output");
		expect(expanded.render(80).join("\n")).toContain("mode: background");
	});

	it("normalizes array custom-message content", () => {
		const render = renderer();
		const component = render({
			content: [{ type: "text", text: "# Array result" }, { type: "text", text: "Done." }],
			details: { workflow: "example" },
		}, { expanded: true }, theme());
		expect(component.render(80).join("\\n")).toContain("Array result");
		expect(component.render(80).join("\\n")).toContain("Done.");
	});

	it("keeps card lines width-safe", () => {
		const render = renderer();
		for (const width of [20, 40, 80, 120]) {
			const lines = render({ content: "A long output with a URL https://example.com/a/very/long/path", details: {} }, { expanded: true }, theme()).render(width);
			expect(lines.every((line: string) => visibleWidth(line) <= width)).toBe(true);
		}
	});
});
