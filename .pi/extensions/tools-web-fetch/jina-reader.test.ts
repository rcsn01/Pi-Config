import { describe, expect, it, vi } from "vitest";
import { createJinaReader } from "./jina-reader.ts";

const url = "https://example.com/path/article";
const timeoutSignal = vi.fn(() => new AbortController().signal);

function jinaResponse(markdown: string, init: ResponseInit = {}): Response {
	return new Response(`Title: ignored\nMarkdown Content:\n${markdown}`, { status: 200, ...init });
}

describe("Jina reader", () => {
	it("extracts valid Markdown and its heading title", async () => {
		const markdown = `# Extracted Heading\n\n${"Useful content. ".repeat(10)}`;
		const fetch = vi.fn(async () => jinaResponse(markdown));
		const reader = createJinaReader({ fetch: fetch as typeof globalThis.fetch, timeoutSignal });

		await expect(reader(url)).resolves.toEqual({
			url,
			title: "Extracted Heading",
			content: markdown.trim(),
			error: null,
		});
		expect(fetch).toHaveBeenCalledWith(`https://r.jina.ai/${url}`, expect.objectContaining({
			headers: { Accept: "text/markdown", "X-No-Cache": "true" },
			signal: expect.any(AbortSignal),
		}));
		expect(timeoutSignal).toHaveBeenCalledWith(30000);
	});

	it("falls back to the final URL path for the title", async () => {
		const markdown = `No heading here. ${"content ".repeat(20)}`;
		const reader = createJinaReader({
			fetch: vi.fn(async () => jinaResponse(markdown)) as typeof globalThis.fetch,
			timeoutSignal,
		});
		expect((await reader(url))?.title).toBe("article");
	});

	it.each([
		new Response("missing marker", { status: 200 }),
		jinaResponse("too short"),
		jinaResponse(`Loading...${"x".repeat(120)}`),
		jinaResponse(`Please enable JavaScript${"x".repeat(120)}`),
		new Response("", { status: 503 }),
	])("returns null for unusable responses", async (response) => {
		const reader = createJinaReader({
			fetch: vi.fn(async () => response.clone()) as typeof globalThis.fetch,
			timeoutSignal,
		});
		expect(await reader(url)).toBeNull();
	});

	it("swallows fetch and abort failures", async () => {
		const reader = createJinaReader({
			fetch: vi.fn(async () => { throw new Error("aborted"); }) as typeof globalThis.fetch,
			timeoutSignal,
		});
		expect(await reader(url, new AbortController().signal)).toBeNull();
	});
});
