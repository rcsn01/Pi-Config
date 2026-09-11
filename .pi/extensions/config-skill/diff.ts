/** Pure classification of Git facts for the Skill update lifecycle. */

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
