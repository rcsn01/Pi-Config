/**
 * Turn Notify Extension - Recreates Codex's desktop notification feature
 *
 * Sends desktop notifications when the agent completes a turn.
 * Supports macOS (osascript), Linux (notify-send), and fallback terminal bell.
 *
 * Commands:
 *   /notify on       - Enable desktop notifications
 *   /notify off      - Disable desktop notifications
 *   /notify status   - Show notification status
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const NOTIFY_CUSTOM_TYPE = "turn-notify-state";

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
	let enabled = false;

	// ── State Reconstruction ──────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		enabled = false;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === NOTIFY_CUSTOM_TYPE) {
				const data = entry.data as { enabled: boolean } | undefined;
				if (data) enabled = data.enabled;
			}
		}
	});

	const persist = () => {
		pi.appendEntry(NOTIFY_CUSTOM_TYPE, { enabled });
	};

	// ── Notify on Agent End ───────────────────────────────────────────────

	pi.on("agent_end", async (event) => {
		if (!enabled) return;

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
		ctx.ui.setStatus("notify", enabled ? "🔔 ON" : undefined);
	});

	// ── Command: /notify ──────────────────────────────────────────────────

	pi.registerCommand("notify", {
		description: "Toggle desktop notifications on turn complete (on|off|status)",
		handler: async (args, ctx) => {
			const trimmed = (args || "").trim().toLowerCase();

			if (trimmed === "on" || trimmed === "enable") {
				if (enabled) {
					ctx.ui.notify("Notifications already enabled.", "info");
					return;
				}
				enabled = true;
				persist();
				await sendDesktopNotification("Pi", "Notifications enabled ✓");
				ctx.ui.notify("Desktop notifications enabled.", "info");
			} else if (trimmed === "off" || trimmed === "disable") {
				if (!enabled) {
					ctx.ui.notify("Notifications already disabled.", "info");
					return;
				}
				enabled = false;
				persist();
				ctx.ui.notify("Desktop notifications disabled.", "info");
			} else {
				ctx.ui.notify(
					`Notifications: ${enabled ? "ON 🔔" : "OFF"}. Use /notify on|off`,
					"info",
				);
			}
		},
	});
}
