/**
 * Diff Extension - Recreates Codex's `/diff` command
 *
 * Shows git diff inline in the TUI, including staged, unstaged,
 * and untracked files.
 *
 * Commands:
 *   /diff              - Show all changes (staged + unstaged + untracked)
 *   /diff staged       - Show staged changes only
 *   /diff unstaged     - Show unstaged changes only
 *   /diff summary      - Show diffstat summary
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";

export default function (pi: ExtensionAPI) {
	// ── Tool: git_diff ────────────────────────────────────────────────────

	pi.registerTool({
		name: "git_diff",
		label: "Git Diff",
		description:
			"Show git diff for staged, unstaged, and untracked changes. " +
			"Useful for reviewing changes before committing.",
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
				let diff = "";

				switch (params.mode) {
					case "staged": {
						const result = await pi.exec("git", ["diff", "--cached", "--stat"], { cwd: ctx.cwd });
						const detail = await pi.exec("git", ["diff", "--cached"], { cwd: ctx.cwd });
						diff = result.stdout + "\n" + detail.stdout;
						break;
					}
					case "unstaged": {
						const result = await pi.exec("git", ["diff", "--stat"], { cwd: ctx.cwd });
						const detail = await pi.exec("git", ["diff"], { cwd: ctx.cwd });
						diff = result.stdout + "\n" + detail.stdout;
						break;
					}
					case "summary": {
						const result = await pi.exec("git", ["diff", "--stat"], { cwd: ctx.cwd });
						const staged = await pi.exec("git", ["diff", "--cached", "--stat"], { cwd: ctx.cwd });
						const untracked = await pi.exec("git", ["ls-files", "--others", "--exclude-standard"], { cwd: ctx.cwd });
						diff = [
							staged.stdout ? "### Staged\n" + staged.stdout : "### No staged changes",
							"",
							result.stdout ? "### Unstaged\n" + result.stdout : "### No unstaged changes",
							"",
							untracked.stdout.trim() ? "### Untracked\n" + untracked.stdout : "### No untracked files",
						].join("\n");
						break;
					}
					case "all":
					default: {
						const staged = await pi.exec("git", ["diff", "--cached"], { cwd: ctx.cwd });
						const unstaged = await pi.exec("git", ["diff"], { cwd: ctx.cwd });
						const untrackedFiles = await pi.exec("git", ["ls-files", "--others", "--exclude-standard"], { cwd: ctx.cwd });
						const parts: string[] = [];
						if (staged.stdout.trim()) parts.push("### Staged Changes\n" + staged.stdout);
						if (unstaged.stdout.trim()) parts.push("### Unstaged Changes\n" + unstaged.stdout);
						if (untrackedFiles.stdout.trim()) {
							parts.push("### Untracked Files\n" + untrackedFiles.stdout);
						}
						diff = parts.join("\n\n") || "(no changes)";
					}
				}

				const maxLen = 30000;
				const display = diff.length > maxLen ? diff.slice(0, maxLen) + "\n... (truncated)" : diff;

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

	// ── Command: /diff ────────────────────────────────────────────────────

	pi.registerCommand("diff", {
		description: "Show git diff (staged, unstaged, untracked changes)",
		handler: async (args, ctx) => {
			const mode = (args || "all").trim().toLowerCase();

			if (!["all", "staged", "unstaged", "summary"].includes(mode)) {
				ctx.ui.notify("Usage: /diff [all|staged|unstaged|summary]", "warning");
				return;
			}

			try {
				let output = "";

				if (mode === "summary") {
					const result = await pi.exec("git", ["diff", "--stat"], { cwd: ctx.cwd });
					const staged = await pi.exec("git", ["diff", "--cached", "--stat"], { cwd: ctx.cwd });
					const untracked = await pi.exec("git", ["ls-files", "--others", "--exclude-standard"], { cwd: ctx.cwd });
					const status = await pi.exec("git", ["status", "--short"], { cwd: ctx.cwd });
					output = [
						"--- Git Status ---",
						status.stdout || "(clean)",
						"",
						staged.stdout ? "--- Staged ---\n" + staged.stdout : "--- No staged changes ---",
						"",
						result.stdout ? "--- Unstaged ---\n" + result.stdout : "--- No unstaged changes ---",
						"",
						untracked.stdout.trim() ? "--- Untracked ---\n" + untracked.stdout : "--- No untracked files ---",
					].join("\n");
				} else {
					const cmds: Record<string, string[][]> = {
						staged: [["diff", "--cached"]],
						unstaged: [["diff"]],
						all: [["diff", "--cached"], ["diff"], ["ls-files", "--others", "--exclude-standard"]],
					};

					const parts: string[] = [];
					for (const cmd of cmds[mode] || cmds.all) {
						const result = await pi.exec("git", cmd, { cwd: ctx.cwd });
						if (result.stdout.trim()) {
							const label = cmd[0] === "ls-files" ? "Untracked files" : `git ${cmd.join(" ")}`;
							parts.push(`--- ${label} ---\n${result.stdout}`);
						}
					}
					output = parts.join("\n\n") || "(no changes)";
				}

				if (output.length > 5000 && ctx.hasUI) {
					// For large diffs, send to agent for summarization
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
