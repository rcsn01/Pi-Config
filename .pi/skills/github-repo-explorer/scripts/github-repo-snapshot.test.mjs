import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, it } from "node:test";
import {
	DEFAULT_SNAPSHOT_LIMITS,
	GitHubRepositoryStore,
	GitSnapshotAdapter,
	parseGitHubRepository,
	parseSnapshotManifest,
	parseTree,
	runCli,
	snapshotId,
	validateGitRef,
} from "./github-repo-snapshot.mjs";

const exec = promisify(execFile);
const roots = [];
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

async function git(cwd, ...args) {
	return (await exec("git", args, {
		cwd,
		env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
	})).stdout.trim();
}

async function tempRoot() {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "github-skill-test-"));
	roots.push(root);
	return root;
}

async function fixture() {
	const root = await tempRoot();
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

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

class FakeAdapter {
	constructor() {
		this.commit = SHA_A;
		this.materializeCalls = 0;
	}

	async resolve(_remote, requestedRef) {
		return { requestedRef, resolvedRef: requestedRef ? `refs/heads/${requestedRef}` : "refs/heads/main", commit: this.commit };
	}

	async materialize(request) {
		this.materializeCalls++;
		await fs.mkdir(path.join(request.stagingPath, "source"), { recursive: true });
		await fs.writeFile(path.join(request.stagingPath, "source", "file.txt"), "hello");
		return { fileCount: 1, byteCount: 5, symlinksConverted: 0, submodulesSkipped: [] };
	}
}

describe("github repository skill helper", () => {
	it("accepts GitHub locators and rejects unsafe locators", () => {
		assert.equal(parseGitHubRepository("Owner/Repo").canonical, "owner/repo");
		assert.equal(parseGitHubRepository("https://github.com/Owner/Repo.git").canonical, "owner/repo");
		for (const input of [
			"git@github.com:owner/repo.git",
			"http://github.com/owner/repo",
			"https://gitlab.com/owner/repo",
			"https://github.com/owner/repo/issues",
			"../repo",
			"owner/../repo",
			"file:///tmp/repo",
		]) {
			assert.throws(() => parseGitHubRepository(input), { code: "INVALID_REPOSITORY" });
		}
	});

	it("accepts exact refs and rejects ambiguous or unsafe syntax", () => {
		assert.equal(validateGitRef(undefined), null);
		assert.equal(validateGitRef("refs/heads/main"), "refs/heads/main");
		assert.equal(validateGitRef(SHA_A.toUpperCase()), SHA_A);
		for (const ref of [
			"-main", "a b", "../main", "main@{1}", "abc123", "refs//main", "main.lock", "@",
			"feature;touch", "feature$IFS", "feature{a,b}", "feature`id`",
		]) {
			assert.throws(() => validateGitRef(ref), { code: "INVALID_REF" });
		}
	});

	it("resolves default, branch, annotated tag, and full commit", async () => {
		const repo = await fixture();
		const adapter = new GitSnapshotAdapter({ allowLocalRemote: true });
		const deadline = Date.now() + 20_000;
		assert.equal((await adapter.resolve(repo.bare, null, deadline, DEFAULT_SNAPSHOT_LIMITS)).commit, repo.main);
		assert.equal((await adapter.resolve(repo.bare, "feature", deadline, DEFAULT_SNAPSHOT_LIMITS)).commit, repo.feature);
		assert.equal((await adapter.resolve(repo.bare, "v1", deadline, DEFAULT_SNAPSHOT_LIMITS)).commit, repo.main);
		await assert.rejects(adapter.resolve(repo.bare, "both", deadline, DEFAULT_SNAPSHOT_LIMITS), { code: "AMBIGUOUS_REF" });
		assert.equal((await adapter.resolve(repo.bare, repo.main, deadline, DEFAULT_SNAPSHOT_LIMITS)).commit, repo.main);
	});

	it("materializes a depth-one, inert, read-only source tree", async () => {
		const repo = await fixture();
		const stage = path.join(repo.root, "stage");
		await fs.mkdir(stage);
		const adapter = new GitSnapshotAdapter({ allowLocalRemote: true });
		const revision = await adapter.resolve(repo.bare, null, Date.now() + 20_000, DEFAULT_SNAPSHOT_LIMITS);
		const result = await adapter.materialize({ remoteUrl: repo.bare, revision, stagingPath: stage, deadline: Date.now() + 20_000, limits: DEFAULT_SNAPSHOT_LIMITS });
		const source = path.join(stage, "source");
		assert.equal(await fs.readFile(path.join(source, "README.md"), "utf8"), "main\n");
		await assert.rejects(fs.access(path.join(source, ".git")));
		assert.equal((await fs.stat(path.join(source, "run.sh"))).mode & 0o111, 0);
		if (process.platform !== "win32") {
			assert.equal((await fs.lstat(path.join(source, "link"))).isFile(), true);
			assert.equal(await fs.readFile(path.join(source, "link"), "utf8"), "../outside");
			assert.equal(result.symlinksConverted, 1);
		}
		await fs.chmod(source, 0o755);
	});

	it("kills Git on cancellation and returns a typed error", { skip: process.platform === "win32" }, async () => {
		const root = await tempRoot();
		const fakeGit = path.join(root, "git");
		await fs.writeFile(fakeGit, "#!/bin/sh\nsleep 30\n", { mode: 0o755 });
		const adapter = new GitSnapshotAdapter({ gitPath: fakeGit });
		const controller = new AbortController();
		const resolving = adapter.resolve("https://github.com/owner/repo.git", "main", Date.now() + 10_000, DEFAULT_SNAPSHOT_LIMITS, controller.signal);
		setTimeout(() => controller.abort(), 50);
		await assert.rejects(resolving, { code: "CANCELLED" });
	});

	it("fails closed on tree limits and unsafe names", () => {
		const limits = { ...DEFAULT_SNAPSHOT_LIMITS, maxBlobBytes: 3 };
		const normal = Buffer.from(`100644 blob ${"a".repeat(40)} 4\tfile.txt\0`);
		assert.throws(() => parseTree(normal, limits), { code: "LIMIT_EXCEEDED" });
		const unsafe = Buffer.from(`100644 blob ${"a".repeat(40)} 1\t.git/config\0`);
		assert.throws(() => parseTree(unsafe, DEFAULT_SNAPSHOT_LIMITS), { code: "UNSAFE_TREE" });
		const aliasPrefix = Buffer.from(
			`120000 blob ${"a".repeat(40)} 3\tLINK\0` +
			`100644 blob ${"b".repeat(40)} 1\tlink/payload\0`,
		);
		assert.throws(() => parseTree(aliasPrefix, DEFAULT_SNAPSHOT_LIMITS), { code: "UNSAFE_TREE" });
	});

	it("lists an absent store without creating it", async () => {
		const parent = await tempRoot();
		const root = path.join(parent, "missing");
		const store = new GitHubRepositoryStore({ storageRoot: root, adapter: new FakeAdapter() });
		assert.deepEqual(await store.list(), []);
		await assert.rejects(fs.access(root));
	});

	it("derives deterministic IDs, reuses commits, and keeps moved branches separate", async () => {
		const adapter = new FakeAdapter();
		const store = new GitHubRepositoryStore({ storageRoot: await tempRoot(), adapter, clock: () => new Date("2026-01-01T00:00:00Z") });
		const first = await store.acquire({ repository: "Owner/Repo", ref: "main" });
		const reused = await store.acquire({ repository: "owner/repo", ref: "main" });
		assert.equal(first.id, snapshotId("owner/repo", SHA_A));
		assert.equal(first.reused, false);
		assert.equal(reused.reused, true);
		assert.equal(adapter.materializeCalls, 1);

		adapter.commit = SHA_B;
		const advanced = await store.acquire({ repository: "owner/repo", ref: "main" });
		assert.notEqual(advanced.id, first.id);
		assert.equal((await store.list()).length, 2);
	});

	it("removes only a completed snapshot selected by opaque ID", async () => {
		const root = await tempRoot();
		const store = new GitHubRepositoryStore({ storageRoot: root, adapter: new FakeAdapter() });
		const snapshot = await store.acquire({ repository: "owner/repo" });
		await assert.rejects(store.remove("../../escape"), { code: "SNAPSHOT_NOT_FOUND" });
		assert.deepEqual(await store.remove(snapshot.id), { id: snapshot.id, repository: snapshot.repository, commit: snapshot.commit, removed: true });
		await assert.rejects(fs.access(path.dirname(snapshot.path)));
		assert.deepEqual(await store.list(), []);
	});

	it("ignores forged manifests and caps the public list", async () => {
		const root = await tempRoot();
		const adapter = new FakeAdapter();
		const store = new GitHubRepositoryStore({ storageRoot: root, adapter, limits: { maxListEntries: 1 } });
		const older = await store.acquire({ repository: "owner/one" });
		adapter.commit = SHA_B;
		await store.acquire({ repository: "owner/two" });
		assert.equal((await store.list()).length, 1);
		assert.deepEqual(await store.remove(older.id), { id: older.id, repository: older.repository, commit: older.commit, removed: true });

		const forged = path.join(root, "owner", "forged", "c".repeat(40));
		await fs.mkdir(path.join(forged, "source"), { recursive: true });
		await fs.writeFile(path.join(forged, "manifest.json"), JSON.stringify({ schemaVersion: 1, id: snapshotId("owner/other", "c".repeat(40)) }));
		assert.equal((await store.list()).some((item) => item.repository === "owner/forged"), false);
	});

	it("unlinks abandoned staging symlinks without touching their targets", { skip: process.platform === "win32" }, async () => {
		const root = await tempRoot();
		const outside = await tempRoot();
		await fs.mkdir(path.join(root, ".staging"), { recursive: true });
		await fs.mkdir(path.join(root, ".locks"), { recursive: true });
		const stale = path.join(root, ".staging", `ghr_${"d".repeat(24)}-00000000-0000-4000-8000-000000000000`);
		await fs.symlink(outside, stale);
		const store = new GitHubRepositoryStore({ storageRoot: root, adapter: new FakeAdapter(), clock: () => new Date("2100-01-01T00:00:00Z") });
		await store.acquire({ repository: "owner/repo" });
		await assert.rejects(fs.access(stale));
		assert.equal((await fs.stat(outside)).mode & 0o777, 0o700);
	});

	it("rejects symlinked repository storage ancestors", { skip: process.platform === "win32" }, async () => {
		const root = await tempRoot();
		const outside = await tempRoot();
		await fs.mkdir(path.join(root, ".staging"), { recursive: true });
		await fs.mkdir(path.join(root, ".locks"), { recursive: true });
		await fs.symlink(outside, path.join(root, "owner"));
		const store = new GitHubRepositoryStore({ storageRoot: root, adapter: new FakeAdapter() });
		await assert.rejects(store.acquire({ repository: "owner/repo" }), { code: "STORAGE_ERROR" });
		assert.deepEqual(await fs.readdir(outside), []);
	});

	it("uses the CLI list and explicit confirmation contract", async () => {
		const workspace = await tempRoot();
		const store = new GitHubRepositoryStore({ storageRoot: path.join(workspace, ".pi", "repos"), adapter: new FakeAdapter() });
		const snapshot = await store.acquire({ repository: "owner/repo" });
		const listed = await runCli(["list"], workspace);
		assert.match(listed, /owner\/repo @ aaaaaaaaaaaa/);
		await assert.rejects(runCli(["remove", snapshot.id], workspace));
		const removed = await runCli(["remove", snapshot.id, "--confirm"], workspace);
		assert.match(removed, /Repository snapshot removed/);
	});

	it("rejects unknown manifest versions", () => {
		const value = {
			schemaVersion: 1, id: snapshotId("owner/repo", SHA_A), repository: "owner/repo", requestedRef: null,
			resolvedRef: "refs/heads/main", commit: SHA_A, acquiredAt: "2026-01-01T00:00:00.000Z",
			fileCount: 1, byteCount: 2, symlinksConverted: 0, submodulesSkipped: [],
		};
		assert.deepEqual(parseSnapshotManifest(value), value);
		assert.throws(() => parseSnapshotManifest({ ...value, schemaVersion: 2 }), { code: "STORAGE_ERROR" });
	});
});
