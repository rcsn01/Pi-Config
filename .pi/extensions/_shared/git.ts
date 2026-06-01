export interface ExecFn {
	(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }>;
}

export type GitDiffMode = "all" | "staged" | "unstaged" | "summary" | "uncommitted" | "custom";

export async function isGitRepo(exec: ExecFn): Promise<boolean> {
	try {
		const result = await exec("git", ["rev-parse", "--is-inside-work-tree"]);
		return result.stdout.trim() === "true";
	} catch {
		return false;
	}
}

export function truncateText(text: string, maxChars: number): { text: string; truncated: boolean; omitted: number } {
	if (text.length <= maxChars) return { text, truncated: false, omitted: 0 };
	return { text: text.slice(0, maxChars) + `\n... [truncated ${text.length - maxChars} chars]`, truncated: true, omitted: text.length - maxChars };
}

export async function readSmallUntrackedFiles(exec: ExecFn, maxFiles = 20, maxBytesPerFile = 20_000): Promise<string> {
	const { stdout } = await exec("git", ["ls-files", "--others", "--exclude-standard"]);
	const allFiles = stdout.split("\n").map((f) => f.trim()).filter(Boolean);
	const files = allFiles.slice(0, maxFiles);
	const parts: string[] = [];
	for (const file of files) {
		try {
			const { stdout: content } = await exec("bash", ["-lc", `f=$1; if [ -f "$f" ]; then bytes=$(wc -c < "$f" | tr -d ' '); if [ "$bytes" -le ${maxBytesPerFile} ]; then cat "$f"; else printf '[skipped: %s bytes]' "$bytes"; fi; fi`, "--", file]);
			parts.push(`--- ${file} ---\n${content}`);
		} catch {
			parts.push(`--- ${file} ---\n[unreadable or binary]`);
		}
	}
	if (allFiles.length > maxFiles) parts.push(`... [${allFiles.length - maxFiles} more untracked files omitted]`);
	return parts.join("\n\n");
}

export async function collectWorkingTreeDiff(exec: ExecFn, mode: GitDiffMode = "all", options: { includeUntrackedContent?: boolean } = {}): Promise<string> {
	switch (mode) {
		case "staged": {
			const stat = await exec("git", ["diff", "--cached", "--stat"]);
			const detail = await exec("git", ["diff", "--cached"]);
			return [stat.stdout, detail.stdout].filter(Boolean).join("\n") || "(no staged changes)";
		}
		case "unstaged": {
			const stat = await exec("git", ["diff", "--stat"]);
			const detail = await exec("git", ["diff"]);
			return [stat.stdout, detail.stdout].filter(Boolean).join("\n") || "(no unstaged changes)";
		}
		case "summary": {
			const status = await exec("git", ["status", "--short"]);
			const unstaged = await exec("git", ["diff", "--stat"]);
			const staged = await exec("git", ["diff", "--cached", "--stat"]);
			const untracked = await exec("git", ["ls-files", "--others", "--exclude-standard"]);
			return [
				status.stdout.trim() ? "### Status\n" + status.stdout : "### Status\n(clean)",
				staged.stdout ? "### Staged\n" + staged.stdout : "### No staged changes",
				unstaged.stdout ? "### Unstaged\n" + unstaged.stdout : "### No unstaged changes",
				untracked.stdout.trim() ? "### Untracked\n" + untracked.stdout : "### No untracked files",
			].join("\n\n");
		}
		case "custom": {
			const staged = await exec("git", ["diff", "--cached"]);
			const unstaged = await exec("git", ["diff"]);
			return [staged.stdout, unstaged.stdout].filter(Boolean).join("\n") || "(no changes)";
		}
		case "uncommitted":
		case "all":
		default: {
			const status = await exec("git", ["status", "--short"]);
			const staged = await exec("git", ["diff", "--cached"]);
			const unstaged = await exec("git", ["diff"]);
			const untracked = options.includeUntrackedContent
				? await readSmallUntrackedFiles(exec, 20, 20_000)
				: (await exec("git", ["ls-files", "--others", "--exclude-standard"])).stdout;
			const parts: string[] = [];
			if (status.stdout.trim()) parts.push("### Status\n" + status.stdout);
			if (staged.stdout.trim()) parts.push("### Staged Changes\n" + staged.stdout);
			if (unstaged.stdout.trim()) parts.push("### Unstaged Changes\n" + unstaged.stdout);
			if (untracked.trim()) parts.push(options.includeUntrackedContent ? "### Untracked File Contents\n" + untracked : "### Untracked Files\n" + untracked);
			return parts.join("\n\n") || "(no changes)";
		}
	}
}
