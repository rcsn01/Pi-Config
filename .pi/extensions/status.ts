/**
 * Status Extension - Recreates Codex's `/status` command
 *
 * Shows session configuration, token usage, model info, and workspace details.
 *
 * Commands:
 *   /status             - Show full session status
 *   /status brief       - Show brief status summary
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("status", {
		description: "Show session configuration and status",
		handler: async (args, ctx) => {
			const brief = (args || "").trim() === "brief";

			// Gather status info
			const sessionFile = ctx.sessionManager.getSessionFile();
			const entryCount = ctx.sessionManager.getBranch().length;
			const leafEntry = ctx.sessionManager.getLeafEntry();

			// Count messages by type
			const entries = ctx.sessionManager.getBranch();
			const userMessages = entries.filter((e: any) => e.type === "message" && e.message?.role === "user").length;
			const assistantMessages = entries.filter((e: any) => e.type === "message" && e.message?.role === "assistant").length;
			const toolResults = entries.filter((e: any) => e.type === "toolResult").length;

			const usage = ctx.getContextUsage();

			const cwd = ctx.cwd;

			if (brief) {
				const lines = [
					`📁 ${sessionFile || "ephemeral"}  ·  ✉️ ${entryCount} entries  ·  ${userMessages} prompts`,
					usage ? `🧠 ~${Math.round(usage.tokens / 1000)}k tokens` : "",
					`📂 ${cwd}`,
				].filter(Boolean);
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}

			const lines = [
				"═══════════════════════════════════",
				"  📊 Session Status",
				"═══════════════════════════════════",
				"",
				`  Session:    ${sessionFile || "ephemeral (not saved)"}`,
				`  Directory:  ${cwd}`,
				"",
				"  ── Messages ──",
				`  User msgs:      ${userMessages}`,
				`  Assistant msgs: ${assistantMessages}`,
				`  Tool results:   ${toolResults}`,
				`  Total entries:  ${entryCount}`,
				"",
			];

			if (usage) {
				lines.push("  ── Context ──");
				lines.push(`  Tokens:    ${usage.tokens?.toLocaleString() || "unknown"}`);
				if (usage.maxTokens) {
					const pct = ((usage.tokens / usage.maxTokens) * 100).toFixed(1);
					lines.push(`  Max:       ${usage.maxTokens?.toLocaleString()} (${pct}%)`);
				}
				lines.push("");
			}

			if (leafEntry) {
				lines.push(`  ── Position ──`);
				lines.push(`  Leaf:  ${leafEntry.id}`);
				lines.push("");
			}

			lines.push("═══════════════════════════════════");

			if (ctx.hasUI) {
				ctx.ui.notify(lines.join("\n"), "info");
			} else {
				ctx.ui.notify(lines.join("\n"), "info");
			}
		},
	});
}
