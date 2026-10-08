/**
 * Turn Notify Extension - Recreates Codex's desktop notification feature
 *
 * Sends notifications after the agent settles, including retries and compaction.
 * Supports desktop notifications and cmux in-app notifications.
 *
 * Command:
 *   /notify          - Send a test notification
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

async function runCommand(cmd: string, args: string[]): Promise<void> {
	const { execFile } = await import("node:child_process");
	await new Promise<void>((resolve) => {
		execFile(cmd, args, { timeout: 5000 }, () => resolve());
	});
}

async function sendDesktopNotification(title: string, message: string): Promise<void> {
	try {
		if (process.platform === "darwin") {
			await runCommand("osascript", ["-e", `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`]);
		} else if (process.platform === "linux") {
			await runCommand("notify-send", [title, message]);
		} else {
			// Windows toast or fallback
			console.log("\x07"); // terminal bell
		}
	} catch {
		// Silently fail - notifications are best-effort
	}
}

async function sendCmuxNotification(title: string, message: string): Promise<void> {
	if (!process.env.CMUX_WORKSPACE_ID && !process.env.CMUX_SURFACE_ID && !process.env.CMUX_BUNDLED_CLI_PATH) return;

	const cmux = process.env.CMUX_BUNDLED_CLI_PATH || "cmux";
	try {
		await runCommand(cmux, ["notify", "--title", title, "--body", message]);
	} catch {
		// Silently fail - notifications are best-effort
	}
}

async function sendNotifications(title: string, message: string): Promise<void> {
	await Promise.all([
		sendDesktopNotification(title, message),
		sendCmuxNotification(title, message),
	]);
}

export function createNotificationExtension(notify = sendNotifications) {
	return (pi: ExtensionAPI) => {
		let pendingMessage: string | undefined;
		const reset = () => { pendingMessage = undefined; };
		pi.on("session_start", reset);
		pi.on("session_shutdown", reset);
		pi.on("agent_start", reset);

		// A low-level run may still be followed by compaction, retries, or queued work.
		// Capture its preview here, but dispatch only at final settlement.
		pi.on("agent_end", (event) => {
			// Get the last assistant message
			const messages = event.messages || [];
			const lastAssistant = [...messages].reverse().find(
				(message) => message.role === "assistant",
			);

			if (lastAssistant) {
				let text = "";
				if (typeof lastAssistant.content === "string") {
					text = lastAssistant.content;
				} else if (Array.isArray(lastAssistant.content)) {
					const textBlock = lastAssistant.content.find(
						(block) => block.type === "text",
					);
					if (textBlock) text = textBlock.text;
				}

				const preview = text.slice(0, 120).replace(/\n/g, " ");
				const display = preview.length < text.length ? preview + "…" : preview;

				pendingMessage = display || "Task completed";
			} else {
				pendingMessage = "Agent finished processing";
			}
		});

		pi.on("agent_settled", async () => {
			const message = pendingMessage;
			reset();
			if (message !== undefined) await notify("Pi - Turn Complete", message);
		});

		// ── Command: /notify ──────────────────────────────────────────────────

		pi.registerCommand("notify", {
			description: "Send a test desktop and cmux notification",
			handler: async (_args, ctx) => {
				await notify("Pi", "Notifications are enabled ✓");
				ctx.ui.notify("Sent desktop and cmux notification test.", "info");
			},
		});
	};
}

export default createNotificationExtension();
