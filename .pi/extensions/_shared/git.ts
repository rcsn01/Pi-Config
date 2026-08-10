import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface GitRunOptions {
	signal?: AbortSignal;
	timeoutMs?: number;
	allowFailure?: boolean;
	maxOutputBytes?: number;
}

export interface GitResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

export interface GitStatusEntry {
	indexStatus: string;
	workTreeStatus: string;
	path: string;
	originalPath?: string;
}

export interface GitFacts {
	isRepository: boolean;
	root?: string;
	branch?: string;
	head?: string;
	status: GitStatusEntry[];
	clean: boolean;
}

export type GitDiffMode = "all" | "staged" | "unstaged" | "summary" | "uncommitted" | "custom";

export async function runGit(
	cwd: string,
	args: readonly string[],
	options: GitRunOptions = {},
): Promise<GitResult> {
	const timeoutMs = options.timeoutMs ?? 30_000;
	const maxOutputBytes = options.maxOutputBytes ?? 10_000_000;
	if (options.signal?.aborted) throw abortError(options.signal);

	return new Promise((resolve, reject) => {
		const child = spawn("git", [...args], {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		let stdout = "";
		let stderr = "";
		let outputBytes = 0;
		let settled = false;
		const timer = setTimeout(() => {
			child.kill();
			finish(undefined, new Error(`git ${args[0] ?? "command"} timed out after ${timeoutMs}ms.`));
		}, timeoutMs);

		const finish = (result?: GitResult, error?: unknown) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", abort);
			if (error) reject(error);
			else resolve(result!);
		};
		const abort = () => {
			child.kill();
			finish(undefined, abortError(options.signal));
		};
		const append = (target: "stdout" | "stderr", chunk: Buffer) => {
			outputBytes += chunk.byteLength;
			if (outputBytes > maxOutputBytes) {
				child.kill();
				finish(undefined, new Error(`git ${args[0] ?? "command"} exceeded ${maxOutputBytes} output bytes.`));
				return;
			}
			if (target === "stdout") stdout += chunk.toString();
			else stderr += chunk.toString();
		};

		child.stdout?.on("data", (chunk: Buffer) => append("stdout", chunk));
		child.stderr?.on("data", (chunk: Buffer) => append("stderr", chunk));
		child.once("error", (error) => finish(undefined, error));
		child.once("close", (exitCode) => {
			const result = { stdout, stderr, exitCode: exitCode ?? 1 };
			if (result.exitCode !== 0 && !options.allowFailure) {
				finish(undefined, new Error(stderr.trim() || stdout.trim() || `git ${args.join(" ")} failed.`));
			} else {
				finish(result);
			}
		});
		options.signal?.addEventListener("abort", abort, { once: true });
	});
}

export async function collectGitFacts(cwd: string, options: GitRunOptions = {}): Promise<GitFacts> {
	const inside = await runGit(cwd, ["rev-parse", "--is-inside-work-tree"], {
		...options,
		allowFailure: true,
	});
	if (inside.exitCode !== 0 || inside.stdout.trim() !== "true") {
		return { isRepository: false, status: [], clean: true };
	}

	const [root, branch, head, status] = await Promise.all([
		runGit(cwd, ["rev-parse", "--show-toplevel"], options),
		runGit(cwd, ["branch", "--show-current"], { ...options, allowFailure: true }),
		runGit(cwd, ["rev-parse", "HEAD"], { ...options, allowFailure: true }),
		runGit(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], options),
	]);
	const entries = parsePorcelainStatus(status.stdout);
	return {
		isRepository: true,
		root: root.stdout.trim(),
		branch: branch.stdout.trim() || undefined,
		head: head.exitCode === 0 ? head.stdout.trim() || undefined : undefined,
		status: entries,
		clean: entries.length === 0,
	};
}

export async function isGitRepo(cwd: string, options: GitRunOptions = {}): Promise<boolean> {
	return (await collectGitFacts(cwd, options)).isRepository;
}

export function parsePorcelainStatus(output: string): GitStatusEntry[] {
	const records = output.split("\0");
	const entries: GitStatusEntry[] = [];
	for (let index = 0; index < records.length; index++) {
		const record = records[index];
		if (!record || record.length < 4) continue;
		const entry: GitStatusEntry = {
			indexStatus: record[0],
			workTreeStatus: record[1],
			path: record.slice(3),
		};
		if (entry.indexStatus === "R" || entry.indexStatus === "C") {
			entry.originalPath = records[++index] || undefined;
		}
		entries.push(entry);
	}
	return entries;
}

export function truncateText(text: string, maxChars: number): { text: string; truncated: boolean; omitted: number } {
	if (text.length <= maxChars) return { text, truncated: false, omitted: 0 };
	return { text: text.slice(0, maxChars) + `\n... [truncated ${text.length - maxChars} chars]`, truncated: true, omitted: text.length - maxChars };
}

export async function readSmallUntrackedFiles(
	cwd: string,
	options: GitRunOptions & { maxFiles?: number; maxBytesPerFile?: number } = {},
): Promise<string> {
	const maxFiles = options.maxFiles ?? 20;
	const maxBytesPerFile = options.maxBytesPerFile ?? 20_000;
	const { stdout } = await runGit(cwd, ["ls-files", "--others", "--exclude-standard", "-z"], options);
	const allFiles = stdout.split("\0").filter(Boolean);
	const parts: string[] = [];
	for (const file of allFiles.slice(0, maxFiles)) {
		const absolutePath = path.resolve(cwd, file);
		if (!isWithinRoot(absolutePath, path.resolve(cwd))) {
			parts.push(`--- ${file} ---\n[skipped: path outside repository]`);
			continue;
		}
		try {
			const stats = await fs.stat(absolutePath);
			if (!stats.isFile()) continue;
			if (stats.size > maxBytesPerFile) {
				parts.push(`--- ${file} ---\n[skipped: ${stats.size} bytes]`);
				continue;
			}
			const content = await fs.readFile(absolutePath);
			parts.push(`--- ${file} ---\n${content.includes(0) ? "[unreadable or binary]" : content.toString("utf8")}`);
		} catch {
			parts.push(`--- ${file} ---\n[unreadable or binary]`);
		}
	}
	if (allFiles.length > maxFiles) parts.push(`... [${allFiles.length - maxFiles} more untracked files omitted]`);
	return parts.join("\n\n");
}

export async function collectWorkingTreeDiff(
	cwd: string,
	mode: GitDiffMode = "all",
	options: GitRunOptions & { includeUntrackedContent?: boolean } = {},
): Promise<string> {
	const git = (args: string[]) => runGit(cwd, args, options);
	switch (mode) {
		case "staged": {
			const stat = await git(["diff", "--cached", "--stat"]);
			const detail = await git(["diff", "--cached"]);
			return [stat.stdout, detail.stdout].filter(Boolean).join("\n") || "(no staged changes)";
		}
		case "unstaged": {
			const stat = await git(["diff", "--stat"]);
			const detail = await git(["diff"]);
			return [stat.stdout, detail.stdout].filter(Boolean).join("\n") || "(no unstaged changes)";
		}
		case "summary": {
			const status = await git(["status", "--short"]);
			const unstaged = await git(["diff", "--stat"]);
			const staged = await git(["diff", "--cached", "--stat"]);
			const untracked = await git(["ls-files", "--others", "--exclude-standard"]);
			return [
				status.stdout.trim() ? "### Status\n" + status.stdout : "### Status\n(clean)",
				staged.stdout ? "### Staged\n" + staged.stdout : "### No staged changes",
				unstaged.stdout ? "### Unstaged\n" + unstaged.stdout : "### No unstaged changes",
				untracked.stdout.trim() ? "### Untracked\n" + untracked.stdout : "### No untracked files",
			].join("\n\n");
		}
		case "custom": {
			const staged = await git(["diff", "--cached"]);
			const unstaged = await git(["diff"]);
			return [staged.stdout, unstaged.stdout].filter(Boolean).join("\n") || "(no changes)";
		}
		case "uncommitted":
		case "all":
		default: {
			const status = await git(["status", "--short"]);
			const staged = await git(["diff", "--cached"]);
			const unstaged = await git(["diff"]);
			const untracked = options.includeUntrackedContent
				? await readSmallUntrackedFiles(cwd, options)
				: (await git(["ls-files", "--others", "--exclude-standard"])).stdout;
			const parts: string[] = [];
			if (status.stdout.trim()) parts.push("### Status\n" + status.stdout);
			if (staged.stdout.trim()) parts.push("### Staged Changes\n" + staged.stdout);
			if (unstaged.stdout.trim()) parts.push("### Unstaged Changes\n" + unstaged.stdout);
			if (untracked.trim()) parts.push(options.includeUntrackedContent ? "### Untracked File Contents\n" + untracked : "### Untracked Files\n" + untracked);
			return parts.join("\n\n") || "(no changes)";
		}
	}
}

function isWithinRoot(target: string, root: string): boolean {
	const relative = path.relative(root, target);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function abortError(signal?: AbortSignal): Error {
	return signal?.reason instanceof Error ? signal.reason : new DOMException("Git command aborted.", "AbortError");
}
