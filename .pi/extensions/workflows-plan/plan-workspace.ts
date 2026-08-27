import { spawn } from "node:child_process";
import { constants, statSync } from "node:fs";
import { chmod, cp, lstat, mkdir, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative } from "node:path";
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
	/** Selects the native clone command. Injectable for tests. */
	platform?: NodeJS.Platform;
	/** Overrides copy-on-write detection. Injectable for tests. */
	supportsCloning?: (hostRoot: string, workspaceRoot: string) => Promise<boolean>;
	/** Overrides clone subprocess execution. Injectable for abort tests. */
	runCloneCommand?: CloneCommandRunner;
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

function isWithin(parent: string, candidate: string): boolean {
	const relPath = relative(parent, candidate);
	return relPath === "" || (!relPath.startsWith("..") && !isAbsolute(relPath));
}

async function runCloneCommand(args: readonly string[], signal?: AbortSignal): Promise<void> {
	throwIfAborted(signal);
	await new Promise<void>((resolvePromise, rejectPromise) => {
		const executable = process.platform === "darwin" ? "/bin/cp" : "/usr/bin/cp";
		const child = spawn(executable, args, {
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

function cloneArgs(platform: NodeJS.Platform, source: string, destination: string): string[] {
	return platform === "darwin"
		? ["-Rcp", source, destination]
		: ["-a", "--reflink=auto", source, destination];
}

async function copyWithFs(hostRoot: string, sandboxRoot: string, signal?: AbortSignal): Promise<void> {
	await cp(hostRoot, sandboxRoot, {
		recursive: true,
		force: false,
		errorOnExist: true,
		preserveTimestamps: true,
		verbatimSymlinks: true,
		mode: constants.COPYFILE_FICLONE,
		filter: () => {
			throwIfAborted(signal);
			return true;
		},
	});
}

function isFileSystemError(error: unknown, code: string): error is NodeJS.ErrnoException {
	return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

interface RemovableTreeOperations {
	lstat(path: string): Promise<{
		mode: number;
		isDirectory(): boolean;
		isSymbolicLink(): boolean;
	}>;
	chmod(path: string, mode: number): Promise<void>;
	readdir(path: string): Promise<Array<{
		name: string;
		isDirectory(): boolean;
		isSymbolicLink(): boolean;
	}>>;
}

const removableTreeOperations: RemovableTreeOperations = {
	lstat,
	chmod,
	readdir: (path) => readdir(path, { withFileTypes: true }),
};

export async function makeTreeRemovable(
	root: string,
	operations: RemovableTreeOperations = removableTreeOperations,
): Promise<void> {
	let info;
	try {
		info = await operations.lstat(root);
	} catch (error) {
		if (isFileSystemError(error, "ENOENT")) return;
		throw error;
	}
	if (!info.isDirectory() || info.isSymbolicLink()) return;

	try {
		await operations.chmod(root, (info.mode & 0o7777) | 0o700);
	} catch (error) {
		if (isFileSystemError(error, "ENOENT")) return;
		throw error;
	}
	let entries;
	try {
		entries = await operations.readdir(root);
	} catch (error) {
		if (isFileSystemError(error, "ENOENT")) return;
		throw error;
	}
	for (const entry of entries) {
		if (entry.isDirectory() && !entry.isSymbolicLink()) {
			await makeTreeRemovable(join(root, entry.name), operations);
		}
	}
}

async function removeDisposableTree(root: string): Promise<void> {
	try {
		await rm(root, { recursive: true, force: true });
	} catch (error) {
		if (!isFileSystemError(error, "EACCES") && !isFileSystemError(error, "EPERM")) throw error;
		await makeTreeRemovable(root);
		await rm(root, { recursive: true, force: true });
	}
}

/**
 * Create a writable, isolated clone of the complete host workspace. On macOS,
 * BSD cp uses APFS clonefile. On Linux, GNU cp requests reflinks and falls back
 * to ordinary copies. Both native paths require the source and temporary root
 * to be on the same device. Other platforms and failed clone commands use the
 * fs.cp implementation.
 *
 * The copy is deliberately policy-free: dependencies, virtual environments,
 * caches, build output, repository metadata, and unrecognized directories all
 * receive the same writable copy-on-write treatment. Plan Mode does not add
 * links back into the host workspace; source symlinks retain their targets.
 */
export async function createPlanWorkspace(
	hostRoot: string,
	options: PlanWorkspaceOptions = {},
): Promise<PlanWorkspace> {
	throwIfAborted(options.signal);
	const platform = options.platform ?? process.platform;
	const canonicalHostRoot = await realpath(hostRoot);
	const createdRoot = await mkdtemp(join(tmpdir(), "pi-plan-workspace-"));
	const root = await realpath(createdRoot);
	const workspaceName = basename(canonicalHostRoot) || "workspace";
	const sandboxRoot = join(root, workspaceName);
	const tempRoot = join(root, workspaceName === "tmp" ? "plan-tmp" : "tmp");

	try {
		if (isWithin(canonicalHostRoot, root)) {
			throw new Error(`Plan workspace root must be outside the host workspace: ${root}`);
		}
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
				await (options.runCloneCommand ?? runCloneCommand)(
					cloneArgs(platform, canonicalHostRoot, sandboxRoot),
					options.signal,
				);
			} catch (error) {
				if (options.signal?.aborted) throw abortError();
				await removeDisposableTree(sandboxRoot);
				await copyWithFs(canonicalHostRoot, sandboxRoot, options.signal);
			}
		} else {
			await copyWithFs(canonicalHostRoot, sandboxRoot, options.signal);
		}

		throwIfAborted(options.signal);
		await mkdir(tempRoot, { recursive: true });
	} catch (error) {
		await removeDisposableTree(root);
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
			disposePromise = removeDisposableTree(root).catch((error) => {
				disposePromise = undefined;
				throw error;
			});
			return disposePromise;
		},
	};
}
