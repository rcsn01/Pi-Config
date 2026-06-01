/**
 * Unified History Extension
 *
 * Single owner for prompt history and draft replay:
 *   /history - global plaintext prompt history in ~/.pi/prompt-history.jsonl
 *   /drafts  - session-local recent prompts stored in session custom entries
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { redactSecrets, containsLikelySecret } from "./_shared/security.ts";

const HISTORY_FILE = path.join(os.homedir(), ".pi", "prompt-history.jsonl");
const SETTINGS_FILE = path.join(os.homedir(), ".pi", "prompt-history-settings.json");
const MAX_HISTORY = 500;
const MAX_DRAFTS = 50;
const DRAFTS_CUSTOM_TYPE = "draft-history";

interface HistoryEntry {
	text: string;
	timestamp: number;
	cwd: string;
}

interface DraftEntry {
	text: string;
	timestamp: number;
}

function historyEnabled(): boolean {
	try {
		if (!fs.existsSync(SETTINGS_FILE)) return true;
		const data = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf-8"));
		return data.enabled !== false;
	} catch {
		return true;
	}
}

function setHistoryEnabled(enabled: boolean): void {
	const dir = path.dirname(SETTINGS_FILE);
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ enabled }, null, 2));
}

function loadHistory(): HistoryEntry[] {
	try {
		if (!fs.existsSync(HISTORY_FILE)) return [];
		return fs.readFileSync(HISTORY_FILE, "utf-8")
			.split("\n")
			.filter(Boolean)
			.map((line) => {
				try { return JSON.parse(line); } catch { return null; }
			})
			.filter(Boolean) as HistoryEntry[];
	} catch {
		return [];
	}
}

function saveHistoryEntry(entry: HistoryEntry): void {
	try {
		const dir = path.dirname(HISTORY_FILE);
		if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
		fs.appendFileSync(HISTORY_FILE, JSON.stringify(entry) + "\n");
	} catch {
		// Best effort.
	}
}

function pruneHistory(): void {
	try {
		if (!fs.existsSync(HISTORY_FILE)) return;
		const lines = fs.readFileSync(HISTORY_FILE, "utf-8").split("\n").filter(Boolean);
		if (lines.length > MAX_HISTORY) {
			fs.writeFileSync(HISTORY_FILE, lines.slice(-MAX_HISTORY).join("\n") + "\n");
		}
	} catch {
		// Best effort.
	}
}

function sanitizedPrompt(text: string): string | undefined {
	const redacted = redactSecrets(text);
	if (containsLikelySecret(text) && redacted.replace(/\[REDACTED[^\]]*\]/g, "").trim().length < 20) {
		return undefined;
	}
	return redacted;
}

export default function (pi: ExtensionAPI) {
	const drafts: DraftEntry[] = [];

	function reconstructDrafts(ctx: any): void {
		drafts.length = 0;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === DRAFTS_CUSTOM_TYPE) {
				const data = entry.data as DraftEntry | undefined;
				if (data?.text) drafts.push(data);
			}
		}
		while (drafts.length > MAX_DRAFTS) drafts.shift();
	}

	pi.on("session_start", async (_event, ctx) => reconstructDrafts(ctx));
	pi.on("session_tree", async (_event, ctx) => reconstructDrafts(ctx));

	// One input hook saves both global history and per-session drafts.
	pi.on("input", async (event, ctx) => {
		if (event.source === "extension") return { action: "continue" };
		if (!event.text || event.text.trim().length === 0) return { action: "continue" };
		if (event.text.startsWith("/")) return { action: "continue" };

		const text = sanitizedPrompt(event.text);
		if (!text) return { action: "continue" };

		if (historyEnabled()) {
			saveHistoryEntry({ text, timestamp: Date.now(), cwd: ctx.cwd });
			pruneHistory();
		}

		if (drafts.length === 0 || drafts[drafts.length - 1].text !== text) {
			const entry: DraftEntry = { text, timestamp: Date.now() };
			drafts.push(entry);
			pi.appendEntry(DRAFTS_CUSTOM_TYPE, entry);
			while (drafts.length > MAX_DRAFTS) drafts.shift();
		}

		return { action: "continue" };
	});

	pi.registerCommand("history", {
		description: "Search or browse prompt history",
		handler: async (args, ctx) => {
			const trimmed = (args || "").trim();

			if (trimmed === "on" || trimmed === "enable") {
				setHistoryEnabled(true);
				ctx.ui.notify("Prompt history enabled. Entries are stored locally in plaintext with basic secret redaction.", "info");
				return;
			}

			if (trimmed === "off" || trimmed === "disable") {
				setHistoryEnabled(false);
				ctx.ui.notify("Prompt history disabled.", "info");
				return;
			}

			if (trimmed === "status") {
				ctx.ui.notify(`Prompt history: ${historyEnabled() ? "ON" : "OFF"}\nFile: ${HISTORY_FILE}\nStored locally in plaintext; common secrets are redacted.\nSession drafts: ${drafts.length}`, "info");
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

			const history = loadHistory();
			if (history.length === 0) {
				ctx.ui.notify("No prompt history yet.", "info");
				return;
			}

			let filtered = history;
			const searchPrefix = "search ";
			if (trimmed.startsWith(searchPrefix)) {
				const query = trimmed.slice(searchPrefix.length).toLowerCase();
				filtered = history.filter((h) => h.text.toLowerCase().includes(query));
				if (filtered.length === 0) {
					ctx.ui.notify(`No history matching "${query}".`, "info");
					return;
				}
			} else if (trimmed) {
				const query = trimmed.toLowerCase();
				filtered = history.filter((h) => h.text.toLowerCase().includes(query));
				if (filtered.length === 0) {
					ctx.ui.notify(`No history matching "${query}".`, "info");
					return;
				}
			}

			filtered = filtered.reverse().slice(0, 20);

			if (!ctx.hasUI) {
				ctx.ui.notify(filtered.map((h, i) => `${i + 1}. [${new Date(h.timestamp).toLocaleString()}] ${h.text.slice(0, 100)}`).join("\n"), "info");
				return;
			}

			const displayItems = filtered.map((h) => {
				const time = new Date(h.timestamp).toLocaleTimeString();
				const preview = h.text.length > 80 ? h.text.slice(0, 77) + "…" : h.text;
				return `[${time}] ${preview}`;
			});

			const choice = await ctx.ui.select("Prompt History:", displayItems);
			if (choice) {
				const idx = displayItems.indexOf(choice);
				if (idx >= 0) pi.sendUserMessage(filtered[idx].text);
			}
		},
	});

	pi.registerCommand("drafts", {
		description: "Browse and re-send previous session drafts",
		handler: async (_args, ctx) => {
			if (drafts.length === 0) {
				ctx.ui.notify("No drafts saved yet.", "info");
				return;
			}

			const recent = [...drafts].reverse().slice(0, 20);
			if (!ctx.hasUI) {
				ctx.ui.notify(recent.map((d, i) => `${i + 1}. ${d.text.slice(0, 100)}`).join("\n"), "info");
				return;
			}

			const displayItems = recent.map((d) => d.text.length > 80 ? d.text.slice(0, 77) + "…" : d.text);
			const choice = await ctx.ui.select("Previous Drafts:", displayItems);
			if (choice) {
				const idx = displayItems.indexOf(choice);
				if (idx >= 0) pi.sendUserMessage(recent[idx].text);
			}
		},
	});
}
