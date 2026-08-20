/**
 * update-skill — source manifest.
 *
 * The upstream repositories whose skills this extension tracks, and the exact
 * skill directories within each. Install layout: `.pi/skills/<basename>/`
 * (e.g. `skills/engineering/code-review` → `.pi/skills/code-review`).
 */

import { join } from "node:path";

export interface SkillSource {
	/** Source id — also the name of the cache directory under `.pi/update-skill/cache/`. */
	id: string;
	/** Clone URL. */
	url: string;
	/** Branch tracked for updates (pinned commits are compared against this branch). */
	branch: string;
	/** Repo-relative paths of the skill directories to track. */
	skills: string[];
}

export const SOURCES: readonly SkillSource[] = [
	{
		id: "mattpocock",
		url: "https://github.com/mattpocock/skills",
		branch: "main",
		skills: [
			"skills/engineering/ask-matt",
			"skills/engineering/code-review",
			"skills/engineering/codebase-design",
			"skills/engineering/diagnosing-bugs",
			"skills/engineering/grill-with-docs",
			"skills/engineering/implement",
			"skills/engineering/improve-codebase-architecture",
			"skills/engineering/prototype",
			"skills/engineering/research",
			"skills/engineering/setup-matt-pocock-skills",
			"skills/engineering/tdd",
			"skills/engineering/to-spec",
			"skills/engineering/to-tickets",
			"skills/engineering/wayfinder",
			"skills/engineering/wizard",
			"skills/productivity/grill-me",
			"skills/productivity/grilling",
			"skills/productivity/handoff",
			"skills/productivity/teach",
			"skills/productivity/wait-what",
		],
	},
	{
		id: "pstack",
		url: "https://github.com/cursor/plugins",
		branch: "main",
		skills: ["pstack/skills/unslop"],
	},
];

export interface TrackedSkill {
	/** Basename of the skill directory, e.g. `code-review`. Install dir name. */
	name: string;
	/** Source id the skill comes from. */
	sourceId: string;
	/** Repo-relative path of the skill directory. */
	path: string;
	/** Clone URL of the source. */
	url: string;
	/** Branch the skill is tracked against. */
	branch: string;
}

/** Flatten the manifest into one entry per tracked skill. */
export function listTrackedSkills(): TrackedSkill[] {
	return SOURCES.flatMap((source) =>
		source.skills.map((path) => ({
			name: basename(path),
			sourceId: source.id,
			path,
			url: source.url,
			branch: source.branch,
		})),
	);
}

/** `skills/engineering/code-review` → `code-review`; `pstack/skills/unslop` → `unslop`. */
export function basename(skillPath: string): string {
	const parts = skillPath.split("/").filter(Boolean);
	return parts[parts.length - 1] ?? skillPath;
}

/**
 * Install directory for a tracked skill: `.pi/skills/<basename>/`.
 * Basenames are unique across all sources today; if that ever changes,
 * this mapping is where the collision would surface.
 */
export function installDirFor(root: string, name: string): string {
	return join(root, name);
}
