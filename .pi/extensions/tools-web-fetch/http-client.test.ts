import { describe, expect, it, vi } from "vitest";
import { createHttpClient } from "./http-client.ts";

const url = "https://example.com/article";

function response(body: BodyInit = "", init: ResponseInit = {}): Response {
	return new Response(body, { status: 200, ...init });
}

describe("HTTP client", () => {
	it("sends browser-like headers and returns non-HTML text", async () => {
		const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response("# Plain Title\n\nBody", {
			headers: { "content-type": "text/plain" },
		}));
		const client = createHttpClient({ fetch: fetch as typeof globalThis.fetch });

		await expect(client(url)).resolves.toEqual({
			url,
			title: "Plain Title",
			content: "# Plain Title\n\nBody",
			error: null,
		});
		const request = fetch.mock.calls[0][1];
		expect(request?.headers).toMatchObject({
			"User-Agent": expect.stringContaining("Mozilla"),
			Accept: expect.stringContaining("text/html"),
		});
		expect(request?.signal).toBeInstanceOf(AbortSignal);
	});

	it("maps unsuccessful responses and fetch exceptions to errors", async () => {
		const httpFailure = createHttpClient({
			fetch: vi.fn(async () => response("", { status: 503, statusText: "Unavailable" })) as typeof globalThis.fetch,
		});
		await expect(httpFailure(url)).resolves.toMatchObject({ error: "HTTP 503: Unavailable" });

		const networkFailure = createHttpClient({
			fetch: vi.fn(async () => { throw new Error("network down"); }) as typeof globalThis.fetch,
		});
		await expect(networkFailure(url)).resolves.toMatchObject({ error: "network down" });
	});

	it("rejects declared normal and PDF response sizes over their limits", async () => {
		const normal = createHttpClient({
			fetch: vi.fn(async () => response("", {
				headers: { "content-type": "text/html", "content-length": String(6 * 1024 * 1024) },
			})) as typeof globalThis.fetch,
		});
		await expect(normal(url)).resolves.toMatchObject({ error: "Response too large (6MB)" });

		const pdf = createHttpClient({
			fetch: vi.fn(async () => response(new Uint8Array(), {
				headers: { "content-type": "application/pdf", "content-length": String(21 * 1024 * 1024) },
			})) as typeof globalThis.fetch,
		});
		await expect(pdf(`${url}.pdf`)).resolves.toMatchObject({ error: "Response too large (21MB)" });
	});

	it("preserves header-only size checks when Content-Length is absent", async () => {
		const client = createHttpClient({
			fetch: vi.fn(async () => response("content without a declared size", {
				headers: { "content-type": "text/plain" },
			})) as typeof globalThis.fetch,
		});
		await expect(client(url)).resolves.toMatchObject({
			content: "content without a declared size",
			error: null,
		});
	});

	it("routes PDFs and HTML to their extractors", async () => {
		const pdfResult = { url: `${url}.pdf`, title: "PDF", content: "pdf", error: null };
		const extractPDF = vi.fn(async () => pdfResult);
		const pdfClient = createHttpClient({
			fetch: vi.fn(async () => response(new Uint8Array([1, 2]), {
				headers: { "content-type": "application/pdf" },
			})) as typeof globalThis.fetch,
			extractPDF,
		});
		await expect(pdfClient(`${url}.pdf`)).resolves.toEqual(pdfResult);
		expect(extractPDF).toHaveBeenCalledWith(expect.any(ArrayBuffer), `${url}.pdf`);

		const htmlResult = { url, title: "HTML", content: "html", error: null };
		const extractHTML = vi.fn(() => htmlResult);
		const htmlClient = createHttpClient({
			fetch: vi.fn(async () => response("<html></html>", {
				headers: { "content-type": "text/html; charset=utf-8" },
			})) as typeof globalThis.fetch,
			extractHTML,
		});
		await expect(htmlClient(url)).resolves.toEqual(htmlResult);
		expect(extractHTML).toHaveBeenCalledWith("<html></html>", url);
	});

	it.each(["application/octet-stream", "image/png", "audio/mpeg", "video/mp4", "application/zip"])(
		"rejects unsupported content type %s",
		async (contentType) => {
			const client = createHttpClient({
				fetch: vi.fn(async () => response("binary", {
					headers: { "content-type": contentType },
				})) as typeof globalThis.fetch,
			});
			await expect(client(url)).resolves.toMatchObject({ error: `Unsupported content type: ${contentType}` });
		},
	);

	it("propagates caller aborts to the request controller", async () => {
		const caller = new AbortController();
		const request: { signal?: AbortSignal } = {};
		const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
			request.signal = init?.signal as AbortSignal;
			return new Promise<Response>((_resolve, reject) => {
				request.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
			});
		});
		const client = createHttpClient({ fetch: fetch as typeof globalThis.fetch });
		const pending = client(url, caller.signal);
		caller.abort();
		await expect(pending).resolves.toMatchObject({ error: "aborted" });
		expect(request.signal?.aborted).toBe(true);
	});
});
