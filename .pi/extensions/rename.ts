/**
 * Thread Rename Extension - Recreates Codex's `/rename` command
 *
 * From Codex source (slash_command.rs):
 *   SlashCommand::Rename => "rename the current thread"
 *   supports_inline_args() => true  (can do /rename <name>)
 *   available_during_task() => true (available while agent runs)
 *
 * Pi already has `/name` for session naming. This adds the `/rename`
 * alias that matches Codex.
 *
 * Commands:
 *   /rename         - Interactive rename prompt
 *   /rename <name>  - Rename thread directly
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("rename", {
		description: "rename the current thread",
		handler: async (args, ctx) => {
			const name = (args || "").trim();

			if (!name) {
				if (!ctx.hasUI) {
					ctx.ui.notify("Usage: /rename <name>", "info");
					return;
				}
				const newName = await ctx.ui.input("New thread name:");
				if (!newName) return;
				pi.setSessionName(newName);
				ctx.ui.notify(`Thread renamed to: "${newName}"`, "info");
				return;
			}

			pi.setSessionName(name);
			ctx.ui.notify(`Thread renamed to: "${name}"`, "info");
		},
	});
}
