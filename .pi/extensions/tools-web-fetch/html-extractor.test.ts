import { describe, expect, it } from "vitest";
import { extractHeadingTitle, extractHTML, isLikelyJSRendered } from "./html-extractor.ts";

const url = "https://example.com/article";

describe("HTML extraction", () => {
	it("extracts a readable article as Markdown", () => {
		const body = "This is substantial article content with useful details. ".repeat(20);
		const html = `<html><head><title>Readable Title</title></head><body><main><article><h1>Heading</h1><p>${body}</p></article></main></body></html>`;
		const result = extractHTML(html, url);

		expect(result.error).toBeNull();
		expect(result.title).toContain("Readable Title");
		expect(result.content).toContain("# Heading");
		expect(result.content.length).toBeGreaterThanOrEqual(500);
	});

	it("reports incomplete content for a short readable article", () => {
		const html = "<html><head><title>Short</title></head><body><article><h1>Short</h1><p>Only a little content.</p></article></body></html>";
		const result = extractHTML(html, url);
		expect(result.error).toBe("Extracted content appears incomplete");
		expect(result.content).toContain("Only a little content");
	});

	it("distinguishes likely JavaScript-rendered pages", () => {
		const scripts = "<script></script>".repeat(4);
		const html = `<html><body><div id="app"></div>${scripts}</body></html>`;
		expect(isLikelyJSRendered(html)).toBe(true);
		expect(extractHTML(html, url).error).toBe("Page appears to be JavaScript-rendered (content loads dynamically)");
	});

	it("extracts and normalizes Markdown heading titles", () => {
		expect(extractHeadingTitle("text\n## **A Title**\nbody")).toBe("A Title");
		expect(extractHeadingTitle("plain text")).toBeNull();
	});
});
