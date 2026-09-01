import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import worktreeExtension from "./index.ts";

/**
 * Characterization tests for the public worktree tool. The tool strictly
 * validates caller-supplied ids, refuses paths outside .pi/worktrees, and
 * fails when the target already exists — intentionally different policy from
 * the workflow runner, which normalizes generated ids and reuses paths.
 */

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(() => {
	while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

async function git(cwd: string, args: string[]) {
	try {
		const { stdout, stderr } = await execFileAsync("git", args, { cwd, maxBuffer: 10 * 1024 * 1024 });
		return { code: 0, stdout: String(stdout), stderr: String(stderr) };
	} catch (error: any) {
		return {
			code: typeof error.code === "number" ? error.code : 1,
			stdout: String(error.stdout ?? ""),
			stderr: String(error.stderr ?? error.message ?? ""),
		};
	}
}

async function repository(): Promise<string> {
	const root = mkdtempSync(join(tmpdir(), "pi-worktree-tool-"));
	roots.push(root);
	await git(root, ["init", "-b", "main"]);
	await git(root, ["config", "user.email", "test@example.com"]);
	await git(root, ["config", "user.name", "Test User"]);
	writeFileSync(join(root, "file.txt"), "base\n");
	await git(root, ["add", "file.txt"]);
	await git(root, ["commit", "-m", "initial"]);
	writeFileSync(join(root, "file.txt"), "second\n");
	await git(root, ["add", "file.txt"]);
	await git(root, ["commit", "-m", "second"]);
	return root;
}

function harness(root: string) {
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const pi = {
		exec: (_command: string, args: string[], options: any) => git(options?.cwd ?? root, args),
		registerTool: vi.fn((definition: any) => tools.set(definition.name, definition)),
		registerCommand: vi.fn((name: string, command: any) => commands.set(name, command)),
	};
	worktreeExtension(pi as any);
	const ctx = {
		cwd: root,
		signal: undefined,
		hasUI: false,
		ui: { notify: vi.fn(), input: vi.fn(), select: vi.fn() },
	};
	const execute = async (tool: string, params: any) =>
		tools.get(tool)!.execute("call", params, undefined, undefined, ctx);
	return { tools, commands, ctx, execute };
}

async function create(execute: any, params: any) {
	return (await execute("worktree_create", params)) as {
		content: Array<{ type: string; text: string }>;
		details: Record<string, unknown>;
	};
}

function errorText(result: { content: Array<{ type: string; text: string }> }): string {
	return result.content[0]!.text;
}

describe("worktree tool characterization", () => {
	it("strictly validates branch ids and rejects path traversal before touching the filesystem", async () => {
		const root = await repository();
		const { execute } = harness(root);

		expect(errorText(await create(execute, { branch_id: "Bad ID!" })))
			.toBe("Error: branch_id must start with a letter/number and contain only letters, numbers, '.', '_' or '-'");
		expect(errorText(await create(execute, { branch_id: "../escape" })))
			.toBe("Error: branch_id must not contain '..'");
		expect(errorText(await create(execute, { branch_id: "feature.lock" })))
			.toBe("Error: branch_id must not end with .lock");
		expect(errorText(await create(execute, { branch_id: "x".repeat(129) })))
			.toBe("Error: branch_id is too long; max 128 characters");
		expect(errorText(await create(execute, { branch_id: "   " })))
			.toBe("Error: branch_id is required");

		// Nothing was created: no managed directory, no worktrees beyond main.
		expect(existsSync(join(root, ".pi"))).toBe(false);
		const listing = await git(root, ["worktree", "list"]);
		expect(listing.stdout.trim().split("\n")).toHaveLength(1);
	});

	it("trims a leading @ from ids and accepts ids the pattern allows", async () => {
		const root = await repository();
		const { execute } = harness(root);

		const result = await create(execute, { branch_id: "@at.id-1" });
		expect(result.details).toMatchObject({ branchId: "at.id-1", branchName: "fleet/at.id-1" });
		expect(existsSync(join(root, ".pi", "worktrees", "at.id-1", "file.txt"))).toBe(true);
	});

	it("applies the default and custom branch prefixes and rejects unsafe prefixes", async () => {
		const root = await repository();
		const { execute } = harness(root);

		expect((await create(execute, { branch_id: "alpha" })).details).toMatchObject({
			branchName: "fleet/alpha",
		});
		expect((await create(execute, { branch_id: "beta", branch_prefix: "team" })).details).toMatchObject({
			branchName: "team/beta",
		});
		expect((await create(execute, { branch_id: "gamma", branch_prefix: "org/sub" })).details).toMatchObject({
			branchName: "org/sub/gamma",
		});

		for (const branch_prefix of ["  /  ", "a//b", "a..b", "ns.lock"]) {
			const result = await create(execute, { branch_id: "delta", branch_prefix });
			expect(errorText(result)).toMatch(/^Error: branch_prefix must not|^Error: branch_prefix must be a safe git branch namespace/);
		}
	});

	it("creates from HEAD by default, an explicit base ref on request, and reports base metadata", async () => {
		const root = await repository();
		const { execute } = harness(root);
		const firstCommit = (await git(root, ["rev-parse", "--short", "HEAD~1"])).stdout.trim();
		const currentBranch = (await git(root, ["branch", "--show-current"])).stdout.trim();

		const fromHead = await create(execute, { branch_id: "from-head" });
		expect(fromHead.details).toMatchObject({
			baseRef: "HEAD",
			baseBranch: currentBranch,
			baseHead: (await git(root, ["rev-parse", "--short", "HEAD"])).stdout.trim(),
			relativePath: join(".pi", "worktrees", "from-head"),
		});

		const fromBase = await create(execute, { branch_id: "from-base", base_ref: "HEAD~1" });
		expect(fromBase.details).toMatchObject({ baseRef: "HEAD~1" });
		const worktreeHead = await git(join(root, ".pi", "worktrees", "from-base"), ["rev-parse", "HEAD"]);
		const firstFull = (await git(root, ["rev-parse", "HEAD~1"])).stdout.trim();
		expect(worktreeHead.stdout.trim()).toBe(firstFull);
	});

	it("refuses to create over an existing path or branch", async () => {
		const root = await repository();
		const { execute } = harness(root);
		await create(execute, { branch_id: "alpha" });

		expect(errorText(await create(execute, { branch_id: "alpha" })))
			.toBe("Error: Worktree path already exists: .pi/worktrees/alpha");

		// Same branch from a different path: the branch check fires.
		await git(root, ["worktree", "add", "-b", "fleet/beta", join(root, "elsewhere-beta")]);
		expect(errorText(await create(execute, { branch_id: "beta" })))
			.toBe("Error: Branch already exists: fleet/beta");
	});

	it("parses porcelain output into managed, external, and detached entries", async () => {
		const root = await repository();
		const { execute } = harness(root);
		await create(execute, { branch_id: "alpha" });
		await git(root, ["worktree", "add", "--detach", join(root, "elsewhere-detached")]);

		const list = (await execute("worktree_list", {})) as {
			content: Array<{ type: string; text: string }>;
			details: { worktrees: Array<Record<string, unknown>> };
		};
		const text = list.content[0]!.text;
		expect(text).toContain("- fleet/alpha");
		expect(text).toContain("id: alpha");
		expect(text).toContain("tags: managed");
		expect(text).toContain("- main");
		expect(text).toContain("tags: external");
		expect(text).toContain("- (detached)");
		expect(text).toContain("tags: external, detached");

		const alpha = list.details.worktrees.find((wt) => wt.branchId === "alpha");
		expect(alpha).toMatchObject({ managed: true, branch: "fleet/alpha" });
		const detached = list.details.worktrees.find((wt) => wt.detached === true);
		expect(detached).toMatchObject({ managed: false });
		expect(detached!.branch).toBeUndefined();
	});

	it("removes managed worktrees but keeps their branches, and refuses unknown ids", async () => {
		const root = await repository();
		const { execute } = harness(root);
		await create(execute, { branch_id: "alpha" });

		const remove = (await execute("worktree_remove", { branch_id: "alpha" })) as {
			content: Array<{ type: string; text: string }>;
			details: Record<string, unknown>;
		};
		expect(remove.details).toMatchObject({
			branchId: "alpha",
			branchName: "fleet/alpha",
			note: "Branch was not deleted. Delete it manually if no longer needed.",
		});
		expect(existsSync(join(root, ".pi", "worktrees", "alpha"))).toBe(false);

		const branch = await git(root, ["show-ref", "--verify", "--quiet", "refs/heads/fleet/alpha"]);
		expect(branch.code).toBe(0);

		expect(errorText(await execute("worktree_remove", { branch_id: "ghost" })))
			.toBe("Error: No managed worktree found for branch_id: ghost");
	});

	it("drives the same operations through the /worktree command", async () => {
		const root = await repository();
		const { commands, ctx } = harness(root);
		const handler = commands.get("worktree")!.handler;

		await handler("create cmd-id", ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining('"branchName": "fleet/cmd-id"'), "info");

		await handler("list", ctx);
		const listCall = ctx.ui.notify.mock.calls.at(-1);
		expect(listCall![0]).toContain("id: cmd-id");

		await handler("remove cmd-id", ctx);
		const removeCall = ctx.ui.notify.mock.calls.at(-1);
		expect(removeCall![0]).toContain('"branchId": "cmd-id"');

		await handler("", ctx);
		expect(ctx.ui.notify.mock.calls.at(-1)![0]).toContain("tools-worktree — manage isolated git worktrees");
	});
});