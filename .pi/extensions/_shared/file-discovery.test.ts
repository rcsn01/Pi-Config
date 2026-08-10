import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverFiles } from "./file-discovery.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("file discovery", () => {
	it("uses bounded Node fallback with nested ignore, hidden, and symlink rules", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-file-discovery-"));
		roots.push(root);
		await fs.mkdir(path.join(root, "nested"), { recursive: true });
		await fs.mkdir(path.join(root, "private"), { recursive: true });
		await fs.mkdir(path.join(root, ".hidden"), { recursive: true });
		await fs.mkdir(path.join(root, "linked-target"), { recursive: true });
		await Promise.all([
			fs.writeFile(path.join(root, ".gitignore"), "ignored.txt\n!important.txt\n"),
			fs.writeFile(path.join(root, ".ignore"), "private/\n"),
			fs.writeFile(path.join(root, "ignored.txt"), "ignored"),
			fs.writeFile(path.join(root, "important.txt"), "kept"),
			fs.writeFile(path.join(root, "nested", ".gitignore"), "*.log\n!keep.log\n"),
			fs.writeFile(path.join(root, "nested", "local.log"), "ignored"),
			fs.writeFile(path.join(root, "nested", "keep.log"), "kept"),
			fs.writeFile(path.join(root, "nested", "source.ts"), "kept"),
			fs.writeFile(path.join(root, "private", "secret.txt"), "ignored"),
			fs.writeFile(path.join(root, ".hidden", "hidden.ts"), "hidden"),
			fs.writeFile(path.join(root, "linked-target", "linked.ts"), "linked"),
		]);
		await fs.symlink(path.join(root, "linked-target"), path.join(root, "linked"), "junction");

		expect(await discoverFiles(root, { backend: "node", maxResults: 20 })).toEqual([
			"important.txt",
			"linked-target/linked.ts",
			"nested/keep.log",
			"nested/source.ts",
		]);
		expect(await discoverFiles(root, { backend: "node", query: "src", maxResults: 1 })).toEqual([
			"nested/source.ts",
		]);
	});

	it("honors cancellation and result limits", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-file-discovery-"));
		roots.push(root);
		await Promise.all(Array.from({ length: 10 }, (_, index) =>
			fs.writeFile(path.join(root, `file-${index}.txt`), String(index)),
		));
		expect(await discoverFiles(root, { backend: "node", maxResults: 3 })).toHaveLength(3);
		const controller = new AbortController();
		controller.abort(new Error("cancelled"));
		await expect(discoverFiles(root, { backend: "node", signal: controller.signal })).rejects.toThrow("cancelled");
	});
});