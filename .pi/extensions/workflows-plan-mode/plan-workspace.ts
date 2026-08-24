import { spawn } from "node:child_process";
import { constants, lstatSync, statSync } from "node:fs";
import { chmod, cp, mkdir, mkdtemp, readdir, realpath, rm, stat, symlink, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { killProcessGroup } from "../_shared/process.ts";

export interface PlanWorkspace {
	root: string;
	hostRoot: string;
	sandboxRoot: string;
	tempRoot: string;
	dispose(): Promise<void>;
}

type CloneCommandRunner = (args: readonly string[], signal?: AbortSignal) => Promise<void>;

export interface PlanWorkspaceOptions {
	signal?: AbortSignal;
	/**
	 * Directories matching this predicate are recreated as links into the host
	 * workspace instead of being copied. Receives the workspace-relative path
	 * ("" for the root, which can never be linked). Defaults to matching any
	 * `node_modules` directory at any depth.
	 */
	shouldLink?: (relPath: string) => boolean;
	/** Directories matching this predicate are omitted from the copy entirely. */
	shouldExclude?: (relPath: string) => boolean;
	/** Selects clone commands and the link type (`junction` on win32). Injectable for tests. */
	platform?: NodeJS.Platform;
	/** Overrides copy-on-write detection. Injectable for tests. */
	supportsCloning?: (hostRoot: string, workspaceRoot: string) => Promise<boolean>;
	/** Overrides clone subprocess execution. Injectable for abort tests. */
	runCloneCommand?: CloneCommandRunner;
}

interface ClonePlan {
	dirtyDirs: Set<string>;
	excluded: Set<string>;
	linkedPaths: Set<string>;
	linked: Array<{ src: string; dst: string }>;
}

function defaultShouldLink(relPath: string): boolean {
	return relPath !== "" && basename(relPath) === "node_modules";
}

function abortError(): Error {
	const error = new Error("Plan workspace creation was aborted.");
	error.name = "AbortError";
	return error;
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw abortError();
}

export function isSameDevice(source: { dev: number }, destination: { dev: number }): boolean {
	return source.dev === destination.dev;
}

async function runCloneCommand(args: readonly string[], signal?: AbortSignal): Promise<void> {
	throwIfAborted(signal);
	await new Promise<void>((resolvePromise, rejectPromise) => {
		const child = spawn("cp", args, {
			detached: process.platform !== "win32",
			stdio: ["ignore", "ignore", "pipe"],
		});
		let stderr = "";
		let settled = false;

		const finish = (callback: () => void) => {
			if (settled) return;
			settled = true;
			signal?.removeEventListener("abort", onAbort);
			callback();
		};
		const onAbort = () => killProcessGroup(child);
		signal?.addEventListener("abort", onAbort, { once: true });
		if (signal?.aborted) onAbort();

		child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
		child.on("error", (error) => finish(() => rejectPromise(error)));
		child.on("close", (code) => finish(() => {
			if (signal?.aborted) rejectPromise(abortError());
			else if (code === 0) resolvePromise();
			else rejectPromise(new Error(`cp exited with code ${code}${stderr ? `: ${stderr.trim()}` : ""}`));
		}));
	});
}

function markAncestorsDirty(relPath: string, dirtyDirs: Set<string>): void {
	let parent = dirname(relPath);
	while (parent !== ".") {
		dirtyDirs.add(parent);
		if (parent === "") break;
		parent = dirname(parent);
	}
	dirtyDirs.add("");
}

async function buildClonePlan(
	hostRoot: string,
	sandboxRoot: string,
	shouldLink: (relPath: string) => boolean,
	shouldExclude: (relPath: string) => boolean,
	signal?: AbortSignal,
): Promise<ClonePlan> {
	const plan: ClonePlan = { dirtyDirs: new Set(), excluded: new Set(), linkedPaths: new Set(), linked: [] };

	const scan = async (relDir: string): Promise<void> => {
		throwIfAborted(signal);
		const sourceDir = relDir === "" ? hostRoot : join(hostRoot, relDir);
		for (const entry of await readdir(sourceDir, { withFileTypes: true })) {
			throwIfAborted(signal);
			const relPath = relDir === "" ? entry.name : join(relDir, entry.name);
			if (shouldExclude(relPath)) {
				plan.excluded.add(relPath);
				markAncestorsDirty(relPath, plan.dirtyDirs);
				continue;
			}
			if (entry.isDirectory() && shouldLink(relPath)) {
				plan.linkedPaths.add(relPath);
				plan.linked.push({ src: join(hostRoot, relPath), dst: join(sandboxRoot, relPath) });
				markAncestorsDirty(relPath, plan.dirtyDirs);
				continue;
			}
			if (entry.isDirectory()) await scan(relPath);
		}
	};

	await scan("");
	return plan;
}

function cloneArgs(platform: NodeJS.Platform, sources: readonly string[], destination: string): string[] {
	return platform === "darwin"
		? ["-Rcp", ...sources, destination]
		: ["-a", "--reflink=auto", ...sources, destination];
}

async function clonePlannedTree(
	hostRoot: string,
	sandboxRoot: string,
	plan: ClonePlan,
	platform: NodeJS.Platform,
	run: CloneCommandRunner,
	signal?: AbortSignal,
): Promise<void> {
	const clone = (sources: readonly string[], destination: string) =>
		run(cloneArgs(platform, sources, destination), signal);

	const copyDirectory = async (relDir: string): Promise<void> => {
		throwIfAborted(signal);
		const src = relDir === "" ? hostRoot : join(hostRoot, relDir);
		const dst = relDir === "" ? sandboxRoot : join(sandboxRoot, relDir);
		if (!plan.dirtyDirs.has(relDir)) {
			await clone([src], dst);
			return;
		}

		await mkdir(dst);
		const files: string[] = [];
		for (const entry of await readdir(src, { withFileTypes: true })) {
			throwIfAborted(signal);
			const relPath = relDir === "" ? entry.name : join(relDir, entry.name);
			if (plan.excluded.has(relPath) || plan.linkedPaths.has(relPath)) continue;
			if (entry.isDirectory()) await copyDirectory(relPath);
			else files.push(join(hostRoot, relPath));
		}
		for (let offset = 0; offset < files.length; offset += 256) {
			await clone(files.slice(offset, offset + 256), dst);
		}
		const sourceStat = await stat(src);
		await chmod(dst, sourceStat.mode & 0o7777);
		await utimes(dst, sourceStat.atime, sourceStat.mtime);
	};

	await copyDirectory("");
}

async function copyWithFs(
	hostRoot: string,
	sandboxRoot: string,
	shouldLink: (relPath: string) => boolean,
	shouldExclude: (relPath: string) => boolean,
	linked: Array<{ src: string; dst: string }>,
	signal?: AbortSignal,
): Promise<void> {
	await cp(hostRoot, sandboxRoot, {
		recursive: true,
		force: false,
		errorOnExist: true,
		preserveTimestamps: true,
		verbatimSymlinks: true,
		mode: constants.COPYFILE_FICLONE,
		filter: (src, dst) => {
			throwIfAborted(signal);
			const relPath = relative(hostRoot, src);
			if (relPath === "") return true;
			if (shouldExclude(relPath)) return false;
			if (shouldLink(relPath) && lstatSync(src).isDirectory()) {
				linked.push({ src, dst });
				return false;
			}
			return true;
		},
	});
}

/**
 * Create an isolated workspace copy. On macOS, BSD cp uses APFS clonefile. On
 * Linux, GNU cp requests a reflink and falls back to an ordinary copy. Both
 * paths require the host and temporary workspace to be on the same device.
 * Other platforms and failed clone commands use the fs.cp implementation.
 *
 * Directories matched by `shouldLink` are recreated as links into the host
 * instead of being copied. The Plan Bash sandbox already allows host reads
 * and denies host writes, so linked content is a read-only live view rather
 * than a snapshot: host-side changes become visible mid-session, and writes
 * into a linked path fail loudly (sandbox denial) instead of being silently
 * discarded. Directories matched by `shouldExclude` are omitted entirely.
 * Disposal removes links without traversing them, leaving host targets
 * untouched.
 */
export async function createPlanWorkspace(
	hostRoot: string,
	options: PlanWorkspaceOptions = {},
): Promise<PlanWorkspace> {
	throwIfAborted(options.signal);
	const shouldLink = options.shouldLink ?? defaultShouldLink;
	const shouldExclude = options.shouldExclude ?? (() => false);
	const platform = options.platform ?? process.platform;
	const canonicalHostRoot = await realpath(hostRoot);
	const createdRoot = await mkdtemp(join(tmpdir(), "pi-plan-workspace-"));
	const root = await realpath(createdRoot);
	const sandboxRoot = join(root, basename(canonicalHostRoot) || "workspace");
	const tempRoot = join(root, "tmp");
	const linked: Array<{ src: string; dst: string }> = [];

	try {
		throwIfAborted(options.signal);
		let supportsCloning = false;
		if (platform === "darwin" || platform === "linux") {
			try {
				const detect = options.supportsCloning ?? (async (src, dst) => isSameDevice(statSync(src), statSync(dst)));
				supportsCloning = await detect(canonicalHostRoot, root);
				throwIfAborted(options.signal);
			} catch (error) {
				if (options.signal?.aborted) throw abortError();
				supportsCloning = false;
			}
		}

		if (supportsCloning) {
			try {
				const plan = await buildClonePlan(canonicalHostRoot, sandboxRoot, shouldLink, shouldExclude, options.signal);
				await clonePlannedTree(
					canonicalHostRoot,
					sandboxRoot,
					plan,
					platform,
					options.runCloneCommand ?? runCloneCommand,
					options.signal,
				);
				linked.push(...plan.linked);
			} catch (error) {
				if (options.signal?.aborted) throw abortError();
				await rm(sandboxRoot, { recursive: true, force: true });
				await copyWithFs(canonicalHostRoot, sandboxRoot, shouldLink, shouldExclude, linked, options.signal);
			}
		} else {
			await copyWithFs(canonicalHostRoot, sandboxRoot, shouldLink, shouldExclude, linked, options.signal);
		}

		throwIfAborted(options.signal);
		for (const link of linked) {
			await mkdir(dirname(link.dst), { recursive: true });
			await symlink(link.src, link.dst, platform === "win32" ? "junction" : "dir");
		}
		throwIfAborted(options.signal);
		await mkdir(tempRoot, { recursive: true });
	} catch (error) {
		await rm(root, { recursive: true, force: true });
		throw error;
	}

	let disposePromise: Promise<void> | undefined;
	return {
		root,
		hostRoot: canonicalHostRoot,
		sandboxRoot,
		tempRoot,
		dispose() {
			if (disposePromise) return disposePromise;
			disposePromise = rm(root, { recursive: true, force: true }).catch((error) => {
				disposePromise = undefined;
				throw error;
			});
			return disposePromise;
		},
	};
}
