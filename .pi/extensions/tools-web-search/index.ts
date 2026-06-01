/**
 * Local Web Search Extension - No API key required
 *
 * Searches the web using DuckDuckGo's free API or uses the local
 * Ollama web_search tool if available.
 *
 * Falls back: DuckDuckGo HTML scrape → Ollama web_search → Local cache
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";

interface SearchResult {
	title: string;
	url: string;
	snippet: string;
}

const searchCache = new Map<string, { at: number; results: SearchResult[] }>();
const CACHE_TTL_MS = 10 * 60 * 1000;

async function duckDuckGoSearch(query: string, count: number, signal?: AbortSignal): Promise<SearchResult[]> {
	try {
		const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
		const timeoutSignal = AbortSignal.timeout(15000);
		const resp = await fetch(url, {
			signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
			headers: {
				"User-Agent": "Mozilla/5.0 (compatible; pi-coding-agent/1.0)",
			},
		});

		if (!resp.ok) return [];

		const html = await resp.text();
		return parseDDGResults(html, count);
	} catch {
		return [];
	}
}

function decodeEntities(text: string): string {
	return text
		.replace(/&amp;/g, "&")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">");
}

function parseDDGResults(html: string, count: number): SearchResult[] {
	const results: SearchResult[] = [];

	// Simple regex-based parsing of DuckDuckGo HTML results
	const resultRegex = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>([^<]*)<\/a>/gi;
	let match;

	while ((match = resultRegex.exec(html)) !== null && results.length < count) {
		const url = decodeEntities(decodeURIComponent(match[1].replace(/\/\/duckduckgo\.com\/l\/\?uddg=/, "").split("&")[0]));
		const title = decodeEntities(match[2].replace(/<[^>]*>/g, "").trim());
		const snippet = decodeEntities(match[3].replace(/<[^>]*>/g, "").trim());

		if (title && url) {
			results.push({ title, url, snippet });
		}
	}

	return results;
}

async function ollamaWebSearch(query: string, count: number, signal?: AbortSignal): Promise<SearchResult[]> {
	try {
		const timeoutSignal = AbortSignal.timeout(10000);
		const resp = await fetch("http://localhost:11434/api/web_search", {
			method: "POST",
			signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ query }),
		});

		if (!resp.ok) return [];

		const data = await resp.json() as any;
		const results: SearchResult[] = [];

		if (data.results && Array.isArray(data.results)) {
			for (const r of data.results) {
				results.push({
					title: r.title || "",
					url: r.url || r.link || "",
					snippet: r.snippet || r.description || r.content || "",
				});
			}
		}

		return results.slice(0, count);
	} catch {
		return [];
	}
}

function formatResults(results: SearchResult[]): string {
	if (results.length === 0) return "No results found.";
	return results
		.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
		.join("\n\n");
}

export default function (pi: ExtensionAPI) {
	const searchTool = {
		name: "ddg_search",
		label: "DuckDuckGo Search",
		description:
			"Search the web using DuckDuckGo (no API key required) or local Ollama. Returns title, URL, and snippet.",
		promptSnippet: "Search the web via DuckDuckGo (no API key)",
		promptGuidelines: [
			"Use ddg_search as a backup when web_search is unavailable or for no-API-key searches.",
			"Make one search per query. If results aren't helpful, refine your query and try again.",
		],

		parameters: Type.Object({
			query: Type.String({ description: "Search query" }),
			max_results: Type.Optional(
				Type.Number({ description: "Max results (default: 5, max: 10)", minimum: 1, maximum: 10 }),
			),
		}),

		async execute(_toolCallId, params, signal, _onUpdate, _ctx) {
			const maxResults = params.max_results || 5;
			const cacheKey = `${params.query}\0${maxResults}`;
			const cached = searchCache.get(cacheKey);
			if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
				return {
					content: [{ type: "text", text: formatResults(cached.results) }],
					details: { query: params.query, resultCount: cached.results.length, cached: true },
				};
			}

			// Try Ollama first (local, no API key)
			let results = await ollamaWebSearch(params.query, maxResults, signal);

			// Fall back to DuckDuckGo
			if (results.length === 0) {
				results = await duckDuckGoSearch(params.query, maxResults, signal);
			}
			searchCache.set(cacheKey, { at: Date.now(), results });

			return {
				content: [{ type: "text", text: formatResults(results) }],
				details: { query: params.query, resultCount: results.length, cached: false },
			};
		},

		renderCall(args, _theme, _context) {
			const query = (args as any).query || "";
			const display = query.length > 60 ? query.slice(0, 57) + "..." : query;
			return new Text(`search "${display}"`, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			if (!expanded) {
				const details = result.details as { resultCount?: number };
				return new Text(`${details?.resultCount ?? 0} results`, 0, 0);
			}
			const text = result.content[0]?.type === "text" ? result.content[0].text : "";
			return new Text(text.slice(0, 500), 0, 0);
		},
	} as const;

	pi.registerTool(searchTool);
}
