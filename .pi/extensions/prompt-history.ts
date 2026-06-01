/**
 * Prompt History Extension - Recreates Codex's Ctrl+R prompt history search
 *
 * Commands:
 *   /history              - Show recent prompt history
 *   /history search <q>   - Search prompt history
 *   /history clear        - Clear prompt history
 *
 * Stores prompt history locally in the session for retrieval.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const HISTORY_FILE = path.join(os.homedir(), ".pi", "prompt-history.jsonl");
const MAX_HISTORY = 500;

interface HistoryEntry {
	text: string;
	timestamp: number;
	cwd: string;
}

function loadHistory(): HistoryEntry[] {
	try {
		if (!fs.existsSync(HISTORY_FILE)) return [];
		const data = fs.readFileSync(HISTORY_FILE, "utf-8");
		return data
			.split("\n")
			.filter(Boolean)
			.map((line) => {
				try {
					return JSON.parse(line);
				} catch {
					return null;
				}
			})
			.filter(Boolean) as HistoryEntry[];
	} catch {
		return [];
	}
}

function saveEntry(entry: HistoryEntry): void {
	try {
		const dir = path.dirname(HISTORY_FILE);
		if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
		fs.appendFileSync(HISTORY_FILE, JSON.stringify(entry) + "\n");
	} catch {
		// Best effort
	}
}

function pruneHistory(): void {
	try {
		if (!fs.existsSync(HISTORY_FILE)) return;
		const lines = fs
			.readFileSync(HISTORY_FILE, "utf-8")
			.split("\n")
			.filter(Boolean);
		if (lines.length > MAX_HISTORY) {
			const keep = lines.slice(-MAX_HISTORY);
			fs.writeFileSync(HISTORY_FILE, keep.join("\n") + "\n");
		}
	} catch {
		// Best effort
	}
}

export default function (pi: ExtensionAPI) {
	// ── Capture prompts to history ────────────────────────────────────────

	pi.on("input", async (event, ctx) => {
		if (event.source === "extension") return { action: "continue" };
		if (!event.text || event.text.trim().length === 0) return { action: "continue" };
		// Skip commands
		if (event.text.startsWith("/")) return { action: "continue" };

		saveEntry({
			text: event.text,
			timestamp: Date.now(),
			cwd: ctx.cwd,
		});
		pruneHistory();

		return { action: "continue" };
	});

	// ── Command: /history ─────────────────────────────────────────────────

	pi.registerCommand("history", {
		description: "Search or browse prompt history",
		handler: async (args, ctx) => {
			const trimmed = (args || "").trim();
			const history = loadHistory();

			if (history.length === 0) {
				ctx.ui.notify("No prompt history yet.", "info");
				return;
			}

			if (trimmed === "clear") {
				try {
					fs.writeFileSync(HISTORY_FILE, "");
					ctx.ui.notify("Prompt history cleared.", "info");
				} catch {
					ctx.ui.notify("Failed to clear history.", "error");
				}
				return;
			}

			// Filter
			let filtered = history;
			const searchPrefix = "search ";
			if (trimmed.startsWith(searchPrefix)) {
				const query = trimmed.slice(searchPrefix.length).toLowerCase();
				filtered = history.filter(
					(h) => h.text.toLowerCase().includes(query),
				);
				if (filtered.length === 0) {
					ctx.ui.notify(`No history matching "${query}".`, "info");
					return;
				}
			} else if (trimmed) {
				const query = trimmed.toLowerCase();
				filtered = history.filter(
					(h) => h.text.toLowerCase().includes(query),
				);
			}

			// Most recent first
			filtered = filtered.reverse().slice(0, 20);

			if (!ctx.hasUI) {
				const lines = filtered.map(
					(h, i) =>
						`${i + 1}. [${new Date(h.timestamp).toLocaleString()}] ${h.text.slice(0, 100)}`,
				);
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}

			const displayItems = filtered.map((h) => {
				const time = new Date(h.timestamp).toLocaleTimeString();
				const preview = h.text.length > 80 ? h.text.slice(0, 77) + "…" : h.text;
				return `[${time}] ${preview}`;
			});

			const choice = await ctx.ui.select("Prompt History:", displayItems);
			if (choice && ctx.hasUI) {
				// Extract the text from the choice
				const idx = displayItems.indexOf(choice);
				if (idx >= 0) {
					// Re-send the historical prompt
					pi.sendUserMessage(filtered[idx].text);
				}
			}
		},
	});
}
