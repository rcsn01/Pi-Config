/**
 * Code Review Extension - Recreates Codex's `/review` feature
 *
 * Commands:
 *   /review                  - Open review preset picker
 *   /review base <branch>    - Review against a base branch
 *   /review uncommitted      - Review uncommitted changes
 *   /review commit [sha]     - Review a specific commit
 *   /review <instructions>   - Custom review instructions
 *
 * LLM Tool: `code_review` - Gets git diff and provides structured review prompt
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { collectWorkingTreeDiff, runGit, truncateText } from "../_shared/git.ts";

const REVIEW_CUSTOM_TYPE = "code-review";

const ReviewToolParams = Type.Object({
	action: StringEnum(["base", "uncommitted", "commit", "custom"] as const),
	branch: Type.Optional(Type.String({ description: "Base branch name (for base)" })),
	commit: Type.Optional(Type.String({ description: "Commit SHA (for commit)" })),
	instructions: Type.Optional(Type.String({ description: "Custom review focus instructions" })),
});

async function getGitDiff(
	cwd: string,
	type: string,
	target?: string,
	signal?: AbortSignal,
): Promise<{ diff: string; error?: string }> {
	try {
		switch (type) {
			case "base": {
				const { stdout: upstream } = await runGit(cwd, [
					"rev-parse", "--abbrev-ref", `${target}@{upstream}`,
				], { signal });
				const upstreamBranch = upstream.trim();
				const { stdout: mergeBase } = await runGit(cwd, [
					"merge-base", upstreamBranch, "HEAD",
				], { signal });
				const { stdout: diff } = await runGit(cwd, [
					"diff", mergeBase.trim() + "...HEAD",
				], { signal });
				return { diff };
			}
			case "uncommitted": {
				return { diff: await collectWorkingTreeDiff(cwd, "uncommitted", { includeUntrackedContent: true, signal }) };
			}
			case "commit": {
				const sha = target || "HEAD";
				const { stdout: diff } = await runGit(cwd, ["show", "--format=fuller", sha], { signal });
				return { diff };
			}
			case "custom": {
				return { diff: await collectWorkingTreeDiff(cwd, "custom", { signal }) };
			}
			default:
				return { diff: "", error: `Unknown review type: ${type}` };
		}
	} catch (e: any) {
		return { diff: "", error: e.message || String(e) };
	}
}

function buildReviewPrompt(action: string, target: string | undefined, instructions: string | undefined, diff: string): string {
	const headerMap: Record<string, string> = {
		base: `against base branch \`${target}\``,
		uncommitted: "of uncommitted changes",
		commit: `of commit \`${target || "HEAD"}\``,
		custom: "with custom instructions",
	};

	let prompt = `## Code Review: ${headerMap[action] || action}\n\n`;

	if (instructions) {
		prompt += `**Focus:** ${instructions}\n\n`;
	}

	const maxDiff = 20000;
	const truncation = truncateText(diff, maxDiff);
	const truncated = truncation.text;
	prompt += `### Changes\n\`\`\`diff\n${truncated || "(no changes detected)"}\n\`\`\`\n\n`;

	prompt += `### Review Checklist
Please provide a thorough review covering:

1. **Summary** - What changed and why (infer intent from the code)
2. **Correctness** - Bugs, logic errors, off-by-one, race conditions, edge cases
3. **Design** - Architecture, coupling, separation of concerns, DRY violations
4. **Security** - Injection risks, auth/authz issues, exposed secrets, unsafe patterns
5. **Performance** - N+1 queries, unnecessary allocations, blocking operations
6. **Style & Naming** - Inconsistent naming, unclear identifiers, formatting issues
7. **Testing** - Missing tests, untestable code, test gaps for changed paths
8. **Documentation** - Missing or outdated comments/docstrings for public APIs
9. **Overall Risk** - Severity assessment: low / medium / high / critical

Be specific: reference file paths, line numbers from the diff, and suggest concrete fixes.`;

	return prompt;
}

export default function (pi: ExtensionAPI) {
	// ── Tool: code_review ─────────────────────────────────────────────────

	pi.registerTool({
		name: "code_review",
		label: "Code Review",
		description: "Collect a git diff and return structured review instructions.",
		promptSnippet: "Review code",
		parameters: ReviewToolParams,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const action = params.action;
			const target = params.branch || params.commit || undefined;

			const { diff, error } = await getGitDiff(
				ctx.cwd,
				action,
				target,
				signal,
			);

			if (error) {
				return {
					content: [{ type: "text", text: `Error getting diff for review: ${error}` }],
					details: { error },
				};
			}

			// Persist review entry
			pi.appendEntry(REVIEW_CUSTOM_TYPE, {
				action: `review_${action}`,
				target,
				diffSize: diff.length,
				timestamp: Date.now(),
			});

			const prompt = buildReviewPrompt(action, target, params.instructions, diff);

			return {
				content: [{ type: "text", text: prompt }],
				details: { action, target, diffSize: diff.length },
			};
		},
	});

	// ── Command: /review ──────────────────────────────────────────────────

	pi.registerCommand("review", {
		description: "Review code - base branch, uncommitted changes, commit, or custom",
		handler: async (args, ctx) => {
			const trimmed = (args || "").trim();

			if (!trimmed) {
				if (!ctx.hasUI) {
					ctx.ui.notify(
						"/review base <branch> | /review uncommitted | /review commit [sha] | /review <instructions>",
						"info",
					);
					return;
				}

				const choice = await ctx.ui.select("Choose review type", [
					"Review against base branch (PR review)",
					"Review uncommitted changes (working tree)",
					"Review a specific commit",
					"Custom review with instructions",
				]);

				if (!choice) return;

				if (choice.includes("base branch")) {
					try {
						const { stdout } = await pi.exec("git", [
							"branch", "--format=%(refname:short)",
						]);
						const branches = stdout.split("\n").map((b) => b.trim()).filter(Boolean);
						if (branches.length === 0) {
							ctx.ui.notify("No branches found.", "warning");
							return;
						}
						const branch = await ctx.ui.select("Select base branch", branches);
						if (!branch) return;
						pi.sendUserMessage(
							`Please review the changes against the \`${branch}\` branch. ` +
							`Use the code_review tool with action=base and branch=${branch}.`,
						);
					} catch {
						ctx.ui.notify("Not a git repository.", "warning");
					}
				} else if (choice.includes("uncommitted")) {
					pi.sendUserMessage(
						"Please review all uncommitted changes in the working tree. " +
						"Use the code_review tool with action=uncommitted.",
					);
				} else if (choice.includes("commit")) {
					try {
						const { stdout } = await pi.exec("git", [
							"log", "--oneline", "-20",
						]);
						const commits = stdout.split("\n").map((c) => c.trim()).filter(Boolean);
						if (commits.length === 0) {
							ctx.ui.notify("No commits found.", "warning");
							return;
						}
						const commit = await ctx.ui.select("Select commit to review", commits);
						if (!commit) return;
						const sha = commit.split(" ")[0];
						pi.sendUserMessage(
							`Please review commit \`${sha}\`. ` +
							`Use the code_review tool with action=commit and commit=${sha}.`,
						);
					} catch {
						ctx.ui.notify("Not a git repository.", "warning");
					}
				} else if (choice.includes("Custom")) {
					const instructions = await ctx.ui.input("What should the review focus on?");
					if (!instructions) return;
					pi.sendUserMessage(
						`Please review the code with focus on: ${instructions}. ` +
						`Use the code_review tool with action=custom and instructions="${instructions}".`,
					);
				}
				return;
			}

			// Parse args
			const parts = trimmed.split(/\s+/);
			const subcmd = parts[0];
			const rest = parts.slice(1).join(" ");

			switch (subcmd) {
				case "base":
					if (!rest) {
						ctx.ui.notify("Usage: /review base <branch-name>", "warning");
						return;
					}
					pi.sendUserMessage(
						`Please review the changes against the \`${rest}\` branch. ` +
						`Use the code_review tool with action=base and branch=${rest}.`,
					);
					break;
				case "uncommitted":
					pi.sendUserMessage(
						"Please review all uncommitted changes. " +
						"Use the code_review tool with action=uncommitted.",
					);
					break;
				case "commit":
					pi.sendUserMessage(
						`Please review commit \`${rest || "HEAD"}\`. ` +
						`Use the code_review tool with action=commit and commit=${rest || "HEAD"}.`,
					);
					break;
				default:
					// Custom instructions
					pi.sendUserMessage(
						`Please review the code with focus on: ${trimmed}. ` +
						`Use the code_review tool with action=custom and instructions="${trimmed}".`,
					);
					break;
			}
		},
	});
}
