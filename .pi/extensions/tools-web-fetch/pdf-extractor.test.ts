import { beforeEach, describe, expect, it, vi } from "vitest";

const { getDocumentProxy } = vi.hoisted(() => ({ getDocumentProxy: vi.fn() }));
vi.mock("unpdf", () => ({ getDocumentProxy }));

import { extractPDF, isPDF } from "./pdf-extractor.ts";

describe("PDF extraction", () => {
	beforeEach(() => getDocumentProxy.mockReset());

	it.each([
		["https://example.com/document.pdf", undefined, true],
		["https://example.com/DOCUMENT.PDF?download=1", undefined, true],
		["https://example.com/download", "application/pdf; charset=binary", true],
		["https://example.com/document.html", "text/html", false],
		["not a url", undefined, false],
	])("detects PDF inputs", (url, contentType, expected) => {
		expect(isPDF(url, contentType)).toBe(expected);
	});

	it("uses metadata and normalizes page text", async () => {
		const getPage = vi.fn(async () => ({
			getTextContent: vi.fn(async () => ({ items: [{ str: "First" }, {}, { str: "  page" }] })),
		}));
		getDocumentProxy.mockResolvedValue({
			numPages: 1,
			getMetadata: vi.fn(async () => ({ info: { Title: "Metadata Title", Author: "An Author" } })),
			getPage,
		});

		const result = await extractPDF(new ArrayBuffer(2), "https://example.com/file_name.pdf");
		expect(result.title).toBe("Metadata Title");
		expect(result.content).toContain("> Author: An Author");
		expect(result.content).toContain("First page");
	});

	it("derives the title from the URL and caps extraction at 100 pages", async () => {
		const getPage = vi.fn(async (page: number) => ({
			getTextContent: vi.fn(async () => ({ items: [{ str: `Page ${page}` }] })),
		}));
		getDocumentProxy.mockResolvedValue({
			numPages: 101,
			getMetadata: vi.fn(async () => ({ info: {} })),
			getPage,
		});

		const result = await extractPDF(new ArrayBuffer(2), "https://example.com/file_name.pdf");
		expect(result.title).toBe("file name");
		expect(getPage).toHaveBeenCalledTimes(100);
		expect(result.content).toContain("extracted first 100");
		expect(result.content).toContain("Only first 100 of 101 pages extracted");
	});
});
