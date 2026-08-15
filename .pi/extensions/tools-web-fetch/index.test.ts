import { describe, expect, it, vi } from "vitest";
import type { FetchDocument, FetchResult } from "./fetch-document.ts";
import webFetchExtension, { registerWebFetchTool } from "./index.ts";

function register(fetchResult: FetchResult | Promise<FetchResult>) {
	let tool: any;
	const pi = { registerTool: vi.fn((definition) => { tool = definition; }) };
	const fetchDocument = vi.fn(async () => await fetchResult) as FetchDocument;
	registerWebFetchTool(pi as any, fetchDocument);
	return { pi, tool, fetchDocument };
}

const result: FetchResult = {
	url: "https://example.com/article",
	title: "Article",
	content: "Extracted content",
	error: null,
};

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

describe("Web Fetch tool registration", () => {
	it("preserves the registered tool interface", () => {
		const { pi, tool } = register(result);
		expect(pi.registerTool).toHaveBeenCalledOnce();
		expect(tool).toMatchObject({
			name: "ddg_fetch",
			label: "Web Fetch",
			description: "Fetch a web page and extract readable content as clean markdown. Uses Readability + Turndown for high-quality HTML→markdown conversion. Handles PDFs, plain text, and falls back to Jina Reader for JS-rendered pages.",
			promptSnippet: "Fetch web content",
			parameters: {
				type: "object",
				properties: {
					url: { type: "string", description: "URL to fetch" },
					max_chars: {
						type: "number",
						description: "Maximum characters to return (default: no extra truncation)",
						minimum: 1000,
					},
				},
				required: ["url"],
			},
		});
	});

	it("preserves the default index.ts extension entrypoint", () => {
		const pi = { registerTool: vi.fn() };
		webFetchExtension(pi as any);
		expect(pi.registerTool).toHaveBeenCalledOnce();
		expect(pi.registerTool.mock.calls[0][0]).toMatchObject({ name: "ddg_fetch" });
	});

	it("adapts successful extraction and truncation without changing details", async () => {
		const longResult = { ...result, content: "x".repeat(2000) };
		const { tool, fetchDocument } = register(longResult);
		const output = await tool.execute("call", { url: result.url, max_chars: 1000 }, new AbortController().signal);

		expect(fetchDocument).toHaveBeenCalledWith(result.url, expect.any(AbortSignal));
		expect(output.content[0].text.startsWith("# Article\n\nSource: https://example.com/article\n\n---\n\n")).toBe(true);
		expect(output.content[0].text).toContain("[truncated 1053 chars]");
		expect(output.details).toEqual({
			url: result.url,
			title: "Article",
			chars: 2000,
			returnedChars: output.content[0].text.length,
			truncated: true,
		});
	});

	it("prefixes extraction errors with the requested URL", async () => {
		const { tool } = register({ ...result, error: "HTTP 500: Failure" });
		await expect(tool.execute("call", { url: result.url }, new AbortController().signal))
			.rejects.toThrow(`${result.url}: HTTP 500: Failure`);
	});

	it("preserves call and result rendering thresholds", () => {
		const { tool } = register(result);
		const longUrl = `https://example.com/${"a".repeat(80)}`;
		const call = tool.renderCall({ url: longUrl }, theme, { lastComponent: undefined });
		expect(call.render(120).join("\n")).toContain("...");

		const collapsed = tool.renderResult(
			{ content: [{ type: "text", text: "x".repeat(600) }], details: { title: "Article", chars: 600 } },
			{ expanded: false, isPartial: false },
			theme,
			{ lastComponent: undefined, isError: false },
		);
		expect(collapsed.render(120).join("\n")).toContain("Article (600 chars)");

		const expanded = tool.renderResult(
			{ content: [{ type: "text", text: "x".repeat(600) }], details: { title: "Article", chars: 600 } },
			{ expanded: true, isPartial: false },
			theme,
			{ lastComponent: undefined, isError: false },
		);
		expect(expanded.render(1000).join("\n")).toContain(`${"x".repeat(500)}...`);
	});
});
