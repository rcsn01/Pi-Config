/**
 * Draft History Extension - Recreates Codex's Up/Down draft history in composer
 *
 * Commands:
 *   /drafts              - Show recent drafts and re-send one
 *
 * Saves user messages as drafts and allows reusing them.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const DRAFTS_CUSTOM_TYPE = "draft-history";

interface DraftEntry {
	text: string;
	timestamp: number;
}

export default function (pi: ExtensionAPI) {
	const drafts: DraftEntry[] = [];

	// ── State Reconstruction ──────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		drafts.length = 0;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === DRAFTS_CUSTOM_TYPE) {
				const data = entry.data as DraftEntry | undefined;
				if (data?.text) drafts.push(data);
			}
		}
	});

	// ── Save drafts on input ──────────────────────────────────────────────

	pi.on("input", async (event, _ctx) => {
		if (event.source === "extension") return { action: "continue" };
		if (!event.text || event.text.trim().length === 0) return { action: "continue" };
		if (event.text.startsWith("/")) return { action: "continue" };

		// Deduplicate: don't save if it's the same as the last draft
		if (drafts.length > 0 && drafts[drafts.length - 1].text === event.text) {
			return { action: "continue" };
		}

		const entry: DraftEntry = { text: event.text, timestamp: Date.now() };
		drafts.push(entry);
		pi.appendEntry(DRAFTS_CUSTOM_TYPE, entry);

		// Keep only last 50
		while (drafts.length > 50) drafts.shift();

		return { action: "continue" };
	});

	// ── Command: /drafts ──────────────────────────────────────────────────

	pi.registerCommand("drafts", {
		description: "Browse and re-send previous drafts",
		handler: async (args, ctx) => {
			if (drafts.length === 0) {
				ctx.ui.notify("No drafts saved yet.", "info");
				return;
			}

			// Most recent first
			const recent = [...drafts].reverse().slice(0, 20);

			if (!ctx.hasUI) {
				const lines = recent.map(
					(d, i) => `${i + 1}. ${d.text.slice(0, 100)}`,
				);
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}

			const displayItems = recent.map((d) => {
				const preview = d.text.length > 80 ? d.text.slice(0, 77) + "…" : d.text;
				return preview;
			});

			const choice = await ctx.ui.select("Previous Drafts:", displayItems);
			if (choice) {
				const idx = displayItems.indexOf(choice);
				if (idx >= 0) {
					pi.sendUserMessage(recent[idx].text);
				}
			}
		},
	});
}
