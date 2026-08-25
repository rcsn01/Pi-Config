import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGit, GitError } from "./git.ts";

const SKILL_DIR = "skills/engineering/code-review";

const dirs: string[] = [];

function tmpDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "update-skill-git-"));
	dirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(dir: string, ...args: string[]): string {
	return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
}

function initRepo(dir: string): void {
	mkdirSync(dir, { recursive: true });
	git(dir, "init", "-b", "main", "--quiet");
	git(dir, "config", "user.email", "test@example.com");
	git(dir, "config", "user.name", "Test");
}

function commitAll(dir: string, message: string): string {
	git(dir, "add", "-A");
	git(dir, "commit", "-m", message, "--quiet");
	return git(dir, "rev-parse", "HEAD");
}

function writeSkill(dir: string, content: string): void {
	mkdirSync(join(dir, SKILL_DIR), { recursive: true });
	writeFileSync(join(dir, SKILL_DIR, "SKILL.md"), content, "utf8");
}

describe("createGit against a real local repository", () => {
	it("clones, fetches, and reports commits/stats/diffs for a skill path", async () => {
		const tmp = tmpDir();
		const upstream = join(tmp, "upstream");
		initRepo(upstream);
		writeSkill(upstream, "# v1\nold content\n");
		const first = commitAll(upstream, "feat: add code-review skill");

		const g = createGit();
		const cache = join(tmp, "cache");

		await g.ensureClone(cache, upstream);
		// Idempotent: cloning over an existing cache is a no-op.
		await g.ensureClone(cache, upstream);

		expect(await g.revParse(cache, "origin/main")).toBe(first);
		expect(await g.pathExistsAtRef(cache, "origin/main", SKILL_DIR)).toBe(true);
		expect(await g.pathExistsAtRef(cache, "origin/main", "skills/engineering/does-not-exist")).toBe(
			false,
		);

		// Upstream moves: fetch picks up the new commit.
		writeSkill(upstream, "# v2\nnew content\n");
		const second = commitAll(upstream, "feat: refresh code-review");
		await g.fetch(cache);
		expect(await g.revParse(cache, "origin/main")).toBe(second);

		const range = `${first}..origin/main`;
		const log = await g.logOneline(cache, range, SKILL_DIR);
		expect(log).toContain("feat: refresh code-review");

		const stat = await g.diffStat(cache, range, SKILL_DIR);
		expect(stat).toContain("SKILL.md");

		const diff = await g.diffSkillMarkdown(cache, range, SKILL_DIR);
		expect(diff).toContain("-# v1");
		expect(diff).toContain("+# v2");

		// checkout exposes the ref's content in the cache worktree.
		await g.checkout(cache, "origin/main");
		expect(readFileSync(join(cache, SKILL_DIR, "SKILL.md"), "utf8")).toContain("# v2");

		// Removal upstream is visible at the ref.
		rmSync(join(upstream, SKILL_DIR), { recursive: true });
		commitAll(upstream, "chore: drop code-review");
		await g.fetch(cache);
		expect(await g.pathExistsAtRef(cache, "origin/main", SKILL_DIR)).toBe(false);
	});

	it("empty range output when the skill path is unchanged", async () => {
		const tmp = tmpDir();
		const upstream = join(tmp, "upstream");
		initRepo(upstream);
		writeSkill(upstream, "# v1\n");
		const first = commitAll(upstream, "feat: add skill");

		const g = createGit();
		const cache = join(tmp, "cache");
		await g.ensureClone(cache, upstream);

		// Unrelated change upstream.
		writeFileSync(join(upstream, "README.md"), "hi\n", "utf8");
		const second = commitAll(upstream, "chore: readme");
		await g.fetch(cache);

		expect(await g.logOneline(cache, `${first}..origin/main`, SKILL_DIR)).toBe("");
		expect(await g.diffStat(cache, `${first}..origin/main`, SKILL_DIR)).toBe("");
		expect(second).not.toBe(first);
	});

	it("repairs a cache dir that is not a git repo", async () => {
		const tmp = tmpDir();
		const upstream = join(tmp, "upstream");
		initRepo(upstream);
		writeSkill(upstream, "# v1\n");
		commitAll(upstream, "feat: add skill");

		const cache = join(tmp, "cache");
		mkdirSync(join(cache, "leftover"), { recursive: true });

		const g = createGit();
		await g.ensureClone(cache, upstream);
		expect(git(cache, "rev-parse", "--is-inside-work-tree")).toBe("true");
		expect(readFileSync(join(cache, SKILL_DIR, "SKILL.md"), "utf8")).toContain("# v1");
	});

	it("throws GitError on unresolvable refs", async () => {
		const tmp = tmpDir();
		const upstream = join(tmp, "upstream");
		initRepo(upstream);
		writeSkill(upstream, "# v1\n");
		commitAll(upstream, "feat: add skill");

		const g = createGit();
		const cache = join(tmp, "cache");
		await g.ensureClone(cache, upstream);

		await expect(g.revParse(cache, "does-not-exist")).rejects.toThrow(GitError);
	});
});
