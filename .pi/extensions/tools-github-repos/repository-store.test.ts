import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { MaterializeRequest, ResolvedRevision, SnapshotAdapter, SnapshotLimits } from "./contract.ts";
import { parseGitHubRepository, validateGitRef } from "./github-locator.ts";
import { GitHubRepositoryStore, parseSnapshotManifest, snapshotId } from "./repository-store.ts";

const roots: string[] = [];
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

async function tempRoot(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "github-store-test-"));
	roots.push(root);
	return root;
}

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });

class FakeAdapter implements SnapshotAdapter {
	commit = SHA_A;
	materializeCalls = 0;
	async resolve(_remote: string, requestedRef: string | null, _deadline: number, _limits: SnapshotLimits): Promise<ResolvedRevision> {
		return { requestedRef, resolvedRef: requestedRef ? `refs/heads/${requestedRef}` : "refs/heads/main", commit: this.commit };
	}
	async materialize(request: MaterializeRequest) {
		this.materializeCalls++;
		await fs.mkdir(path.join(request.stagingPath, "source"), { recursive: true });
		await fs.writeFile(path.join(request.stagingPath, "source", "file.txt"), "hello");
		return { fileCount: 1, byteCount: 5, symlinksConverted: 0, submodulesSkipped: [] };
	}
}

describe("GitHub locator and ref validation", () => {
	it.each([
		["Owner/Repo", "owner/repo"],
		["https://github.com/Owner/Repo", "owner/repo"],
		["https://github.com/Owner/Repo.git", "owner/repo"],
	])("accepts %s", (input, canonical) => {
		expect(parseGitHubRepository(input).canonical).toBe(canonical);
	});

	it.each([
		"git@github.com:owner/repo.git", "http://github.com/owner/repo", "https://gitlab.com/owner/repo",
		"https://user@github.com/owner/repo", "https://github.com/owner/repo/issues", "../repo", "owner/../repo",
		"https://github.com/owner/repo?x=1", "file:///tmp/repo", "bad_owner/repo", "owner--name/repo",
	])("rejects repository %s", (input) => {
		expect(() => parseGitHubRepository(input)).toThrowError(expect.objectContaining({ code: "INVALID_REPOSITORY" }));
	});

	it("accepts exact refs and rejects ambiguous or unsafe syntax", () => {
		expect(validateGitRef(undefined)).toBeNull();
		expect(validateGitRef("refs/heads/main")).toBe("refs/heads/main");
		expect(validateGitRef(SHA_A.toUpperCase())).toBe(SHA_A);
		for (const ref of ["-main", "a b", "../main", "main@{1}", "abc123", "refs//main", "main.lock", "@"]) {
			expect(() => validateGitRef(ref)).toThrowError(expect.objectContaining({ code: "INVALID_REF" }));
		}
	});
});

describe("GitHubRepositoryStore", () => {
	it("lists an absent store without creating it", async () => {
		const parent = await tempRoot();
		const root = path.join(parent, "missing");
		const store = new GitHubRepositoryStore({ storageRoot: root, adapter: new FakeAdapter() });
		expect(await store.list()).toEqual([]);
		await expect(fs.access(root)).rejects.toThrow();
	});

	it("derives deterministic IDs, reuses commits, and keeps moved branches separate", async () => {
		const adapter = new FakeAdapter();
		const store = new GitHubRepositoryStore({ storageRoot: await tempRoot(), adapter, clock: () => new Date("2026-01-01T00:00:00Z") });
		const first = await store.acquire({ repository: "Owner/Repo", ref: "main" });
		const reused = await store.acquire({ repository: "owner/repo", ref: "main" });
		expect(first.id).toBe(snapshotId("owner/repo", SHA_A));
		expect(first.reused).toBe(false);
		expect(reused.reused).toBe(true);
		expect(adapter.materializeCalls).toBe(1);

		adapter.commit = SHA_B;
		const advanced = await store.acquire({ repository: "owner/repo", ref: "main" });
		expect(advanced.id).not.toBe(first.id);
		expect(await store.list()).toHaveLength(2);
	});

	it("removes only a completed snapshot selected by opaque ID", async () => {
		const root = await tempRoot();
		const store = new GitHubRepositoryStore({ storageRoot: root, adapter: new FakeAdapter() });
		const snapshot = await store.acquire({ repository: "owner/repo" });
		await expect(store.remove("../../escape")).rejects.toMatchObject({ code: "SNAPSHOT_NOT_FOUND" });
		await expect(store.remove(snapshot.id)).resolves.toMatchObject({ id: snapshot.id, removed: true });
		await expect(fs.access(path.dirname(snapshot.path))).rejects.toThrow();
		expect(await store.list()).toEqual([]);
	});

	it("ignores forged manifests and caps the public list", async () => {
		const root = await tempRoot();
		const adapter = new FakeAdapter();
		const store = new GitHubRepositoryStore({ storageRoot: root, adapter, limits: { maxListEntries: 1 } });
		const older = await store.acquire({ repository: "owner/one" });
		adapter.commit = SHA_B;
		await store.acquire({ repository: "owner/two" });
		expect(await store.list()).toHaveLength(1);
		await expect(store.remove(older.id)).resolves.toMatchObject({ id: older.id, removed: true });

		const forged = path.join(root, "owner", "forged", "c".repeat(40));
		await fs.mkdir(path.join(forged, "source"), { recursive: true });
		await fs.writeFile(path.join(forged, "manifest.json"), JSON.stringify({ schemaVersion: 1, id: snapshotId("owner/other", "c".repeat(40)) }));
		expect((await store.list()).some((item) => item.repository === "owner/forged")).toBe(false);
	});

	it.skipIf(process.platform === "win32")("unlinks abandoned staging symlinks without touching their targets", async () => {
		const root = await tempRoot();
		const outside = await tempRoot();
		await fs.mkdir(path.join(root, ".staging"), { recursive: true });
		await fs.mkdir(path.join(root, ".locks"), { recursive: true });
		const stale = path.join(root, ".staging", `ghr_${"d".repeat(24)}-00000000-0000-4000-8000-000000000000`);
		await fs.symlink(outside, stale);
		const store = new GitHubRepositoryStore({ storageRoot: root, adapter: new FakeAdapter(), clock: () => new Date("2100-01-01T00:00:00Z") });
		await store.acquire({ repository: "owner/repo" });
		await expect(fs.access(stale)).rejects.toThrow();
		expect((await fs.stat(outside)).mode & 0o777).toBe(0o700);
	});

	it.skipIf(process.platform === "win32")("rejects symlinked repository storage ancestors", async () => {
		const root = await tempRoot();
		const outside = await tempRoot();
		await fs.mkdir(path.join(root, ".staging"), { recursive: true });
		await fs.mkdir(path.join(root, ".locks"), { recursive: true });
		await fs.symlink(outside, path.join(root, "owner"));
		const store = new GitHubRepositoryStore({ storageRoot: root, adapter: new FakeAdapter() });
		await expect(store.acquire({ repository: "owner/repo" })).rejects.toMatchObject({ code: "STORAGE_ERROR" });
		expect(await fs.readdir(outside)).toEqual([]);
	});
});

describe("manifest parsing", () => {
	it("accepts version 1 and rejects unknown versions", () => {
		const value = {
			schemaVersion: 1, id: snapshotId("owner/repo", SHA_A), repository: "owner/repo", requestedRef: null,
			resolvedRef: "refs/heads/main", commit: SHA_A, acquiredAt: "2026-01-01T00:00:00.000Z",
			fileCount: 1, byteCount: 2, symlinksConverted: 0, submodulesSkipped: [],
		};
		expect(parseSnapshotManifest(value)).toEqual(value);
		expect(() => parseSnapshotManifest({ ...value, schemaVersion: 2 })).toThrow();
	});
});
