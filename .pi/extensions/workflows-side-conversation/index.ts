/**
 * Side Conversation Extension - Recreates Codex's `/side` command
 *
 * Starts an ephemeral side conversation from the current session
 * without disrupting the main thread. The side conversation is a
 * fork that runs independently.
 *
 * Commands:
 *   /side                    - Start a side conversation
 *   /side <prompt>           - Start with an inline prompt
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("side", {
		description: "Start an ephemeral side conversation (fork + run)",
		handler: async (args, ctx) => {
			const prompt = (args || "").trim();
			const branch = ctx.sessionManager.getBranch();

			if (branch.length === 0) {
				ctx.ui.notify("No conversation to fork from.", "warning");
				return;
			}

			// Get the parent session file
			const parentSession = ctx.sessionManager.getSessionFile();

			// Create and switch to a new session with context from current
			try {
				await ctx.newSession({
					parentSession: parentSession || undefined,
					setup: async (sm) => {
						// Copy the last few entries as context
						const recentEntries = branch.slice(-10);
						for (const entry of recentEntries) {
							if (entry.type === "message") {
								sm.appendMessage((entry as any).message);
							} else if (entry.type === "custom" && (entry as any).customType === "goal-state") {
								// Copy goal state
								sm.appendEntry("goal-state", (entry as any).data);
							}
						}
					},
					withSession: async (newCtx) => {
						newCtx.ui.notify("⚡ Side conversation started. /resume to return to the main thread.", "info");

						if (prompt) {
							await newCtx.sendUserMessage(prompt);
						} else {
							// Wait for user input
							newCtx.ui.notify(
								"Side conversation active. Type your question or task.",
								"info",
							);
						}
					},
				});
			} catch (e: any) {
				ctx.ui.notify(`Failed to start side conversation: ${e.message}`, "error");
			}
		},
	});
}
