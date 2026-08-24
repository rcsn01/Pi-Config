import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_SNAPSHOT_LIMITS } from "./contract.ts";
import { GitSnapshotAdapter, parseTree } from "./git-snapshot.ts";

const exec = promisify(execFile);
const roots: string[] = [];

async function git(cwd: string, ...args: string[]): Promise<string> {
	return (await exec("git", args, { cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } })).stdout.trim();
}

async function fixture(): Promise<{ root: string; bare: string; main: string; feature: string }> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "git-snapshot-test-"));
	roots.push(root);
	const work = path.join(root, "work");
	const bare = path.join(root, "remote.git");
	await fs.mkdir(work);
	await git(work, "init", "-q", "-b", "main");
	await git(work, "config", "user.name", "Test");
	await git(work, "config", "user.email", "test@example.com");
	await fs.writeFile(path.join(work, "README.md"), "main\n");
	await fs.writeFile(path.join(work, "run.sh"), "#!/bin/sh\n", { mode: 0o755 });
	if (process.platform !== "win32") await fs.symlink("../outside", path.join(work, "link"));
	await git(work, "add", ".");
	await git(work, "commit", "-qm", "main");
	const main = await git(work, "rev-parse", "HEAD");
	await git(work, "tag", "-a", "v1", "-m", "version one");
	await git(work, "tag", "both");
	await git(work, "branch", "both");
	await git(work, "checkout", "-qb", "feature");
	await fs.writeFile(path.join(work, "feature.txt"), "feature\n");
	await git(work, "add", ".");
	await git(work, "commit", "-qm", "feature");
	const feature = await git(work, "rev-parse", "HEAD");
	await git(root, "clone", "-q", "--bare", work, bare);
	await git(bare, "symbolic-ref", "HEAD", "refs/heads/main");
	return { root, bare, main, feature };
}

beforeAll(async () => { await exec("git", ["--version"]); });
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });

describe("GitSnapshotAdapter", () => {
	it("resolves default, branch, annotated tag, and full commit", async () => {
		const repo = await fixture();
		const adapter = new GitSnapshotAdapter({ allowLocalRemote: true });
		const deadline = Date.now() + 20_000;
		expect((await adapter.resolve(repo.bare, null, deadline, DEFAULT_SNAPSHOT_LIMITS)).commit).toBe(repo.main);
		expect((await adapter.resolve(repo.bare, "feature", deadline, DEFAULT_SNAPSHOT_LIMITS)).commit).toBe(repo.feature);
		expect((await adapter.resolve(repo.bare, "v1", deadline, DEFAULT_SNAPSHOT_LIMITS)).commit).toBe(repo.main);
		await expect(adapter.resolve(repo.bare, "both", deadline, DEFAULT_SNAPSHOT_LIMITS)).rejects.toMatchObject({ code: "AMBIGUOUS_REF" });
		expect((await adapter.resolve(repo.bare, repo.main, deadline, DEFAULT_SNAPSHOT_LIMITS)).commit).toBe(repo.main);
	});

	it("materializes a depth-one, inert, read-only source tree", async () => {
		const repo = await fixture();
		const stage = path.join(repo.root, "stage");
		await fs.mkdir(stage);
		const adapter = new GitSnapshotAdapter({ allowLocalRemote: true });
		const revision = await adapter.resolve(repo.bare, null, Date.now() + 20_000, DEFAULT_SNAPSHOT_LIMITS);
		const result = await adapter.materialize({ remoteUrl: repo.bare, revision, stagingPath: stage, deadline: Date.now() + 20_000, limits: DEFAULT_SNAPSHOT_LIMITS });
		const source = path.join(stage, "source");
		expect(await fs.readFile(path.join(source, "README.md"), "utf8")).toBe("main\n");
		await expect(fs.access(path.join(source, ".git"))).rejects.toThrow();
		expect((await fs.stat(path.join(source, "run.sh"))).mode & 0o111).toBe(0);
		if (process.platform !== "win32") {
			expect((await fs.lstat(path.join(source, "link"))).isFile()).toBe(true);
			expect(await fs.readFile(path.join(source, "link"), "utf8")).toBe("../outside");
			expect(result.symlinksConverted).toBe(1);
		}
		await fs.chmod(source, 0o755);
	});

	it.skipIf(process.platform === "win32")("kills Git on cancellation and returns a typed error", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "git-snapshot-cancel-"));
		roots.push(root);
		const fakeGit = path.join(root, "git");
		await fs.writeFile(fakeGit, "#!/bin/sh\nsleep 30\n", { mode: 0o755 });
		const adapter = new GitSnapshotAdapter({ gitPath: fakeGit });
		const controller = new AbortController();
		const resolving = adapter.resolve("https://github.com/owner/repo.git", "main", Date.now() + 10_000, DEFAULT_SNAPSHOT_LIMITS, controller.signal);
		setTimeout(() => controller.abort(), 50);
		await expect(resolving).rejects.toMatchObject({ code: "CANCELLED" });
	});

	it("fails closed on tree limits and unsafe names", () => {
		const limits = { ...DEFAULT_SNAPSHOT_LIMITS, maxBlobBytes: 3 };
		const normal = Buffer.from(`100644 blob ${"a".repeat(40)} 4\tfile.txt\0`);
		expect(() => parseTree(normal, limits)).toThrowError(expect.objectContaining({ code: "LIMIT_EXCEEDED" }));
		const unsafe = Buffer.from(`100644 blob ${"a".repeat(40)} 1\t.git/config\0`);
		expect(() => parseTree(unsafe, DEFAULT_SNAPSHOT_LIMITS)).toThrowError(expect.objectContaining({ code: "UNSAFE_TREE" }));
		const aliasPrefix = Buffer.from(
			`120000 blob ${"a".repeat(40)} 3\tLINK\0` +
			`100644 blob ${"b".repeat(40)} 1\tlink/payload\0`,
		);
		expect(() => parseTree(aliasPrefix, DEFAULT_SNAPSHOT_LIMITS)).toThrowError(expect.objectContaining({ code: "UNSAFE_TREE" }));
	});
});
