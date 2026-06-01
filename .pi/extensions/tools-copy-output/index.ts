/**
 * Copy Output Extension - Recreates Codex's Ctrl+O copy last output
 *
 * Commands:
 *   /copy-output       - Copy the last assistant message to clipboard
 *   /copy-output <n>   - Copy the nth last assistant message
 *
 * Tool:
 *   copy_output    - LLM can copy its own output to clipboard
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execSync } from "node:child_process";

function copyToClipboard(text: string): boolean {
	try {
		if (process.platform === "darwin") {
			execSync("pbcopy", { input: text, timeout: 3000 });
		} else if (process.platform === "linux") {
			// Try xclip first, then xsel
			try {
				execSync("xclip -selection clipboard", { input: text, timeout: 3000 });
			} catch {
				execSync("xsel --clipboard --input", { input: text, timeout: 3000 });
			}
		} else if (process.platform === "win32") {
			execSync("clip", { input: text, timeout: 3000 });
		} else {
			return false;
		}
		return true;
	} catch {
		return false;
	}
}

export default function (pi: ExtensionAPI) {
	// ── Tool: copy_output ─────────────────────────────────────────────────

	pi.registerTool({
		name: "copy_output",
		label: "Copy to Clipboard",
		description: "Copy text to the system clipboard. Use when the user asks to copy something.",
		promptSnippet: "Copy text to system clipboard",
		parameters: Type.Object({
			text: Type.String({ description: "Text to copy to clipboard" }),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const success = copyToClipboard(params.text);
			return {
				content: [
					{
						type: "text",
						text: success
							? `Copied to clipboard (${params.text.length} chars).`
							: "Failed to copy to clipboard (no clipboard utility found).",
					},
				],
				details: { success, length: params.text.length },
			};
		},
	});

	// ── Command: /copy-output ─────────────────────────────────────────────

	pi.registerCommand("copy-output", {
		description: "Copy last assistant message to clipboard (or /copy-output <n>)",
		handler: async (args, ctx) => {
			const nStr = (args || "").trim();
			const n = nStr ? parseInt(nStr, 10) : 1;
			if (isNaN(n) || n < 1) {
				ctx.ui.notify("Usage: /copy-output [n] (default: 1 for last message)", "warning");
				return;
			}

			// Get assistant messages from the branch
			const branch = ctx.sessionManager.getBranch();
			const assistantMessages = branch
				.filter((e: any) => e.type === "message" && e.message?.role === "assistant")
				.reverse();

			if (assistantMessages.length === 0) {
				ctx.ui.notify("No assistant messages to copy.", "warning");
				return;
			}

			if (n > assistantMessages.length) {
				ctx.ui.notify(
					`Only ${assistantMessages.length} message(s). Using the oldest.`,
					"warning",
				);
			}

			const targetIdx = Math.min(n - 1, assistantMessages.length - 1);
			const msg = (assistantMessages[targetIdx] as any).message;

			let text = "";
			if (msg) {
				if (typeof msg.content === "string") {
					text = msg.content;
				} else if (Array.isArray(msg.content)) {
					text = msg.content
						.filter((b: any) => b.type === "text" && b.text)
						.map((b: any) => b.text)
						.join("\n\n");
				}
			}

			if (!text) {
				ctx.ui.notify("Message has no text content.", "warning");
				return;
			}

			const success = copyToClipboard(text);
			if (success) {
				const preview = text.length > 80 ? text.slice(0, 77) + "…" : text;
				ctx.ui.notify(`Copied: "${preview}" (${text.length} chars)`, "info");
			} else {
				ctx.ui.notify("No clipboard utility available. Install xclip/xsel (Linux) or use macOS/Windows.", "error");
			}
		},
	});
}
