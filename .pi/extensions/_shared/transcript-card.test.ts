import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { renderTranscriptCard } from "./transcript-card.ts";

function theme() {
	const fg = vi.fn((_color: string, text: string) => text);
	const bg = vi.fn((_color: string, text: string) => text);
	return {
		fg,
		bg,
		bold: (text: string) => text,
		italic: (text: string) => text,
		strikethrough: (text: string) => text,
		underline: (text: string) => text,
	};
}

describe("transcript cards", () => {
	it("renders a padded themed card with Markdown and expanded metadata", () => {
		const th = theme();
		const card = renderTranscriptCard(th as any, {
			title: "Workflow result",
			state: "success",
			body: "## Completed\n\nUse **Markdown**.",
			metadata: ["workflow: example", "run: abc"],
			expanded: true,
		});

		const output = card.render(80).join("\n");
		expect(output).toContain("✓ Workflow result");
		expect(output).toContain("Completed");
		expect(output).toContain("Markdown");
		expect(output).toContain("workflow: example");
		expect(th.bg).toHaveBeenCalledWith("customMessageBg", expect.any(String));
		expect(th.fg).toHaveBeenCalledWith("success", expect.any(String));
		expect(th.fg).toHaveBeenCalledWith("customMessageText", expect.any(String));
	});

	it("uses a compact summary when collapsed and omits expanded metadata", () => {
		const th = theme();
		const output = renderTranscriptCard(th as any, {
			title: "Proposed Plan",
			body: "A long plan body",
			summary: "Plan ready · expand to view",
			metadata: ["created 2026-01-01"],
			expanded: false,
		}).render(80).join("\n");

		expect(output).toContain("Proposed Plan");
		expect(output).toContain("Plan ready · expand to view");
		expect(output).not.toContain("A long plan body");
		expect(output).not.toContain("created 2026-01-01");
	});

	it("keeps every rendered line within narrow and normal widths", () => {
		for (const width of [20, 40, 80, 120]) {
			const lines = renderTranscriptCard(theme() as any, {
				title: "A very long transcript heading",
				state: "error",
				body: "A paragraph with a long unbroken value: https://example.com/this/is/a/long/path.",
				metadata: ["reason: a long diagnostic explanation that should wrap safely"],
				expanded: true,
			}).render(width);
			expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
		}
	});
});
