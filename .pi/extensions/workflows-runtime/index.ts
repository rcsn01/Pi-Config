import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { loadAgents, runSubagent, type AgentConfig, type AgentResult } from "../tools-subagents/index.ts";
import { defineWorkflow, type WorkflowAgentOptions, type WorkflowDefinition, type WorkflowParallelOptions } from "./lib/definition.ts";
import fanOutAndSynthesize from "./bundled/fan-out-and-synthesize.ts";
import deepVerification from "./bundled/deep-verification.ts";

export { defineWorkflow } from "./lib/definition.ts";

const CUSTOM_TYPE = "workflow-result";
const RUNS_DIR = path.join(".pi", "workflow-runs");
const APPROVALS_DIR = path.join(".pi", "workflow-approvals");
const PROJECT_WORKFLOWS_DIR = path.join(".pi", "workflows");
const DEFAULT_MAX_AGENTS = 20;
const DEFAULT_MAX_CONCURRENT = 4;

interface RegistryEntry {
	name: string;
	description: string;
	trust: "bundled" | "project";
	cost: "quick" | "medium" | "heavy";
	canEditFiles: boolean;
	workflow?: WorkflowDefinition;
	filePath?: string;
	source: string;
	sourceHash: string;
}

type RunStatus = "created" | "running" | "completed" | "failed" | "stopped";

interface RunState {
	runId: string;
	workflowName: string;
	trust: RegistryEntry["trust"];
	args: string;
	status: RunStatus;
	currentPhase?: string;
	startedAt: number;
	updatedAt: number;
	completedAt?: number;
	error?: string;
	result?: unknown;
	agentsStarted: number;
	agentsCompleted: number;
	agentsFailed: number;
	tokens: number;
	cost: number;
	steps: Record<string, { status: "running" | "completed" | "failed" | "invalidated"; result?: unknown; error?: string; updatedAt: number }>;
	agents: Record<string, { status: "running" | "completed" | "failed" | "invalidated"; agent: string; result?: unknown; raw?: AgentResult; error?: string; updatedAt: number }>;
	artifacts: string[];
	invalidatedKeys: string[];
}

interface RunPaths {
	root: string;
	events: string;
	state: string;
	artifacts: string;
	source: string;
}

class AsyncQueue {
	private tail = Promise.resolve();

	run<T>(fn: () => Promise<T>): Promise<T> {
		const next = this.tail.then(fn, fn);
		this.tail = next.then(() => undefined, () => undefined);
		return next;
	}
}

function slugify(input: string): string {
	return input.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "workflow";
}

function hash(input: string): string {
	return crypto.createHash("sha256").update(input).digest("hex");
}

function shortHash(input: string): string {
	return hash(input).slice(0, 12);
}

async function ensureDir(dir: string): Promise<void> {
	await fsp.mkdir(dir, { recursive: true });
}

function nowId(name: string): string {
	const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
	return `${stamp}-${slugify(name)}-${crypto.randomBytes(3).toString("hex")}`;
}

function runPaths(cwd: string, runId: string): RunPaths {
	const root = path.join(cwd, RUNS_DIR, runId);
	return {
		root,
		events: path.join(root, "events.jsonl"),
		state: path.join(root, "state.json"),
		artifacts: path.join(root, "artifacts"),
		source: path.join(root, "source.txt"),
	};
}

async function writeJson(file: string, data: unknown): Promise<void> {
	await ensureDir(path.dirname(file));
	await fsp.writeFile(file, JSON.stringify(data, null, 2), "utf-8");
}

async function appendJsonl(file: string, event: Record<string, unknown>): Promise<void> {
	await ensureDir(path.dirname(file));
	await fsp.appendFile(file, JSON.stringify({ ts: Date.now(), ...event }) + "\n", "utf-8");
}

function safeArtifactPath(base: string, requested: string): string {
	const clean = requested.replace(/^[/\\]+/, "");
	const target = path.resolve(base, clean);
	const rel = path.relative(base, target);
	if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
		throw new Error(`Artifact path escapes run directory: ${requested}`);
	}
	return target;
}

function parseJsonOutput(text: string): unknown {
	const trimmed = text.trim();
	try { return JSON.parse(trimmed); } catch {}
	const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
	if (fenced) {
		try { return JSON.parse(fenced[1].trim()); } catch {}
	}
	const firstObj = trimmed.indexOf("{");
	const lastObj = trimmed.lastIndexOf("}");
	if (firstObj >= 0 && lastObj > firstObj) {
		try { return JSON.parse(trimmed.slice(firstObj, lastObj + 1)); } catch {}
	}
	const firstArr = trimmed.indexOf("[");
	const lastArr = trimmed.lastIndexOf("]");
	if (firstArr >= 0 && lastArr > firstArr) {
		try { return JSON.parse(trimmed.slice(firstArr, lastArr + 1)); } catch {}
	}
	throw new Error("Agent did not return valid JSON");
}

function workflowSource(entry: RegistryEntry): string {
	if (entry.source) return entry.source;
	return entry.workflow?.run?.toString?.() || entry.name;
}

function summarizeWorkflow(entry: RegistryEntry): string {
	const edit = entry.canEditFiles ? "edits files" : "read-only";
	return `${entry.name} — ${entry.description} (${entry.trust}, ${entry.cost}, ${edit})`;
}

async function bundledEntries(): Promise<RegistryEntry[]> {
	const workflows = [fanOutAndSynthesize, deepVerification];
	return workflows.map((workflow) => {
		const source = `Bundled workflow: ${workflow.name}\n\n${workflow.run.toString()}`;
		return {
			name: workflow.name,
			description: workflow.description,
			trust: "bundled" as const,
			cost: workflow.budget?.estimatedCost || "medium",
			canEditFiles: !!workflow.canEditFiles,
			workflow,
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
		const source = await fsp.readFile(filePath, "utf-8");
		const inferredName = slugify(path.basename(name, path.extname(name)));
		entries.push({
			name: inferredName,
			description: "Project workflow",
			trust: "project",
			cost: "medium",
			canEditFiles: true,
			filePath,
			source,
			sourceHash: hash(source),
		});
	}
	return entries;
}

async function registry(cwd: string): Promise<RegistryEntry[]> {
	return [...await bundledEntries(), ...await projectEntries(cwd)];
}

async function loadWorkflow(entry: RegistryEntry): Promise<WorkflowDefinition> {
	if (entry.workflow) return entry.workflow;
	if (!entry.filePath) throw new Error(`Workflow ${entry.name} has no source path`);
	const mod = await import(`${pathToFileURL(entry.filePath).href}?v=${entry.sourceHash}`);
	const workflow = mod.default || mod.workflow;
	return defineWorkflow(workflow);
}

function approvalPath(cwd: string, entry: RegistryEntry): string {
	return path.join(cwd, APPROVALS_DIR, `${slugify(entry.name)}-${entry.sourceHash.slice(0, 16)}.json`);
}

async function hasApproval(cwd: string, entry: RegistryEntry): Promise<boolean> {
	return fs.existsSync(approvalPath(cwd, entry));
}

async function saveApproval(cwd: string, entry: RegistryEntry): Promise<void> {
	await writeJson(approvalPath(cwd, entry), {
		workflow: entry.name,
		trust: entry.trust,
		sourceHash: entry.sourceHash,
		approvedAt: Date.now(),
	});
}

async function approve(pi: ExtensionAPI, ctx: ExtensionContext, entry: RegistryEntry, args: string): Promise<boolean> {
	if (entry.trust === "bundled" && await hasApproval(ctx.cwd, entry)) return true;
	if (entry.trust === "project" && await hasApproval(ctx.cwd, entry)) return true;

	const plan = [
		`Workflow: ${entry.name}`,
		`Input: ${args || "(none)"}`,
		`Trust: ${entry.trust}`,
		`Cost: ${entry.cost}`,
		`Files: ${entry.canEditFiles ? "may edit" : "read-only"}`,
	].join("\n");

	if (!ctx.hasUI) {
		ctx.ui.notify(`${plan}\n\nApproval required. Run interactively to approve this workflow.`, "warning");
		return false;
	}

	while (true) {
		const choice = await ctx.ui.select(`${plan}\n\nChoose workflow action:`, [
			"Run once",
			"Always allow in this project",
			"View script",
			"Cancel",
		]);
		if (!choice || choice === "Cancel") return false;
		if (choice === "View script") {
			ctx.ui.notify(workflowSource(entry).slice(0, 12000), "info");
			continue;
		}
		if (choice === "Always allow in this project") await saveApproval(ctx.cwd, entry);
		return true;
	}
}

function initialState(runId: string, entry: RegistryEntry, args: string): RunState {
	return {
		runId,
		workflowName: entry.name,
		trust: entry.trust,
		args,
		status: "created",
		startedAt: Date.now(),
		updatedAt: Date.now(),
		agentsStarted: 0,
		agentsCompleted: 0,
		agentsFailed: 0,
		tokens: 0,
		cost: 0,
		steps: {},
		agents: {},
		artifacts: [],
		invalidatedKeys: [],
	};
}

class WorkflowRun {
	private queue = new AsyncQueue();
	private agentConfigs: AgentConfig[];
	private runningAgents = 0;

	constructor(
		private pi: ExtensionAPI,
		private commandCtx: ExtensionContext,
		private entry: RegistryEntry,
		private workflow: WorkflowDefinition,
		private paths: RunPaths,
		private state: RunState,
		private sourceSnapshot: string,
	) {
		this.agentConfigs = loadAgents();
	}

	async initialize(): Promise<void> {
		await ensureDir(this.paths.artifacts);
		await fsp.writeFile(this.paths.source, this.sourceSnapshot, "utf-8");
		await this.persist("run_created", { workflow: this.entry.name, args: this.state.args });
	}

	async execute(): Promise<unknown> {
		this.state.status = "running";
		await this.persist("run_started", {});
		const runtimeCtx = this.buildContext();
		try {
			const result = await this.workflow.run(runtimeCtx as any);
			this.state.status = "completed";
			this.state.completedAt = Date.now();
			this.state.result = result;
			await this.persist("run_completed", { result });
			return result;
		} catch (error: any) {
			if (this.commandCtx.signal?.aborted) {
				this.state.status = "stopped";
				this.state.error = "Workflow stopped by abort signal";
				await this.persist("run_stopped", { error: this.state.error });
			} else {
				this.state.status = "failed";
				this.state.error = error?.message || String(error);
				await this.persist("run_failed", { error: this.state.error });
			}
			throw error;
		} finally {
			this.commandCtx.ui.setStatus?.("workflow", "");
		}
	}

	private buildContext() {
		return {
			runId: this.state.runId,
			args: this.state.args,
			cwd: this.commandCtx.cwd,
			signal: this.commandCtx.signal,
			phase: async <T>(name: string, fn: () => Promise<T> | T): Promise<T> => {
				this.state.currentPhase = name;
				await this.persist("phase_started", { name });
				try {
					const value = await fn();
					await this.persist("phase_completed", { name });
					return value;
				} catch (error: any) {
					await this.persist("phase_failed", { name, error: error?.message || String(error) });
					throw error;
				}
			},
			step: async <T>(key: string, fn: () => Promise<T> | T): Promise<T> => this.step(key, fn),
			agent: async <T>(options: WorkflowAgentOptions): Promise<T> => this.agent(options) as Promise<T>,
			parallel: async <T, R>(items: T[], worker: (item: T, index: number) => Promise<R> | R, options: WorkflowParallelOptions): Promise<R[]> => this.parallel(items, worker, options),
			artifact: async (artifactPath: string, data: unknown): Promise<string> => this.artifact(artifactPath, data),
			log: async (message: string, details?: Record<string, unknown>): Promise<void> => {
				await this.persist("log", { message, details });
			},
			fail: (message: string): never => { throw new Error(message); },
		};
	}

	private async step<T>(key: string, fn: () => Promise<T> | T): Promise<T> {
		this.validateKey(key);
		const existing = this.state.steps[key];
		if (existing?.status === "completed" && !this.state.invalidatedKeys.includes(key)) return existing.result as T;
		this.state.steps[key] = { status: "running", updatedAt: Date.now() };
		await this.persist("step_started", { key });
		try {
			const result = await fn();
			this.state.steps[key] = { status: "completed", result: this.clone(result), updatedAt: Date.now() };
			await this.persist("step_completed", { key, result });
			return result;
		} catch (error: any) {
			this.state.steps[key] = { status: "failed", error: error?.message || String(error), updatedAt: Date.now() };
			await this.persist("step_failed", { key, error: error?.message || String(error) });
			throw error;
		}
	}

	private async agent(options: WorkflowAgentOptions): Promise<unknown> {
		this.validateKey(options.key);
		if (options.worktree) throw new Error("Workflow worktree agents are not implemented in the foreground MVP");
		const existing = this.state.agents[options.key];
		if (existing?.status === "completed" && !this.state.invalidatedKeys.includes(options.key)) return existing.result;

		const maxAgents = this.workflow.budget?.maxAgents ?? DEFAULT_MAX_AGENTS;
		if (this.state.agentsStarted >= maxAgents) throw new Error(`Workflow budget exceeded: maxAgents=${maxAgents}`);

		const agent = this.agentConfigs.find((a) => a.name === options.agent);
		if (!agent) throw new Error(`Unknown subagent '${options.agent}'. Available: ${this.agentConfigs.map((a) => a.name).join(", ") || "none"}`);

		this.state.agentsStarted++;
		this.state.agents[options.key] = { status: "running", agent: options.agent, updatedAt: Date.now() };
		await this.persist("agent_started", { key: options.key, agent: options.agent });
		this.commandCtx.ui.setStatus?.("workflow", `${this.entry.name}: ${this.state.currentPhase || "running"} · ${this.state.agentsCompleted}/${this.state.agentsStarted} agents`);

		try {
			const result = await runSubagent(agent, options.prompt, options.cwd || this.commandCtx.cwd, this.commandCtx.signal, async () => {
				this.commandCtx.ui.setStatus?.("workflow", `${this.entry.name}: ${this.state.currentPhase || "running"} · ${this.state.agentsCompleted}/${this.state.agentsStarted} agents`);
			});
			if (result.exitCode !== 0 || result.progress?.error) {
				throw new Error(result.progress?.error || result.output || `Subagent ${options.agent} failed`);
			}
			const returned = options.output === "json" ? parseJsonOutput(result.output) : result.output;
			this.state.agentsCompleted++;
			this.state.tokens += result.usage.input + result.usage.output;
			this.state.cost += result.usage.cost || 0;
			this.state.agents[options.key] = { status: "completed", agent: options.agent, result: this.clone(returned), raw: result, updatedAt: Date.now() };
			await this.persist("agent_completed", { key: options.key, agent: options.agent, result: returned, usage: result.usage });
			return returned;
		} catch (error: any) {
			this.state.agentsFailed++;
			this.state.agents[options.key] = { status: "failed", agent: options.agent, error: error?.message || String(error), updatedAt: Date.now() };
			await this.persist("agent_failed", { key: options.key, agent: options.agent, error: error?.message || String(error) });
			throw error;
		}
	}

	private async parallel<T, R>(items: T[], worker: (item: T, index: number) => Promise<R> | R, options: WorkflowParallelOptions): Promise<R[]> {
		this.validateKey(options.key);
		const concurrency = Math.max(1, Math.min(options.concurrency || this.workflow.budget?.maxConcurrent || DEFAULT_MAX_CONCURRENT, this.workflow.budget?.maxConcurrent || DEFAULT_MAX_CONCURRENT));
		const results: R[] = new Array(items.length);
		let next = 0;
		let firstError: unknown;
		await this.persist("parallel_started", { key: options.key, count: items.length, concurrency });

		const runWorker = async () => {
			while (next < items.length) {
				if (firstError && options.stopOnError !== false) return;
				const index = next++;
				try {
					results[index] = await worker(items[index], index);
				} catch (error) {
					if (options.stopOnError === false) {
						results[index] = { error: error instanceof Error ? error.message : String(error) } as R;
					} else {
						firstError = error;
						return;
					}
				}
			}
		};

		await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, runWorker));
		if (firstError) {
			await this.persist("parallel_failed", { key: options.key, error: firstError instanceof Error ? firstError.message : String(firstError) });
			throw firstError;
		}
		await this.persist("parallel_completed", { key: options.key, count: items.length });
		return results;
	}

	private async artifact(artifactPath: string, data: unknown): Promise<string> {
		const target = safeArtifactPath(this.paths.artifacts, artifactPath);
		await ensureDir(path.dirname(target));
		const content = typeof data === "string" ? data : JSON.stringify(data, null, 2);
		await fsp.writeFile(target, content, "utf-8");
		const rel = path.relative(this.paths.root, target);
		this.state.artifacts.push(rel);
		await this.persist("artifact_written", { path: rel });
		return rel;
	}

	private async persist(type: string, data: Record<string, unknown>): Promise<void> {
		this.state.updatedAt = Date.now();
		await this.queue.run(async () => {
			await appendJsonl(this.paths.events, { type, ...data });
			await writeJson(this.paths.state, this.state);
		});
	}

	private validateKey(key: string): void {
		if (!key || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(key)) throw new Error(`Invalid durable key: ${key}`);
	}

	private clone<T>(value: T): T {
		if (value === undefined) return value;
		return JSON.parse(JSON.stringify(value));
	}
}

async function createRun(pi: ExtensionAPI, ctx: ExtensionContext, entry: RegistryEntry, workflow: WorkflowDefinition, args: string, previousState?: RunState): Promise<WorkflowRun> {
	const runId = previousState?.runId || nowId(entry.name);
	const paths = runPaths(ctx.cwd, runId);
	const state = previousState || initialState(runId, entry, args);
	const run = new WorkflowRun(pi, ctx, entry, workflow, paths, state, workflowSource(entry));
	if (!previousState) await run.initialize();
	return run;
}

async function readRunState(cwd: string, runId: string): Promise<RunState> {
	const file = runPaths(cwd, runId).state;
	return JSON.parse(await fsp.readFile(file, "utf-8")) as RunState;
}

async function listRunStates(cwd: string): Promise<RunState[]> {
	const base = path.join(cwd, RUNS_DIR);
	if (!fs.existsSync(base)) return [];
	const states: RunState[] = [];
	for (const entry of await fsp.readdir(base)) {
		const stateFile = path.join(base, entry, "state.json");
		if (!fs.existsSync(stateFile)) continue;
		try { states.push(JSON.parse(await fsp.readFile(stateFile, "utf-8")) as RunState); } catch {}
	}
	return states.sort((a, b) => b.updatedAt - a.updatedAt);
}

function formatRunList(states: RunState[]): string {
	if (states.length === 0) return "No workflow runs found.";
	return states.slice(0, 30).map((s) => {
		const phase = s.currentPhase ? ` · phase: ${s.currentPhase}` : "";
		const err = s.error ? ` · error: ${s.error}` : "";
		return `- ${s.runId}\n  ${s.workflowName} · ${s.status}${phase} · agents ${s.agentsCompleted}/${s.agentsStarted} · tokens ${s.tokens}${err}`;
	}).join("\n");
}

function formatRunDetail(s: RunState): string {
	const agentLines = Object.entries(s.agents).map(([key, a]) => `- ${key}: ${a.agent} ${a.status}${a.error ? ` — ${a.error}` : ""}`);
	return [
		`# Workflow Run ${s.runId}`,
		`workflow: ${s.workflowName}`,
		`status: ${s.status}`,
		`args: ${s.args || "(none)"}`,
		s.currentPhase ? `phase: ${s.currentPhase}` : undefined,
		`agents: ${s.agentsCompleted}/${s.agentsStarted} completed, ${s.agentsFailed} failed`,
		`tokens: ${s.tokens}`,
		s.cost ? `cost: $${s.cost.toFixed(4)}` : undefined,
		s.error ? `error: ${s.error}` : undefined,
		s.artifacts.length ? `artifacts:\n${s.artifacts.map((a) => `- ${a}`).join("\n")}` : undefined,
		agentLines.length ? `agents:\n${agentLines.join("\n")}` : undefined,
	].filter(Boolean).join("\n");
}

async function runWorkflow(pi: ExtensionAPI, ctx: ExtensionContext, entry: RegistryEntry, args: string, previousState?: RunState): Promise<void> {
	const workflow = await loadWorkflow(entry);
	const allowed = previousState ? true : await approve(pi, ctx, { ...entry, workflow }, args);
	if (!allowed) return;
	const run = await createRun(pi, ctx, { ...entry, workflow }, workflow, args, previousState);
	ctx.ui.notify(`Started workflow ${entry.name} (${(run as any).state?.runId || previousState?.runId || "new run"})`, "info");
	try {
		const result = await run.execute();
		const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
		pi.sendMessage({ customType: CUSTOM_TYPE, content: text, display: true, details: { workflow: entry.name } });
		ctx.ui.notify(`Workflow completed: ${entry.name}`, "success");
	} catch (error: any) {
		ctx.ui.notify(`Workflow failed: ${error?.message || String(error)}`, "error");
	}
}

async function findEntryForState(cwd: string, state: RunState): Promise<RegistryEntry | undefined> {
	const entries = await registry(cwd);
	return entries.find((e) => e.name === state.workflowName && e.trust === state.trust) || entries.find((e) => e.name === state.workflowName);
}

export default function (pi: ExtensionAPI) {
	pi.registerMessageRenderer(CUSTOM_TYPE, (message: any, options: any, theme: any) => {
		const c = new Container();
		c.addChild(new Text(theme.fg("toolTitle", theme.bold("Workflow result")), 0, 0));
		c.addChild(new Spacer(1));
		c.addChild(new Markdown(String(message.content || ""), 0, 0, getMarkdownTheme()));
		return c;
	});

	pi.registerCommand("workflow", {
		description: "Run a durable foreground workflow, or resume/restart a run",
		getArgumentCompletions: (prefix: string) => {
			const builtins = ["fan-out-and-synthesize", "deep-verification", "resume ", "restart "];
			return builtins.filter((name) => name.startsWith(prefix)).map((value) => ({ value, label: value }));
		},
		handler: async (args, ctx) => {
			const trimmed = (args || "").trim();
			if (trimmed.startsWith("resume ")) {
				const runId = trimmed.slice("resume ".length).trim();
				const state = await readRunState(ctx.cwd, runId);
				const entry = await findEntryForState(ctx.cwd, state);
				if (!entry) { ctx.ui.notify(`Workflow definition not found for run ${runId}`, "error"); return; }
				await runWorkflow(pi, ctx, entry, state.args, state);
				return;
			}
			if (trimmed.startsWith("restart ")) {
				const [, runId, key] = trimmed.match(/^restart\s+(\S+)\s+(\S+)$/) || [];
				if (!runId || !key) { ctx.ui.notify("Usage: /workflow restart <run-id> <durable-key>", "warning"); return; }
				const state = await readRunState(ctx.cwd, runId);
				state.invalidatedKeys = Array.from(new Set([...(state.invalidatedKeys || []), key]));
				if (state.steps[key]) state.steps[key].status = "invalidated";
				if (state.agents[key]) state.agents[key].status = "invalidated";
				await writeJson(runPaths(ctx.cwd, runId).state, state);
				const entry = await findEntryForState(ctx.cwd, state);
				if (!entry) { ctx.ui.notify(`Workflow definition not found for run ${runId}`, "error"); return; }
				await runWorkflow(pi, ctx, entry, state.args, state);
				return;
			}

			const entries = await registry(ctx.cwd);
			if (!trimmed) {
				if (entries.length === 0) { ctx.ui.notify("No workflows found.", "info"); return; }
				if (!ctx.hasUI) { ctx.ui.notify(entries.map(summarizeWorkflow).join("\n"), "info"); return; }
				const choices = entries.map(summarizeWorkflow);
				const choice = await ctx.ui.select("Choose workflow:", choices);
				if (!choice) return;
				const selected = entries[choices.indexOf(choice)];
				await runWorkflow(pi, ctx, selected, "");
				return;
			}

			const [name, ...rest] = trimmed.split(/\s+/);
			const entry = entries.find((e) => e.name === name);
			if (!entry) {
				ctx.ui.notify(`Unknown workflow: ${name}\n\nAvailable:\n${entries.map((e) => `- ${e.name}`).join("\n")}`, "error");
				return;
			}
			await runWorkflow(pi, ctx, entry, rest.join(" "));
		},
	});

	pi.registerCommand("workflows", {
		description: "List workflow runs or inspect one run",
		handler: async (args, ctx) => {
			const id = (args || "").trim();
			if (id) {
				try {
					ctx.ui.notify(formatRunDetail(await readRunState(ctx.cwd, id)), "info");
				} catch (error: any) {
					ctx.ui.notify(`Run not found: ${id}\n${error?.message || String(error)}`, "error");
				}
				return;
			}
			ctx.ui.notify(formatRunList(await listRunStates(ctx.cwd)), "info");
		},
	});
}
