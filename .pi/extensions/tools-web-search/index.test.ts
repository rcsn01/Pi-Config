import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import webSearchExtension from "./index.ts";

function theme() {
	return {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
		italic: (text: string) => text,
		strikethrough: (text: string) => text,
		underline: (text: string) => text,
	} as any;
}

function register() {
	let tool: any;
	webSearchExtension({ registerTool: (definition: any) => { tool = definition; } } as any);
	return tool;
}

afterEach(() => vi.unstubAllGlobals());

describe("Web Search tool", () => {
	it("keeps successful empty results distinct from request failures", async () => {
		const tool = register();
		vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, text: async () => "" })));
		const result = await tool.execute("call", { query: `empty-${Date.now()}` }, undefined);
		expect(result.content[0].text).toBe("No results found.");
		expect(result.details.resultCount).toBe(0);

		vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 503, text: async () => "" })));
		await expect(tool.execute("call", { query: `failed-${Date.now()}` }, undefined)).rejects.toThrow("HTTP 503");
	});

	it("renders collapsed, expanded, partial, and error states", () => {
		const tool = register();
		const result = {
			content: [{ type: "text", text: "1. Result\n   https://example.com\n   A useful snippet" }],
			details: { resultCount: 1 },
		};
		const collapsed = tool.renderResult(result, { expanded: false, isPartial: false }, theme(), { isError: false });
		expect(collapsed.render(80).join("\n")).toContain("✓ 1 result · expand to view");

		const expanded = tool.renderResult(result, { expanded: true, isPartial: false }, theme(), { isError: false });
		expect(expanded.render(80).join("\n")).toContain("A useful snippet");

		const partial = tool.renderResult(result, { expanded: false, isPartial: true }, theme(), { isError: false });
		expect(partial.render(80).join("\n")).toContain("⟳ Searching…");

		const error = tool.renderResult({ content: [{ type: "text", text: "network failed" }] }, { expanded: false, isPartial: false }, theme(), { isError: true });
		expect(error.render(80).join("\n")).toContain("✗ network failed");
	});

	it("keeps expanded lines width-safe", () => {
		const tool = register();
		const result = {
			content: [{ type: "text", text: "1. Result\n   https://example.com/a/very/long/path\n   A snippet that needs to wrap safely." }],
			details: { resultCount: 1 },
		};
		for (const width of [20, 40, 80, 120]) {
			const lines = tool.renderResult(result, { expanded: true, isPartial: false }, theme(), { isError: false }).render(width);
			expect(lines.every((line: string) => visibleWidth(line) <= width)).toBe(true);
		}
	});
});
