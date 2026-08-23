import { constants, lstatSync } from "node:fs";
import { cp, mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";

export interface PlanWorkspace {
	root: string;
	hostRoot: string;
	sandboxRoot: string;
	tempRoot: string;
	dispose(): Promise<void>;
}

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
	/** Selects the link type (`junction` on win32). Injectable for tests. */
	platform?: NodeJS.Platform;
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

/**
 * Create an isolated workspace copy. COPYFILE_FICLONE uses copy-on-write when
 * the filesystem supports it and safely falls back to an ordinary copy.
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
		await cp(canonicalHostRoot, sandboxRoot, {
			recursive: true,
			force: false,
			errorOnExist: true,
			preserveTimestamps: true,
			verbatimSymlinks: true,
			mode: constants.COPYFILE_FICLONE,
			filter: (src, dst) => {
				throwIfAborted(options.signal);
				const relPath = relative(canonicalHostRoot, src);
				if (relPath === "") return true;
				if (shouldExclude(relPath)) return false;
				if (shouldLink(relPath) && lstatSync(src).isDirectory()) {
					linked.push({ src, dst });
					return false;
				}
				return true;
			},
		});
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
