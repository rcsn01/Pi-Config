import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import type { FetchResult } from "./fetch-document.ts";
import { extractRSCContent } from "./rsc-extractor.ts";

const MIN_USEFUL_CONTENT = 500;
const turndown = new TurndownService({
	headingStyle: "atx",
	codeBlockStyle: "fenced",
});

export function isLikelyJSRendered(html: string): boolean {
	const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
	if (!bodyMatch) return false;
	const textContent = bodyMatch[1]
		.replace(/<script[\s\S]*?<\/script>/gi, "")
		.replace(/<style[\s\S]*?<\/style>/gi, "")
		.replace(/<[^>]+>/g, "")
		.replace(/\s+/g, " ")
		.trim();
	const scriptCount = (html.match(/<script/gi) || []).length;
	return textContent.length < 500 && scriptCount > 3;
}

export function extractHeadingTitle(text: string): string | null {
	const match = text.match(/^#{1,2}\s+(.+)/m);
	if (!match) return null;
	const cleaned = match[1].replace(/\*+/g, "").trim();
	return cleaned || null;
}

export function extractHTML(html: string, url: string): FetchResult {
	const { document } = parseHTML(html);
	const reader = new Readability(document as unknown as Document);
	const article = reader.parse();

	if (!article) {
		const rscResult = extractRSCContent(html);
		if (rscResult) {
			return { url, title: rscResult.title, content: rscResult.content, error: null };
		}

		return {
			url,
			title: "",
			content: "",
			error: isLikelyJSRendered(html)
				? "Page appears to be JavaScript-rendered (content loads dynamically)"
				: "Could not extract readable content from HTML structure",
		};
	}

	const markdown = turndown.turndown(article.content);
	if (markdown.length < MIN_USEFUL_CONTENT) {
		return {
			url,
			title: article.title || "",
			content: markdown,
			error: isLikelyJSRendered(html)
				? "Page appears to be JavaScript-rendered (content loads dynamically)"
				: "Extracted content appears incomplete",
		};
	}

	return { url, title: article.title || "", content: markdown, error: null };
}
