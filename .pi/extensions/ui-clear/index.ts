/**
 * Clear Extension - Recreates Codex's `/clear` command EXACTLY
 *
 * From Codex source code (app_event.rs):
 *   ClearUi: "Clear the terminal UI (screen + scrollback), start a
 *   fresh session, and keep the previous chat resumable."
 *
 * Unlike `/new` which only starts a new session, `/clear`:
 *   1. Clears the terminal output (ANSI clear screen + scrollback)
 *   2. Starts a new session (like /new)
 *   3. Previous session remains resumable via /resume
 *
 * From slash_command.rs:
 *   SlashCommand::Clear => "clear the terminal and start a new chat"
 *   available_during_task() => false (disabled while task runs)
 *
 * Commands:
 *   /clear   - Clear terminal AND start new session
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	// ── Input interception: handle /clear before agent starts ────────────

	pi.on("input", async (event, ctx) => {
		if (event.source === "extension") return { action: "continue" };

		const text = event.text?.trim() || "";

		// Match /clear exactly (Codex's /clear takes no args)
		if (text === "/clear") {
			// Step 1: Clear terminal output (ANSI escape to clear screen + scrollback)
			// \x1b[2J = clear entire screen
			// \x1b[3J = clear scrollback buffer
			// \x1b[H  = move cursor to home
			process.stdout.write("\x1b[2J\x1b[3J\x1b[H");

			if (!ctx.hasUI) {
				ctx.ui.notify("Terminal cleared.", "info");
				return { action: "handled" };
			}

			// Step 2: Start a new session (like /new)
			try {
				const parentSession = ctx.sessionManager.getSessionFile();

				await ctx.newSession({
					parentSession: parentSession || undefined,
					setup: (_sm) => {
						// Fresh session, no context carryover
					},
					withSession: async (newCtx) => {
						newCtx.ui.notify(
							"✨ Terminal cleared. New session started. Previous session is resumable via /resume.",
							"info",
						);
					},
				});
			} catch (e: any) {
				ctx.ui.notify(
					`Cleared terminal but couldn't start new session: ${e.message}`,
					"warning",
				);
			}

			return { action: "handled" };
		}

		return { action: "continue" };
	});

	// ── Command registration for slash popup ─────────────────────────────

	pi.registerCommand("clear", {
		description: "clear the terminal and start a new chat",
		handler: async (args, ctx) => {
			// This handler runs when the user types /clear
			// We handle it in the input event above for terminal clearing,
			// but also provide the command for /help listings.
			// The input handler already handled this, but if somehow
			// we get here (e.g., triggered programmatically), do it again.
			process.stdout.write("\x1b[2J\x1b[3J\x1b[H");

			try {
				const parentSession = ctx.sessionManager.getSessionFile();
				await ctx.newSession({
					parentSession: parentSession || undefined,
					setup: (_sm) => {},
					withSession: async (newCtx) => {
						newCtx.ui.notify(
							"✨ Terminal cleared. New session started.",
							"info",
						);
					},
				});
			} catch (e: any) {
				// Already handled by input event
			}
		},
	});
}
