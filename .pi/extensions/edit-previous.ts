/**
 * Edit Previous Extension - Recreates Codex's Esc-to-edit-previous-messages
 *
 * Commands:
 *   /edit-previous      - Fork from and edit the last user message
 *   /edit-previous <n>  - Fork from the nth previous user message
 *
 * Walks back through the transcript and lets you edit and resubmit
 * from a previous point (like Codex's double-Esc on empty composer).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("edit-previous", {
		description: "Edit and re-send a previous message (like Esc on empty composer)",
		handler: async (args, ctx) => {
			const nStr = (args || "").trim();
			const n = nStr ? parseInt(nStr, 10) : 1;
			if (isNaN(n) || n < 1) {
				ctx.ui.notify("Usage: /edit-previous [n] (default: 1 for last message)", "warning");
				return;
			}

			// Get branch entries
			const branch = ctx.sessionManager.getBranch();
			if (branch.length === 0) {
				ctx.ui.notify("No messages to edit.", "warning");
				return;
			}

			// Find user messages (latest first)
			const userMessages = branch
				.filter((e: any) => e.type === "message" && e.message?.role === "user")
				.reverse();

			if (userMessages.length === 0) {
				ctx.ui.notify("No previous user messages found.", "warning");
				return;
			}

			if (n > userMessages.length) {
				ctx.ui.notify(
					`Only ${userMessages.length} previous message(s). Using the oldest.`,
					"warning",
				);
			}

			const targetIdx = Math.min(n - 1, userMessages.length - 1);
			const target = userMessages[targetIdx];

			if (!target || !target.id) {
				ctx.ui.notify("Could not find target message.", "error");
				return;
			}

			// Extract text from message
			let messageText = "";
			const msg = (target as any).message;
			if (msg) {
				if (typeof msg.content === "string") {
					messageText = msg.content;
				} else if (Array.isArray(msg.content)) {
					const textBlock = msg.content.find((b: any) => b.type === "text");
					if (textBlock) messageText = textBlock.text;
				}
			}

			if (!ctx.hasUI) {
				ctx.ui.notify(`Would edit: ${messageText.slice(0, 100)}...`, "info");
				return;
			}

			// Show confirmation with preview
			const preview = messageText.length > 150
				? messageText.slice(0, 147) + "…"
				: messageText;
			const confirmed = await ctx.ui.confirm(
				"Edit Previous Message",
				`Fork from message #${n} and edit:\n\n"${preview}"\n\nThis will fork the session from this point. Continue?`,
			);

			if (!confirmed) return;

			// Fork from this entry
			try {
				await ctx.fork(target.id, {
					withSession: async (newCtx) => {
						// Place the message text back in the input
						// The fork should restore the editor, but we can also send it
						newCtx.ui.notify(
							`Forked at message #${n}. Edit and resubmit, or /resume to go back.`,
							"info",
						);
					},
				});
			} catch (e: any) {
				ctx.ui.notify(`Failed to fork: ${e.message}`, "error");
			}
		},
	});
}
