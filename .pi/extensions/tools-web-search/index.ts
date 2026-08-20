/**
 * Local Web Search Extension - No API key required
 *
 * Searches the web using DuckDuckGo's free HTML API.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Container, Text } from "@earendil-works/pi-tui";
import { renderToolMarkdown, renderToolSummary, truncateToolLine } from "../_shared/tool-result-ui.ts";

interface SearchResult {
	title: string;
	url: string;
	snippet: string;
}

const searchCache = new Map<string, { at: number; results: SearchResult[] }>();
const CACHE_TTL_MS = 10 * 60 * 1000;

async function duckDuckGoSearch(query: string, count: number, signal?: AbortSignal): Promise<SearchResult[]> {
	const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
	const timeoutSignal = AbortSignal.timeout(15000);
	const resp = await fetch(url, {
		signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
		headers: {
			"User-Agent": "Mozilla/5.0 (compatible; pi-coding-agent/1.0)",
		},
	});

	if (!resp.ok) throw new Error(`DuckDuckGo request failed (HTTP ${resp.status}).`);

	const html = await resp.text();
	return parseDDGResults(html, count);
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

function formatResults(results: SearchResult[]): string {
	if (results.length === 0) return "No results found.";
	return results
		.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`)
		.join("\n\n");
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "ddg_search",
		label: "DuckDuckGo Search",
		description: "Search DuckDuckGo and return titles, URLs, and snippets.",
		promptSnippet: "Search the web",

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

			const results = await duckDuckGoSearch(params.query, maxResults, signal);
			searchCache.set(cacheKey, { at: Date.now(), results });

			return {
				content: [{ type: "text", text: formatResults(results) }],
				details: { query: params.query, resultCount: results.length, cached: false },
			};
		},

		renderCall(args, theme, _context) {
			const query = String((args as any).query || "");
			const display = truncateToolLine(query, 60);
			return new Text(theme.fg("toolTitle", theme.bold("search ")) + theme.fg("muted", `"${display}"`), 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme, context) {
			if (isPartial) return renderToolSummary(theme, "running", "Searching…");
			if (context.isError) {
				const message = result.content.find((content) => content.type === "text")?.text ?? "Search failed.";
				return renderToolSummary(theme, "error", message);
			}
			const details = result.details as { resultCount?: number };
			const count = details?.resultCount ?? 0;
			if (!expanded) return renderToolSummary(theme, "success", count === 0 ? "No results found" : `${count} result${count === 1 ? "" : "s"}`, count > 0);
			const text = result.content[0]?.type === "text" ? result.content[0].text : "No results found.";
			const container = new Container();
			container.addChild(renderToolSummary(theme, "success", count === 0 ? "No results found" : `${count} result${count === 1 ? "" : "s"}`));
			container.addChild(renderToolMarkdown(text, theme));
			return container;
		},
	});
}
