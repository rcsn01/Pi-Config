import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runGit } from "../../_shared/git.ts";
import { collectWorktreeArtifacts, type WorktreeInfo } from "./worktree-artifacts.ts";

const roots: string[] = [];

afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function tempRepo(): Promise<string> {
	const cwd = await mkdtemp(path.join(os.tmpdir(), "worktree-artifacts-"));
	roots.push(cwd);
	await runGit(cwd, ["init", "-b", "main"]);
	await runGit(cwd, ["config", "user.email", "test@example.com"]);
	await runGit(cwd, ["config", "user.name", "Test User"]);
	await writeFile(path.join(cwd, "base.txt"), "base\n");
	await runGit(cwd, ["add", "base.txt"]);
	await runGit(cwd, ["commit", "-m", "initial"]);
	return cwd;
}

function worktreeInfo(cwd: string): WorktreeInfo {
	return { path: cwd, branch: "fleet/test", branchId: "test", preserve: false, fileOwnership: [] };
}

function fakeArtifacts(): { deps: { writeArtifact: (rel: string, data: unknown) => Promise<string> }; written: Map<string, unknown> } {
	const written = new Map<string, unknown>();
	return {
		written,
		deps: {
			writeArtifact: async (rel: string, data: unknown) => {
				written.set(rel, data);
				return `<artifacts>/${rel}`;
			},
		},
	};
}

describe("worktree artifact collection", () => {
	it("collects staged, unstaged, and untracked changes into one patch", async () => {
		const cwd = await tempRepo();
		await writeFile(path.join(cwd, "staged.txt"), "staged\n");
		await runGit(cwd, ["add", "staged.txt"]);
		await writeFile(path.join(cwd, "base.txt"), "base edited\n");
		await writeFile(path.join(cwd, "untracked.txt"), "fresh\n");
		const { deps, written } = fakeArtifacts();

		const summary = await collectWorktreeArtifacts("agent-1", worktreeInfo(cwd), { output: "done" }, deps);

		const patch = written.get("diffs/agent-1.patch") as string;
		expect(patch).toContain("diff --git a/staged.txt b/staged.txt");
		expect(patch).toContain("diff --git a/base.txt b/base.txt");
		expect(patch).toContain("diff --git a/untracked.txt b/untracked.txt");
		expect(patch).toContain("new file mode");
		expect(new Set(summary.changedFiles as string[])).toEqual(new Set(["staged.txt", "base.txt", "untracked.txt"]));
		expect(summary.status).toContain("A  staged.txt");
		expect(summary.status).toContain("?? untracked.txt");
		expect(summary.patchPath).toBe("<artifacts>/diffs/agent-1.patch");
		expect(summary.jsonPath).toBe("<artifacts>/diffs/agent-1.json");
		expect(summary.result).toEqual({ output: "done" });
		expect(written.get("diffs/agent-1.json")).toMatchObject({ branch: "fleet/test", branchId: "test" });
	});

	it("collects untracked binary files as binary patches", async () => {
		const cwd = await tempRepo();
		await writeFile(path.join(cwd, "blob.bin"), Buffer.from([0x00, 0x01, 0x02, 0x00]));
		const { deps, written } = fakeArtifacts();

		const summary = await collectWorktreeArtifacts("agent-2", worktreeInfo(cwd), null, deps);

		const patch = written.get("diffs/agent-2.patch") as string;
		expect(patch).toContain("GIT binary patch");
		expect(new Set(summary.changedFiles as string[])).toEqual(new Set(["blob.bin"]));
	});

	it("omits the patch artifact for a clean worktree but still writes the summary", async () => {
		const cwd = await tempRepo();
		const { deps, written } = fakeArtifacts();

		const summary = await collectWorktreeArtifacts("agent-3", worktreeInfo(cwd), "ok", deps);

		expect(summary.patchPath).toBeUndefined();
		expect(summary.changedFiles).toEqual([]);
		expect(summary.status).toBe("");
		expect(written.get("diffs/agent-3.patch")).toBeUndefined();
		expect(written.get("diffs/agent-3.json")).toBeDefined();
	});
});