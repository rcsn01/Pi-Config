import { describe, expect, it, vi } from "vitest";
import { createFetchDocument, type FetchResult } from "./fetch-document.ts";
import { createFetchResultCache } from "./http-client.ts";

const url = "https://example.com/article";
const success: FetchResult = { url, title: "Article", content: "content", error: null };
const directFailure: FetchResult = { url, title: "", content: "partial", error: "HTTP 503: Unavailable" };

function createCache() {
	const values = new Map<string, FetchResult>();
	return {
		get: vi.fn((key: string) => values.get(key)),
		set: vi.fn((key: string, value: FetchResult) => values.set(key, value)),
	};
}

describe("fetch document orchestration", () => {
	it("returns and caches a successful direct extraction", async () => {
		const cache = createCache();
		const fetchViaHttp = vi.fn(async () => success);
		const fetchViaJina = vi.fn();
		const fetchDocument = createFetchDocument({ fetchViaHttp, fetchViaJina, cache });

		expect(await fetchDocument(url)).toEqual(success);
		expect(await fetchDocument(url)).toEqual(success);
		expect(fetchViaHttp).toHaveBeenCalledOnce();
		expect(fetchViaJina).not.toHaveBeenCalled();
		expect(cache.set).toHaveBeenCalledWith(url, success);
	});

	it("falls back to Jina and caches its successful result", async () => {
		const jinaResult = { ...success, title: "Jina Article" };
		const cache = createCache();
		const fetchViaHttp = vi.fn(async () => directFailure);
		const fetchViaJina = vi.fn(async () => jinaResult);
		const fetchDocument = createFetchDocument({ fetchViaHttp, fetchViaJina, cache });

		expect(await fetchDocument(url)).toEqual(jinaResult);
		expect(fetchViaJina).toHaveBeenCalledWith(url, undefined);
		expect(cache.set).toHaveBeenCalledWith(url, jinaResult);
	});

	it.each(["Unsupported content type: image/png", "Response too large (8MB)"])(
		"does not use Jina for terminal direct errors: %s",
		async (error) => {
			const result = { ...directFailure, error };
			const fetchViaJina = vi.fn();
			const fetchDocument = createFetchDocument({
				fetchViaHttp: vi.fn(async () => result),
				fetchViaJina,
				cache: createCache(),
			});

			expect(await fetchDocument(url)).toEqual(result);
			expect(fetchViaJina).not.toHaveBeenCalled();
		},
	);

	it("returns the original error with guidance when Jina fails", async () => {
		const fetchDocument = createFetchDocument({
			fetchViaHttp: vi.fn(async () => directFailure),
			fetchViaJina: vi.fn(async () => null),
			cache: createCache(),
		});

		const result = await fetchDocument(url);
		expect(result.content).toBe("partial");
		expect(result.error).toContain("HTTP 503: Unavailable");
		expect(result.error).toContain("web_search");
	});

	it("rejects invalid URLs before invoking either extraction strategy", async () => {
		const fetchViaHttp = vi.fn();
		const fetchViaJina = vi.fn();
		const fetchDocument = createFetchDocument({ fetchViaHttp, fetchViaJina, cache: createCache() });

		expect(await fetchDocument("not a url")).toMatchObject({ error: "Invalid URL" });
		expect(fetchViaHttp).not.toHaveBeenCalled();
		expect(fetchViaJina).not.toHaveBeenCalled();
	});

	it("gives aborts precedence before extraction and after direct extraction", async () => {
		const alreadyAborted = new AbortController();
		alreadyAborted.abort();
		const fetchViaHttp = vi.fn();
		const fetchViaJina = vi.fn();
		const fetchDocument = createFetchDocument({ fetchViaHttp, fetchViaJina, cache: createCache() });
		expect(await fetchDocument(url, alreadyAborted.signal)).toMatchObject({ error: "Aborted" });

		const duringDirect = new AbortController();
		const abortingHttp = vi.fn(async () => {
			duringDirect.abort();
			return directFailure;
		});
		const secondDocument = createFetchDocument({
			fetchViaHttp: abortingHttp,
			fetchViaJina,
			cache: createCache(),
		});
		expect(await secondDocument(url, duringDirect.signal)).toMatchObject({ error: "Aborted" });
		expect(fetchViaJina).not.toHaveBeenCalled();
	});

	it("expires cached successes after the configured TTL and never caches failures", async () => {
		let now = 100;
		const cache = createFetchResultCache(() => now, 10);
		const fetchViaHttp = vi.fn(async () => success);
		const fetchDocument = createFetchDocument({ fetchViaHttp, fetchViaJina: vi.fn(), cache });
		await fetchDocument(url);
		now = 105;
		await fetchDocument(url);
		now = 111;
		await fetchDocument(url);
		expect(fetchViaHttp).toHaveBeenCalledTimes(2);

		const failingHttp = vi.fn(async () => directFailure);
		const failingDocument = createFetchDocument({
			fetchViaHttp: failingHttp,
			fetchViaJina: vi.fn(async () => null),
			cache: createFetchResultCache(),
		});
		await failingDocument(url);
		await failingDocument(url);
		expect(failingHttp).toHaveBeenCalledTimes(2);
	});
});
