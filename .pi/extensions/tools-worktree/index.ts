/**
 * Worktree Extension
 *
 * Creates isolated git worktrees under .pi/worktrees/<branch-id>.
 * Each worktree gets a new branch, by default fleet/<branch-id>, based on
 * the repository's current HEAD.
 *
 * Commands:
 *   /worktree                         - Show help
 *   /worktree create <branch-id>      - Create a worktree + branch
 *   /worktree list                    - List repo worktrees
 *   /worktree remove <branch-id>      - Remove a managed worktree
 *
 * Tools:
 *   worktree_create
 *   worktree_list
 *   worktree_remove
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const WORKTREE_DIR = path.join(".pi", "worktrees");
const DEFAULT_BRANCH_PREFIX = "fleet";

type ExecResult = Awaited<ReturnType<ExtensionAPI["exec"]>>;

interface ManagedWorktree {
	path: string;
	branch?: string;
	head?: string;
	detached?: boolean;
	bare?: boolean;
	managed: boolean;
	branchId?: string;
}

const CreateParams = Type.Object({
	branch_id: Type.String({
		description: "Safe branch/worktree id. Used as .pi/worktrees/<branch_id> and fleet/<branch_id>.",
	}),
	branch_prefix: Type.Optional(Type.String({
		description: "Optional branch namespace prefix; default: fleet. Final branch is <prefix>/<branch_id>.",
	})),
	base_ref: Type.Optional(Type.String({
		description: "Optional git ref to branch from; default: current HEAD.",
	})),
});

const ListParams = Type.Object({});

const RemoveParams = Type.Object({
	branch_id: Type.String({ description: "Managed worktree id under .pi/worktrees/<branch_id>." }),
});

function trimAtPrefix(value: string): string {
	return value.startsWith("@") ? value.slice(1) : value;
}

function validateBranchId(input: string): string {
	const id = trimAtPrefix(input).trim();
	if (!id) throw new Error("branch_id is required");
	if (id.length > 128) throw new Error("branch_id is too long; max 128 characters");
	if (id.includes("..")) throw new Error("branch_id must not contain '..'");
	if (id.endsWith(".lock")) throw new Error("branch_id must not end with .lock");
	if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
		throw new Error("branch_id must start with a letter/number and contain only letters, numbers, '.', '_' or '-'");
	}
	return id;
}

function normalizeBranchPrefix(input?: string): string {
	const prefix = (input || DEFAULT_BRANCH_PREFIX).trim().replace(/^\/+|\/+$/g, "");
	if (!prefix) throw new Error("branch_prefix must not be empty");
	if (prefix.includes("..")) throw new Error("branch_prefix must not contain '..'");
	if (prefix.endsWith(".lock")) throw new Error("branch_prefix must not end with .lock");
	if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(prefix) || prefix.includes("//")) {
		throw new Error("branch_prefix must be a safe git branch namespace, for example 'fleet'");
	}
	return prefix;
}

function ensureInside(base: string, target: string): void {
	const rel = path.relative(base, target);
	if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
		throw new Error(`Refusing path outside managed worktree directory: ${target}`);
	}
}

async function runGit(
	pi: ExtensionAPI,
	cwd: string,
	args: string[],
	options: { allowFailure?: boolean; signal?: AbortSignal } = {},
): Promise<ExecResult> {
	const result = await pi.exec("git", args, { cwd, signal: options.signal });
	if (!options.allowFailure && result.code !== 0) {
		throw new Error(result.stderr?.trim() || result.stdout?.trim() || `git ${args.join(" ")} failed`);
	}
	return result;
}

async function repoRoot(pi: ExtensionAPI, cwd: string): Promise<string> {
	const result = await runGit(pi, cwd, ["rev-parse", "--show-toplevel"]);
	return result.stdout.trim();
}

async function branchExists(pi: ExtensionAPI, root: string, branchName: string): Promise<boolean> {
	const result = await runGit(
		pi,
		root,
		["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`],
		{ allowFailure: true },
	);
	return result.code === 0;
}

async function validateGitBranchName(pi: ExtensionAPI, root: string, branchName: string): Promise<void> {
	const result = await runGit(pi, root, ["check-ref-format", "--branch", branchName], { allowFailure: true });
	if (result.code !== 0) {
		throw new Error(result.stderr?.trim() || `Invalid git branch name: ${branchName}`);
	}
}

async function currentBaseInfo(pi: ExtensionAPI, root: string): Promise<{ baseBranch: string; head: string }> {
	const branch = await runGit(pi, root, ["branch", "--show-current"], { allowFailure: true });
	const head = await runGit(pi, root, ["rev-parse", "--short", "HEAD"]);
	return {
		baseBranch: branch.stdout.trim() || "(detached HEAD)",
		head: head.stdout.trim(),
	};
}

function managedBase(root: string): string {
	return path.join(root, WORKTREE_DIR);
}

function managedPath(root: string, branchId: string): string {
	return path.join(managedBase(root), branchId);
}

async function createManagedWorktree(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	params: { branch_id: string; branch_prefix?: string; base_ref?: string },
): Promise<Record<string, unknown>> {
	const root = await repoRoot(pi, ctx.cwd);
	const branchId = validateBranchId(params.branch_id);
	const prefix = normalizeBranchPrefix(params.branch_prefix);
	const branchName = `${prefix}/${branchId}`;
	const baseRef = (params.base_ref || "HEAD").trim() || "HEAD";
	const base = managedBase(root);
	const target = managedPath(root, branchId);

	ensureInside(base, target);
	await validateGitBranchName(pi, root, branchName);

	try {
		await fs.access(target);
		throw new Error(`Worktree path already exists: ${path.relative(root, target)}`);
	} catch (error: any) {
		if (error?.code !== "ENOENT") throw error;
	}

	if (await branchExists(pi, root, branchName)) {
		throw new Error(`Branch already exists: ${branchName}`);
	}

	await fs.mkdir(base, { recursive: true });
	const before = await currentBaseInfo(pi, root);
	await runGit(pi, root, ["worktree", "add", "-b", branchName, target, baseRef], { signal: ctx.signal });

	return {
		branchId,
		branchName,
		path: target,
		relativePath: path.relative(root, target),
		baseRef,
		baseBranch: before.baseBranch,
		baseHead: before.head,
	};
}

function parseWorktreePorcelain(stdout: string, root: string): ManagedWorktree[] {
	const entries: ManagedWorktree[] = [];
	let current: ManagedWorktree | undefined;
	const base = managedBase(root);

	const finish = () => {
		if (!current) return;
		const rel = path.relative(base, current.path);
		current.managed = rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
		if (current.managed) current.branchId = rel.split(path.sep)[0];
		entries.push(current);
		current = undefined;
	};

	for (const line of stdout.split("\n")) {
		if (!line.trim()) {
			finish();
			continue;
		}
		const [key, ...rest] = line.split(" ");
		const value = rest.join(" ");
		if (key === "worktree") {
			finish();
			current = { path: value, managed: false };
		} else if (current && key === "HEAD") {
			current.head = value;
		} else if (current && key === "branch") {
			current.branch = value.replace(/^refs\/heads\//, "");
		} else if (current && key === "detached") {
			current.detached = true;
		} else if (current && key === "bare") {
			current.bare = true;
		}
	}
	finish();
	return entries;
}

async function listWorktrees(pi: ExtensionAPI, ctx: ExtensionContext): Promise<ManagedWorktree[]> {
	const root = await repoRoot(pi, ctx.cwd);
	const result = await runGit(pi, root, ["worktree", "list", "--porcelain"]);
	return parseWorktreePorcelain(result.stdout, root);
}

function formatWorktrees(worktrees: ManagedWorktree[]): string {
	if (worktrees.length === 0) return "No git worktrees found.";
	return worktrees.map((wt) => {
		const tags = [wt.managed ? "managed" : "external", wt.detached ? "detached" : undefined, wt.bare ? "bare" : undefined]
			.filter(Boolean)
			.join(", ");
		return [
			`- ${wt.branch || "(detached)"}`,
			`  path: ${wt.path}`,
			wt.branchId ? `  id: ${wt.branchId}` : undefined,
			wt.head ? `  head: ${wt.head}` : undefined,
			`  tags: ${tags || "none"}`,
		].filter(Boolean).join("\n");
	}).join("\n\n");
}

async function removeManagedWorktree(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	params: { branch_id: string },
): Promise<Record<string, unknown>> {
	const root = await repoRoot(pi, ctx.cwd);
	const branchId = validateBranchId(params.branch_id);
	const base = managedBase(root);
	const target = managedPath(root, branchId);
	ensureInside(base, target);

	const worktrees = await listWorktrees(pi, ctx);
	const match = worktrees.find((wt) => wt.managed && wt.branchId === branchId);
	if (!match) throw new Error(`No managed worktree found for branch_id: ${branchId}`);

	await runGit(pi, root, ["worktree", "remove", target], { signal: ctx.signal });
	return {
		branchId,
		removedPath: target,
		branchName: match.branch,
		note: "Branch was not deleted. Delete it manually if no longer needed.",
	};
}

function helpText(): string {
	return [
		"tools-worktree — manage isolated git worktrees for fleet agents",
		"",
		"Commands:",
		"  /worktree create <branch-id>   Create .pi/worktrees/<branch-id> on fleet/<branch-id>",
		"  /worktree list                 List git worktrees",
		"  /worktree remove <branch-id>   Remove a managed worktree; branch is kept",
		"",
		"Rules:",
		"  branch-id: letters/numbers plus '.', '_' or '-' only",
		"  creation branches from current HEAD by default; no automatic git pull",
	].join("\n");
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "worktree_create",
		label: "Create Worktree",
		description: "Create an isolated git worktree under .pi/worktrees/<branch_id> with a new branch based on current HEAD.",
		promptSnippet: "Create git worktree for fleet/minion work",
		promptGuidelines: [
			"Use worktree_create before assigning separate agents/minions to implementation tasks so they do not edit the same checkout.",
			"worktree_create creates branches from current HEAD by default and does not run git pull.",
		],
		parameters: CreateParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				const result = await createManagedWorktree(pi, ctx, params);
				return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return { content: [{ type: "text", text: `Error: ${message}` }], details: { error: message } };
			}
		},
	});

	pi.registerTool({
		name: "worktree_list",
		label: "List Worktrees",
		description: "List git worktrees and identify those managed under .pi/worktrees/.",
		promptSnippet: "List managed git worktrees",
		promptGuidelines: ["Use worktree_list before creating or removing fleet worktrees to avoid collisions."],
		parameters: ListParams,
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			try {
				const result = await listWorktrees(pi, ctx);
				return { content: [{ type: "text", text: formatWorktrees(result) }], details: { worktrees: result } };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return { content: [{ type: "text", text: `Error: ${message}` }], details: { error: message } };
			}
		},
	});

	pi.registerTool({
		name: "worktree_remove",
		label: "Remove Worktree",
		description: "Remove a managed git worktree under .pi/worktrees/<branch_id>. Does not delete the branch.",
		promptSnippet: "Remove managed git worktree",
		promptGuidelines: ["Use worktree_remove only when the user asks to remove a fleet worktree; it does not delete branches."],
		parameters: RemoveParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				const result = await removeManagedWorktree(pi, ctx, params);
				return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], details: result };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return { content: [{ type: "text", text: `Error: ${message}` }], details: { error: message } };
			}
		},
	});

	pi.registerCommand("worktree", {
		description: "Manage isolated git worktrees under .pi/worktrees/",
		handler: async (args, ctx) => {
			const parts = (args || "").trim().split(/\s+/).filter(Boolean);
			const sub = (parts[0] || "").toLowerCase();

			if (!sub || sub === "help") {
				ctx.ui.notify(helpText(), "info");
				return;
			}

			if (sub === "list") {
				try {
					ctx.ui.notify(formatWorktrees(await listWorktrees(pi, ctx)), "info");
				} catch (error) {
					ctx.ui.notify(`Error: ${error instanceof Error ? error.message : String(error)}`, "error");
				}
				return;
			}

			if (sub === "create") {
				let branchId = parts[1];
				if (!branchId && ctx.hasUI) branchId = await ctx.ui.input("Worktree branch id:");
				if (!branchId) {
					ctx.ui.notify("Usage: /worktree create <branch-id>", "warning");
					return;
				}
				try {
					const result = await createManagedWorktree(pi, ctx, { branch_id: branchId });
					ctx.ui.notify(JSON.stringify(result, null, 2), "info");
				} catch (error) {
					ctx.ui.notify(`Error: ${error instanceof Error ? error.message : String(error)}`, "error");
				}
				return;
			}

			if (sub === "remove") {
				let branchId = parts[1];
				if (!branchId && ctx.hasUI) {
					try {
						const managed = (await listWorktrees(pi, ctx)).filter((wt) => wt.managed && wt.branchId);
						const choice = await ctx.ui.select("Remove managed worktree:", managed.map((wt) => wt.branchId!));
						branchId = choice;
					} catch {}
				}
				if (!branchId) {
					ctx.ui.notify("Usage: /worktree remove <branch-id>", "warning");
					return;
				}
				try {
					const result = await removeManagedWorktree(pi, ctx, { branch_id: branchId });
					ctx.ui.notify(JSON.stringify(result, null, 2), "info");
				} catch (error) {
					ctx.ui.notify(`Error: ${error instanceof Error ? error.message : String(error)}`, "error");
				}
				return;
			}

			ctx.ui.notify(helpText(), "warning");
		},
	});
}
