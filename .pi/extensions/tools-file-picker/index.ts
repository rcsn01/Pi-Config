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
import * as fs from "node:fs";
import * as path from "node:path";

function fuzzyMatch(pattern: string, str: string): boolean {
	const p = pattern.toLowerCase();
	const s = str.toLowerCase();
	let pi = 0;
	for (let si = 0; si < s.length && pi < p.length; si++) {
		if (s[si] === p[pi]) pi++;
	}
	return pi === p.length;
}

function scoreMatch(query: string, relPath: string): number {
	const q = query.toLowerCase();
	const p = relPath.toLowerCase();
	const base = path.basename(p);
	if (base === q) return 1000;
	if (base.startsWith(q)) return 900 - base.length;
	if (base.includes(q)) return 800 - base.indexOf(q);
	if (p.startsWith(q)) return 700 - p.length;
	if (p.includes(q)) return 600 - p.indexOf(q);
	return fuzzyMatch(q, p) ? 300 - p.length : -1;
}

function loadGitignore(cwd: string): string[] {
	const gitignorePath = path.join(cwd, ".gitignore");
	try {
		if (!fs.existsSync(gitignorePath)) return [];
		return fs.readFileSync(gitignorePath, "utf-8")
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line && !line.startsWith("#") && !line.startsWith("!"));
	} catch {
		return [];
	}
}

function isIgnored(relPath: string, patterns: string[]): boolean {
	const normalized = relPath.split(path.sep).join("/");
	for (const raw of patterns) {
		const pattern = raw.replace(/^\//, "");
		if (pattern.endsWith("/")) {
			const dir = pattern.slice(0, -1);
			if (normalized === dir || normalized.startsWith(dir + "/") || normalized.includes("/" + dir + "/")) return true;
			continue;
		}
		if (pattern.includes("*")) {
			const re = new RegExp("^" + pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$" );
			if (re.test(normalized) || re.test(path.basename(normalized))) return true;
			continue;
		}
		if (normalized === pattern || normalized.startsWith(pattern + "/") || path.basename(normalized) === pattern) return true;
	}
	return false;
}

async function findFiles(
	cwd: string,
	query: string,
	maxResults = 20,
	options: { includeHidden?: boolean } = {},
): Promise<string[]> {
	const results: string[] = [];
	const ignorePatterns = loadGitignore(cwd);
	const ignoreDirs = new Set([
		"node_modules", ".git", "__pycache__", ".venv", "venv",
		"dist", "build", ".next", ".cache", "target", ".idea", ".vscode",
	]);

	function walk(dir: string, depth: number) {
		if (depth > 5 || results.length >= maxResults * 2) return;

		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}

		for (const entry of entries) {
			if (!options.includeHidden && entry.name.startsWith(".")) continue;
			if (ignoreDirs.has(entry.name)) continue;

			const fullPath = path.join(dir, entry.name);
			const relPath = path.relative(cwd, fullPath);
			if (isIgnored(relPath, ignorePatterns)) continue;

			if (entry.isDirectory()) {
				walk(fullPath, depth + 1);
			} else if (entry.isFile()) {
				if (scoreMatch(query, relPath) >= 0) {
					results.push(relPath);
				}
			}
		}
	}

	walk(cwd, 0);
	return results
		.sort((a, b) => scoreMatch(query, b) - scoreMatch(query, a) || a.localeCompare(b))
		.slice(0, maxResults);
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

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const files = await findFiles(
				ctx.cwd,
				params.query,
				params.max_results || 20,
				{ includeHidden: params.include_hidden },
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
