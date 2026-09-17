import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { projectStatePath, projectStateRoot } from "../../_shared/state-paths.ts";
import { ensureDir } from "./registry.ts";
import type { WorkflowRunEventView } from "./workflow-run-events.ts";

export interface InternalRunPaths {
	root: string;
	events: string;
	state: string;
	input: string;
	artifacts: string;
}

export interface RunInput {
	args: string;
	workflowName: string;
	sourceHash: string;
	createdAt?: number;
}

export interface RunPersistence {
	initializeInput(input: RunInput): Promise<void>;
	appendEvent(event: WorkflowRunEventView): Promise<void>;
	readEventLog(): Promise<{ exists: boolean; events: readonly WorkflowRunEventView[] }>;
	readProjection(): Promise<unknown | undefined>;
	writeProjection(projection: unknown): Promise<void>;
	writeArtifact(requestedPath: string, data: string): Promise<string>;
	paths(): InternalRunPaths;
}

export function validateRunId(runId: string): string {
	if (typeof runId !== "string" || !runId || runId === "." || runId === ".." || runId.includes("/") || runId.includes("\\") || runId.includes("\0")) {
		throw new Error(`Invalid workflow run id: ${String(runId)}`);
	}
	return runId;
}

function isWithinRoot(target: string, root: string): boolean {
	const relative = path.relative(path.resolve(root), path.resolve(target));
	return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function assertContained(target: string, root: string, label: string): void {
	if (!isWithinRoot(target, root)) throw new Error(`Invalid workflow ${label}: path escapes its root`);
}

export function runPaths(cwd: string, runId: string): InternalRunPaths {
	validateRunId(runId);
	const rootBase = projectStateRoot(cwd);
	const root = projectStatePath(cwd, "workflow-runs", runId);
	assertContained(root, path.join(rootBase, "workflow-runs"), "run id");
	return {
		root,
		events: path.join(root, "events.jsonl"),
		state: path.join(root, "state.json"),
		input: path.join(root, "input.json"),
		artifacts: path.join(root, "artifacts"),
	};
}

export function workflowRunsRoot(cwd: string): string {
	return projectStatePath(cwd, "workflow-runs");
}

export async function writeJson(file: string, data: unknown): Promise<void> {
	await ensureDir(path.dirname(file));
	const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
	await fsp.writeFile(tmp, JSON.stringify(data, null, 2), "utf-8");
	await fsp.rename(tmp, file);
}

export function safeArtifactPath(base: string, requested: string): string {
	if (typeof requested !== "string" || !requested) throw new Error(`Artifact path escapes run directory: ${String(requested)}`);
	const clean = requested.replace(/^[/\\]+/, "").replace(/\\/g, path.sep);
	const target = path.resolve(base, clean);
	const relative = path.relative(path.resolve(base), target);
	if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
		throw new Error(`Artifact path escapes run directory: ${requested}`);
	}
	return target;
}

async function existingAncestor(file: string): Promise<string> {
	let current = path.resolve(file);
	while (true) {
		try {
			await fsp.lstat(current);
			return current;
		} catch (error) {
			if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
			const parent = path.dirname(current);
			if (parent === current) return current;
			current = parent;
		}
	}
}

async function realPathWithMissing(file: string): Promise<string> {
	const suffix: string[] = [];
	let current = path.resolve(file);
	while (true) {
		try {
			return path.join(await fsp.realpath(current), ...suffix);
		} catch (error) {
			if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
			const parent = path.dirname(current);
			if (parent === current) return path.resolve(file);
			suffix.unshift(path.basename(current));
			current = parent;
		}
	}
}

async function assertArtifactWriteSafe(base: string, target: string): Promise<void> {
	const resolvedRunRoot = await fsp.realpath(path.dirname(base)).catch(() => path.resolve(path.dirname(base)));
	const resolvedBase = await fsp.realpath(base).catch(() => path.resolve(base));
	assertContained(resolvedBase, resolvedRunRoot, "artifact");
	const ancestor = await existingAncestor(path.dirname(target));
	const resolvedAncestor = await fsp.realpath(ancestor);
	assertContained(resolvedAncestor, resolvedBase, "artifact");
	try {
		const resolvedTarget = await fsp.realpath(target);
		assertContained(resolvedTarget, resolvedBase, "artifact");
		const stat = await fsp.stat(target);
		if (!stat.isFile()) throw new Error(`Artifact path is not a regular file: ${target}`);
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
	}
}

export class FileRunPersistence implements RunPersistence {
	private readonly runPaths: InternalRunPaths;
	private readonly runRootBoundary: string;

	constructor(cwd: string, runId: string) {
		this.runPaths = runPaths(cwd, runId);
		this.runRootBoundary = path.join(projectStateRoot(cwd), "workflow-runs");
	}

	paths(): InternalRunPaths {
		return { ...this.runPaths };
	}

	private async assertRunRootSafe(): Promise<void> {
		const boundary = await realPathWithMissing(this.runRootBoundary);
		const root = await realPathWithMissing(this.runPaths.root);
		if (!isWithinRoot(root, boundary) || root === boundary) throw new Error(`Invalid workflow run root: ${this.runPaths.root}`);
	}

	private async assertStoredPathSafe(file: string, label: string): Promise<void> {
		await this.assertRunRootSafe();
		const root = await realPathWithMissing(this.runPaths.root);
		const target = await realPathWithMissing(file);
		if (!isWithinRoot(target, root) || target === root) throw new Error(`Invalid workflow ${label}: path escapes run root`);
	}

	async initializeInput(input: RunInput): Promise<void> {
		await this.assertRunRootSafe();
		await ensureDir(this.runPaths.artifacts);
		await this.assertStoredPathSafe(this.runPaths.artifacts, "artifact directory");
		await this.assertStoredPathSafe(this.runPaths.input, "input");
		await writeJson(this.runPaths.input, {
			args: input.args,
			workflowName: input.workflowName,
			sourceHash: input.sourceHash,
			createdAt: input.createdAt ?? Date.now(),
		});
	}

	async appendEvent(event: WorkflowRunEventView): Promise<void> {
		await this.assertRunRootSafe();
		await ensureDir(this.runPaths.root);
		await this.assertStoredPathSafe(this.runPaths.events, "event log");
		// The spread order is intentional: a supplied ts remains compatible with
		// the old JSONL adapter while ordinary events receive the append time.
		await fsp.appendFile(this.runPaths.events, JSON.stringify({ ts: Date.now(), ...event }) + "\n", "utf-8");
	}

	async readEventLog(): Promise<{ exists: boolean; events: readonly WorkflowRunEventView[] }> {
		await this.assertStoredPathSafe(this.runPaths.events, "event log");
		let text: string;
		try {
			text = await fsp.readFile(this.runPaths.events, "utf-8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return { exists: false, events: [] };
			throw error;
		}
		const events: WorkflowRunEventView[] = [];
		for (const [index, line] of text.split(/\r?\n/).entries()) {
			if (!line.trim()) continue;
			try {
				const parsed = JSON.parse(line) as WorkflowRunEventView;
				if (!parsed || typeof parsed !== "object" || typeof parsed.type !== "string") throw new Error("event must contain a string type");
				events.push(parsed);
			} catch (error) {
				throw new Error(`Invalid workflow event JSONL at ${this.runPaths.events}:${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		return { exists: true, events };
	}

	async readProjection(): Promise<unknown | undefined> {
		await this.assertStoredPathSafe(this.runPaths.state, "state projection");
		try {
			return JSON.parse(await fsp.readFile(this.runPaths.state, "utf-8")) as unknown;
		} catch (error) {
			if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
			throw error;
		}
	}

	async writeProjection(projection: unknown): Promise<void> {
		await this.assertStoredPathSafe(this.runPaths.state, "state projection");
		await writeJson(this.runPaths.state, projection);
	}

	async writeArtifact(requestedPath: string, data: string): Promise<string> {
		await this.assertRunRootSafe();
		await ensureDir(this.runPaths.artifacts);
		const target = safeArtifactPath(this.runPaths.artifacts, requestedPath);
		await assertArtifactWriteSafe(this.runPaths.artifacts, target);
		await fsp.mkdir(path.dirname(target), { recursive: true });
		await assertArtifactWriteSafe(this.runPaths.artifacts, target);
		await fsp.writeFile(target, data, "utf-8");
		return path.relative(this.runPaths.root, target);
	}
}
