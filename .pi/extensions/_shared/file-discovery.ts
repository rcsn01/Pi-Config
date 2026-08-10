import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import ignore from "ignore";

export type FileDiscoveryBackend = "auto" | "fd" | "rg" | "node";

export interface FileDiscoveryOptions {
	query?: string;
	maxResults?: number;
	maxFilesScanned?: number;
	includeHidden?: boolean;
	followSymlinks?: boolean;
	backend?: FileDiscoveryBackend;
	signal?: AbortSignal;
}

const DEFAULT_EXCLUDED_NAMES = new Set([
	".git",
	"node_modules",
	"__pycache__",
	".venv",
	"venv",
	"dist",
	"build",
	".next",
	".cache",
	"target",
	".idea",
	".vscode",
]);

export async function discoverFiles(
	cwd: string,
	options: FileDiscoveryOptions = {},
): Promise<string[]> {
	const root = path.resolve(cwd);
	const maxResults = clampInteger(options.maxResults, 20, 1, 1_000);
	const maxFilesScanned = clampInteger(
		options.maxFilesScanned,
		Math.max(5_000, maxResults * 50),
		maxResults,
		100_000,
	);
	throwIfAborted(options.signal);

	let files: string[] | undefined;
	const backend = options.backend ?? "auto";
	if (backend === "auto" || backend === "fd") {
		files = await listWithCommand("fd", fdArgs(options), root, maxFilesScanned, options.signal);
		if (backend === "fd" && !files) throw new Error("fd is not available or failed to list files.");
	}
	if (!files && (backend === "auto" || backend === "rg")) {
		files = await listWithCommand("rg", rgArgs(options), root, maxFilesScanned, options.signal);
		if (backend === "rg" && !files) throw new Error("rg is not available or failed to list files.");
	}
	if (!files) files = await listWithNode(root, maxFilesScanned, options);

	const query = options.query?.trim() ?? "";
	return files
		.map(normalizeRelativePath)
		.filter(Boolean)
		.filter((file, index, all) => all.indexOf(file) === index)
		.map((file) => ({ file, score: query ? scoreFilePath(query, file) : 0 }))
		.filter((candidate) => !query || candidate.score >= 0)
		.sort((left, right) => right.score - left.score || left.file.localeCompare(right.file))
		.slice(0, maxResults)
		.map((candidate) => candidate.file);
}

export function scoreFilePath(query: string, relativePath: string): number {
	const normalizedQuery = query.toLowerCase();
	const normalizedPath = relativePath.toLowerCase();
	const basename = path.posix.basename(normalizedPath);
	if (!normalizedQuery) return 0;
	if (basename === normalizedQuery) return 1_000;
	if (basename.startsWith(normalizedQuery)) return 900 - basename.length;
	if (basename.includes(normalizedQuery)) return 800 - basename.indexOf(normalizedQuery);
	if (normalizedPath.startsWith(normalizedQuery)) return 700 - normalizedPath.length;
	if (normalizedPath.includes(normalizedQuery)) return 600 - normalizedPath.indexOf(normalizedQuery);
	return fuzzyMatch(normalizedQuery, normalizedPath) ? 300 - normalizedPath.length : -1;
}

function fuzzyMatch(query: string, value: string): boolean {
	let queryIndex = 0;
	for (let valueIndex = 0; valueIndex < value.length && queryIndex < query.length; valueIndex++) {
		if (value[valueIndex] === query[queryIndex]) queryIndex++;
	}
	return queryIndex === query.length;
}

function fdArgs(options: FileDiscoveryOptions): string[] {
	const args = ["--type", "f", "--color", "never"];
	if (options.includeHidden) args.push("--hidden");
	if (options.followSymlinks) args.push("--follow");
	for (const name of DEFAULT_EXCLUDED_NAMES) args.push("--exclude", name);
	return args;
}

function rgArgs(options: FileDiscoveryOptions): string[] {
	const args = ["--files"];
	if (options.includeHidden) args.push("--hidden");
	if (options.followSymlinks) args.push("--follow");
	for (const name of DEFAULT_EXCLUDED_NAMES) args.push("--glob", `!${name}/**`);
	return args;
}

async function listWithCommand(
	command: string,
	args: string[],
	cwd: string,
	limit: number,
	signal?: AbortSignal,
): Promise<string[] | undefined> {
	throwIfAborted(signal);
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
		const files: string[] = [];
		let buffer = "";
		let stoppedAtLimit = false;
		let settled = false;

		const finish = (value: string[] | undefined, error?: unknown) => {
			if (settled) return;
			settled = true;
			signal?.removeEventListener("abort", abort);
			if (error) reject(error);
			else resolve(value);
		};
		const abort = () => {
			child.kill();
			finish(undefined, abortError(signal));
		};
		const acceptLine = (line: string) => {
			if (!line.trim() || files.length >= limit) return;
			files.push(line.trim());
			if (files.length >= limit) {
				stoppedAtLimit = true;
				child.kill();
			}
		};

		child.once("error", (error: NodeJS.ErrnoException) => {
			finish(error.code === "ENOENT" ? undefined : undefined);
		});
		child.stdout?.on("data", (chunk: Buffer) => {
			buffer += chunk.toString();
			const lines = buffer.split(/\r?\n/);
			buffer = lines.pop() ?? "";
			for (const line of lines) acceptLine(line);
		});
		child.once("close", (code) => {
			if (buffer) acceptLine(buffer);
			finish(code === 0 || stoppedAtLimit ? files : undefined);
		});
		if (signal?.aborted) abort();
		else signal?.addEventListener("abort", abort, { once: true });
	});
}

async function listWithNode(
	root: string,
	limit: number,
	options: FileDiscoveryOptions,
): Promise<string[]> {
	const matcher = ignore();
	const files: string[] = [];
	const visitedDirectories = new Set<string>();
	const rootRealPath = await fs.realpath(root);

	async function walk(directory: string, relativeDirectory: string): Promise<void> {
		throwIfAborted(options.signal);
		if (files.length >= limit) return;
		const realDirectory = await fs.realpath(directory);
		if (visitedDirectories.has(realDirectory)) return;
		visitedDirectories.add(realDirectory);
		await addIgnoreFiles(matcher, directory, relativeDirectory);

		let entries;
		try {
			entries = await fs.readdir(directory, { withFileTypes: true });
		} catch {
			return;
		}

		for (const entry of entries) {
			throwIfAborted(options.signal);
			if (files.length >= limit) return;
			if (DEFAULT_EXCLUDED_NAMES.has(entry.name)) continue;
			if (!options.includeHidden && entry.name.startsWith(".")) continue;

			const relativePath = normalizeRelativePath(path.join(relativeDirectory, entry.name));
			const fullPath = path.join(directory, entry.name);
			let isDirectory = entry.isDirectory();
			let isFile = entry.isFile();
			if (entry.isSymbolicLink()) {
				if (!options.followSymlinks) continue;
				try {
					const realPath = await fs.realpath(fullPath);
					if (!isWithinRoot(realPath, rootRealPath)) continue;
					const stats = await fs.stat(fullPath);
					isDirectory = stats.isDirectory();
					isFile = stats.isFile();
				} catch {
					continue;
				}
			}

			const ignorePath = isDirectory ? `${relativePath}/` : relativePath;
			if (matcher.ignores(ignorePath)) continue;
			if (isDirectory) await walk(fullPath, relativePath);
			else if (isFile) files.push(relativePath);
		}
	}

	await walk(root, "");
	return files;
}

async function addIgnoreFiles(
	matcher: ReturnType<typeof ignore>,
	directory: string,
	relativeDirectory: string,
): Promise<void> {
	for (const fileName of [".gitignore", ".ignore"]) {
		try {
			const source = await fs.readFile(path.join(directory, fileName), "utf8");
			const patterns = source.split(/\r?\n/).flatMap((pattern) =>
				prefixNestedPattern(pattern, relativeDirectory),
			);
			matcher.add(patterns);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") continue;
		}
	}
}

function prefixNestedPattern(pattern: string, relativeDirectory: string): string[] {
	if (!relativeDirectory || !pattern || /^\s*#/.test(pattern)) return [pattern];
	const negative = pattern.startsWith("!");
	const raw = negative ? pattern.slice(1) : pattern;
	const prefix = negative ? "!" : "";
	const normalized = raw.replace(/^\//, "");
	if (normalized.includes("/")) return [`${prefix}${relativeDirectory}/${normalized}`];
	return [
		`${prefix}${relativeDirectory}/${normalized}`,
		`${prefix}${relativeDirectory}/**/${normalized}`,
	];
}

function normalizeRelativePath(value: string): string {
	return value.replace(/^\.([/\\])/, "").split(path.sep).join("/").replace(/\\/g, "/");
}

function isWithinRoot(target: string, root: string): boolean {
	const relative = path.relative(root, target);
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function clampInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
	if (value === undefined || !Number.isFinite(value)) return fallback;
	return Math.min(maximum, Math.max(minimum, Math.floor(value)));
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw abortError(signal);
}

function abortError(signal?: AbortSignal): Error {
	return signal?.reason instanceof Error ? signal.reason : new DOMException("File discovery aborted.", "AbortError");
}