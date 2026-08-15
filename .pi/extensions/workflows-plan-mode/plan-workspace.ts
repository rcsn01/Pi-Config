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

/**
 * Create an isolated workspace copy. COPYFILE_FICLONE uses copy-on-write when
 * the filesystem supports it and safely falls back to an ordinary copy.
 */
export async function createPlanWorkspace(hostRoot: string): Promise<PlanWorkspace> {
	const canonicalHostRoot = await realpath(hostRoot);
	const root = await mkdtemp(join(tmpdir(), "pi-plan-workspace-"));
	const sandboxRoot = join(root, basename(canonicalHostRoot) || "workspace");
	const tempRoot = join(root, "tmp");

	try {
		await cp(canonicalHostRoot, sandboxRoot, {
			recursive: true,
			force: false,
			errorOnExist: true,
			preserveTimestamps: true,
			verbatimSymlinks: true,
			mode: constants.COPYFILE_FICLONE,
		});
		await mkdir(tempRoot, { recursive: true });
	} catch (error) {
		await rm(root, { recursive: true, force: true });
		throw error;
	}

	let disposed = false;
	return {
		root,
		hostRoot: canonicalHostRoot,
		sandboxRoot,
		tempRoot,
		async dispose() {
			if (disposed) return;
			disposed = true;
			await rm(root, { recursive: true, force: true });
		},
	};
}
