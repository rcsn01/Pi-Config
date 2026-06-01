/**
 * Archive Extension - Recreates Codex's `/archive` command
 *
 * From Codex source (slash_command.rs):
 *   SlashCommand::Archive => "archive this session and exit"
 *
 * Archives the current session (marks it complete) and exits.
 *
 * Commands:
 *   /archive   - Archive current session and exit
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("archive", {
		description: "archive this session and exit",
		handler: async (args, ctx) => {
			const sessionName = pi.getSessionName() || "unnamed";
			const sessionFile = ctx.sessionManager.getSessionFile();

			if (!ctx.hasUI) {
				ctx.ui.notify(`Would archive session: ${sessionFile || "ephemeral"}`, "info");
				return;
			}

			const confirmed = await ctx.ui.confirm(
				"Archive Session",
				`Archive "${sessionName}" and exit?\n\n` +
				`Session: ${sessionFile || "ephemeral"}\n` +
				"The session will be marked as complete and remain resumable via /resume.",
			);

			if (!confirmed) return;

			// Persist archive marker
			pi.appendEntry("session-archived", {
				archivedAt: Date.now(),
				reason: "user-requested",
			});

			ctx.ui.notify(
				`Session "${sessionName}" archived. Exiting...`,
				"info",
			);

			// Request shutdown
			ctx.shutdown();
		},
	});
}
