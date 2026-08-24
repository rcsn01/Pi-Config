import { describe, expect, it } from "vitest";
import { WRITE_TOOLS, extractPathsFromInput } from "./path-policy.ts";

describe("tool classifications", () => {
	it("classifies repository removal as a mutation without treating listing as one", () => {
		expect(WRITE_TOOLS.has("github_repo_remove")).toBe(true);
		expect(WRITE_TOOLS.has("github_repo_list")).toBe(false);
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
