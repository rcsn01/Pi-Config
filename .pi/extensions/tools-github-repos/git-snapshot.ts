import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	RepositoryError,
	repositoryError,
	type MaterializeRequest,
	type MaterializeResult,
	type ResolvedRevision,
	type SnapshotAdapter,
	type SnapshotLimits,
} from "./contract.ts";
import { isFullCommit } from "./github-locator.ts";

interface ProcessResult { code: number; stdout: Buffer; stderr: Buffer }
interface TreeEntry { mode: string; type: string; size: number; path: string }

export class GitSnapshotAdapter implements SnapshotAdapter {
	constructor(private readonly options: { gitPath?: string; allowLocalRemote?: boolean } = {}) {}

	async resolve(remoteUrl: string, requestedRef: string | null, deadline: number, limits: SnapshotLimits, signal?: AbortSignal): Promise<ResolvedRevision> {
		checkActive(deadline, signal);
		if (requestedRef && isFullCommit(requestedRef)) {
			return { requestedRef, resolvedRef: requestedRef, commit: requestedRef };
		}
		const patterns = requestedRef === null
			? ["--symref", remoteUrl, "HEAD"]
			: requestedRef.startsWith("refs/")
				? [remoteUrl, requestedRef, `${requestedRef}^{}`]
				: [remoteUrl, `refs/heads/${requestedRef}`, `refs/tags/${requestedRef}`, `refs/tags/${requestedRef}^{}`];
		const isolatedCwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-github-resolve-"));
		let result: ProcessResult;
		try {
			result = await this.git(isolatedCwd, ["ls-remote", ...patterns], deadline, limits, signal);
		} finally {
			await fs.rm(isolatedCwd, { recursive: true, force: true }).catch(() => {});
		}
		if (result.code !== 0) throw classifyGitFailure(result.stderr, "resolve");
		const output = decodeUtf8(result.stdout, "NETWORK_ERROR");
		const refs = parseRemoteRefs(output);

		if (requestedRef === null) {
			const commit = refs.values.get("HEAD");
			if (!commit) throw repositoryError("REF_NOT_FOUND");
			return { requestedRef: null, resolvedRef: refs.symbolicHead ?? "HEAD", commit };
		}
		if (requestedRef.startsWith("refs/")) {
			const commit = refs.values.get(`${requestedRef}^{}`) ?? refs.values.get(requestedRef);
			if (!commit) throw repositoryError("REF_NOT_FOUND");
			return { requestedRef, resolvedRef: requestedRef, commit };
		}
		const head = refs.values.get(`refs/heads/${requestedRef}`);
		const tag = refs.values.get(`refs/tags/${requestedRef}^{}`) ?? refs.values.get(`refs/tags/${requestedRef}`);
		if (head && tag) throw repositoryError("AMBIGUOUS_REF");
		if (!head && !tag) throw repositoryError("REF_NOT_FOUND");
		return {
			requestedRef,
			resolvedRef: head ? `refs/heads/${requestedRef}` : `refs/tags/${requestedRef}`,
			commit: (head ?? tag)!,
		};
	}

	async materialize(request: MaterializeRequest): Promise<MaterializeResult> {
		const { stagingPath, limits, signal, deadline, revision } = request;
		const source = path.join(stagingPath, "source");
		const template = path.join(stagingPath, ".template");
		await fs.mkdir(source, { recursive: true });
		await fs.mkdir(template, { recursive: true });
		const monitor = () => enforceStagingLimit(stagingPath, limits.maxStagingBytes);

		await this.mustGit(stagingPath, ["init", "--quiet", `--template=${template}`, source], deadline, limits, signal, monitor);
		await this.mustGit(source, ["fetch", "--quiet", "--depth=1", "--no-tags", "--no-recurse-submodules", request.remoteUrl, revision.commit], deadline, limits, signal, monitor, "fetch");
		const verified = await this.mustGit(source, ["rev-parse", "--verify", "FETCH_HEAD^{commit}"], deadline, limits, signal, monitor);
		if (decodeUtf8(verified.stdout, "STORAGE_ERROR").trim().toLowerCase() !== revision.commit.toLowerCase()) {
			throw repositoryError("NETWORK_ERROR", "The remote changed while the revision was being pinned.");
		}

		const treeResult = await this.mustGit(source, ["ls-tree", "-r", "-l", "-z", revision.commit], deadline, limits, signal, monitor);
		const entries = parseTree(treeResult.stdout, limits, deadline, signal);
		await this.mustGit(source, ["checkout", "--quiet", "--detach", "--force", revision.commit], deadline, limits, signal, monitor);
		await monitor();
		checkActive(deadline, signal);
		const converted = await convertSymlinks(source, new Set(entries.filter((entry) => entry.mode === "120000").map((entry) => entry.path)), deadline, signal);
		await fs.rm(path.join(source, ".git"), { recursive: true, force: true });
		await fs.rm(template, { recursive: true, force: true });
		await makeReadOnly(source, deadline, signal);
		checkActive(deadline, signal);
		await monitor();
		return {
			fileCount: entries.filter((entry) => entry.mode !== "160000").length,
			byteCount: entries.filter((entry) => entry.mode !== "160000").reduce((sum, entry) => sum + entry.size, 0),
			symlinksConverted: converted,
			submodulesSkipped: entries.filter((entry) => entry.mode === "160000").map((entry) => entry.path),
		};
	}

	private async mustGit(
		cwd: string,
		args: string[],
		deadline: number,
		limits: SnapshotLimits,
		signal?: AbortSignal,
		monitor?: () => Promise<void>,
		phase: "fetch" | "other" = "other",
	): Promise<ProcessResult> {
		const result = await this.git(cwd, args, deadline, limits, signal, monitor);
		if (result.code !== 0) throw classifyGitFailure(result.stderr, phase);
		return result;
	}

	private git(cwd: string, args: string[], deadline: number, limits: SnapshotLimits, signal?: AbortSignal, monitor?: () => Promise<void>): Promise<ProcessResult> {
		const gitArgs = [
			"-c", "core.hooksPath=/dev/null",
			"-c", "filter.lfs.smudge=",
			"-c", "filter.lfs.required=false",
			"-c", `protocol.file.allow=${this.options.allowLocalRemote ? "always" : "never"}`,
			"-c", "protocol.ext.allow=never",
			"-c", "protocol.ssh.allow=never",
			"-c", "protocol.git.allow=never",
			"-c", "credential.helper=",
			...args,
		];
		return runBounded(this.options.gitPath ?? "git", gitArgs, {
			cwd,
			deadline,
			signal,
			maxStdoutBytes: limits.maxStdoutBytes,
			maxStderrBytes: limits.maxStderrBytes,
			monitor,
		});
	}
}

function controlledEnvironment(cwd: string): NodeJS.ProcessEnv {
	return {
		PATH: process.env.PATH ?? "/usr/bin:/bin",
		LANG: "C",
		LC_ALL: "C",
		HOME: "/dev/null",
		XDG_CONFIG_HOME: "/dev/null",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_CONFIG_SYSTEM: "/dev/null",
		GIT_CONFIG_GLOBAL: "/dev/null",
		GIT_TERMINAL_PROMPT: "0",
		GIT_ASKPASS: "",
		SSH_ASKPASS: "",
		GIT_SSH_COMMAND: "false",
		GIT_ATTR_NOSYSTEM: "1",
		GIT_LFS_SKIP_SMUDGE: "1",
		GIT_CEILING_DIRECTORIES: cwd,
	};
}

async function runBounded(command: string, args: string[], options: {
	cwd: string; deadline: number; signal?: AbortSignal; maxStdoutBytes: number; maxStderrBytes: number; monitor?: () => Promise<void>;
}): Promise<ProcessResult> {
	if (options.signal?.aborted) throw repositoryError("CANCELLED");
	const remaining = options.deadline - Date.now();
	if (remaining <= 0) throw repositoryError("TIMEOUT");

	return new Promise<ProcessResult>((resolve, reject) => {
		let settled = false;
		let killReason: RepositoryError | undefined;
		let killTimer: NodeJS.Timeout | undefined;
		let stdoutBytes = 0;
		let stderrBytes = 0;
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		const child = spawn(command, args, {
			cwd: options.cwd,
			env: controlledEnvironment(options.cwd),
			shell: false,
			detached: process.platform !== "win32",
			stdio: ["ignore", "pipe", "pipe"],
		});
		const finish = (error?: unknown, result?: ProcessResult) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			clearInterval(poller);
			if (killTimer) clearTimeout(killTimer);
			options.signal?.removeEventListener("abort", onAbort);
			if (error) reject(error);
			else resolve(result!);
		};
		const kill = (error: RepositoryError) => {
			if (settled || killReason) return;
			killReason = error;
			terminateProcess(child.pid, process.platform === "win32" ? "SIGKILL" : "SIGTERM");
			killTimer = setTimeout(() => terminateProcess(child.pid, "SIGKILL"), 250);
			killTimer.unref();
		};
		const onAbort = () => kill(repositoryError("CANCELLED"));
		const timer = setTimeout(() => kill(repositoryError("TIMEOUT")), remaining);
		timer.unref();
		const poller = setInterval(() => {
			void options.monitor?.().catch((error) => kill(error instanceof RepositoryError ? error : repositoryError("STORAGE_ERROR")));
		}, 250);
		poller.unref();
		options.signal?.addEventListener("abort", onAbort, { once: true });
		if (options.signal?.aborted) onAbort();
		child.stdout.on("data", (chunk: Buffer) => {
			stdoutBytes += chunk.length;
			if (stdoutBytes > options.maxStdoutBytes) return kill(repositoryError("LIMIT_EXCEEDED", "Git produced too much output."));
			stdout.push(chunk);
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderrBytes += chunk.length;
			if (stderrBytes > options.maxStderrBytes) return kill(repositoryError("LIMIT_EXCEEDED", "Git produced too much diagnostic output."));
			stderr.push(chunk);
		});
		child.on("error", (error: NodeJS.ErrnoException) => {
			finish(error.code === "ENOENT" ? repositoryError("GIT_UNAVAILABLE") : repositoryError("STORAGE_ERROR"));
		});
		child.on("close", (code) => {
			if (killReason) finish(killReason);
			else finish(undefined, { code: code ?? 1, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
		});
	});
}

function terminateProcess(pid: number | undefined, signal: NodeJS.Signals = "SIGTERM"): void {
	if (!pid) return;
	if (process.platform === "win32" && signal === "SIGKILL") {
		try {
			const killer = spawn("taskkill", ["/pid", String(pid), "/t", "/f"], { shell: false, stdio: "ignore", windowsHide: true });
			killer.unref();
		} catch {}
		return;
	}
	try { process.kill(process.platform === "win32" ? pid : -pid, signal); } catch {}
}

function classifyGitFailure(stderr: Buffer, phase: "resolve" | "fetch" | "other"): RepositoryError {
	const text = stderr.toString("utf8").toLowerCase().replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
	if (/authentication failed|could not read username|permission denied|repository is private/.test(text)) return repositoryError("AUTH_REQUIRED");
	if (/repository not found|not found/.test(text)) return repositoryError("REPOSITORY_NOT_FOUND");
	if (/couldn't find remote ref|not our ref|unadvertised object|remote ref does not exist/.test(text)) return repositoryError("REF_NOT_FOUND");
	if (/could not resolve host|failed to connect|network is unreachable|connection timed out|connection reset/.test(text)) return repositoryError("NETWORK_ERROR");
	return repositoryError(phase === "fetch" ? "NETWORK_ERROR" : "STORAGE_ERROR");
}

function decodeUtf8(value: Buffer, code: "NETWORK_ERROR" | "STORAGE_ERROR"): string {
	try { return new TextDecoder("utf-8", { fatal: true }).decode(value); }
	catch { throw repositoryError(code); }
}

function parseRemoteRefs(output: string): { values: Map<string, string>; symbolicHead?: string } {
	const values = new Map<string, string>();
	let symbolicHead: string | undefined;
	for (const line of output.split("\n")) {
		if (!line) continue;
		const [left, ref] = line.split("\t");
		if (!left || !ref) continue;
		if (left.startsWith("ref: ") && ref === "HEAD") symbolicHead = left.slice(5);
		else if (/^[0-9a-f]{40}$/i.test(left)) values.set(ref, left.toLowerCase());
	}
	return { values, symbolicHead };
}

export function parseTree(output: Buffer, limits: SnapshotLimits, deadline = Number.POSITIVE_INFINITY, signal?: AbortSignal): TreeEntry[] {
	const entries: TreeEntry[] = [];
	const portablePaths = new Set<string>();
	const directories = new Set<string>();
	let offset = 0;
	let bytes = 0;
	let pathBytes = 0;
	while (offset < output.length) {
		checkActive(deadline, signal);
		const end = output.indexOf(0, offset);
		if (end < 0) throw repositoryError("UNSAFE_TREE");
		const record = output.subarray(offset, end);
		offset = end + 1;
		const tab = record.indexOf(9);
		if (tab < 0) throw repositoryError("UNSAFE_TREE");
		const header = record.subarray(0, tab).toString("ascii").trim().split(/ +/);
		if (header.length !== 4 || !/^(100644|100755|120000|160000)$/.test(header[0]) || !/^[0-9a-f]{40,64}$/i.test(header[2])) throw repositoryError("UNSAFE_TREE");
		const size = header[3] === "-" && header[0] === "160000" ? 0 : Number(header[3]);
		if (!Number.isSafeInteger(size) || size < 0) throw repositoryError("UNSAFE_TREE");
		const entryPath = decodeUtf8(record.subarray(tab + 1), "STORAGE_ERROR");
		validateTreePath(entryPath);
		const portablePath = entryPath.normalize("NFC").toLowerCase();
		if (portablePaths.has(portablePath)) throw repositoryError("UNSAFE_TREE");
		portablePaths.add(portablePath);
		const parts = portablePath.split("/");
		if (parts.length > 256) throw repositoryError("LIMIT_EXCEEDED", "A tracked path is nested too deeply.");
		for (let index = 1; index < parts.length; index++) directories.add(parts.slice(0, index).join("/"));
		if (directories.size > limits.maxEntries) throw repositoryError("LIMIT_EXCEEDED", "The tree would create too many directories.");
		pathBytes += Buffer.byteLength(entryPath);
		if (pathBytes > 64 * 1024 * 1024) throw repositoryError("LIMIT_EXCEEDED", "The tree contains too much path metadata.");
		if (size > limits.maxBlobBytes) throw repositoryError("LIMIT_EXCEEDED", "A tracked file is too large.");
		bytes += size;
		if (bytes > limits.maxTreeBytes) throw repositoryError("LIMIT_EXCEEDED", "The tracked tree is too large.");
		entries.push({ mode: header[0], type: header[1], size, path: entryPath });
		if (entries.length > limits.maxEntries) throw repositoryError("LIMIT_EXCEEDED", "The tree has too many entries.");
	}
	const entryPaths = new Set(entries.map((entry) => entry.path.normalize("NFC").toLowerCase()));
	for (const entry of entries) {
		const parts = entry.path.normalize("NFC").toLowerCase().split("/");
		for (let index = 1; index < parts.length; index++) {
			if (entryPaths.has(parts.slice(0, index).join("/"))) throw repositoryError("UNSAFE_TREE");
		}
	}
	return entries;
}

function validateTreePath(value: string): void {
	const parts = value.split("/");
	if (!value || Buffer.byteLength(value) > 4096 || path.isAbsolute(value) || parts.some((part) => !part || part === "." || part === ".." || Buffer.byteLength(part) > 255)) {
		throw repositoryError("UNSAFE_TREE");
	}
	for (const part of parts) {
		if (/^[.]git$/i.test(part) || /[\x00-\x1f\x7f\\:]/.test(part) || /[ .]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) {
			throw repositoryError("UNSAFE_TREE");
		}
	}
}

async function convertSymlinks(root: string, expected: Set<string>, deadline: number, signal?: AbortSignal): Promise<number> {
	let converted = 0;
	async function visit(dir: string): Promise<void> {
		checkActive(deadline, signal);
		for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
			checkActive(deadline, signal);
			const absolute = path.join(dir, entry.name);
			const relative = path.relative(root, absolute).split(path.sep).join("/");
			if (entry.isSymbolicLink()) {
				if (!expected.delete(relative)) throw repositoryError("UNSAFE_TREE");
				const target = await fs.readlink(absolute, { encoding: "buffer" });
				await fs.unlink(absolute);
				await fs.writeFile(absolute, target, { mode: 0o600 });
				converted++;
			} else if (entry.isDirectory()) await visit(absolute);
		}
	}
	await visit(root);
	if (expected.size > 0) throw repositoryError("UNSAFE_TREE");
	return converted;
}

async function makeReadOnly(root: string, deadline: number, signal?: AbortSignal): Promise<void> {
	const directories: string[] = [];
	async function visit(dir: string): Promise<void> {
		checkActive(deadline, signal);
		directories.push(dir);
		for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
			const absolute = path.join(dir, entry.name);
			if (entry.isDirectory()) await visit(absolute);
			else if (entry.isFile()) await fs.chmod(absolute, 0o444);
			else throw repositoryError("UNSAFE_TREE");
		}
	}
	await visit(root);
	for (const directory of directories.reverse()) {
		checkActive(deadline, signal);
		await fs.chmod(directory, 0o555);
	}
}

function checkActive(deadline: number, signal?: AbortSignal): void {
	if (signal?.aborted) throw repositoryError("CANCELLED");
	if (Date.now() >= deadline) throw repositoryError("TIMEOUT");
}

async function enforceStagingLimit(root: string, maximum: number): Promise<void> {
	let total = 0;
	async function visit(current: string): Promise<void> {
		for (const entry of await fs.readdir(current, { withFileTypes: true })) {
			const absolute = path.join(current, entry.name);
			if (entry.isDirectory()) {
				total += 4096;
				await visit(absolute);
			} else {
				const stat = await fs.lstat(absolute);
				total += typeof stat.blocks === "number" && stat.blocks > 0 ? stat.blocks * 512 : stat.size;
			}
			if (total > maximum) throw repositoryError("LIMIT_EXCEEDED", "Staging storage exceeded the limit.");
		}
	}
	try { await visit(root); }
	catch (error: any) {
		if (error?.code === "ENOENT") return;
		throw error;
	}
}
