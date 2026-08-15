import { createFetchResultCache, extractViaHttp, type FetchResultCache, type HttpClient } from "./http-client.ts";
import { extractWithJinaReader, type JinaReader } from "./jina-reader.ts";

export interface FetchResult {
	url: string;
	title: string;
	content: string;
	error: string | null;
}

export interface FetchDocumentDependencies {
	fetchViaHttp: HttpClient;
	fetchViaJina: JinaReader;
	cache: FetchResultCache;
}

export type FetchDocument = (url: string, signal?: AbortSignal) => Promise<FetchResult>;

export function createFetchDocument(
	overrides: Partial<FetchDocumentDependencies> = {},
): FetchDocument {
	const dependencies: FetchDocumentDependencies = {
		fetchViaHttp: extractViaHttp,
		fetchViaJina: extractWithJinaReader,
		cache: createFetchResultCache(),
		...overrides,
	};

	return async (url, signal) => {
		if (signal?.aborted) return { url, title: "", content: "", error: "Aborted" };

		const cached = dependencies.cache.get(url);
		if (cached) return cached;

		try {
			new URL(url);
		} catch {
			return { url, title: "", content: "", error: "Invalid URL" };
		}

		const httpResult = await dependencies.fetchViaHttp(url, signal);
		if (signal?.aborted) return { url, title: "", content: "", error: "Aborted" };
		if (!httpResult.error) {
			dependencies.cache.set(url, httpResult);
			return httpResult;
		}

		if (
			httpResult.error.startsWith("Unsupported content type") ||
			httpResult.error.startsWith("Response too large")
		) {
			return httpResult;
		}

		const jinaResult = await dependencies.fetchViaJina(url, signal);
		if (jinaResult) {
			dependencies.cache.set(url, jinaResult);
			return jinaResult;
		}
		if (signal?.aborted) return { url, title: "", content: "", error: "Aborted" };

		return {
			...httpResult,
			error: `${httpResult.error}\n\nThe page may be JavaScript-rendered. Try:\n  • A different URL for the same content\n  • web_search to find cached/alternative versions`,
		};
	};
}

export const fetchDocument = createFetchDocument();
