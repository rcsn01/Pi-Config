import type { FetchResult } from "./fetch-document.ts";

export function isPDF(url: string, contentType?: string): boolean {
	if (contentType?.includes("application/pdf")) return true;
	try {
		return new URL(url).pathname.toLowerCase().endsWith(".pdf");
	} catch {
		return false;
	}
}

export async function extractPDF(buffer: ArrayBuffer, url: string): Promise<FetchResult> {
	const { getDocumentProxy } = await import("unpdf");
	const pdf = await getDocumentProxy(new Uint8Array(buffer));

	const metadata = await pdf.getMetadata();
	const metadataInfo =
		metadata.info && typeof metadata.info === "object"
			? (metadata.info as Record<string, unknown>)
			: null;

	const metaTitle = typeof metadataInfo?.Title === "string" ? metadataInfo.Title.trim() : "";
	const metaAuthor = typeof metadataInfo?.Author === "string" ? metadataInfo.Author.trim() : "";

	let urlTitle = "document";
	try {
		const { basename } = await import("node:path");
		urlTitle = basename(new URL(url).pathname, ".pdf").replace(/[_-]+/g, " ").trim() || "document";
	} catch {
		// Keep the generic fallback title for malformed URLs.
	}
	const title = metaTitle || urlTitle;

	const maxPages = Math.min(pdf.numPages, 100);
	const pages: string[] = [];
	for (let i = 1; i <= maxPages; i++) {
		const page = await pdf.getPage(i);
		const textContent = await page.getTextContent();
		const pageText = textContent.items
			.map((item: unknown) => (item as { str?: string }).str || "")
			.join(" ")
			.replace(/\s+/g, " ")
			.trim();
		if (pageText) pages.push(pageText);
	}

	const lines: string[] = [
		`# ${title}`,
		"",
		`> Source: ${url}`,
		`> Pages: ${pdf.numPages}${pdf.numPages > maxPages ? ` (extracted first ${maxPages})` : ""}`,
	];
	if (metaAuthor) lines.push(`> Author: ${metaAuthor}`);
	lines.push("", "---", "");
	lines.push(pages.join("\n\n"));

	if (pdf.numPages > maxPages) {
		lines.push("", "---", "", `*[Truncated: Only first ${maxPages} of ${pdf.numPages} pages extracted]*`);
	}

	return { url, title, content: lines.join("\n"), error: null };
}
