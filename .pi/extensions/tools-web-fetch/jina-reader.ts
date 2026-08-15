import type { FetchResult } from "./fetch-document.ts";
import { extractHeadingTitle } from "./html-extractor.ts";

const JINA_READER_BASE = "https://r.jina.ai/";
const JINA_TIMEOUT_MS = 30000;

export interface JinaReaderDependencies {
	fetch: typeof globalThis.fetch;
	timeoutSignal: (milliseconds: number) => AbortSignal;
}

export type JinaReader = (url: string, signal?: AbortSignal) => Promise<FetchResult | null>;

export function createJinaReader(
	overrides: Partial<JinaReaderDependencies> = {},
): JinaReader {
	const dependencies: JinaReaderDependencies = {
		fetch: globalThis.fetch,
		timeoutSignal: AbortSignal.timeout.bind(AbortSignal),
		...overrides,
	};

	return async (url, signal) => {
		try {
			const response = await dependencies.fetch(JINA_READER_BASE + url, {
				headers: { Accept: "text/markdown", "X-No-Cache": "true" },
				signal: AbortSignal.any([
					dependencies.timeoutSignal(JINA_TIMEOUT_MS),
					...(signal ? [signal] : []),
				]),
			});
			if (!response.ok) return null;

			const content = await response.text();
			const contentStart = content.indexOf("Markdown Content:");
			if (contentStart < 0) return null;

			const markdownPart = content.slice(contentStart + 17).trim();
			if (
				markdownPart.length < 100 ||
				markdownPart.startsWith("Loading...") ||
				markdownPart.startsWith("Please enable JavaScript")
			) {
				return null;
			}

			const title = extractHeadingTitle(markdownPart) ?? new URL(url).pathname.split("/").pop() ?? url;
			return { url, title, content: markdownPart, error: null };
		} catch {
			return null;
		}
	};
}

export const extractWithJinaReader = createJinaReader();
