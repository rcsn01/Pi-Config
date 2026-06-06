/**
 * Turn Notify Extension - Recreates Codex's desktop notification feature
 *
 * Sends desktop notifications when the agent completes a turn.
 * Supports macOS (osascript), Linux (notify-send), and fallback terminal bell.
 *
 * Command:
 *   /notify          - Show that desktop notifications are always enabled
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

async function sendDesktopNotification(title: string, message: string): Promise<void> {
	const { execFile } = await import("node:child_process");
	const run = (cmd: string, args: string[]) =>
		new Promise<void>((resolve) => {
			execFile(cmd, args, { timeout: 5000 }, () => resolve());
		});
	try {
		if (process.platform === "darwin") {
			await run("osascript", ["-e", `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`]);
		} else if (process.platform === "linux") {
			await run("notify-send", [title, message]);
		} else {
			// Windows toast or fallback
			console.log("\x07"); // terminal bell
		}
	} catch {
		// Silently fail - notifications are best-effort
	}
}

export default function (pi: ExtensionAPI) {
	// ── Notify on Agent End ───────────────────────────────────────────────

	pi.on("agent_end", async (event) => {
		// Get the last assistant message
		const messages = event.messages || [];
		const lastAssistant = [...messages].reverse().find(
			(m: any) => m.role === "assistant" && m.content,
		);

		if (lastAssistant) {
			let text = "";
			if (typeof lastAssistant.content === "string") {
				text = lastAssistant.content;
			} else if (Array.isArray(lastAssistant.content)) {
				const textBlock = lastAssistant.content.find(
					(b: any) => b.type === "text",
				);
				if (textBlock) text = textBlock.text;
			}

			const preview = text.slice(0, 120).replace(/\n/g, " ");
			const display = preview.length < text.length ? preview + "…" : preview;

			await sendDesktopNotification("Pi - Turn Complete", display || "Task completed");
		} else {
			await sendDesktopNotification("Pi - Turn Complete", "Agent finished processing");
		}
	});

	// ── Notify Status Widget ──────────────────────────────────────────────

	pi.on("turn_end", async (_event, ctx) => {
		ctx.ui.setStatus("notify", "🔔 ON");
	});

	// ── Command: /notify ──────────────────────────────────────────────────

	pi.registerCommand("notify", {
		description: "Desktop notifications are always enabled on turn complete",
		handler: async (_args, ctx) => {
			ctx.ui.notify("Desktop notifications are always enabled 🔔", "info");
		},
	});
}
