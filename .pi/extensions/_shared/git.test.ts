import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectGitFacts, collectWorkingTreeDiff, runGit } from "./git.ts";

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