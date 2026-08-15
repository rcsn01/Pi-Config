import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { fetchDocument, type FetchDocument } from "./fetch-document.ts";

export function registerWebFetchTool(pi: ExtensionAPI, fetchAndExtract: FetchDocument): void {
	pi.registerTool({
		name: "ddg_fetch",
		label: "Web Fetch",
		description:
			"Fetch a web page and extract readable content as clean markdown. Uses Readability + Turndown for high-quality HTML→markdown conversion. Handles PDFs, plain text, and falls back to Jina Reader for JS-rendered pages.",
		promptSnippet: "Fetch web content",

		parameters: Type.Object({
			url: Type.String({ description: "URL to fetch" }),
			max_chars: Type.Optional(Type.Number({
				description: "Maximum characters to return (default: no extra truncation)",
				minimum: 1000,
			})),
		}),

		async execute(_toolCallId, params, signal) {
			const result = await fetchAndExtract(params.url, signal);
			if (result.error) throw new Error(`${params.url}: ${result.error}`);

			const header = result.title
				? `# ${result.title}\n\nSource: ${result.url}\n\n---\n\n`
				: "";
			const fullText = header + result.content;
			const maxChars = typeof params.max_chars === "number" ? params.max_chars : undefined;
			const text = maxChars && fullText.length > maxChars
				? `${fullText.slice(0, maxChars)}\n\n... [truncated ${fullText.length - maxChars} chars]`
				: fullText;
			return {
				content: [{ type: "text" as const, text }],
				details: {
					url: result.url,
					title: result.title,
					chars: result.content.length,
					returnedChars: text.length,
					truncated: text.length < fullText.length,
				},
			};
		},

		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const { url } = args as { url?: string };
			if (!url) {
				text.setText(theme.fg("toolTitle", theme.bold("fetch ")) + theme.fg("error", "(no URL)"));
				return text;
			}
			const display = url.length > 70 ? `${url.slice(0, 67)}...` : url;
			text.setText(theme.fg("toolTitle", theme.bold("fetch ")) + theme.fg("accent", display));
			return text;
		},

		renderResult(result, { expanded, isPartial }, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			if (isPartial) {
				text.setText(theme.fg("warning", "Fetching…"));
				return text;
			}

			if (context.isError) {
				const message = result.content.find((item) => item.type === "text")?.text || "Error";
				text.setText(theme.fg("error", message));
				return text;
			}

			const details = result.details as { title?: string; chars?: number };
			const title = details?.title || "Untitled";
			const chars = details?.chars ?? 0;
			const status = theme.fg("success", title) + theme.fg("muted", ` (${chars} chars)`);
			if (!expanded) {
				text.setText(status);
				return text;
			}

			const content = result.content.find((item) => item.type === "text")?.text || "";
			const preview = content.length > 500 ? `${content.slice(0, 500)}...` : content;
			text.setText(`${status}\n${theme.fg("dim", preview)}`);
			return text;
		},
	});
}

export default function (pi: ExtensionAPI): void {
	registerWebFetchTool(pi, fetchDocument);
}
