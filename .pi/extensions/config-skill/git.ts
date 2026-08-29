/**
 * update-skill — git adapter.
 *
 * Every operation is a single `git` invocation through the shared git
 * executor (`_shared/git.ts`), against a private cache clone per source
 * under `.pi/update-skill/cache/<sourceId>/`. Clones are full (mattpocock is
 * small, cursor/plugins ~5.5 MB) so `git log <pinned>..origin/main -- <path>`
 * and diffs against old pinned commits always work without shallow-boundary
 * surprises.
 *
 * The `Git` interface is the seam tests fake: the menu/apply logic in
 * index.ts depends only on it, never on process spawning directly.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { runGit, type GitResult, type GitRunOptions } from "../_shared/git.ts";

/** Clone and fetch hit the network; they outwait the executor's 30s default. */
const CLONE_TIMEOUT_MS = 300_000;

/** The former private executor allowed 16 MiB per invocation; keep that bound. */
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

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

/** Real git implementation over the shared git executor. */
export function createGit(): Git {
	return {
		async ensureClone(dir, url) {
			if (isRepo(dir)) return;
			// Partial/corrupt cache dir: replace it rather than failing forever.
			rmSync(dir, { recursive: true, force: true });
			// The clone target does not exist yet, so run git from its parent.
			mkdirSync(dirname(dir), { recursive: true });
			await checkedRun(dirname(dir), ["clone", "--quiet", url, dir], { timeoutMs: CLONE_TIMEOUT_MS });
		},
		async fetch(dir) {
			await checkedRun(dir, ["fetch", "--quiet", "origin"], { timeoutMs: CLONE_TIMEOUT_MS });
		},
		async revParse(dir, ref) {
			const { stdout } = await checkedRun(dir, ["rev-parse", ref]);
			return stdout.trim();
		},
		async pathExistsAtRef(dir, ref, path) {
			const { stdout } = await checkedRun(dir, ["ls-tree", ref, "--", `${path}/SKILL.md`]);
			return stdout.trim().length > 0;
		},
		async logOneline(dir, range, path) {
			const { stdout } = await checkedRun(dir, ["log", "--oneline", range, "--", path]);
			return stdout.trim();
		},
		async diffStat(dir, range, path) {
			const { stdout } = await checkedRun(dir, ["diff", "--stat", range, "--", path]);
			return stdout.trim();
		},
		async diffSkillMarkdown(dir, range, path) {
			const { stdout } = await checkedRun(dir, ["diff", range, "--", `${path}/SKILL.md`]);
			return stdout;
		},
		async checkout(dir, ref) {
			await checkedRun(dir, ["checkout", "--quiet", "--force", ref]);
		},
	};
}

function isRepo(dir: string): boolean {
	return existsSync(join(dir, ".git"));
}

/**
 * Run one git invocation through the shared executor and surface failures
 * as `GitError`. Abort errors propagate untouched so cancellation keeps its
 * own meaning.
 */
async function checkedRun(dir: string, args: string[], options: GitRunOptions = {}): Promise<GitResult> {
	try {
		const result = await runGit(dir, args, { maxOutputBytes: MAX_OUTPUT_BYTES, ...options, allowFailure: true });
		if (result.exitCode !== 0) throw gitFailure(args, result.stderr || result.stdout);
		return result;
	} catch (error) {
		if (error instanceof GitError || (error as Error | undefined)?.name === "AbortError") throw error;
		throw gitFailure(args, error instanceof Error ? error.message : String(error));
	}
}

function gitFailure(args: string[], detail: string): GitError {
	return new GitError(`git ${args.join(" ")} failed: ${detail.trim()}`, detail);
}