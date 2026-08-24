import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	DEFAULT_SNAPSHOT_LIMITS,
	RepositoryError,
	repositoryError,
	type AcquireInput,
	type RemoveResult,
	type RepositoryStore,
	type Snapshot,
	type SnapshotAdapter,
	type SnapshotLimits,
	type SnapshotManifest,
	type SnapshotSummary,
} from "./contract.ts";
import { parseGitHubRepository, validateGitRef } from "./github-locator.ts";

const COMMIT_RE = /^[0-9a-f]{40}$/;
const ID_RE = /^ghr_[0-9a-f]{24}$/;
const ABANDONED_STAGE_MS = 24 * 60 * 60 * 1000;
const ABANDONED_LOCK_MS = 60 * 60 * 1000;

export interface RepositoryStoreOptions {
	storageRoot: string;
	adapter: SnapshotAdapter;
	clock?: () => Date;
	idSource?: (repository: string, commit: string) => string;
	limits?: Partial<SnapshotLimits>;
}

export class GitHubRepositoryStore implements RepositoryStore {
	private readonly root: string;
	private readonly adapter: SnapshotAdapter;
	private readonly clock: () => Date;
	private readonly idSource: (repository: string, commit: string) => string;
	private readonly limits: SnapshotLimits;
	private mutationTail: Promise<void> = Promise.resolve();

	constructor(options: RepositoryStoreOptions) {
		this.root = path.resolve(options.storageRoot);
		this.adapter = options.adapter;
		this.clock = options.clock ?? (() => new Date());
		this.idSource = options.idSource ?? snapshotId;
		this.limits = { ...DEFAULT_SNAPSHOT_LIMITS, ...options.limits };
	}

	acquire(input: AcquireInput, signal?: AbortSignal): Promise<Snapshot> {
		const deadline = Date.now() + this.limits.deadlineMs;
		return this.enqueue(async () => {
			throwIfCancelled(signal);
			if (Date.now() >= deadline) throw repositoryError("TIMEOUT");
			const locator = parseGitHubRepository(input.repository);
			const requestedRef = validateGitRef(input.ref);
			await this.prepareStorage();
			await this.cleanAbandonedStaging();
			throwIfCancelled(signal);
			const revision = await this.adapter.resolve(locator.remoteUrl, requestedRef, deadline, this.limits, signal);
			if (!COMMIT_RE.test(revision.commit)) throw repositoryError("NETWORK_ERROR");
			const commit = revision.commit.toLowerCase();
			const id = this.idSource(locator.canonical, commit);
			if (!ID_RE.test(id)) throw repositoryError("STORAGE_ERROR");
			const finalDirectory = this.snapshotDirectory(locator.owner, locator.repo, commit);
			return this.withLock(id, deadline, signal, async () => {
				await ensureDirectory(path.join(this.root, locator.owner));
				await ensureDirectory(path.join(this.root, locator.owner, locator.repo));
				const existing = await this.readCompleted(finalDirectory, locator.canonical, commit);
				if (existing) return { ...existing, requestedRef, resolvedRef: revision.resolvedRef, path: path.join(finalDirectory, "source"), reused: true };

				const stagingPath = path.join(this.root, ".staging", `${id}-${randomUUID()}`);
				assertInside(this.root, stagingPath);
				await fs.mkdir(stagingPath, { recursive: false });
				try {
					const materialized = await this.adapter.materialize({
						remoteUrl: locator.remoteUrl,
						revision: { ...revision, commit },
						stagingPath,
						deadline,
						limits: this.limits,
						signal,
					});
					checkActive(deadline, signal);
					const manifest: SnapshotManifest = {
						schemaVersion: 1,
						id,
						repository: locator.canonical,
						requestedRef,
						resolvedRef: revision.resolvedRef,
						commit,
						acquiredAt: this.clock().toISOString(),
						fileCount: materialized.fileCount,
						byteCount: materialized.byteCount,
						symlinksConverted: materialized.symlinksConverted,
						submodulesSkipped: materialized.submodulesSkipped,
					};
					await fs.writeFile(path.join(stagingPath, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o444, flag: "wx" });
					checkActive(deadline, signal);
					try {
						await fs.rename(stagingPath, finalDirectory);
					} catch (error: any) {
						if (error?.code !== "EEXIST" && error?.code !== "ENOTEMPTY") throw error;
						const winner = await this.readCompleted(finalDirectory, locator.canonical, commit);
						if (!winner) throw repositoryError("STORAGE_ERROR");
						return { ...winner, path: path.join(finalDirectory, "source"), reused: true };
					}
					return { ...manifest, path: path.join(finalDirectory, "source"), reused: false };
				} catch (error) {
					throw normalizeError(error);
				} finally {
					await makeTreeRemovable(stagingPath).catch(() => {});
					await fs.rm(stagingPath, { recursive: true, force: true }).catch(() => {});
				}
			});
		});
	}

	async list(): Promise<SnapshotSummary[]> {
		try {
			const stat = await fs.lstat(this.root);
			if (!stat.isDirectory() || stat.isSymbolicLink()) throw repositoryError("STORAGE_ERROR");
		} catch (error: any) {
			if (error?.code === "ENOENT") return [];
			throw normalizeError(error);
		}
		return (await this.scanSnapshots()).slice(0, this.limits.maxListEntries);
	}

	remove(id: string, signal?: AbortSignal): Promise<RemoveResult> {
		const deadline = Date.now() + this.limits.deadlineMs;
		return this.enqueue(async () => {
			checkActive(deadline, signal);
			if (!ID_RE.test(id)) throw repositoryError("SNAPSHOT_NOT_FOUND");
			await this.prepareStorage();
			const snapshot = (await this.scanSnapshots()).find((item) => item.id === id);
			if (!snapshot) throw repositoryError("SNAPSHOT_NOT_FOUND");
			const directory = path.dirname(snapshot.path);
			return this.withLock(id, deadline, signal, async () => {
				const manifest = await this.readCompleted(directory, snapshot.repository, snapshot.commit);
				if (!manifest || manifest.id !== id) throw repositoryError("SNAPSHOT_NOT_FOUND");
				await this.assertRemovable(directory);
				checkActive(deadline, signal);
				await makeTreeRemovable(directory);
				checkActive(deadline, signal);
				await fs.rm(directory, { recursive: true, force: false }).catch((error) => { throw normalizeError(error); });
				return { id, repository: manifest.repository, commit: manifest.commit, removed: true as const };
			});
		});
	}

	private enqueue<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.mutationTail.then(operation, operation);
		this.mutationTail = result.then(() => undefined, () => undefined);
		return result;
	}

	private async scanSnapshots(): Promise<SnapshotSummary[]> {
		const snapshots: SnapshotSummary[] = [];
		for (const owner of await safeDirectories(this.root)) {
			if (owner.name.startsWith(".")) continue;
			for (const repo of await safeDirectories(path.join(this.root, owner.name))) {
				for (const commit of await safeDirectories(path.join(this.root, owner.name, repo.name))) {
					if (!COMMIT_RE.test(commit.name)) continue;
					const directory = path.join(this.root, owner.name, repo.name, commit.name);
					const manifest = await this.readCompleted(directory, `${owner.name}/${repo.name}`, commit.name);
					if (manifest) snapshots.push({ ...manifest, path: path.join(directory, "source") });
				}
			}
		}
		return snapshots.sort((a, b) => b.acquiredAt.localeCompare(a.acquiredAt) || a.repository.localeCompare(b.repository) || a.commit.localeCompare(b.commit));
	}

	private async prepareStorage(): Promise<void> {
		try {
			await fs.mkdir(this.root, { recursive: true });
			await ensureDirectory(this.root);
			await ensureDirectory(path.join(this.root, ".staging"));
			await ensureDirectory(path.join(this.root, ".locks"));
		} catch (error) { throw normalizeError(error); }
	}

	private snapshotDirectory(owner: string, repo: string, commit: string): string {
		const target = path.join(this.root, owner, repo, commit);
		assertInside(this.root, target);
		return target;
	}

	private async readCompleted(directory: string, repository: string, commit: string): Promise<SnapshotManifest | undefined> {
		try {
			const snapshotDirectory = await fs.lstat(directory);
			if (!snapshotDirectory.isDirectory() || snapshotDirectory.isSymbolicLink()) return undefined;
			const manifestPath = path.join(directory, "manifest.json");
			const manifestStat = await fs.lstat(manifestPath);
			if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.size > 64 * 1024) return undefined;
			const manifest = parseSnapshotManifest(JSON.parse(await fs.readFile(manifestPath, "utf8")));
			if (
				manifest.repository !== repository || manifest.commit !== commit || manifest.id !== this.idSource(repository, commit) ||
				parseGitHubRepository(manifest.repository).canonical !== manifest.repository ||
				validateGitRef(manifest.requestedRef ?? undefined) !== manifest.requestedRef ||
				validateGitRef(manifest.resolvedRef) !== manifest.resolvedRef ||
				manifest.fileCount > this.limits.maxEntries || manifest.byteCount > this.limits.maxTreeBytes ||
				manifest.submodulesSkipped.some((item) => !isSafeStoredPath(item))
			) return undefined;
			const source = await fs.lstat(path.join(directory, "source"));
			if (!source.isDirectory() || source.isSymbolicLink()) return undefined;
			return manifest;
		} catch { return undefined; }
	}

	private async withLock<T>(id: string, deadline: number, signal: AbortSignal | undefined, operation: () => Promise<T>): Promise<T> {
		const lock = path.join(this.root, ".locks", id);
		const ownerToken = randomUUID();
		while (true) {
			throwIfCancelled(signal);
			if (Date.now() >= deadline) throw repositoryError("TIMEOUT");
			try {
				await fs.mkdir(lock);
				await fs.writeFile(path.join(lock, "owner"), ownerToken, { flag: "wx", mode: 0o600 });
				break;
			} catch (error: any) {
				if (error?.code !== "EEXIST") {
					await fs.rm(lock, { recursive: true, force: true }).catch(() => {});
					throw normalizeError(error);
				}
				try {
					const stat = await fs.lstat(lock);
					if (!stat.isDirectory() || stat.isSymbolicLink()) throw repositoryError("STORAGE_ERROR");
					if (Date.now() - stat.mtimeMs > ABANDONED_LOCK_MS) {
						const abandoned = `${lock}.abandoned-${randomUUID()}`;
						await fs.rename(lock, abandoned);
						await fs.rm(abandoned, { recursive: true, force: true });
						continue;
					}
				} catch (lockError: any) {
					if (lockError instanceof RepositoryError) throw lockError;
					if (lockError?.code !== "ENOENT") throw normalizeError(lockError);
				}
				await delay(50, signal);
			}
		}
		const heartbeat = setInterval(() => {
			void fs.readFile(path.join(lock, "owner"), "utf8")
				.then((owner) => owner === ownerToken ? fs.utimes(lock, new Date(), new Date()) : undefined)
				.catch(() => {});
		}, 60_000);
		heartbeat.unref();
		try { return await operation(); }
		finally {
			clearInterval(heartbeat);
			try {
				if (await fs.readFile(path.join(lock, "owner"), "utf8") === ownerToken) {
					await fs.rm(lock, { recursive: true, force: true });
				}
			} catch {}
		}
	}

	private async cleanAbandonedStaging(): Promise<void> {
		const now = this.clock().getTime();
		for (const entry of await fs.readdir(path.join(this.root, ".staging"), { withFileTypes: true })) {
			if (!/^ghr_[0-9a-f]{24}-[0-9a-f-]{36}$/.test(entry.name)) continue;
			const target = path.join(this.root, ".staging", entry.name);
			try {
				const stat = await fs.lstat(target);
				if (now - stat.mtimeMs > ABANDONED_STAGE_MS) {
					if (stat.isDirectory() && !stat.isSymbolicLink()) await makeTreeRemovable(target);
					await fs.rm(target, { recursive: true, force: true });
				}
			} catch {}
		}
	}

	private async assertRemovable(directory: string): Promise<void> {
		assertInside(this.root, directory);
		const relative = path.relative(this.root, directory);
		if (relative.split(path.sep).length !== 3) throw repositoryError("STORAGE_ERROR");
		let current = this.root;
		for (const part of relative.split(path.sep)) {
			current = path.join(current, part);
			const stat = await fs.lstat(current);
			if (stat.isSymbolicLink() || !stat.isDirectory()) throw repositoryError("STORAGE_ERROR");
		}
	}
}

export function snapshotId(repository: string, commit: string): string {
	return `ghr_${createHash("sha256").update(`${repository}\0${commit}`).digest("hex").slice(0, 24)}`;
}

export function parseSnapshotManifest(value: unknown): SnapshotManifest {
	if (!isRecord(value) || value.schemaVersion !== 1) throw repositoryError("STORAGE_ERROR");
	const manifest = value as Record<string, unknown>;
	if (
		typeof manifest.id !== "string" || !ID_RE.test(manifest.id) ||
		typeof manifest.repository !== "string" || !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(manifest.repository) ||
		(manifest.requestedRef !== null && typeof manifest.requestedRef !== "string") ||
		typeof manifest.resolvedRef !== "string" || !manifest.resolvedRef ||
		typeof manifest.commit !== "string" || !COMMIT_RE.test(manifest.commit) ||
		typeof manifest.acquiredAt !== "string" || !Number.isFinite(Date.parse(manifest.acquiredAt)) ||
		!nonnegativeInteger(manifest.fileCount) || !nonnegativeInteger(manifest.byteCount) || !nonnegativeInteger(manifest.symlinksConverted) ||
		!Array.isArray(manifest.submodulesSkipped) || !manifest.submodulesSkipped.every((item) => typeof item === "string")
	) throw repositoryError("STORAGE_ERROR");
	return manifest as unknown as SnapshotManifest;
}

function isSafeStoredPath(value: string): boolean {
	return Boolean(value) && !path.isAbsolute(value) && !value.includes("\\") && !/[\x00-\x1f\x7f]/.test(value) && value.split("/").every((part) => part && part !== "." && part !== "..");
}

function assertInside(root: string, target: string): void {
	const relative = path.relative(root, target);
	if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw repositoryError("STORAGE_ERROR");
}

async function safeDirectories(directory: string): Promise<Array<{ name: string }>> {
	try {
		const entries = await fs.readdir(directory, { withFileTypes: true });
		return entries.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink()).map((entry) => ({ name: entry.name }));
	} catch { return []; }
}

async function ensureDirectory(directory: string): Promise<void> {
	try { await fs.mkdir(directory); }
	catch (error: any) { if (error?.code !== "EEXIST") throw error; }
	const stat = await fs.lstat(directory);
	if (!stat.isDirectory() || stat.isSymbolicLink()) throw repositoryError("STORAGE_ERROR");
}

async function makeTreeRemovable(root: string): Promise<void> {
	const rootStat = await fs.lstat(root);
	if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw repositoryError("STORAGE_ERROR");
	async function visit(directory: string): Promise<void> {
		await fs.chmod(directory, 0o700);
		for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
			if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
			await visit(path.join(directory, entry.name));
		}
	}
	try { await visit(root); }
	catch (error) { throw normalizeError(error); }
}

function normalizeError(error: unknown): RepositoryError {
	if (error instanceof RepositoryError) return error;
	return repositoryError("STORAGE_ERROR");
}

function throwIfCancelled(signal?: AbortSignal): void {
	if (signal?.aborted) throw repositoryError("CANCELLED");
}

function checkActive(deadline: number, signal?: AbortSignal): void {
	throwIfCancelled(signal);
	if (Date.now() >= deadline) throw repositoryError("TIMEOUT");
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener("abort", () => { clearTimeout(timer); reject(repositoryError("CANCELLED")); }, { once: true });
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonnegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
