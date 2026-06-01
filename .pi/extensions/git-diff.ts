/**
 * Diff Extension - Recreates Codex's `/diff` command
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { collectWorkingTreeDiff, truncateText } from "./_shared/git.ts";

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "git_diff",
		label: "Git Diff",
		description: "Show git diff for staged, unstaged, and untracked changes. Useful for reviewing changes before committing.",
		promptSnippet: "Show git diff (staged|unstaged|all|summary)",
		promptGuidelines: [
			"Use git_diff when the user asks what changed, wants to review edits, or before committing.",
			"After showing the diff, summarize the changes clearly.",
		],
		parameters: Type.Object({
			mode: StringEnum(["all", "staged", "unstaged", "summary"] as const),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				const diff = await collectWorkingTreeDiff(
					(cmd, args) => pi.exec(cmd, args, { cwd: ctx.cwd }),
					params.mode,
				);
				const display = truncateText(diff, 30000).text;
				return {
					content: [{ type: "text", text: display }],
					details: { mode: params.mode, size: diff.length },
				};
			} catch (e: any) {
				return {
					content: [{ type: "text", text: `Error: ${e.message || String(e)}. Not a git repository?` }],
					details: { error: String(e) },
				};
			}
		},
	});

	pi.registerCommand("diff", {
		description: "Show git diff (staged, unstaged, untracked changes)",
		handler: async (args, ctx) => {
			const mode = (args || "all").trim().toLowerCase() as "all" | "staged" | "unstaged" | "summary";
			if (!["all", "staged", "unstaged", "summary"].includes(mode)) {
				ctx.ui.notify("Usage: /diff [all|staged|unstaged|summary]", "warning");
				return;
			}

			try {
				const output = await collectWorkingTreeDiff(
					(cmd, cmdArgs) => pi.exec(cmd, cmdArgs, { cwd: ctx.cwd }),
					mode,
				);
				if (output.length > 5000 && ctx.hasUI) {
					pi.sendUserMessage(`Show and summarize this git diff:\n\`\`\`\n${output.slice(0, 10000)}\n\`\`\``);
				} else {
					ctx.ui.notify(output, "info");
				}
			} catch (e: any) {
				ctx.ui.notify(`Error: ${e.message}. Not a git repository?`, "error");
			}
		},
	});
}
