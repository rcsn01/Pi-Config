/**
 * update-skill — interpreting git output into skill statuses and previews.
 *
 * Pure functions over the raw `git log`/`git diff` output produced by git.ts,
 * plus the menu label builder. No I/O here — everything is unit-testable.
 */

export type SkillStatus =
	| "up-to-date"
	| "behind"
	| "not-installed"
	| "removed";

export interface SkillFacts {
	/** Whether the skill is installed in `.pi/skills/<name>/`. */
	installed: boolean;
	/** Pinned upstream commit (from state). */
	pinned: string | null;
	/** Current upstream head commit for the skill's source branch. */
	head: string | null;
	/** Whether the skill directory still exists upstream. */
	existsUpstream: boolean;
}

/** Non-empty lines in `git log --oneline` output = commits between the range endpoints. */
export function countCommits(logOutput: string): number {
	return logOutput
		.split("\n")
		.filter((line) => line.trim().length > 0).length;
}

/**
 * Priority: not installed → "not-installed"; installed but gone upstream →
 * "removed"; head unknown (fetch failed) → "up-to-date" (never alarm on
 * network failure); installed but unpinned → "not-installed"; pinned == head
 * or no commits for this path → "up-to-date"; else "behind".
 */
export function classifyStatus(facts: SkillFacts, commitsBehind: number): SkillStatus {
	if (!facts.installed) return "not-installed";
	if (facts.head === null) return "up-to-date";
	if (!facts.existsUpstream) return "removed";
	if (facts.pinned === null) return "not-installed";
	if (facts.pinned === facts.head || commitsBehind === 0) return "up-to-date";
	return "behind";
}

export function statusLabel(status: SkillStatus, commitsBehind: number): string {
	switch (status) {
		case "up-to-date":
			return "up to date";
		case "behind":
			return `${commitsBehind} commit${commitsBehind === 1 ? "" : "s"} behind`;
		case "not-installed":
			return "not installed";
		case "removed":
			return "removed upstream";
	}
}

/** Menu label for a skill, e.g. `code-review — 2 commits behind`. */
export function skillMenuLabel(name: string, status: SkillStatus, commitsBehind: number): string {
	return `${name} — ${statusLabel(status, commitsBehind)}`;
}

const PREVIEW_MAX_LINES = 30;
const PREVIEW_FOOTER = "… (diff truncated)";

/**
 * Build the "what does this update contain" message shown in the confirm
 * dialog: latest commit messages, `--stat` summary, and a bounded SKILL.md
 * diff preview (first `maxLines` lines of diff hunks).
 */
export function buildUpdatePreview(
	logOutput: string,
	statOutput: string,
	diffOutput: string,
	maxLines: number = PREVIEW_MAX_LINES,
): string {
	const sections: string[] = [];

	const commits = logOutput
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	if (commits.length > 0) {
		sections.push(
			`Commits (${commits.length}):\n${commits.slice(0, 15).map((c) => `  ${c}`).join("\n")}`,
		);
	}

	if (statOutput.trim().length > 0) {
		sections.push(`Changed files:\n${statOutput.split("\n").map((l) => `  ${l}`).join("\n")}`);
	}

	sections.push(`SKILL.md preview:\n${truncateDiff(diffOutput, maxLines)}`);
	return sections.join("\n\n");
}

/** Raw diff input → diff body (first N lines, with a truncation footer). */
export function truncateDiff(diffText: string, maxLines: number = PREVIEW_MAX_LINES): string {
	const lines = diffText.split("\n");
	if (lines.length <= maxLines) return diffText.trimEnd();
	return `${lines.slice(0, maxLines).join("\n")}\n${PREVIEW_FOOTER}`;
}
