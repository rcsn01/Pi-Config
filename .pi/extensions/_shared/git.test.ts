import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectGitFacts, collectWorkingTreeDiff, collectWorkingTreePatches, runGit } from "./git.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function repository(): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-git-facts-"));
	roots.push(root);
	await runGit(root, ["init", "-b", "main"]);
	await runGit(root, ["config", "user.email", "test@example.com"]);
	await runGit(root, ["config", "user.name", "Test User"]);
	await fs.writeFile(path.join(root, "tracked file.txt"), "first\n");
	await runGit(root, ["add", "tracked file.txt"]);
	await runGit(root, ["commit", "-m", "initial"]);
	return root;
}

describe("shared git", () => {
	it("collects typed branch, status, and diff facts with paths containing spaces", async () => {
		const root = await repository();
		await fs.writeFile(path.join(root, "tracked file.txt"), "first\nsecond\n");
		await fs.writeFile(path.join(root, "untracked file.txt"), "new content\n");
		const facts = await collectGitFacts(root);
		expect(facts).toMatchObject({ isRepository: true, branch: "main", clean: false });
		expect(facts.status.map((entry) => entry.path)).toEqual(["tracked file.txt", "untracked file.txt"]);

		const diff = await collectWorkingTreeDiff(root, "uncommitted", { includeUntrackedContent: true });
		expect(diff).toContain("tracked file.txt");
		expect(diff).toContain("--- untracked file.txt ---");
		expect(diff).toContain("new content");
	});

	it("applies path scopes to tracked, staged, and untracked output", async () => {
		const root = await repository();
		const files = [
			"selected-staged.txt",
			"other-staged.txt",
			"selected-unstaged.txt",
			"other-unstaged.txt",
		];
		for (const file of files) await fs.writeFile(path.join(root, file), "initial\n");
		await runGit(root, ["add", ...files]);
		await runGit(root, ["commit", "-m", "add scope fixtures"]);

		await fs.writeFile(path.join(root, "selected-staged.txt"), "SELECTED_STAGED\n");
		await fs.writeFile(path.join(root, "other-staged.txt"), "OTHER_STAGED\n");
		await runGit(root, ["add", "selected-staged.txt", "other-staged.txt"]);
		await fs.writeFile(path.join(root, "selected-unstaged.txt"), "SELECTED_UNSTAGED\n");
		await fs.writeFile(path.join(root, "other-unstaged.txt"), "OTHER_UNSTAGED\n");
		await fs.writeFile(path.join(root, "selected-untracked.txt"), "SELECTED_UNTRACKED_CONTENT\n");
		await fs.writeFile(path.join(root, "other-untracked.txt"), "OTHER_UNTRACKED_CONTENT\n");
		const paths = [
			path.join(root, "selected-staged.txt"),
			path.join(root, "selected-unstaged.txt"),
			path.join(root, "selected-untracked.txt"),
		];

		const staged = await collectWorkingTreeDiff(root, "staged", { paths });
		expect(staged).toContain("SELECTED_STAGED");
		expect(staged).not.toContain("OTHER_STAGED");
		const unstaged = await collectWorkingTreeDiff(root, "unstaged", { paths });
		expect(unstaged).toContain("SELECTED_UNSTAGED");
		expect(unstaged).not.toContain("OTHER_UNSTAGED");

		for (const mode of ["summary", "uncommitted"] as const) {
			const diff = await collectWorkingTreeDiff(root, mode, { paths });
			expect(diff).toContain("selected-staged.txt");
			expect(diff).toContain("selected-unstaged.txt");
			expect(diff).toContain("selected-untracked.txt");
			expect(diff).not.toContain("other-staged.txt");
			expect(diff).not.toContain("other-unstaged.txt");
			expect(diff).not.toContain("other-untracked.txt");
			expect(diff).not.toContain("SELECTED_UNTRACKED_CONTENT");
		}

		const withContents = await collectWorkingTreeDiff(root, "uncommitted", {
			paths: [path.join(root, "selected-untracked.txt")],
			includeUntrackedContent: true,
		});
		expect(withContents).toContain("SELECTED_UNTRACKED_CONTENT");
		expect(withContents).not.toContain("OTHER_UNTRACKED_CONTENT");
	});

	it("supports directory scopes, deleted files, and child working directories", async () => {
		const root = await repository();
		await fs.mkdir(path.join(root, "child", "selected"), { recursive: true });
		await fs.mkdir(path.join(root, "child", "other"), { recursive: true });
		await fs.writeFile(path.join(root, "child", "selected", "changed.txt"), "initial\n");
		await fs.writeFile(path.join(root, "child", "selected", "deleted.txt"), "delete me\n");
		await fs.writeFile(path.join(root, "child", "other", "changed.txt"), "initial\n");
		await runGit(root, ["add", "child"]);
		await runGit(root, ["commit", "-m", "add child fixtures"]);
		await fs.writeFile(path.join(root, "child", "selected", "changed.txt"), "DIRECTORY_SELECTED\n");
		await fs.writeFile(path.join(root, "child", "other", "changed.txt"), "DIRECTORY_OTHER\n");
		await fs.rm(path.join(root, "child", "selected", "deleted.txt"));

		const child = path.join(root, "child");
		const diff = await collectWorkingTreeDiff(child, "uncommitted", {
			paths: [path.join(child, "selected")],
		});
		expect(diff).toContain("DIRECTORY_SELECTED");
		expect(diff).toContain("deleted.txt");
		expect(diff).not.toContain("DIRECTORY_OTHER");
	});

	it("treats scoped paths literally and a repository-root path as unscoped", async () => {
		const root = await repository();
		const selectedFiles = [
			"space name.txt",
			"-leading.txt",
			"star*.txt",
			"question?.txt",
			"left[.txt",
			"right].txt",
			"colon:name.txt",
		];
		const decoyFiles = ["starX.txt", "questionX.txt", "leftx.txt", "unrelated.txt"];
		const allFiles = [...selectedFiles, ...decoyFiles];
		for (const [index, file] of allFiles.entries()) {
			await fs.writeFile(path.join(root, file), `initial ${index}\n`);
		}
		await runGit(root, ["add", "--", ...allFiles]);
		await runGit(root, ["commit", "-m", "add literal fixtures"]);
		for (const [index, file] of allFiles.entries()) {
			await fs.writeFile(path.join(root, file), `MARKER_${index}\n`);
		}

		for (const [index, file] of selectedFiles.entries()) {
			const diff = await collectWorkingTreeDiff(root, "unstaged", {
				paths: [path.join(root, file)],
			});
			expect(diff).toContain(`MARKER_${index}`);
			for (let other = 0; other < allFiles.length; other++) {
				if (other !== index) expect(diff).not.toContain(`MARKER_${other}`);
			}
		}

		const unscoped = await collectWorkingTreeDiff(root, "unstaged");
		const rootScoped = await collectWorkingTreeDiff(root, "unstaged", { paths: [root] });
		expect(rootScoped).toBe(unscoped);
		for (let index = 0; index < allFiles.length; index++) {
			expect(unscoped).toContain(`MARKER_${index}`);
		}
	});

	it("rejects scoped paths outside the Git repository", async () => {
		const root = await repository();
		const outside = await fs.mkdtemp(path.join(os.tmpdir(), "pi-git-outside-"));
		roots.push(outside);
		await expect(collectWorkingTreeDiff(root, "summary", { paths: [outside] }))
			.rejects.toThrow("outside the repository");
	});

	it("reports non-repositories and honors pre-aborted signals", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-git-facts-"));
		roots.push(root);
		await expect(collectGitFacts(root)).resolves.toEqual({
			isRepository: false,
			status: [],
			clean: true,
		});
		const controller = new AbortController();
		controller.abort(new Error("cancelled"));
		await expect(runGit(root, ["status"], { signal: controller.signal })).rejects.toThrow("cancelled");
	});
});

describe("collectWorkingTreePatches", () => {
	it("collects status, changed paths, and binary diffs across staged, unstaged, and untracked changes", async () => {
		const root = await repository();
		await fs.writeFile(path.join(root, "staged.txt"), "staged\n");
		await runGit(root, ["add", "staged.txt"]);
		await fs.writeFile(path.join(root, "tracked file.txt"), "first\nsecond\n");
		await fs.writeFile(path.join(root, "untracked.txt"), "fresh\n");
		await fs.writeFile(path.join(root, "blob.bin"), Buffer.from([0x00, 0x01, 0x02, 0x00]));

		const patches = await collectWorkingTreePatches(root);

		expect(patches.status).toContain("A  staged.txt");
		expect(patches.status).toContain("?? untracked.txt");
		expect(new Set(patches.changedFiles)).toEqual(
			new Set(["staged.txt", "tracked file.txt", "untracked.txt", "blob.bin"]),
		);
		expect(patches.staged).toContain("diff --git a/staged.txt b/staged.txt");
		expect(patches.unstaged).toContain("diff --git a/tracked file.txt b/tracked file.txt");
		expect(patches.untrackedPatches.join("")).toContain("new file mode");
		expect(patches.untrackedPatches.join("")).toContain("GIT binary patch");
	});

	it("preserves multi-byte UTF-8 content and filenames across output chunks", async () => {
		const root = await repository();
		// ~150 KB forces stdout to arrive in multiple pipe chunks.
		const filler = "héllo wörld ✓\n".repeat(10_000);
		await fs.writeFile(path.join(root, "groß-ünicode.txt"), filler);
		await runGit(root, ["add", "groß-ünicode.txt"]);
		await fs.writeFile(path.join(root, "café-notes.txt"), "crème brûlée\n");

		const patches = await collectWorkingTreePatches(root);

		expect(patches.changedFiles).toContain("groß-ünicode.txt");
		expect(patches.changedFiles).toContain("café-notes.txt");
		expect(patches.staged).toContain("héllo wörld ✓");
		expect(patches.staged).not.toContain("\uFFFD");
		expect(patches.untrackedPatches.join("")).toContain("crème brûlée");
		expect(patches.status).not.toContain("\uFFFD");
	});
});