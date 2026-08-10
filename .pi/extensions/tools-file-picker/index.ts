/**
 * File Picker Extension - Recreates Codex's @ file search in composer
 *
 * Type `@` in the composer followed by a search term, and this extension
 * intercepts the input to show a fuzzy file picker. Selecting a file inserts
 * its path into the prompt.
 *
 * Also provides the `list_files` tool so the LLM can explore the workspace.
 *
 * Command:
 *   /files <query>    - Search workspace files and insert path
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { discoverFiles } from "../_shared/file-discovery.ts";

async function findFiles(
	cwd: string,
	query: string,
	maxResults = 20,
	options: { includeHidden?: boolean; signal?: AbortSignal } = {},
): Promise<string[]> {
	return discoverFiles(cwd, {
		query,
		maxResults,
		includeHidden: options.includeHidden,
		signal: options.signal,
	});
}

export default function (pi: ExtensionAPI) {
	// ── Input interception for @ search ───────────────────────────────────

	pi.on("input", async (event, ctx) => {
		if (event.source === "extension") return { action: "continue" };

		const text = event.text || "";
		// Check for @file pattern
		const match = text.match(/@(\S*)$/);
		if (!match) return { action: "continue" };

		const query = match[1];
		if (query.length === 0) return { action: "continue" };

		// If the query is short, don't interrupt
		if (query.length < 2) return { action: "continue" };

		if (!ctx.hasUI) return { action: "continue" };

		// Find matching files
		const files = await findFiles(ctx.cwd, query, 10);

		if (files.length === 0) return { action: "continue" };

		// Show file picker
		const choice = await ctx.ui.select(
			`Files matching "${query}":`,
			files.map((f) => `@${f}`),
		);

		if (choice) {
			// Replace the @query with the selected file
			const newText = text.replace(/@\S*$/, choice);
			return { action: "transform", text: newText };
		}

		return { action: "continue" };
	});

	// ── Tool: list_files ──────────────────────────────────────────────────

	pi.registerTool({
		name: "list_files",
		label: "List Files",
		description:
			"Search for files in the workspace by name (fuzzy matching). " +
			"Useful for finding files when you need to reference them.",
		promptSnippet: "Search workspace files by name (fuzzy match)",
		promptGuidelines: [
			"Use list_files when you need to find files by name before reading or editing them.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "Search query for file name (fuzzy match)" }),
			max_results: Type.Optional(
				Type.Number({ description: "Maximum results (default 20)" }),
			),
			include_hidden: Type.Optional(Type.Boolean({ description: "Include hidden dotfiles/directories" })),
		}),

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const files = await findFiles(
				ctx.cwd,
				params.query,
				params.max_results || 20,
				{ includeHidden: params.include_hidden, signal },
			);

			if (files.length === 0) {
				return {
					content: [{ type: "text", text: `No files found matching "${params.query}".` }],
					details: { query: params.query, count: 0 },
				};
			}

			const lines = [
				`Found ${files.length} file(s) matching "${params.query}":`,
				"",
				...files.map((f) => `  ${f}`),
			];

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: { query: params.query, count: files.length, files },
			};
		},
	});

	// ── Command: /files ───────────────────────────────────────────────────

	pi.registerCommand("files", {
		description: "Search workspace files (fuzzy match)",
		handler: async (args, ctx) => {
			const raw = (args || "").trim();
			const includeHidden = raw.includes("--hidden") || raw.includes("--all");
			const query = raw.replace(/--hidden|--all/g, "").trim();
			if (!query) {
				ctx.ui.notify("Usage: /files <search-query>", "info");
				return;
			}

			const files = await findFiles(ctx.cwd, query, 20, { includeHidden });
			if (files.length === 0) {
				ctx.ui.notify(`No files matching "${query}".`, "info");
				return;
			}

			if (!ctx.hasUI) {
				ctx.ui.notify(files.join("\n"), "info");
				return;
			}

			const choice = await ctx.ui.select(
				`Files matching "${query}":`,
				files,
			);

			if (choice) {
				// Send the file as context
				pi.sendUserMessage(`Read and analyze this file: ${choice}`);
			}
		},
	});
}
