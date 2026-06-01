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

const REVIEW_CUSTOM_TYPE = "code-review";

const ReviewToolParams = Type.Object({
	action: StringEnum(["base", "uncommitted", "commit", "custom"] as const),
	branch: Type.Optional(Type.String({ description: "Base branch name (for base)" })),
	commit: Type.Optional(Type.String({ description: "Commit SHA (for commit)" })),
	instructions: Type.Optional(Type.String({ description: "Custom review focus instructions" })),
});

async function getGitDiff(
	exec: (cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string }>,
	type: string,
	target?: string,
): Promise<{ diff: string; error?: string }> {
	try {
		switch (type) {
			case "base": {
				const { stdout: upstream } = await exec("git", [
					"rev-parse", "--abbrev-ref", `${target}@{upstream}`,
				]);
				const upstreamBranch = upstream.trim();
				const { stdout: mergeBase } = await exec("git", [
					"merge-base", upstreamBranch, "HEAD",
				]);
				const { stdout: diff } = await exec("git", [
					"diff", mergeBase.trim() + "...HEAD",
				]);
				return { diff };
			}
			case "uncommitted": {
				const { stdout: staged } = await exec("git", ["diff", "--cached"]);
				const { stdout: unstaged } = await exec("git", ["diff"]);
				const { stdout: untrackedFiles } = await exec("git", [
					"ls-files", "--others", "--exclude-standard",
				]);
				let untrackedContent = "";
				if (untrackedFiles.trim()) {
					const { stdout: content } = await exec("bash", [
						"-c",
						`git ls-files --others --exclude-standard | head -20 | while read f; do echo "--- $f ---"; cat "$f" 2>/dev/null || echo "(binary)"; done`,
					]);
					untrackedContent = content;
				}
				return { diff: [staged, unstaged, untrackedContent].filter(Boolean).join("\n") || "(no changes)" };
			}
			case "commit": {
				const sha = target || "HEAD";
				const { stdout: diff } = await exec("git", ["show", "--format=fuller", sha]);
				return { diff };
			}
			case "custom": {
				const { stdout: staged } = await exec("git", ["diff", "--cached"]);
				const { stdout: unstaged } = await exec("git", ["diff"]);
				return { diff: [staged, unstaged].filter(Boolean).join("\n") || "(no changes)" };
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
	const truncated = diff.length > maxDiff ? diff.slice(0, maxDiff) + "\n... (truncated)" : diff;
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
		description:
			"Get a git diff for code review. Supports: base (against a branch), uncommitted (working tree changes), " +
			"commit (specific commit), or custom (staged+unstaged with focus instructions). " +
			"Returns the diff and a structured review checklist.",
		promptSnippet: "Get git diff for code review (base|uncommitted|commit|custom)",
		promptGuidelines: [
			"Use code_review when the user asks to review code, check changes before committing, or audit a PR.",
			"After calling code_review, provide a thorough review covering correctness, design, security, performance, style, testing, and documentation.",
			"Be specific in your review: reference file paths and line numbers from the diff, and suggest concrete fixes.",
		],
		parameters: ReviewToolParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const action = params.action;
			const target = params.branch || params.commit || undefined;

			const { diff, error } = await getGitDiff(
				(cmd, args) => pi.exec(cmd, args, { cwd: ctx.cwd }),
				action,
				target,
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

				const choice = await ctx.ui.select("Code Review - choose type:", [
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
						const branch = await ctx.ui.select("Select base branch:", branches);
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
						const commit = await ctx.ui.select("Select commit to review:", commits);
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
