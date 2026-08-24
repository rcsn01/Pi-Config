import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	executeRepoQuery,
	formatRepoQueryResults,
	REPO_QUERY_LIMITS,
	type RepoQueryOperation,
} from "./repo-query.ts";
import registerRepoQueryTool, {
	createRepoQueryExecutor,
	extractToolText,
} from "./tools/repo-query.ts";

const roots: string[] = [];

function fixture(): string {
	const root = mkdtempSync(join(tmpdir(), "repo-query-"));
	roots.push(root);
	return root;
}

function writeFixtureFiles(root: string, count = 3): void {
	for (let index = 0; index < count; index++) {
		writeFileSync(join(root, `file-${index}.txt`), `file ${index}\nneedle ${index}\n`);
	}
}

async function run(
	root: string,
	operations: RepoQueryOperation[],
	executor: Parameters<typeof executeRepoQuery>[2],
	context: Omit<Parameters<typeof executeRepoQuery>[1], "cwd"> = {},
) {
	return executeRepoQuery({ operations }, { cwd: root, ...context }, executor);
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("repo_query module", () => {
	it("validates mixed operations and normalizes leading @ paths and defaults", async () => {
		const root = fixture();
		writeFixtureFiles(root);
		const seen: any[] = [];
		const result = await run(root, [
			{ id: "read", kind: "read", path: "@file-0.txt" },
			{ id: "grep", kind: "grep", pattern: "needle", path: "." },
			{ id: "find", kind: "find", pattern: "*.txt" },
			{ id: "ls", kind: "ls" },
			{ id: "files", kind: "files", query: "file" },
			{ id: "status", kind: "git_status" },
			{ id: "diff", kind: "git_diff", mode: "summary" },
		], async (operation) => {
			seen.push(operation);
			return operation.kind;
		});

		expect(result.details.operations).toHaveLength(7);
		expect(seen.find((operation) => operation.kind === "read")).toMatchObject({
			path: resolve(root, "file-0.txt"),
			limit: 200,
		});
		expect(seen.find((operation) => operation.kind === "grep")).toMatchObject({
			path: resolve(root),
			context: 0,
			limit: 50,
		});
		expect(seen.find((operation) => operation.kind === "find")).toMatchObject({ path: resolve(root), limit: 100 });
		expect(seen.find((operation) => operation.kind === "ls")).toMatchObject({ path: resolve(root), limit: 200 });
	});

	it("runs at most six operations concurrently and preserves input order", async () => {
		const root = fixture();
		writeFixtureFiles(root, 12);
		let active = 0;
		let maximumActive = 0;
		const operations = Array.from({ length: 12 }, (_, index) => ({
			id: `op-${index}`,
			kind: "read" as const,
			path: `file-${index}.txt`,
		}));
		const result = await run(root, operations, async (operation) => {
			active++;
			maximumActive = Math.max(maximumActive, active);
			await new Promise((resolve) => setTimeout(resolve, 12 - Number(operation.id!.slice(3))));
			active--;
			return operation.id!;
		});

		expect(maximumActive).toBeLessThanOrEqual(REPO_QUERY_LIMITS.maxConcurrency);
		expect(result.details.operations.map((operation) => operation.id)).toEqual(operations.map((operation) => operation.id));
		for (let index = 0; index < operations.length; index++) {
			expect(result.text.indexOf(`## op-${index} [read]`)).toBeLessThan(
				index === operations.length - 1 ? result.text.length : result.text.indexOf(`## op-${index + 1} [read]`),
			);
		}
	});

	it("keeps successful results beside ordinary operation failures", async () => {
		const root = fixture();
		writeFixtureFiles(root, 2);
		const result = await run(root, [
			{ id: "good", kind: "read", path: "file-0.txt" },
			{ id: "bad", kind: "read", path: "file-1.txt" },
		], async (operation) => {
			if (operation.id === "bad") throw new Error("fixture failed");
			return "successful evidence";
		});

		expect(result.text).toContain("successful evidence");
		expect(result.text).toContain("Error: fixture failed");
		expect(result.details.operations).toEqual(expect.arrayContaining([
			expect.objectContaining({ id: "good", success: true }),
			expect.objectContaining({ id: "bad", success: false, error: "fixture failed" }),
		]));
	});

	it("deduplicates identical normalized operations and references the first ID", async () => {
		const root = fixture();
		writeFixtureFiles(root, 1);
		let calls = 0;
		const result = await run(root, [
			{ id: "first", kind: "read", path: "file-0.txt", limit: 200 },
			{ id: "second", kind: "read", path: "@file-0.txt" },
		], async () => {
			calls++;
			return "only once";
		});

		expect(calls).toBe(1);
		expect(result.text).toContain("Duplicate of first.");
		expect(result.details.operations[1]).toMatchObject({
			id: "second",
			deduplicatedFrom: "first",
			success: true,
		});
	});

	it("normalizes, sorts, and deduplicates git diff paths", async () => {
		const root = fixture();
		mkdirSync(join(root, "src"));
		writeFileSync(join(root, "src", "one.ts"), "one");
		writeFileSync(join(root, "src", "two.ts"), "two");
		const seen: any[] = [];

		await run(root, [
			{ id: "one", kind: "git_diff", mode: "summary", paths: ["@src/two.ts", "src/one.ts", "src/two.ts"] },
			{ id: "several", kind: "git_diff", mode: "unstaged", paths: ["src", "src/one.ts"] },
		], async (operation) => {
			seen.push(operation);
			return "ok";
		});

		expect(seen[0].paths).toEqual([
			resolve(root, "src", "one.ts"),
			resolve(root, "src", "two.ts"),
		]);
		expect(seen[1].paths).toEqual([resolve(root, "src"), resolve(root, "src", "one.ts")]);
	});

	it("deduplicates equivalent git diff path sets regardless of input order", async () => {
		const root = fixture();
		writeFixtureFiles(root, 2);
		let calls = 0;
		const result = await run(root, [
			{ id: "first", kind: "git_diff", mode: "uncommitted", paths: ["file-1.txt", "file-0.txt"] },
			{ id: "second", kind: "git_diff", mode: "uncommitted", paths: ["@file-0.txt", "file-1.txt"] },
		], async () => {
			calls++;
			return "diff";
		});

		expect(calls).toBe(1);
		expect(result.details.operations[1].deduplicatedFrom).toBe("first");
	});

	it("validates git diff paths and accepts deleted leaves with an existing parent", async () => {
		const root = fixture();
		const outside = fixture();
		mkdirSync(join(root, "deleted"));
		writeFileSync(join(root, "deleted", "gone.txt"), "gone");
		unlinkSync(join(root, "deleted", "gone.txt"));
		symlinkSync(outside, join(root, "outside-link"), "dir");
		const executor = async () => "ok";
		const deleted = await run(root, [
			{ kind: "git_diff", mode: "uncommitted", paths: ["deleted/gone.txt"] },
		], async (operation) => operation.paths!.join("\n"));
		expect(deleted.text).toContain(resolve(root, "deleted", "gone.txt"));

		for (const paths of [[], "file.txt", [1], [""], [" "]]) {
			await expect(run(root, [
				{ kind: "git_diff", mode: "summary", paths } as any,
			], executor)).rejects.toThrow(/git_diff\.paths/);
		}
		await expect(run(root, [{
			kind: "git_diff",
			mode: "summary",
			paths: Array.from({ length: 101 }, () => "."),
		}], executor)).rejects.toThrow("1-100");
		await expect(run(root, [{ kind: "read", path: ".", paths: ["."] } as any], executor))
			.rejects.toThrow("paths is not valid");
		await expect(run(root, [{ kind: "git_diff", mode: "summary", paths: ["../outside"] }], executor))
			.rejects.toThrow("escapes");
		await expect(run(root, [{ kind: "git_diff", mode: "summary", paths: [outside] }], executor))
			.rejects.toThrow("escapes");
		await expect(run(root, [{ kind: "git_diff", mode: "summary", paths: ["outside-link/file.txt"] }], executor))
			.rejects.toThrow("resolves outside");
	});

	it("generates IDs and rejects invalid fields and operation limits", async () => {
		const root = fixture();
		writeFixtureFiles(root, 1);
		const executor = async () => "ok";
		const generated = await run(root, [
			{ kind: "ls" },
			{ kind: "git_status" },
		], executor);
		expect(generated.details.operations.map((operation) => operation.id)).toEqual(["op-1", "op-2"]);

		await expect(run(root, [{ kind: "read", path: "file-0.txt", limit: 1_001 }], executor)).rejects.toThrow("at most 1000");
		await expect(run(root, [{ kind: "grep", pattern: "x", context: 0 }], executor)).resolves.toBeDefined();
		await expect(run(root, [{ kind: "grep", pattern: "x", context: 11 }], executor)).rejects.toThrow("at most 10");
		await expect(run(root, [{ kind: "read" } as any], executor)).rejects.toThrow("read.path is required");
		await expect(run(root, [{ kind: "git_diff" } as any], executor)).rejects.toThrow("git_diff.mode");
		await expect(run(root, Array.from({ length: 25 }, () => ({ kind: "git_status" })) as any, executor))
			.rejects.toThrow("1-24 operations");
	});

	it("rejects lexical escapes and symlinks that resolve outside the cwd", async () => {
		const root = fixture();
		const outside = fixture();
		writeFileSync(join(outside, "secret.txt"), "secret");
		writeFileSync(join(root, "inside.txt"), "inside");
		symlinkSync(outside, join(root, "outside-link"), "dir");
		const executor = async () => "never reached";

		await expect(run(root, [{ kind: "read", path: "../secret.txt" }], executor)).rejects.toThrow("escapes");
		await expect(run(root, [{ kind: "read", path: resolve(outside, "secret.txt") }], executor)).rejects.toThrow("escapes");
		await expect(run(root, [{ kind: "read", path: "outside-link/secret.txt" }], executor)).rejects.toThrow("resolves outside");
	});

	it("propagates caller cancellation instead of turning it into an operation error", async () => {
		const root = fixture();
		writeFixtureFiles(root, 1);
		const controller = new AbortController();
		const promise = run(root, [{ kind: "read", path: "file-0.txt" }], () => new Promise(() => {}), {
			signal: controller.signal,
		});
		setTimeout(() => controller.abort(new Error("caller cancelled")), 10);
		await expect(promise).rejects.toThrow("caller cancelled");
	});

	it("keeps every operation represented under aggregate truncation and redistributes short output", () => {
		const records = [
			{ id: "short", kind: "read" as const, body: "small", durationMs: 1, success: true },
			...Array.from({ length: 7 }, (_, index) => ({
				id: `long-${index}`,
				kind: "grep" as const,
				body: Array.from({ length: 2_000 }, (_, line) => `long-${index}-${line}-${"x".repeat(80)}`).join("\n"),
				durationMs: 1,
				success: true,
			})),
		];
		const formatted = formatRepoQueryResults(records);

		expect(formatted.outputBytes).toBeLessThanOrEqual(50 * 1024);
		expect(formatted.outputLines).toBeLessThanOrEqual(2_000);
		for (const record of records) expect(formatted.text).toContain(`## ${record.id} [${record.kind}]`);
		expect(formatted.operationTruncated.filter(Boolean).length).toBeGreaterThan(0);
		expect(formatted.text).toContain("Output truncated");
	});

	it("uses fixed Git helpers and never includes untracked file contents", async () => {
		const root = fixture();
		execFileSync("git", ["init", "-q"], { cwd: root });
		writeFileSync(join(root, "untracked.txt"), "TOP-SECRET-CONTENT");
		const executor = createRepoQueryExecutor(root);
		const result = await run(root, [
			{ id: "status", kind: "git_status" },
			{ id: "diff", kind: "git_diff", mode: "uncommitted" },
		], executor);

		expect(result.text).toContain("untracked.txt");
		expect(result.text).not.toContain("TOP-SECRET-CONTENT");
	});

	it("registers the Pi adapter and executes mixed read-only operations", async () => {
		const root = fixture();
		writeFileSync(join(root, "evidence.txt"), "adapter evidence");
		let tool: any;
		registerRepoQueryTool({ registerTool: (candidate: any) => { tool = candidate; } } as any);
		const result = await tool.execute("call", {
			operations: [
				{ id: "read", kind: "read", path: "evidence.txt" },
				{ id: "list", kind: "ls", path: "." },
				{ id: "files", kind: "files", query: "evidence" },
				{ id: "status", kind: "git_status" },
			],
		}, undefined, undefined, { cwd: root });

		expect(tool.name).toBe("repo_query");
		expect(result.content[0].text).toContain("adapter evidence");
		expect(result.content[0].text).toContain("## list [ls]");
		expect(result.content[0].text).toContain("evidence.txt");
		expect(result.details.operations).toHaveLength(4);
	});

	it("returns text-only notices when a built-in result contains an image", () => {
		expect(extractToolText({ content: [{ type: "image", data: "abc", mimeType: "image/png" }] }, "Use normal read"))
			.toBe("Use normal read");
		expect(extractToolText({ content: [{ type: "text", text: "text result" }] })).toBe("text result");
	});
});
