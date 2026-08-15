import { constants } from "node:fs";
import { cp, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

export interface PlanWorkspace {
	root: string;
	hostRoot: string;
	sandboxRoot: string;
	tempRoot: string;
	dispose(): Promise<void>;
}

export interface PlanWorkspaceOptions {
	signal?: AbortSignal;
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
 */
export async function createPlanWorkspace(
	hostRoot: string,
	options: PlanWorkspaceOptions = {},
): Promise<PlanWorkspace> {
	throwIfAborted(options.signal);
	const canonicalHostRoot = await realpath(hostRoot);
	const createdRoot = await mkdtemp(join(tmpdir(), "pi-plan-workspace-"));
	const root = await realpath(createdRoot);
	const sandboxRoot = join(root, basename(canonicalHostRoot) || "workspace");
	const tempRoot = join(root, "tmp");

	try {
		throwIfAborted(options.signal);
		await cp(canonicalHostRoot, sandboxRoot, {
			recursive: true,
			force: false,
			errorOnExist: true,
			preserveTimestamps: true,
			verbatimSymlinks: true,
			mode: constants.COPYFILE_FICLONE,
			filter: () => {
				throwIfAborted(options.signal);
				return true;
			},
		});
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
