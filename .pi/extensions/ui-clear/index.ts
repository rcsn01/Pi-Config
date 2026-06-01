/**
 * Clear Extension - Clear all terminal output and start a fresh pi session
 *
 * /clear does two things:
 *   1. Clears the terminal output (screen + scrollback buffer)
 *   2. Starts a fresh pi session with no context carryover
 *
 * The previous session remains resumable via /resume.
 *
 * Commands:
 *   /clear   - Clear terminal output AND start a fresh session
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	// ── Command registration ────────────────────────────────────────────
	//
	// When the user types /clear, pi routes it to this command handler
	// which has ExtensionCommandContext (with newSession, fork, etc.).
	// We do NOT use the "input" event handler because it only provides
	// ExtensionContext (missing newSession).

	pi.registerCommand("clear", {
		description: "clear all terminal output and start a fresh session",
		handler: async (args, ctx) => {
			// Step 1: Clear terminal output (ANSI escape to clear screen + scrollback)
			// \x1b[2J = clear entire screen
			// \x1b[3J = clear scrollback buffer
			// \x1b[H  = move cursor to home
			process.stdout.write("\x1b[2J\x1b[3J\x1b[H");

			// Step 2: Start a fresh pi session (no context carryover)
			try {
				const parentSession = ctx.sessionManager.getSessionFile();

				const result = await ctx.newSession({
					parentSession: parentSession || undefined,
					setup: (_sm) => {
						// Fresh session - no context carryover from previous session
					},
					withSession: async (newCtx) => {
						newCtx.ui.notify(
							"✨ Terminal cleared. Fresh session started. Previous session resumable via /resume.",
							"info",
						);
					},
				});

				if (result.cancelled) {
					ctx.ui.notify("Clear cancelled.", "info");
				}
			} catch (e: any) {
				ctx.ui.notify(
					`Cleared terminal but couldn't start new session: ${e.message}`,
					"warning",
				);
			}
		},
	});
}