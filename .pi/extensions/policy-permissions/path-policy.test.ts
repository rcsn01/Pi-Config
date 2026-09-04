import { describe, expect, it } from "vitest";
import { extractPathsFromInput } from "./path-policy.ts";
import {
	githubRepositorySnapshotOperation,
	isNetworkCommand,
	isReadOnlyShellCommand,
	mentionsGithubRepositorySnapshotHelper,
} from "../_shared/command-policy.ts";

describe("tool classifications", () => {
	it("classifies skill snapshot commands by operation", () => {
		const script = ".pi/skills/github-repo-explorer/scripts/github-repo-snapshot.mjs";
		expect(githubRepositorySnapshotOperation(`node ${script} acquire owner/repo`)).toBe("acquire");
		expect(githubRepositorySnapshotOperation(`node ${script} list`)).toBe("list");
		expect(githubRepositorySnapshotOperation(`node ${script} remove ghr_${"a".repeat(24)} --confirm`)).toBe("remove");
		expect(isNetworkCommand(`node ${script} acquire owner/repo`)).toBe(true);
		expect(isNetworkCommand(`node ${script} list`)).toBe(false);
		expect(isReadOnlyShellCommand(`node ${script} list`)).toBe(true);
		expect(isReadOnlyShellCommand(`node ${script} acquire owner/repo`)).toBe(false);
		expect(isReadOnlyShellCommand(`node ${script} remove ghr_${"a".repeat(24)} --confirm`)).toBe(false);

		const compound = `node ${script} list; node ${script} acquire owner/repo`;
		expect(githubRepositorySnapshotOperation(compound)).toBeUndefined();
		expect(mentionsGithubRepositorySnapshotHelper(compound)).toBe(true);
		expect(isNetworkCommand(compound)).toBe(true);
		expect(isReadOnlyShellCommand(compound)).toBe(false);
		expect(githubRepositorySnapshotOperation(`node -e "run" ${script} list`)).toBeUndefined();
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
