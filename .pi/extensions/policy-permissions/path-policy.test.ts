import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { extractPathsFromInput } from "./path-policy.ts";
import {
	extractExternalPathsFromCommand,
	githubRepositorySnapshotOperation,
	isNetworkCommand,
	isReadOnlyShellCommand,
	mentionsGithubRepositorySnapshotHelper,
} from "../_shared/command-policy.ts";

describe("tool classifications", () => {
	it("classifies the bundled helper from a different workspace", () => {
		const absoluteScript = fileURLToPath(new URL("../../skills/github-repo-explorer/scripts/github-repo-snapshot.mjs", import.meta.url));
		const relativeScript = ".pi/skills/github-repo-explorer/scripts/github-repo-snapshot.mjs";
		const foreignCwd = fileURLToPath(new URL(".", import.meta.url));

		expect(githubRepositorySnapshotOperation(`node ${absoluteScript} list`, foreignCwd)).toBe("list");
		expect(githubRepositorySnapshotOperation(`node ${relativeScript} list`, foreignCwd)).toBeUndefined();
		expect(isNetworkCommand(`node ${relativeScript} list`, foreignCwd)).toBe(true);
		expect(isReadOnlyShellCommand(`node ${relativeScript} list`, foreignCwd)).toBe(false);
	});

	it("recognizes the helper addressed through a symlink from a foreign workspace", () => {
		// pi presents global skills via ~/.pi/agent/skills, a symlink into this
		// repository; that path must classify as the same trusted script.
		const realScript = fileURLToPath(new URL("../../skills/github-repo-explorer/scripts/github-repo-snapshot.mjs", import.meta.url));
		const foreignCwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-snapshot-policy-"));
		try {
			const linkedScript = path.join(foreignCwd, "github-repo-snapshot.mjs");
			fs.symlinkSync(realScript, linkedScript);
			expect(githubRepositorySnapshotOperation(`node ${linkedScript} list`, foreignCwd)).toBe("list");
			expect(githubRepositorySnapshotOperation(`node ${linkedScript} acquire owner/repo`, foreignCwd)).toBe("acquire");
			expect(githubRepositorySnapshotOperation(`node ${linkedScript} acquire https://github.com/owner/repo`, foreignCwd)).toBe("acquire");
			expect(githubRepositorySnapshotOperation(`node ${linkedScript} remove ghr_${"a".repeat(24)} --confirm`, foreignCwd)).toBe("remove");
			expect(isNetworkCommand(`node ${linkedScript} acquire owner/repo`, foreignCwd)).toBe(true);
			expect(isReadOnlyShellCommand(`node ${linkedScript} list`, foreignCwd)).toBe(true);
			expect(extractExternalPathsFromCommand(`node ${linkedScript} acquire owner/repo`, foreignCwd)).toEqual([]);

			// Symlinks to anything else — or to nothing — are not the bundled helper.
			const strangerScript = path.join(foreignCwd, "stranger.mjs");
			fs.symlinkSync(process.execPath, strangerScript);
			expect(githubRepositorySnapshotOperation(`node ${strangerScript} list`, foreignCwd)).toBeUndefined();
			fs.rmSync(strangerScript);
			const brokenScript = path.join(foreignCwd, "broken.mjs");
			fs.symlinkSync(path.join(foreignCwd, "missing.mjs"), brokenScript);
			expect(githubRepositorySnapshotOperation(`node ${brokenScript} list`, foreignCwd)).toBeUndefined();
		} finally {
			fs.rmSync(foreignCwd, { recursive: true, force: true });
		}
	});

	it("classifies skill snapshot commands by operation from the owning workspace", () => {
		const script = ".pi/skills/github-repo-explorer/scripts/github-repo-snapshot.mjs";
		const projectCwd = fileURLToPath(new URL("../../../", import.meta.url));
		expect(githubRepositorySnapshotOperation(`node ${script} acquire owner/repo`, projectCwd)).toBe("acquire");
		expect(githubRepositorySnapshotOperation(`node ${script} list`, projectCwd)).toBe("list");
		expect(githubRepositorySnapshotOperation(`node ${script} remove ghr_${"a".repeat(24)} --confirm`, projectCwd)).toBe("remove");
		expect(isNetworkCommand(`node ${script} acquire owner/repo`, projectCwd)).toBe(true);
		expect(isNetworkCommand(`node ${script} list`, projectCwd)).toBe(false);
		expect(isReadOnlyShellCommand(`node ${script} list`, projectCwd)).toBe(true);
		expect(isReadOnlyShellCommand(`node ${script} acquire owner/repo`, projectCwd)).toBe(false);
		expect(isReadOnlyShellCommand(`node ${script} remove ghr_${"a".repeat(24)} --confirm`, projectCwd)).toBe(false);

		const compound = `node ${script} list; node ${script} acquire owner/repo`;
		expect(githubRepositorySnapshotOperation(compound, projectCwd)).toBeUndefined();
		expect(mentionsGithubRepositorySnapshotHelper(compound)).toBe(true);
		expect(isNetworkCommand(compound, projectCwd)).toBe(true);
		expect(isReadOnlyShellCommand(compound, projectCwd)).toBe(false);
		expect(githubRepositorySnapshotOperation(`node -e "run" ${script} list`, projectCwd)).toBeUndefined();
	});
});

describe("extractPathsFromInput", () => {
	it("returns an empty array for null/non-object input", () => {
		expect(extractPathsFromInput("read", null)).toEqual([]);
		expect(extractPathsFromInput("read", "not-an-object")).toEqual([]);
	});

	it("extracts the primary path field", () => {
		expect(extractPathsFromInput("read", { path: "/workspace/a.txt" })).toEqual(["/workspace/a.txt"]);
	});

	it("extracts a write target", () => {
		expect(extractPathsFromInput("write", { path: "/workspace/out.txt" })).toEqual(["/workspace/out.txt"]);
	});

	it("extracts the edit target path and ignores per-edit blocks", () => {
		const input = {
			path: "/workspace/file.ts",
			edits: [{ oldText: "a", newText: "b" }],
		};
		expect(extractPathsFromInput("edit", input)).toEqual(["/workspace/file.ts"]);
	});

	it("collects multiple path-bearing fields", () => {
		const input = { path: "/a", file: "/b", output: "/c", dir: "/d" };
		expect(extractPathsFromInput("write", input)).toEqual(["/a", "/b", "/c", "/d"]);
	});

	it("returns nothing for bash commands (no path fields)", () => {
		expect(extractPathsFromInput("bash", { command: "ls -la" })).toEqual([]);
	});

	it("drops empty-string path fields", () => {
		expect(extractPathsFromInput("write", { path: "" })).toEqual([]);
	});
});
