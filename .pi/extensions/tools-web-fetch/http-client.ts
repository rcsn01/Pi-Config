import type { FetchResult } from "./fetch-document.ts";
import { extractHeadingTitle, extractHTML } from "./html-extractor.ts";
import { extractPDF, isPDF } from "./pdf-extractor.ts";

const USER_AGENT =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
const DEFAULT_TIMEOUT_MS = 30000;
const MAX_RESPONSE_SIZE = 5 * 1024 * 1024;
const MAX_PDF_SIZE = 20 * 1024 * 1024;
const CACHE_TTL_MS = 10 * 60 * 1000;

export interface FetchResultCache {
	get(url: string): FetchResult | undefined;
	set(url: string, result: FetchResult): void;
}

export function createFetchResultCache(
	now: () => number = Date.now,
	ttlMs = CACHE_TTL_MS,
): FetchResultCache {
	const values = new Map<string, { at: number; result: FetchResult }>();
	return {
		get(url) {
			const cached = values.get(url);
			return cached && now() - cached.at < ttlMs ? cached.result : undefined;
		},
		set(url, result) {
			values.set(url, { at: now(), result });
		},
	};
}

export interface HttpClientDependencies {
	fetch: typeof globalThis.fetch;
	extractPDF: typeof extractPDF;
	extractHTML: typeof extractHTML;
}

export type HttpClient = (url: string, signal?: AbortSignal) => Promise<FetchResult>;

export function createHttpClient(
	overrides: Partial<HttpClientDependencies> = {},
): HttpClient {
	const dependencies: HttpClientDependencies = {
		fetch: globalThis.fetch,
		extractPDF,
		extractHTML,
		...overrides,
	};

	return async (url, signal) => {
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
		const onAbort = () => controller.abort();
		signal?.addEventListener("abort", onAbort);

		try {
			const response = await dependencies.fetch(url, {
				signal: controller.signal,
				headers: {
					"User-Agent": USER_AGENT,
					Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
					"Accept-Language": "en-US,en;q=0.9",
					"Cache-Control": "no-cache",
					"Sec-Fetch-Dest": "document",
					"Sec-Fetch-Mode": "navigate",
					"Sec-Fetch-Site": "none",
					"Sec-Fetch-User": "?1",
					"Upgrade-Insecure-Requests": "1",
				},
			});

			if (!response.ok) {
				return { url, title: "", content: "", error: `HTTP ${response.status}: ${response.statusText}` };
			}

			const contentType = response.headers.get("content-type") || "";
			const contentLengthHeader = response.headers.get("content-length");
			const isPDFContent = isPDF(url, contentType);
			const maxSize = isPDFContent ? MAX_PDF_SIZE : MAX_RESPONSE_SIZE;
			if (contentLengthHeader) {
				const contentLength = Number.parseInt(contentLengthHeader, 10);
				if (contentLength > maxSize) {
					return {
						url,
						title: "",
						content: "",
						error: `Response too large (${Math.round(contentLength / 1024 / 1024)}MB)`,
					};
				}
			}

			if (isPDFContent) {
				const buffer = await response.arrayBuffer();
				return await dependencies.extractPDF(buffer, url);
			}

			if (
				contentType.includes("application/octet-stream") ||
				contentType.includes("image/") ||
				contentType.includes("audio/") ||
				contentType.includes("video/") ||
				contentType.includes("application/zip")
			) {
				return {
					url,
					title: "",
					content: "",
					error: `Unsupported content type: ${contentType.split(";")[0]}`,
				};
			}

			const text = await response.text();
			const isHTML = contentType.includes("text/html") || contentType.includes("application/xhtml+xml");
			if (!isHTML) {
				const title = extractHeadingTitle(text) ?? new URL(url).pathname.split("/").pop() ?? url;
				return { url, title, content: text, error: null };
			}

			return dependencies.extractHTML(text, url);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return { url, title: "", content: "", error: message };
		} finally {
			clearTimeout(timeoutId);
			signal?.removeEventListener("abort", onAbort);
		}
	};
}

export const extractViaHttp = createHttpClient();
