import { describe, expect, it } from "vitest";
import { extractRSCContent } from "./rsc-extractor.ts";

function rscPage(chunks: Array<[string, unknown]>, title = "Docs | Site"): string {
	const flight = chunks.map(([id, node]) => `${id}:${JSON.stringify(node)}`).join("\n");
	const encoded = JSON.stringify(flight).slice(1, -1);
	return `<html><head><title>${title}</title></head><body><script>self.__next_f.push([1,"${encoded}"])</script></body></html>`;
}

function paragraph(text: string): unknown {
	return ["$", "p", null, { children: text }];
}

describe("RSC extraction", () => {
	it("returns null when no flight payload is present", () => {
		expect(extractRSCContent("<html><body>plain</body></html>")).toBeNull();
	});

	it("prefers main chunk 23 and converts React nodes to Markdown", () => {
		const body = "Main documentation content ".repeat(8);
		const html = rscPage([
			["23", ["$", "article", null, { children: [
				["$", "h1", null, { children: "Main Heading" }],
				paragraph(body),
				["$", "a", null, { href: "https://example.com/more", children: "More" }],
			] }]],
			["2", paragraph("Fallback content that should not replace the preferred main chunk. ".repeat(3))],
		]);

		expect(extractRSCContent(html)).toEqual({
			title: "Docs",
			content: expect.stringContaining("# Main Heading"),
		});
		expect(extractRSCContent(html)?.content).toContain("[More](https://example.com/more)");
	});

	it("orders fallback chunks by hexadecimal id and filters not-found content", () => {
		const first = `First valid fallback ${"a".repeat(120)}`;
		const second = `Second valid fallback ${"b".repeat(120)}`;
		const html = rscPage([
			["a", paragraph(second)],
			["2", paragraph(first)],
			["3", paragraph(`404 page was not found ${"c".repeat(120)}`)],
		]);
		const result = extractRSCContent(html);

		expect(result?.content.indexOf("First valid")).toBeLessThan(result?.content.indexOf("Second valid") ?? 0);
		expect(result?.content).not.toContain("page was not found");
	});

	it("follows references without recursing forever", () => {
		const referenced = paragraph(`Referenced content ${"x".repeat(120)}`);
		const html = rscPage([
			["23", ["$", "article", null, { children: "$L2" }]],
			["2", referenced],
		]);
		expect(extractRSCContent(html)?.content).toContain("Referenced content");
	});

	it("ignores malformed flight data", () => {
		const html = '<script>self.__next_f.push([1,"not-json\\x"])</script>';
		expect(extractRSCContent(html)).toBeNull();
	});
});
