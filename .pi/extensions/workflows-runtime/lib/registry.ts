import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { defineWorkflow, type NormalizedWorkflowDefinition } from "./definition.ts";
import fanOutAndSynthesize from "../bundled/fan-out-and-synthesize.ts";
import deepVerification from "../bundled/deep-verification.ts";
import deepResearch from "../bundled/deep-research.ts";
import generateFilterTournament from "../bundled/generate-filter-tournament.ts";

export const RUNS_DIR = path.join(".pi", "workflow-runs");
export const APPROVALS_DIR = path.join(".pi", "workflow-approvals");
export const PROJECT_WORKFLOWS_DIR = path.join(".pi", "workflows");

export type WorkflowTrust = "bundled" | "project";
export type WorkflowCost = "quick" | "medium" | "heavy" | "unknown";

export interface RegistryEntry {
	name: string;
	description: string;
	trust: WorkflowTrust;
	cost: WorkflowCost;
	canEditFiles?: boolean;
	workflow?: NormalizedWorkflowDefinition;
	filePath?: string;
	extension?: string;
	source: string;
	sourceHash: string;
}

export function slugify(input: string): string {
	return input.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "workflow";
}

export function hash(input: string): string {
	return crypto.createHash("sha256").update(input).digest("hex");
}

export function shortHash(input: string): string {
	return hash(input).slice(0, 12);
}

export function projectPathHash(cwd: string): string {
	return shortHash(path.resolve(cwd));
}

export function nowId(name: string): string {
	const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
	return `${stamp}-${slugify(name)}-${crypto.randomBytes(3).toString("hex")}`;
}

export async function ensureDir(dir: string): Promise<void> {
	await fsp.mkdir(dir, { recursive: true });
}

function workflowSource(workflow: NormalizedWorkflowDefinition): string {
	return `Bundled workflow: ${workflow.name}\n\n${workflow.run.toString()}`;
}

export function entrySource(entry: RegistryEntry): string {
	if (entry.source) return entry.source;
	return entry.workflow ? workflowSource(entry.workflow) : entry.name;
}

async function bundledEntries(): Promise<RegistryEntry[]> {
	const workflows = [fanOutAndSynthesize, deepVerification, deepResearch, generateFilterTournament];
	return workflows.map((workflow) => {
		const source = workflowSource(workflow);
		return {
			name: workflow.name,
			description: workflow.description,
			trust: "bundled" as const,
			cost: workflow.budget?.estimatedCost || "medium",
			canEditFiles: workflow.canEditFiles,
			workflow,
			extension: ".txt",
			source,
			sourceHash: hash(source),
		};
	});
}

async function projectEntries(cwd: string): Promise<RegistryEntry[]> {
	const dir = path.join(cwd, PROJECT_WORKFLOWS_DIR);
	if (!fs.existsSync(dir)) return [];
	const entries: RegistryEntry[] = [];
	for (const name of await fsp.readdir(dir)) {
		if (!name.endsWith(".js") && !name.endsWith(".mjs") && !name.endsWith(".ts")) continue;
		const filePath = path.join(dir, name);
		const stat = await fsp.stat(filePath).catch(() => undefined);
		if (!stat?.isFile()) continue;
		const source = await fsp.readFile(filePath, "utf-8");
		const inferredName = slugify(path.basename(name, path.extname(name)));
		entries.push({
			name: inferredName,
			description: "Project workflow (approval required before import)",
			trust: "project",
			cost: "unknown",
			canEditFiles: undefined,
			filePath,
			extension: path.extname(name) || ".js",
			source,
			sourceHash: hash(source),
		});
	}
	return entries;
}

export async function discoverWorkflows(cwd: string): Promise<RegistryEntry[]> {
	return [...await bundledEntries(), ...await projectEntries(cwd)];
}

export async function writeWorkflowSnapshot(root: string, entry: RegistryEntry): Promise<string> {
	await ensureDir(root);
	const ext = entry.trust === "project" ? (entry.extension || ".js") : ".txt";
	const snapshotPath = path.join(root, `source${ext}`);
	await fsp.writeFile(snapshotPath, entrySource(entry), "utf-8");
	return snapshotPath;
}

export async function loadWorkflowFromEntry(entry: RegistryEntry, snapshotPath?: string): Promise<NormalizedWorkflowDefinition> {
	if (entry.workflow) return entry.workflow;
	if (entry.trust !== "project") throw new Error(`Workflow ${entry.name} has no bundled definition`);
	const importPath = snapshotPath || entry.filePath;
	if (!importPath) throw new Error(`Project workflow ${entry.name} has no source path`);
	const mod = await import(`${pathToFileURL(importPath).href}?v=${entry.sourceHash}`);
	const workflow = defineWorkflow(mod.default || mod.workflow);
	if (workflow.name !== entry.name) {
		throw new Error(`Project workflow definition name '${workflow.name}' must match filename-derived invocation name '${entry.name}'`);
	}
	return workflow;
}

export function enrichEntryWithWorkflow(entry: RegistryEntry, workflow: NormalizedWorkflowDefinition): RegistryEntry {
	return {
		...entry,
		description: workflow.description,
		cost: workflow.budget?.estimatedCost || "medium",
		canEditFiles: workflow.canEditFiles,
		workflow,
	};
}
