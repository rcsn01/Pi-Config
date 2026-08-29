/**
 * Worktree artifact collection.
 *
 * Turns a workflow agent's worktree into durable run artifacts: fetches the
 * working-tree patch parts through the shared git executor
 * (`collectWorkingTreePatches` in `_shared/git.ts`), writes the combined
 * patch and summary through `writeArtifact`, and returns the summary. Git
 * invocation policy — timeout, abort, output caps, diff semantics — lives in
 * the executor; this module owns artifact records only.
 */

import { collectWorkingTreePatches } from "../../_shared/git.ts";

export interface WorktreeInfo {
	path: string;
	branch: string;
	branchId: string;
	preserve?: boolean;
	fileOwnership?: string[];
}

export interface WorktreeArtifactDeps {
	signal?: AbortSignal;
	writeArtifact: (relativePath: string, data: unknown) => Promise<string>;
}

export async function collectWorktreeArtifacts(
	key: string,
	worktree: WorktreeInfo,
	returned: unknown,
	deps: WorktreeArtifactDeps,
): Promise<Record<string, unknown>> {
	const { signal, writeArtifact } = deps;
	const patches = await collectWorkingTreePatches(worktree.path, { signal, maxOutputBytes: 20_000_000 });
	const patch = [patches.staged, patches.unstaged, ...patches.untrackedPatches].filter(Boolean).join("\n");
	const patchPath = patch ? await writeArtifact(`diffs/${key}.patch`, patch) : undefined;
	const summary = { ...worktree, changedFiles: patches.changedFiles, status: patches.status, patchPath, result: returned };
	const jsonPath = await writeArtifact(`diffs/${key}.json`, summary);
	return { ...summary, jsonPath };
}