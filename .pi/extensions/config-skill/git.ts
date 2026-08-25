/**
 * update-skill — thin git wrapper.
 *
 * Every operation is a single `git` invocation via `child_process.execFile`,
 * against a private cache clone per source under
 * `.pi/update-skill/cache/<sourceId>/`. Clones are full (mattpocock is small,
 * cursor/plugins ~5.5 MB) so `git log <pinned>..origin/main -- <path>` and
 * diffs against old pinned commits always work without shallow-boundary
 * surprises.
 *
 * The `Git` interface is the seam tests fake: the menu/apply logic in
 * index.ts depends only on it, never on `execFile` directly.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export class GitError extends Error {
	constructor(
		message: string,
		public readonly stderr: string,
	) {
		super(message);
		this.name = "GitError";
	}
}

/** All git operations used by update-skill. Fakeable in tests. */
export interface Git {
	/** Ensure a full clone of `url` exists at `dir` (repairs a partial/invalid dir). */
	ensureClone(dir: string, url: string): Promise<void>;
	/** Fetch latest `origin` refs into the cache clone. */
	fetch(dir: string): Promise<void>;
	/** Resolve a ref (`origin/main`, a sha, …) to its full commit sha. */
	revParse(dir: string, ref: string): Promise<string>;
	/** Whether `path` (a directory) exists at `ref`. */
	pathExistsAtRef(dir: string, ref: string, path: string): Promise<boolean>;
	/** `git log --oneline <range> -- <path>` output (empty string when clean). */
	logOneline(dir: string, range: string, path: string): Promise<string>;
	/** `git diff --stat <range> -- <path>` output (empty string when clean). */
	diffStat(dir: string, range: string, path: string): Promise<string>;
	/** `git diff <range> -- <path>/SKILL.md` output. */
	diffSkillMarkdown(dir: string, range: string, path: string): Promise<string>;
	/** Check out `ref` (detached) in the cache worktree, so the caller can copy files from disk. */
	checkout(dir: string, ref: string): Promise<void>;
}

/** Real git implementation over `execFile("git", ...)`. */
export function createGit(): Git {
	return {
		async ensureClone(dir, url) {
			if (isRepo(dir)) return;
			// Partial/corrupt cache dir: replace it rather than failing forever.
			rmSync(dir, { recursive: true, force: true });
			await runGit(["clone", "--quiet", url, dir]);
		},
		async fetch(dir) {
			await runGit(["fetch", "--quiet", "origin"], dir);
		},
		async revParse(dir, ref) {
			const { stdout } = await runGit(["rev-parse", ref], dir);
			return stdout.trim();
		},
		async pathExistsAtRef(dir, ref, path) {
			const { stdout } = await runGit(["ls-tree", ref, "--", `${path}/SKILL.md`], dir);
			return stdout.trim().length > 0;
		},
		async logOneline(dir, range, path) {
			const { stdout } = await runGit(["log", "--oneline", range, "--", path], dir);
			return stdout.trim();
		},
		async diffStat(dir, range, path) {
			const { stdout } = await runGit(["diff", "--stat", range, "--", path], dir);
			return stdout.trim();
		},
		async diffSkillMarkdown(dir, range, path) {
			const { stdout } = await runGit(["diff", range, "--", `${path}/SKILL.md`], dir);
			return stdout;
		},
		async checkout(dir, ref) {
			await runGit(["checkout", "--quiet", "--force", ref], dir);
		},
	};
}

function isRepo(dir: string): boolean {
	return existsSync(join(dir, ".git"));
}

async function runGit(
	args: string[],
	cwd?: string,
): Promise<{ stdout: string; stderr: string }> {
	try {
		const { stdout, stderr } = await execFileAsync("git", args, {
			cwd,
			maxBuffer: 16 * 1024 * 1024,
		});
		return { stdout, stderr };
	} catch (error) {
		const stderr = (error as { stderr?: string }).stderr ?? String(error);
		throw new GitError(`git ${args.join(" ")} failed: ${stderr.trim()}`, stderr);
	}
}
