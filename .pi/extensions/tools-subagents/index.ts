/**
 * Minimal subagents extension.
 *
 * Registers a single `subagent` tool with agents such as explorer, worker, default, researcher, and judge.
 * Supports single and parallel execution. Output is verbal only (no file handoff).
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme, parseFrontmatter, truncateHead, withFileMutationQueue, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
import { Container, Input, Markdown, SelectList, Spacer, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	registerSubagentService,
	type AgentConfig,
	type AgentProgress,
	type AgentResult,
	type RunSubagentOptions,
	type RunSubagentsParallelOptions,
	type SubagentProgressEvent,
	type SubagentService,
} from "../_shared/subagent-service.ts";
import {
	appendChildModelArgument,
	appendChildThinkingArgument,
	canonicalMainModel,
	clearAllThinkingAssignments,
	normalizeModelSetting,
	normalizeThinkingLevel,
	parseModelConfiguration,
	removeAgentModelAssignment,
	removeAgentThinkingAssignment,
	resolveLaunchConfiguration,
	selectModelSetting,
	setAgentModelAssignment,
	setAgentThinkingAssignment,
	setAllModelAssignments,
	setAllThinkingAssignments,
	splitModelThinkingSetting,
	THINKING_LEVELS,
	type ModelConfiguration,
	type ResolvedLaunchConfiguration,
	type SubagentThinkingLevel,
} from "./model-config.ts";

export type {
	AgentConfig,
	AgentProgress,
	AgentResult,
	RunSubagentOptions,
	RunSubagentsParallelOptions,
	SubagentProgressEvent,
} from "../_shared/subagent-service.ts";

// ── Types ──────────────────────────────────────────────────────────────

interface ToolEvent {
	tool: string;
	args: string;
}

interface Details {
	mode: "single" | "parallel";
	results: AgentResult[];
}

// ── Config ─────────────────────────────────────────────────────────────

interface ExtensionConfig extends ModelConfiguration {
	maxConcurrency?: number;
}

const EXT_DIR = path.dirname(fileURLToPath(import.meta.url));
const AGENTS_DIR = path.join(EXT_DIR, "agents");
const TOOLS_DIR = path.join(EXT_DIR, "tools");
const CONFIG_PATH = path.join(EXT_DIR, "config.json");
const DEFAULT_MAX_CONCURRENCY = 4;
let activeMainModel: string | undefined;

function readConfigDocument(): Record<string, unknown> {
	if (!fs.existsSync(CONFIG_PATH)) return {};
	try {
		const value = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")) as unknown;
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			throw new Error("the root value must be a JSON object");
		}
		return value as Record<string, unknown>;
	} catch (error) {
		throw new Error(`Cannot read subagent config ${CONFIG_PATH}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function loadConfig(): ExtensionConfig {
	const document = readConfigDocument();
	const modelConfig = parseModelConfiguration(document);
	const maxConcurrency = document.maxConcurrency;
	if (maxConcurrency !== undefined && (!Number.isInteger(maxConcurrency) || (maxConcurrency as number) < 1)) {
		throw new Error("Subagent config maxConcurrency must be a positive integer.");
	}
	return { ...modelConfig, maxConcurrency: maxConcurrency as number | undefined };
}

function rememberMainModel(model: { provider: unknown; id: unknown } | undefined): void {
	activeMainModel = model ? canonicalMainModel(model) : undefined;
}

function resolveLaunch(
	agent: AgentConfig,
	explicitModel?: string,
	explicitThinkingLevel?: SubagentThinkingLevel,
): ResolvedLaunchConfiguration {
	return resolveLaunchConfiguration({
		agentName: agent.name,
		config: readConfigDocument(),
		explicitModel,
		explicitThinkingLevel,
		frontmatterModel: agent.model,
		mainModel: activeMainModel,
	});
}

// Built-in tools that pi provides natively (no extension needed)
const BUILTIN_TOOLS = new Set(["read", "write", "edit", "bash", "grep", "find", "ls"]);

// Custom tools that require loading an extension into the subagent process.
// This extension lives at .pi/extensions/tools-subagents, so sibling extensions are one directory up.
const EXT_BASE = path.dirname(EXT_DIR);
const CUSTOM_TOOL_EXTENSIONS: Record<string, string> = {
	// Use local ddg_* tools to avoid conflicts with separately installed web_search/web_fetch packages.
	ddg_search: path.join(EXT_BASE, "tools-web-search", "index.ts"),
	ddg_fetch: path.join(EXT_BASE, "tools-web-fetch", "index.ts"),
	safe_bash: path.join(TOOLS_DIR, "safe-bash.ts"),
};

// ── Agent Discovery & Registration ────────────────────────────────────

let agents: AgentConfig[] = [];

export function registerAgent(config: AgentConfig): void {
	if (agents.find((a) => a.name === config.name)) {
		throw new Error(`Agent already registered: ${config.name}`);
	}
	agents.push(config);
}

export function unregisterAgent(name: string): void {
	agents = agents.filter((a) => a.name !== name);
}

export function loadAgents(): AgentConfig[] {
	const discovered: AgentConfig[] = [];
	if (!fs.existsSync(AGENTS_DIR)) return [...agents];
	for (const entry of fs.readdirSync(AGENTS_DIR)) {
		if (!entry.endsWith(".md")) continue;
		const filePath = path.join(AGENTS_DIR, entry);
		const content = fs.readFileSync(filePath, "utf-8");
		const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);
		if (!frontmatter.name) continue;
		const tools = (frontmatter.tools || "")
			.split(",")
			.map((t) => t.trim())
			.filter(Boolean);
		discovered.push({
			name: frontmatter.name,
			description: frontmatter.description || "",
			tools,
			model: frontmatter.model?.trim() || "",
			systemPrompt: body,
			filePath,
		});
	}
	const byName = new Map<string, AgentConfig>();
	for (const agent of discovered) byName.set(agent.name, agent);
	for (const agent of agents) byName.set(agent.name, agent);
	return [...byName.values()];
}

// ── Pi Binary Resolution ──────────────────────────────────────────────

function resolvePiBinary(): { command: string; baseArgs: string[] } {
	// Resolve the pi entry point from process.argv[1]
	const entry = process.argv[1];
	if (entry) {
		try {
			const realEntry = fs.realpathSync(entry);
			if (/\.(?:mjs|cjs|js)$/i.test(realEntry)) {
				return { command: process.execPath, baseArgs: [realEntry] };
			}
		} catch {}
	}
	return { command: "pi", baseArgs: [] };
}

// ── Formatting Utilities ──────────────────────────────────────────────

function formatTokens(n: number): string {
	return n < 1000 ? String(n) : n < 10000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n / 1000)}k`;
}

function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
	return `${Math.floor(ms / 60000)}m${Math.floor((ms % 60000) / 1000)}s`;
}

function formatToolPreview(name: string, args: Record<string, unknown>): string {
	switch (name) {
		case "bash":
		case "safe_bash":
			return `$ ${((args.command as string) || "").slice(0, 80)}`;
		case "read":
			return `read ${(args.path as string) || ""}`;
		case "write":
			return `write ${(args.path as string) || ""}`;
		case "edit":
			return `edit ${(args.path as string) || ""}`;
		case "grep":
			return `grep ${(args.pattern as string) || ""}`;
		case "find":
			return `find ${(args.pattern as string) || ""}`;
		case "ls":
			return `ls ${(args.path as string) || "."}`;
		case "ddg_search":
			return `search "${(args.query as string) || ""}"`;
		case "ddg_fetch":
			return `fetch ${(args.url as string) || ""}`;
		default: {
			const s = JSON.stringify(args);
			return `${name} ${s.slice(0, 60)}`;
		}
	}
}

function truncLine(text: string, maxWidth: number): string {
	if (visibleWidth(text) <= maxWidth) return text;
	// Simple truncation - strip to fit
	let result = "";
	let width = 0;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		// Skip ANSI escape sequences
		if (ch === "\x1b") {
			const match = text.slice(i).match(/^\x1b\[[0-9;]*m/);
			if (match) {
				result += match[0];
				i += match[0].length - 1;
				continue;
			}
		}
		if (width >= maxWidth - 1) {
			return result + "…";
		}
		result += ch;
		width++;
	}
	return result;
}

// ── Subagent Execution ────────────────────────────────────────────────

async function buildPiArgs(
	agent: AgentConfig,
	task: string,
	cwd: string,
	launch: ResolvedLaunchConfiguration,
): Promise<{ args: string[]; tempDir: string }> {
	const piBin = resolvePiBinary();
	const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-sub-"));

	// Write system prompt to temp file
	const promptPath = path.join(tempDir, `${agent.name}.md`);
	await withFileMutationQueue(promptPath, async () => {
		await fs.promises.writeFile(promptPath, agent.systemPrompt, { encoding: "utf-8", mode: 0o600 });
	});

	let args = [...piBin.baseArgs, "--mode", "json", "-p", "--no-session", "--no-skills"];

	// Separate builtin tools from custom tools
	const builtinTools: string[] = [];
	const extensionPaths = new Set<string>();

	for (const tool of agent.tools) {
		if (BUILTIN_TOOLS.has(tool)) {
			builtinTools.push(tool);
		} else if (CUSTOM_TOOL_EXTENSIONS[tool]) {
			extensionPaths.add(CUSTOM_TOOL_EXTENSIONS[tool]);
		}
	}

	// Use --no-extensions then add only what we need
	args.push("--no-extensions");

	if (builtinTools.length > 0) {
		args.push("--tools", builtinTools.join(","));
	} else {
		// No builtin tools needed — disable defaults so only extension tools are available
		args.push("--no-tools");
	}

	for (const extPath of extensionPaths) {
		args.push("--extension", extPath);
	}

	args = appendChildModelArgument(args, launch.model);
	args = appendChildThinkingArgument(args, launch.thinkingLevel);
	args.push("--append-system-prompt", promptPath);

	// Handle long tasks by writing to file
	const TASK_LIMIT = 8000;
	if (task.length > TASK_LIMIT) {
		const taskPath = path.join(tempDir, "task.md");
		await withFileMutationQueue(taskPath, async () => {
			await fs.promises.writeFile(taskPath, `Task: ${task}`, { encoding: "utf-8", mode: 0o600 });
		});
		args.push(`@${taskPath}`);
	} else {
		args.push(`Task: ${task}`);
	}

	return { args: [piBin.command, ...args], tempDir };
}

function extractTextFromContent(content: unknown): string {
	if (!content) return "";
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((c: any) => c.type === "text")
			.map((c: any) => c.text)
			.join("\n");
	}
	return "";
}

function extractToolArgsPreview(args: Record<string, unknown>): string {
	if (args.command) return String(args.command).slice(0, 100);
	if (args.path) return String(args.path);
	if (args.query) return `"${String(args.query).slice(0, 80)}"`;
	if (args.url) return String(args.url);
	if (args.pattern) return String(args.pattern);
	const s = JSON.stringify(args);
	return s.length > 80 ? s.slice(0, 80) + "…" : s;
}

function resolveAgentConfig(agent: string | AgentConfig): AgentConfig {
	if (typeof agent !== "string") return agent;
	const availableAgents = loadAgents();
	const found = availableAgents.find((a) => a.name === agent);
	if (!found) throw new Error(`Unknown agent: ${agent}. Available agents: ${availableAgents.map((a) => a.name).join(", ") || "none"}`);
	return found;
}

function withTimeoutSignal(signal: AbortSignal | undefined, timeoutMs: number | undefined): { signal?: AbortSignal; cleanup: () => void } {
	if (!timeoutMs) return { signal, cleanup: () => undefined };
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => controller.abort(new Error(`Subagent timed out after ${timeoutMs}ms`)), timeoutMs);
	const abort = () => controller.abort(signal?.reason);
	if (signal?.aborted) controller.abort(signal.reason);
	else signal?.addEventListener("abort", abort, { once: true });
	return {
		signal: controller.signal,
		cleanup: () => {
			if (timer) clearTimeout(timer);
			timer = undefined;
			signal?.removeEventListener("abort", abort);
		},
	};
}

export async function runSubagent(options: RunSubagentOptions): Promise<AgentResult>;
export async function runSubagent(agent: AgentConfig, task: string, cwd: string, signal?: AbortSignal, onUpdate?: (progress: AgentProgress) => void): Promise<AgentResult>;
export async function runSubagent(
	agentOrOptions: AgentConfig | RunSubagentOptions,
	taskArg?: string,
	cwdArg?: string,
	signalArg?: AbortSignal,
	onUpdateArg?: (progress: AgentProgress) => void,
): Promise<AgentResult> {
	const options: RunSubagentOptions = "cwd" in (agentOrOptions as any)
		? agentOrOptions as RunSubagentOptions
		: { agent: agentOrOptions as AgentConfig, task: taskArg, cwd: cwdArg || process.cwd(), signal: signalArg, onUpdate: onUpdateArg };
	const agent = resolveAgentConfig(options.agent);
	const task = options.task ?? options.prompt ?? "";
	const launch = resolveLaunch(agent, options.model, options.thinkingLevel);
	const { signal, cleanup } = withTimeoutSignal(options.signal, options.timeoutMs);
	await options.onProgress?.({ type: "started", agent: agent.name, task });
	const { args, tempDir } = await buildPiArgs(agent, task, options.cwd, launch);
	const command = args[0];
	const spawnArgs = args.slice(1);

	const result: AgentResult = {
		agent: agent.name,
		task,
		output: "",
		exitCode: 0,
		model: launch.model,
		thinkingLevel: launch.thinkingLevel,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
		progress: {
			agent: agent.name,
			status: "running",
			task,
			recentTools: [],
			toolCount: 0,
			tokens: 0,
			durationMs: 0,
			lastMessage: "",
		},
	};

	const startTime = Date.now();
	const progress = result.progress;
	let lastTool: string | undefined;
	let lastToolArgs: string | undefined;
	let recentToolCount = 0;
	let lastMessage = "";

	const emitProgress = (event: SubagentProgressEvent) => { void options.onProgress?.(event, progress); };
	const fireUpdate = throttle(() => {
		progress.durationMs = Date.now() - startTime;
		options.onUpdate?.(progress);
	}, 150);

	const exitCode = await new Promise<number>((resolve) => {
		const proc = spawn(command, spawnArgs, {
			cwd: options.cwd,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let buf = "";
		let stderrBuf = "";

		const processLine = (line: string) => {
			if (!line.trim()) return;
			try {
				const evt = JSON.parse(line) as any;
				progress.durationMs = Date.now() - startTime;

				if (evt.type === "tool_execution_start") {
					progress.toolCount++;
					progress.currentTool = evt.toolName;
					progress.currentToolArgs = extractToolArgsPreview((evt.args || {}) as Record<string, unknown>);
					if (progress.currentTool && (progress.currentTool !== lastTool || progress.currentToolArgs !== lastToolArgs)) {
						lastTool = progress.currentTool;
						lastToolArgs = progress.currentToolArgs;
						emitProgress({ type: "tool_call", agent: agent.name, tool: progress.currentTool, args: progress.currentToolArgs });
					}
					fireUpdate();
				}

				if (evt.type === "tool_execution_end") {
					if (progress.currentTool) {
						progress.recentTools.push({
							tool: progress.currentTool,
							args: progress.currentToolArgs || "",
						});
						for (const tool of progress.recentTools.slice(recentToolCount)) {
							emitProgress({ type: "tool_result", agent: agent.name, tool: tool.tool, args: tool.args });
						}
						recentToolCount = progress.recentTools.length;
						// Keep last 20
						if (progress.recentTools.length > 20) {
							progress.recentTools.splice(0, progress.recentTools.length - 20);
							recentToolCount = Math.min(recentToolCount, progress.recentTools.length);
						}
					}
					progress.currentTool = undefined;
					progress.currentToolArgs = undefined;
					fireUpdate();
				}

				if (evt.type === "tool_result_end") {
					fireUpdate();
				}

				if (evt.type === "message_end" && evt.message) {
					if (evt.message.role === "assistant") {
						result.usage.turns++;
						const u = evt.message.usage;
						if (u) {
							result.usage.input += u.input || 0;
							result.usage.output += u.output || 0;
							result.usage.cacheRead += u.cacheRead || 0;
							result.usage.cacheWrite += u.cacheWrite || 0;
							result.usage.cost += u.cost?.total || 0;
							progress.tokens = result.usage.input + result.usage.output;
						}
						if (evt.message.model) result.model = evt.message.model;
						if (evt.message.errorMessage) progress.error = evt.message.errorMessage;

						const text = extractTextFromContent(evt.message.content);
						if (text) {
							result.output = text;
							// Extract just the prose "thinking" text — skip code blocks
							const proseLines: string[] = [];
							let inCodeBlock = false;
							for (const line of text.split("\n")) {
								if (line.trimStart().startsWith("```")) {
									inCodeBlock = !inCodeBlock;
									continue;
								}
								if (!inCodeBlock && line.trim()) {
									proseLines.push(line.trim());
								}
							}
							if (proseLines.length > 0) {
								progress.lastMessage = proseLines.slice(0, 3).join(" ");
								if (progress.lastMessage !== lastMessage) {
									lastMessage = progress.lastMessage;
									emitProgress({ type: "message", agent: agent.name, message: lastMessage, tokens: progress.tokens });
								}
							}
						}
					}

					fireUpdate();
				}
			} catch {
				// Non-JSON lines are expected
			}
		};

		proc.stdout.on("data", (d: Buffer) => {
			buf += d.toString();
			const lines = buf.split("\n");
			buf = lines.pop() || "";
			lines.forEach(processLine);
		});

		proc.stderr.on("data", (d: Buffer) => {
			stderrBuf += d.toString();
		});

		proc.on("close", (code) => {
			if (buf.trim()) processLine(buf);
			if (code !== 0 && stderrBuf.trim() && !progress.error) {
				progress.error = stderrBuf.trim();
			}
			resolve(code ?? 1);
		});

		proc.on("error", () => resolve(1));

		if (signal) {
			const kill = () => {
				proc.kill("SIGTERM");
				setTimeout(() => !proc.killed && proc.kill("SIGKILL"), 3000);
			};
			if (signal.aborted) kill();
			else signal.addEventListener("abort", kill, { once: true });
		}
	});

	// Cleanup temp dir and timeout listeners
	cleanup();
	try {
		fs.rmSync(tempDir, { recursive: true, force: true });
	} catch {}

	result.exitCode = exitCode;
	progress.status = exitCode === 0 && !progress.error ? "completed" : "failed";
	progress.durationMs = Date.now() - startTime;
	if (progress.error) result.output = result.output || `Error: ${progress.error}`;

	// Truncate output if very large
	const maxBytes = options.maxOutputBytes ?? DEFAULT_MAX_BYTES;
	result.originalOutputBytes = Buffer.byteLength(result.output, "utf-8");
	if (result.originalOutputBytes > maxBytes) {
		const trunc = truncateHead(result.output, { maxLines: DEFAULT_MAX_LINES, maxBytes });
		result.output = trunc.content;
		if (trunc.truncated) {
			result.output += "\n\n[Output truncated]";
			result.truncated = true;
		}
	}

	if (progress.status === "completed") await options.onProgress?.({ type: "completed", agent: agent.name, result }, progress);
	else await options.onProgress?.({ type: "failed", agent: agent.name, result, error: progress.error || result.output || `Subagent ${agent.name} failed` }, progress);

	return result;
}

// ── Throttle ──────────────────────────────────────────────────────────

function throttle<T extends (...args: any[]) => void>(fn: T, ms: number): T {
	let lastCall = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	return ((...args: any[]) => {
		const now = Date.now();
		const remaining = ms - (now - lastCall);
		if (remaining <= 0) {
			lastCall = now;
			if (timer) { clearTimeout(timer); timer = undefined; }
			fn(...args);
		} else if (!timer) {
			timer = setTimeout(() => {
				lastCall = Date.now();
				timer = undefined;
				fn(...args);
			}, remaining);
		}
	}) as T;
}

// ── Parallel Execution with Concurrency Limit ─────────────────────────

async function mapConcurrent<T, R>(
	items: T[],
	concurrency: number,
	fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let nextIndex = 0;

	async function worker() {
		while (nextIndex < items.length) {
			const i = nextIndex++;
			results[i] = await fn(items[i], i);
		}
	}

	const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
	await Promise.all(workers);
	return results;
}

export async function runSubagentsParallel(options: RunSubagentsParallelOptions): Promise<AgentResult[]> {
	const availableAgents = loadAgents();
	const available = availableAgents.map((a) => a.name).join(", ") || "none";
	const concurrency = Math.max(1, options.maxConcurrency ?? loadConfig().maxConcurrency ?? DEFAULT_MAX_CONCURRENCY);
	return mapConcurrent(options.tasks, concurrency, async (task, index) => {
		const agent = availableAgents.find((a) => a.name === task.agent);
		if (!agent) throw new Error(`Unknown agent: ${task.agent}. Available agents: ${available}`);
		const result = await runSubagent({
			agent,
			task: task.task ?? task.prompt ?? "",
			cwd: task.cwd ?? options.cwd,
			signal: options.signal,
			timeoutMs: options.timeoutMs,
			maxOutputBytes: options.maxOutputBytes,
			model: task.model,
			thinkingLevel: task.thinkingLevel,
			onProgress: (event, progress) => options.onProgress?.(index, event, progress),
		});
		options.onUpdate?.(index, result);
		return result;
	});
}

// ── Rendering ─────────────────────────────────────────────────────────

type Theme = ExtensionContext["ui"]["theme"];
type Component = ReturnType<typeof Text.prototype.render> extends string[] ? Text : any;

function getTermWidth(): number {
	return process.stdout.columns || 120;
}

function renderAgentProgress(
	r: AgentResult,
	theme: Theme,
	expanded: boolean,
	w: number,
): Container {
	const c = new Container();
	const prog = r.progress;
	const isRunning = prog.status === "running";
	const isPending = prog.status === "pending";

	// Header: icon + agent + stats (always one line, truncated)
	const icon = isRunning
		? theme.fg("warning", "⟳")
		: isPending
			? theme.fg("dim", "○")
			: r.exitCode === 0
				? theme.fg("success", "✓")
				: theme.fg("error", "✗");
	const stats = `${prog.toolCount} tools · ${formatTokens(prog.tokens)} tok · ${formatDuration(prog.durationMs)}`;
	const configuration = [r.model, r.thinkingLevel ? `thinking ${r.thinkingLevel}` : undefined].filter(Boolean).join(" · ");
	const configurationStr = configuration ? theme.fg("dim", ` (${configuration})`) : "";
	c.addChild(
		new Text(
			truncLine(`${icon} ${theme.fg("toolTitle", theme.bold(r.agent))}${configurationStr} — ${theme.fg("dim", stats)}`, w),
			0, 0,
		),
	);

	// Task
	if (expanded) {
		// Full task, Text wraps naturally
		c.addChild(new Text(theme.fg("dim", `Task: ${r.task}`), 0, 0));
	} else {
		// Truncate to one line
		const flat = r.task.replace(/\n/g, " ");
		c.addChild(
			new Text(truncLine(theme.fg("dim", `Task: ${flat}`), w), 0, 0),
		);
	}

	// Current tool (running state)
	if (isRunning && prog.currentTool) {
		const toolLine = prog.currentToolArgs
			? `${prog.currentTool}: ${prog.currentToolArgs}`
			: prog.currentTool;
		if (expanded) {
			c.addChild(new Text(theme.fg("warning", `▸ ${toolLine}`), 0, 0));
		} else {
			c.addChild(new Text(truncLine(theme.fg("warning", `▸ ${toolLine}`), w), 0, 0));
		}
	}

	// Recent tools (always all)
	const toolsToShow = prog.recentTools;
	for (const t of toolsToShow) {
		const line = `  ${t.tool}: ${t.args}`;
		if (expanded) {
			c.addChild(new Text(theme.fg("muted", line), 0, 0));
		} else {
			c.addChild(new Text(truncLine(theme.fg("muted", line), w), 0, 0));
		}
	}

	// Latest assistant message — the prose "thinking" text, always visible
	if (prog.lastMessage) {
		c.addChild(new Spacer(1));
		if (expanded) {
			c.addChild(new Text(theme.fg("text", prog.lastMessage), 0, 0));
		} else {
			c.addChild(new Text(truncLine(theme.fg("text", prog.lastMessage), w), 0, 0));
		}
	}

	// Expanded: full final output
	if (!isRunning && r.output && expanded) {
		c.addChild(new Spacer(1));
		const mdTheme = getMarkdownTheme();
		c.addChild(new Markdown(r.output, 0, 0, mdTheme));
	}

	// Usage breakdown
	c.addChild(new Spacer(1));
	const usageParts: string[] = [];
	if (r.usage.turns) usageParts.push(`${r.usage.turns} turn${r.usage.turns > 1 ? "s" : ""}`);
	if (r.usage.input) usageParts.push(`in:${formatTokens(r.usage.input)}`);
	if (r.usage.output) usageParts.push(`out:${formatTokens(r.usage.output)}`);
	if (r.usage.cacheRead) usageParts.push(`cR:${formatTokens(r.usage.cacheRead)}`);
	if (r.usage.cacheWrite) usageParts.push(`cW:${formatTokens(r.usage.cacheWrite)}`);
	if (r.usage.cost) usageParts.push(`$${r.usage.cost.toFixed(4)}`);
	if (usageParts.length) {
		c.addChild(new Text(theme.fg("dim", usageParts.join(" · ")), 0, 0));
	}
	

	// Error
	if (prog.error) {
		if (expanded) {
			c.addChild(new Text(theme.fg("error", `Error: ${prog.error}`), 0, 0));
		} else {
			c.addChild(new Text(truncLine(theme.fg("error", `Error: ${prog.error}`), w), 0, 0));
		}
	}

	return c;
}

// ── Model Command Helpers ─────────────────────────────────────────────

const SUBAGENT_MODEL_USAGE = [
	"Usage:",
	"  /subagents",
	"  /subagents status",
	"  /subagents models",
	"  /subagents model",
	"  /subagents model all <main|provider/model>",
	"  /subagents model <agent> <main|provider/model|inherit>",
	"  /subagents thinking all <default|off|minimal|low|medium|high|xhigh|max>",
	"  /subagents thinking <agent> <inherit|off|minimal|low|medium|high|xhigh|max>",
].join("\n");

function selectedModelSettingForAgent(agent: AgentConfig, config: ModelConfiguration): string {
	return selectModelSetting({
		agentName: agent.name,
		config,
		frontmatterModel: agent.model,
	});
}

function effectiveModelForAgent(agent: AgentConfig, config: ModelConfiguration): { setting: string; resolved: string } {
	const selected = selectedModelSettingForAgent(agent, config);
	const split = splitModelThinkingSetting(selected);
	return {
		setting: split.model,
		resolved: split.model === "main" ? canonicalMainModel(activeMainModel) : split.model,
	};
}

function effectiveThinkingForAgent(agent: AgentConfig, config: ModelConfiguration): SubagentThinkingLevel | undefined {
	if (Object.hasOwn(config.agentThinkingLevels, agent.name)) return config.agentThinkingLevels[agent.name];
	const selected = splitModelThinkingSetting(selectedModelSettingForAgent(agent, config));
	return selected.thinkingLevel ?? config.defaultThinkingLevel;
}

function modelDisplay(setting: string, resolved: string): string {
	return setting === resolved ? resolved : `${setting} → ${resolved}`;
}

function thinkingDisplay(level: SubagentThinkingLevel | undefined): string {
	return level ?? "Pi default";
}

function statusLines(availableAgents: AgentConfig[]): string[] {
	const config = loadConfig();
	const lines = [
		"Subagents status:",
		`Extensions dir: ${EXT_BASE}`,
		`Max concurrency: ${config.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY}`,
		`Main model: ${canonicalMainModel(activeMainModel)}`,
		"",
		"Agents:",
	];
	for (const agent of availableAgents) {
		const missing = agent.tools
			.filter((tool) => !BUILTIN_TOOLS.has(tool) && (!CUSTOM_TOOL_EXTENSIONS[tool] || !fs.existsSync(CUSTOM_TOOL_EXTENSIONS[tool])))
			.map((tool) => `${tool}${CUSTOM_TOOL_EXTENSIONS[tool] ? ` (${CUSTOM_TOOL_EXTENSIONS[tool]})` : " (unmapped)"}`);
		const effective = effectiveModelForAgent(agent, config);
		lines.push(`- ${agent.name}: ${agent.description || "(no description)"}`);
		lines.push(`  model: ${modelDisplay(effective.setting, effective.resolved)}`);
		lines.push(`  thinking: ${thinkingDisplay(effectiveThinkingForAgent(agent, config))}`);
		lines.push(`  tools: ${agent.tools.join(", ") || "none"}`);
		if (missing.length) lines.push(`  missing: ${missing.join(", ")}`);
	}
	return lines;
}

function modelStatusLines(availableAgents: AgentConfig[]): string[] {
	const config = loadConfig();
	const modelOverrides = Object.entries(config.agentModels);
	const thinkingOverrides = Object.entries(config.agentThinkingLevels);
	const lines = [
		"Subagent model and thinking configuration:",
		`Main model: ${canonicalMainModel(activeMainModel)}`,
		`Global model: ${config.defaultModel ?? "(unset; frontmatter/main fallback)"}`,
		`Global thinking: ${thinkingDisplay(config.defaultThinkingLevel)}`,
		"Individual model overrides:",
		...(modelOverrides.length > 0
			? modelOverrides.sort(([left], [right]) => left.localeCompare(right)).map(([name, model]) => `- ${name}: ${model}`)
			: ["- (none)"]),
		"Individual thinking overrides:",
		...(thinkingOverrides.length > 0
			? thinkingOverrides.sort(([left], [right]) => left.localeCompare(right)).map(([name, level]) => `- ${name}: ${level}`)
			: ["- (none)"]),
		"",
		"Effective assignments:",
	];
	for (const agent of availableAgents) {
		const effective = effectiveModelForAgent(agent, config);
		lines.push(`- ${agent.name}: ${modelDisplay(effective.setting, effective.resolved)} · thinking ${thinkingDisplay(effectiveThinkingForAgent(agent, config))}`);
	}
	return lines;
}

function catalogueModelReference(setting: string): string {
	return splitModelThinkingSetting(setting).model;
}

async function validateAvailableModel(setting: string, ctx: ExtensionContext): Promise<boolean> {
	if (setting === "main") return true;
	try {
		await ctx.modelRegistry.refresh({ allowNetwork: false });
	} catch (error) {
		ctx.ui.notify(`Could not refresh Pi's model catalogue: ${error instanceof Error ? error.message : String(error)}`, "error");
		return false;
	}
	const reference = catalogueModelReference(setting);
	const available = ctx.modelRegistry.getAvailable();
	if (available.some((model) => `${model.provider}/${model.id}` === reference)) return true;
	ctx.ui.notify(
		`Unavailable or unauthenticated model: ${reference}\n\n${SUBAGENT_MODEL_USAGE}`,
		"error",
	);
	return false;
}

async function updateConfigDocument(
	update: (document: Record<string, unknown>) => Record<string, unknown>,
): Promise<Record<string, unknown>> {
	return withFileMutationQueue(CONFIG_PATH, async () => {
		const next = update(readConfigDocument());
		parseModelConfiguration(next);
		const temporaryPath = `${CONFIG_PATH}.${process.pid}.${Date.now()}.tmp`;
		try {
			await fs.promises.writeFile(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
			await fs.promises.rename(temporaryPath, CONFIG_PATH);
		} finally {
			await fs.promises.rm(temporaryPath, { force: true }).catch(() => undefined);
		}
		return next;
	});
}

async function applyModelCommand(
	target: string,
	rawValue: string,
	availableAgents: AgentConfig[],
	ctx: ExtensionContext,
): Promise<void> {
	const agent = availableAgents.find((candidate) => candidate.name === target);
	if (target !== "all" && !agent) {
		ctx.ui.notify(`Unknown subagent: ${target}. Available: ${availableAgents.map((item) => item.name).join(", ") || "none"}\n\n${SUBAGENT_MODEL_USAGE}`, "error");
		return;
	}

	const value = rawValue.trim();
	if (value.toLowerCase() === "inherit") {
		if (target === "all") {
			ctx.ui.notify(`"inherit" applies only to an individual agent.\n\n${SUBAGENT_MODEL_USAGE}`, "error");
			return;
		}
		await updateConfigDocument((document) => removeAgentModelAssignment(document, target));
		ctx.ui.notify(`${target} now inherits the global/frontmatter model setting.`, "info");
		return;
	}

	let setting: string;
	try {
		setting = normalizeModelSetting(value, `model for ${target}`);
	} catch (error) {
		ctx.ui.notify(`${error instanceof Error ? error.message : String(error)}\n\n${SUBAGENT_MODEL_USAGE}`, "error");
		return;
	}
	if (!(await validateAvailableModel(setting, ctx))) return;

	if (target === "all") {
		await updateConfigDocument((document) => setAllModelAssignments(document, setting));
		ctx.ui.notify(`All subagents now use ${setting}; individual overrides were cleared.`, "info");
	} else {
		await updateConfigDocument((document) => setAgentModelAssignment(document, target, setting));
		ctx.ui.notify(`${target} now uses ${setting}.`, "info");
	}
}

async function applyThinkingCommand(
	target: string,
	rawValue: string,
	availableAgents: AgentConfig[],
	ctx: ExtensionContext,
): Promise<void> {
	const agent = availableAgents.find((candidate) => candidate.name === target);
	if (target !== "all" && !agent) {
		ctx.ui.notify(`Unknown subagent: ${target}. Available: ${availableAgents.map((item) => item.name).join(", ") || "none"}\n\n${SUBAGENT_MODEL_USAGE}`, "error");
		return;
	}

	const value = rawValue.trim().toLowerCase();
	if (target === "all" && value === "default") {
		await updateConfigDocument(clearAllThinkingAssignments);
		ctx.ui.notify("All subagents now use Pi's default thinking behavior; individual thinking overrides were cleared.", "info");
		return;
	}
	if (target !== "all" && value === "inherit") {
		await updateConfigDocument((document) => removeAgentThinkingAssignment(document, target));
		ctx.ui.notify(`${target} now inherits the global/Pi default thinking level.`, "info");
		return;
	}

	let level: SubagentThinkingLevel;
	try {
		level = normalizeThinkingLevel(value, `thinking level for ${target}`);
	} catch (error) {
		ctx.ui.notify(`${error instanceof Error ? error.message : String(error)}\n\n${SUBAGENT_MODEL_USAGE}`, "error");
		return;
	}

	if (target === "all") {
		await updateConfigDocument((document) => setAllThinkingAssignments(document, level));
		ctx.ui.notify(`All subagents now use ${level} thinking; individual thinking overrides were cleared.`, "info");
	} else {
		await updateConfigDocument((document) => setAgentThinkingAssignment(document, target, level));
		ctx.ui.notify(`${target} now uses ${level} thinking.`, "info");
	}
}

async function applyInteractiveConfiguration(
	target: string,
	rawModel: string,
	rawThinking: string,
	availableAgents: AgentConfig[],
	ctx: ExtensionContext,
): Promise<void> {
	const agent = availableAgents.find((candidate) => candidate.name === target);
	if (target !== "all" && !agent) throw new Error(`Unknown subagent: ${target}`);

	const modelValue = rawModel.trim();
	const inheritModel = modelValue.toLowerCase() === "inherit";
	if (target === "all" && inheritModel) throw new Error('"inherit" applies only to an individual agent model.');
	const modelSetting = inheritModel ? undefined : normalizeModelSetting(modelValue, `model for ${target}`);
	if (modelSetting && !(await validateAvailableModel(modelSetting, ctx))) return;

	const thinkingValue = rawThinking.trim().toLowerCase();
	const clearThinking = target === "all" && thinkingValue === "default";
	const inheritThinking = target !== "all" && thinkingValue === "inherit";
	if (!clearThinking && !inheritThinking) normalizeThinkingLevel(thinkingValue, `thinking level for ${target}`);

	await updateConfigDocument((document) => {
		let next = target === "all"
			? setAllModelAssignments(document, modelSetting!)
			: inheritModel
				? removeAgentModelAssignment(document, target)
				: setAgentModelAssignment(document, target, modelSetting!);

		if (clearThinking) next = clearAllThinkingAssignments(next);
		else if (inheritThinking) next = removeAgentThinkingAssignment(next, target);
		else if (target === "all") next = setAllThinkingAssignments(next, thinkingValue);
		else next = setAgentThinkingAssignment(next, target, thinkingValue);
		return next;
	});

	const modelNote = inheritModel ? "inherited model" : modelSetting;
	const thinkingNote = clearThinking ? "Pi default thinking" : inheritThinking ? "inherited thinking" : `${thinkingValue} thinking`;
	ctx.ui.notify(
		target === "all"
			? `All subagents now use ${modelNote} with ${thinkingNote}; individual overrides were cleared.`
			: `${target} now uses ${modelNote} with ${thinkingNote}.`,
		"info",
	);
}

function modelKey(model: Pick<Model<Api>, "provider" | "id">): string {
	return `${model.provider}/${model.id}`;
}

function formatContextWindow(tokens: number): string {
	if (tokens >= 1_000_000) {
		const millions = tokens / 1_000_000;
		return `${Number.isInteger(millions) ? millions.toFixed(0) : millions.toFixed(2)}M context`;
	}
	if (tokens >= 1_000) {
		const thousands = tokens / 1_000;
		return `${Number.isInteger(thousands) ? thousands.toFixed(0) : thousands.toFixed(1)}K context`;
	}
	return `${tokens} context`;
}

function availableModelCatalogue(ctx: ExtensionContext): Model<Api>[] {
	const models = ctx.scopedModels.length > 0
		? ctx.scopedModels.map((entry) =>
			ctx.modelRegistry.find(entry.model.provider, entry.model.id) ?? entry.model)
		: ctx.modelRegistry.getAvailable();
	const unique = new Map<string, Model<Api>>();
	for (const model of models) unique.set(modelKey(model), model);
	return [...unique.values()].sort((left, right) => modelKey(left).localeCompare(modelKey(right)));
}

async function selectSubagentTarget(
	availableAgents: AgentConfig[],
	ctx: ExtensionContext,
): Promise<string | undefined> {
	const config = loadConfig();
	const defaultSelection = config.defaultModel
		? splitModelThinkingSetting(config.defaultModel)
		: undefined;
	const defaultModel = defaultSelection
		? modelDisplay(defaultSelection.model, defaultSelection.model === "main" ? canonicalMainModel(activeMainModel) : defaultSelection.model)
		: "(unset; per-agent fallback)";
	const defaultThinking = defaultSelection?.thinkingLevel ?? config.defaultThinkingLevel;
	const items = [
		{
			value: "all",
			label: "All subagents",
			description: `${defaultModel} · thinking ${thinkingDisplay(defaultThinking)} · clears individual overrides`,
		},
		...availableAgents.map((agent) => {
			const effective = effectiveModelForAgent(agent, config);
			return {
				value: agent.name,
				label: agent.name,
				description: `${modelDisplay(effective.setting, effective.resolved)} · thinking ${thinkingDisplay(effectiveThinkingForAgent(agent, config))}`,
			};
		}),
	];

	return ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
		const list = new SelectList(items, Math.min(Math.max(items.length, 1), 12), {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("warning", text),
		}, { minPrimaryColumnWidth: 18, maxPrimaryColumnWidth: 28 });
		list.onSelect = (item) => done(item.value);
		list.onCancel = () => done(undefined);

		return {
			render(width: number) {
				const border = theme.fg("accent", "─".repeat(Math.max(0, width)));
				return [
					border,
					truncateToWidth(theme.fg("accent", theme.bold("Subagent Configuration")), width),
					truncateToWidth(theme.fg("dim", "Choose all subagents or one agent to change model and thinking"), width),
					"",
					...list.render(width),
					"",
					truncateToWidth(theme.fg("dim", "↑↓ navigate · Enter select · Esc close"), width),
					border,
				];
			},
			invalidate() {
				list.invalidate();
			},
			handleInput(data: string) {
				list.handleInput(data);
				tui.requestRender();
			},
		};
	});
}

interface ModelPickerChoice {
	value: string;
	label: string;
	description: string;
	searchText: string;
}

function filterModelChoices(choices: readonly ModelPickerChoice[], query: string): ModelPickerChoice[] {
	const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
	if (terms.length === 0) return [...choices];
	return choices.filter((choice) => {
		const searchable = `${choice.label} ${choice.description} ${choice.searchText}`.toLowerCase();
		return terms.every((term) => searchable.includes(term));
	});
}

async function selectSubagentModel(
	target: string,
	availableAgents: AgentConfig[],
	models: readonly Model<Api>[],
	ctx: ExtensionContext,
): Promise<string | undefined> {
	const config = loadConfig();
	const agent = target === "all" ? undefined : availableAgents.find((candidate) => candidate.name === target);
	if (target !== "all" && !agent) throw new Error(`Unknown subagent: ${target}`);

	const hasOverride = target !== "all" && Object.hasOwn(config.agentModels, target);
	const currentValue = target === "all"
		? config.defaultModel ?? "main"
		: hasOverride
			? config.agentModels[target]!
			: "inherit";
	const currentModelValue = currentValue === "inherit"
		? currentValue
		: splitModelThinkingSetting(currentValue).model;
	const mainModel = canonicalMainModel(activeMainModel);
	const choices: ModelPickerChoice[] = [];

	if (agent) {
		const inheritedAgentModels = { ...config.agentModels };
		delete inheritedAgentModels[target];
		const inherited = effectiveModelForAgent(agent, { ...config, agentModels: inheritedAgentModels });
		choices.push({
			value: "inherit",
			label: `${currentValue === "inherit" ? "●" : "○"} Inherit global/frontmatter setting`,
			description: `Uses ${modelDisplay(inherited.setting, inherited.resolved)}`,
			searchText: "inherit default global frontmatter",
		});
	}

	choices.push({
		value: "main",
		label: `${currentModelValue === "main" ? "●" : "○"} Main session model`,
		description: `${mainModel} · follows future /model changes`,
		searchText: `main default ${mainModel}`,
	});

	const configuredReference = currentModelValue === "main" || currentModelValue === "inherit"
		? undefined
		: currentModelValue;
	for (const model of models) {
		const reference = modelKey(model);
		const isCurrent = reference === configuredReference;
		choices.push({
			value: reference,
			label: `${isCurrent ? "●" : "○"} ${reference}`,
			description: `${model.name} · ${formatContextWindow(model.contextWindow)} · ${model.reasoning ? "thinking" : "no thinking"}${isCurrent && currentValue !== reference ? ` · configured as ${currentValue}` : ""}`,
			searchText: `${reference} ${model.name}`,
		});
	}

	return ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) => {
		const search = new Input();
		let list: SelectList;

		const rebuildList = () => {
			const filtered = filterModelChoices(choices, search.getValue());
			list = new SelectList(
				filtered.map((choice) => ({
					value: choice.value,
					label: choice.label,
					description: choice.description,
				})),
				Math.min(Math.max(filtered.length, 1), 12),
				{
					selectedPrefix: (text) => theme.fg("accent", text),
					selectedText: (text) => theme.fg("accent", text),
					description: (text) => theme.fg("muted", text),
					scrollInfo: (text) => theme.fg("dim", text),
					noMatch: (text) => theme.fg("warning", text),
				},
				{ minPrimaryColumnWidth: 30, maxPrimaryColumnWidth: 52 },
			);
			list.onSelect = (item) => done(item.value);
			list.onCancel = () => done(undefined);
			if (!search.getValue()) {
				const currentIndex = filtered.findIndex((choice) => choice.value === currentModelValue);
				if (currentIndex >= 0) list.setSelectedIndex(currentIndex);
			}
		};

		rebuildList();

		return {
			get focused() {
				return search.focused;
			},
			set focused(value: boolean) {
				search.focused = value;
			},
			render(width: number) {
				const border = theme.fg("accent", "─".repeat(Math.max(0, width)));
				return [
					border,
					truncateToWidth(theme.fg("accent", theme.bold(`Model for ${target === "all" ? "all subagents" : target}`)), width),
					...search.render(width),
					"",
					...list.render(width),
					"",
					truncateToWidth(theme.fg("dim", "Type to filter · ↑↓ navigate · Enter next · Esc back"), width),
					border,
				];
			},
			invalidate() {
				search.invalidate();
				list.invalidate();
			},
			handleInput(data: string) {
				if (
					keybindings.matches(data, "tui.select.up") ||
					keybindings.matches(data, "tui.select.down") ||
					keybindings.matches(data, "tui.select.confirm") ||
					keybindings.matches(data, "tui.select.cancel")
				) {
					list.handleInput(data);
				} else {
					const before = search.getValue();
					search.handleInput(data);
					if (search.getValue() !== before) rebuildList();
				}
				tui.requestRender();
			},
		};
	});
}

const THINKING_DESCRIPTIONS: Record<SubagentThinkingLevel, string> = {
	off: "No extended thinking",
	minimal: "Fastest reasoning",
	low: "Light reasoning",
	medium: "Balanced reasoning",
	high: "Deep reasoning",
	xhigh: "Extra-high reasoning",
	max: "Maximum reasoning",
};

function modelSettingAfterChoice(
	target: string,
	choice: string,
	agent: AgentConfig | undefined,
	config: ModelConfiguration,
): string {
	if (choice !== "inherit") return choice;
	if (!agent || target === "all") throw new Error('"inherit" requires an individual subagent.');
	const inheritedAgentModels = { ...config.agentModels };
	delete inheritedAgentModels[target];
	return selectModelSetting({
		agentName: agent.name,
		config: { ...config, agentModels: inheritedAgentModels },
		frontmatterModel: agent.model,
	});
}

function findCatalogueModel(
	setting: string,
	models: readonly Model<Api>[],
	ctx: ExtensionContext,
): Model<Api> | undefined {
	const selected = splitModelThinkingSetting(setting).model;
	const reference = selected === "main" ? canonicalMainModel(activeMainModel) : selected;
	const listed = models.find((model) => modelKey(model) === reference);
	if (listed) return listed;
	const slash = reference.indexOf("/");
	return slash > 0
		? ctx.modelRegistry.find(reference.slice(0, slash), reference.slice(slash + 1))
		: undefined;
}

async function selectSubagentThinking(
	target: string,
	modelChoice: string,
	availableAgents: AgentConfig[],
	models: readonly Model<Api>[],
	ctx: ExtensionContext,
): Promise<string | undefined> {
	const config = loadConfig();
	const agent = target === "all" ? undefined : availableAgents.find((candidate) => candidate.name === target);
	if (target !== "all" && !agent) throw new Error(`Unknown subagent: ${target}`);

	const pendingModelSetting = modelSettingAfterChoice(target, modelChoice, agent, config);
	const catalogueModel = findCatalogueModel(pendingModelSetting, models, ctx);
	const supported = catalogueModel
		? getSupportedThinkingLevels(catalogueModel).map((level) => normalizeThinkingLevel(level))
		: [...THINKING_LEVELS];

	const currentModelSetting = target === "all"
		? config.defaultModel ?? "main"
		: selectedModelSettingForAgent(agent!, config);
	const pendingModel = splitModelThinkingSetting(pendingModelSetting).model;
	const currentModel = splitModelThinkingSetting(currentModelSetting);
	const sameModel = currentModel.model === pendingModel;
	const currentValue = target === "all"
		? sameModel && currentModel.thinkingLevel
			? currentModel.thinkingLevel
			: config.defaultThinkingLevel ?? "default"
		: Object.hasOwn(config.agentThinkingLevels, target)
			? config.agentThinkingLevels[target]!
			: sameModel && currentModel.thinkingLevel
				? currentModel.thinkingLevel
				: "inherit";

	const items: Array<{ value: string; label: string; description: string }> = [];
	if (target === "all") {
		items.push({
			value: "default",
			label: `${currentValue === "default" ? "●" : "○"} Pi default`,
			description: "Do not pass a --thinking override to child Pi processes",
		});
	} else {
		const inheritedAgentThinking = { ...config.agentThinkingLevels };
		delete inheritedAgentThinking[target];
		const inheritedConfig = { ...config, agentThinkingLevels: inheritedAgentThinking };
		const inheritedModelSetting = modelSettingAfterChoice(target, modelChoice, agent, inheritedConfig);
		const inheritedSplit = splitModelThinkingSetting(inheritedModelSetting);
		const inheritedLevel = inheritedSplit.thinkingLevel ?? inheritedConfig.defaultThinkingLevel;
		items.push({
			value: "inherit",
			label: `${currentValue === "inherit" ? "●" : "○"} Inherit global/Pi default`,
			description: `Uses ${thinkingDisplay(inheritedLevel)}`,
		});
	}

	for (const level of supported) {
		items.push({
			value: level,
			label: `${currentValue === level ? "●" : "○"} ${level}`,
			description: THINKING_DESCRIPTIONS[level],
		});
	}

	return ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
		const list = new SelectList(items, Math.min(Math.max(items.length, 1), 10), {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("warning", text),
		}, { minPrimaryColumnWidth: 24, maxPrimaryColumnWidth: 36 });
		list.onSelect = (item) => done(item.value);
		list.onCancel = () => done(undefined);
		const currentIndex = items.findIndex((item) => item.value === currentValue);
		if (currentIndex >= 0) list.setSelectedIndex(currentIndex);

		return {
			render(width: number) {
				const border = theme.fg("accent", "─".repeat(Math.max(0, width)));
				const modelLabel = splitModelThinkingSetting(pendingModelSetting).model;
				return [
					border,
					truncateToWidth(theme.fg("accent", theme.bold(`Thinking for ${target === "all" ? "all subagents" : target}`)), width),
					truncateToWidth(theme.fg("dim", `Model: ${modelLabel}`), width),
					"",
					...list.render(width),
					"",
					truncateToWidth(theme.fg("dim", "↑↓ navigate · Enter apply · Esc back"), width),
					border,
				];
			},
			invalidate() {
				list.invalidate();
			},
			handleInput(data: string) {
				list.handleInput(data);
				tui.requestRender();
			},
		};
	});
}

async function runInteractiveModelCommand(availableAgents: AgentConfig[], ctx: ExtensionContext): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify(`Interactive subagent model configuration requires TUI mode.\n\n${SUBAGENT_MODEL_USAGE}`, "error");
		return;
	}
	try {
		await ctx.modelRegistry.refresh({ allowNetwork: false });
	} catch (error) {
		ctx.ui.notify(`Could not refresh Pi's model catalogue: ${error instanceof Error ? error.message : String(error)}`, "error");
		return;
	}
	const models = availableModelCatalogue(ctx);

	while (true) {
		const target = await selectSubagentTarget(availableAgents, ctx);
		if (!target) return;
		const model = await selectSubagentModel(target, availableAgents, models, ctx);
		if (model === undefined) continue;
		const thinking = await selectSubagentThinking(target, model, availableAgents, models, ctx);
		if (thinking === undefined) continue;
		await applyInteractiveConfiguration(target, model, thinking, availableAgents, ctx);
	}
}

// ── Extension ─────────────────────────────────────────────────────────

const service: SubagentService = {
	id: "tools-subagents",
	registerAgent,
	unregisterAgent,
	loadAgents,
	runSubagent: (options) => runSubagent(options),
	runSubagentsParallel,
};

export default function (pi: ExtensionAPI) {
	registerSubagentService(service);
	const config = loadConfig();
	const maxConcurrency = config.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
	agents = loadAgents();

	pi.on("session_start", (_event, ctx) => rememberMainModel(ctx.model));
	pi.on("model_select", (event) => rememberMainModel(event.model));

	pi.registerCommand("subagents", {
		description: "View and configure subagent models and thinking levels",
		getArgumentCompletions: (prefix) => {
			const agentCommands = loadAgents().flatMap((agent) => [
				`model ${agent.name} main`,
				`thinking ${agent.name} inherit`,
			]);
			const values = ["status", "models", "model", "model all main", "thinking all default", "thinking all medium", ...agentCommands];
			const matches = values.filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value }));
			return matches.length > 0 ? matches : null;
		},
		handler: async (args, ctx) => {
			rememberMainModel(ctx.model);
			agents = loadAgents();
			const parts = args.trim().split(/\s+/).filter(Boolean);
			try {
				if (parts.length === 0) {
					if (ctx.mode === "tui") await runInteractiveModelCommand(agents, ctx);
					else ctx.ui.notify(statusLines(agents).join("\n"), "info");
					return;
				}
				if (parts.length === 1 && parts[0] === "status") {
					ctx.ui.notify(statusLines(agents).join("\n"), "info");
					return;
				}
				if (parts.length === 1 && parts[0] === "models") {
					ctx.ui.notify(modelStatusLines(agents).join("\n"), "info");
					return;
				}
				if (parts[0] === "model") {
					if (parts.length === 1) {
						await runInteractiveModelCommand(agents, ctx);
						return;
					}
					if (parts.length === 3) {
						await applyModelCommand(parts[1]!, parts[2]!, agents, ctx);
						return;
					}
				}
				if (parts[0] === "thinking" && parts.length === 3) {
					await applyThinkingCommand(parts[1]!, parts[2]!, agents, ctx);
					return;
				}
				ctx.ui.notify(SUBAGENT_MODEL_USAGE, "error");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description:
			"Run a subagent to complete a task. Subagents have NO context from the current conversation — include all necessary context in the task description.",
		promptSnippet: "Run subagents for delegated tasks",
		promptGuidelines: [
			"Parallel tool calls are your primary parallelism mechanism — put multiple independent read/fetch/search calls in one function_calls block. Don't use subagents to parallelize simple I/O.",
			"Use subagent to delegate only when it materially improves progress: explorer for read-only codebase investigation, worker for bounded implementation or verification, default for small general tasks, researcher for web research.",
			"For multiple independent subagent tasks, use parallel mode with tasks[] array",
			"Subagents have NO context from the current conversation — include ALL necessary context in the task description",
		],
		parameters: Type.Object({
			agent: Type.Optional(
				Type.String({ description: "Name of the agent to invoke (SINGLE mode)" }),
			),
			task: Type.Optional(Type.String({ description: "Task description (SINGLE mode)" })),
			tasks: Type.Optional(
				Type.Array(
					Type.Object({
						agent: Type.String({ description: "Name of the agent to invoke" }),
						task: Type.String({ description: "Task description" }),
						cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
					}),
					{ description: "PARALLEL mode: array of {agent, task} objects" },
				),
			),
			cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
		}),

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const cwd = ctx.cwd;
			rememberMainModel(ctx.model);
			agents = loadAgents();

			// Validate mode
			if (params.tasks && params.tasks.length > 0) {
				// ── Parallel mode ──
				const taskList = params.tasks;

				// Validate all agents
				const available = agents.map((a) => a.name).join(", ") || "none";
				for (const t of taskList) {
					if (!agents.find((a) => a.name === t.agent)) {
						throw new Error(`Unknown agent: ${t.agent}. Available agents: ${available}`);
					}
				}

				const allResults: AgentResult[] = [];

				// Initialize all result slots as pending
				for (let i = 0; i < taskList.length; i++) {
					allResults[i] = {
						agent: taskList[i].agent,
						task: taskList[i].task,
						output: "",
						exitCode: -1,
						model: undefined,
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
						progress: { agent: taskList[i].agent, status: "pending" as any, task: taskList[i].task, recentTools: [], toolCount: 0, tokens: 0, durationMs: 0, lastMessage: "" },
					};
				}

				const flushParallelUpdate = () => {
					onUpdate?.({
						content: [{ type: "text", text: `Running ${taskList.length} tasks...` }],
						details: {
							mode: "parallel" as const,
							results: [...allResults],
						},
					});
				};
				const fireParallelUpdate = throttle(flushParallelUpdate, 150);

				const results = await mapConcurrent(taskList, maxConcurrency, async (t, idx) => {
					const agent = agents.find((a) => a.name === t.agent)!;
					const launch = resolveLaunch(agent);
					allResults[idx].model = launch.model;
					allResults[idx].thinkingLevel = launch.thinkingLevel;
					allResults[idx].progress.status = "running";
					flushParallelUpdate();
					const result = await runSubagent({
						agent,
						task: t.task,
						cwd: t.cwd ?? cwd,
						signal,
						onUpdate: (progress) => {
							allResults[idx].progress = progress;
							fireParallelUpdate();
						},
					});

					// Update allResults with the completed result so the UI reflects it immediately
					allResults[idx] = result;
					flushParallelUpdate();

					return result;
				});

				// Build final output text
				const outputParts = results.map((r) => {
					const header = `## ${r.agent}${r.exitCode !== 0 ? " (FAILED)" : ""}`;
					return `${header}\n\n${r.output || "(no output)"}`;
				});

				return {
					content: [{ type: "text", text: outputParts.join("\n\n---\n\n") }],
					details: { mode: "parallel" as const, results },
				};
			} else if (params.agent && params.task) {
				// ── Single mode ──
				const agent = agents.find((a) => a.name === params.agent);
				if (!agent) {
					const available = agents.map((a) => a.name).join(", ") || "none";
					throw new Error(`Unknown agent: ${params.agent}. Available agents: ${available}`);
				}

				const launch = resolveLaunch(agent);
				const liveResult: AgentResult = {
					agent: params.agent!,
					task: params.task!,
					output: "",
					exitCode: -1,
					model: launch.model,
					thinkingLevel: launch.thinkingLevel,
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
					progress: { agent: params.agent!, status: "running" as const, task: params.task!, recentTools: [], toolCount: 0, tokens: 0, durationMs: 0, lastMessage: "" },
				};
				const result = await runSubagent({
					agent,
					task: params.task,
					cwd: params.cwd ?? cwd,
					signal,
					onUpdate: (progress) => {
						liveResult.progress = progress;
						onUpdate?.({
							content: [{ type: "text", text: "(running...)" }],
							details: { mode: "single" as const, results: [liveResult] },
						});
					},
				});

				const isError = result.exitCode !== 0 || !!result.progress.error;
				return {
					content: [{ type: "text", text: result.output || "(no output)" }],
					details: { mode: "single" as const, results: [result] },
					...(isError ? { isError: true } : {}),
				};
			} else {
				throw new Error("Provide either (agent + task) for single mode, or tasks[] for parallel mode.");
			}
		},

		// ── Render: tool call header ──
		renderCall(args, theme, _context) {
			if (args.tasks && args.tasks.length > 0) {
				const agentNames = args.tasks.map((t: any) => t.agent).join(", ");
				return new Text(
					`${theme.fg("toolTitle", theme.bold("subagent"))} ${theme.fg("accent", "parallel")} ${theme.fg("dim", `(${args.tasks.length} tasks: ${agentNames})`)}`,
					0, 0,
				);
			}
			if (args.agent) {
				const taskPreview = args.task
					? (args.task.length > 60 ? args.task.slice(0, 60) + "…" : args.task).replace(/\n/g, " ")
					: "";
				return new Text(
					`${theme.fg("toolTitle", theme.bold("subagent"))} ${theme.fg("accent", args.agent)} ${theme.fg("dim", taskPreview)}`,
					0, 0,
				);
			}
			return new Text(theme.fg("toolTitle", theme.bold("subagent")), 0, 0);
		},

		// ── Render: result ──
		renderResult(result, options, theme, context) {
			const details = result.details as Details | undefined;
			if (!details?.results?.length) {
				const t = result.content[0];
				const text = t?.type === "text" ? t.text : "(no output)";
				return new Text(text.slice(0, 200), 0, 0);
			}

			const w = getTermWidth() - 4;
			const expanded = options.expanded;
			const c = new Container();

			if (details.mode === "parallel") {
				// Parallel summary header
				const ok = details.results.filter((r) => r.exitCode === 0).length;
				const running = details.results.filter((r) => r.progress?.status === "running").length;
				const totalIcon = running > 0
					? theme.fg("warning", "⟳")
					: ok === details.results.length
						? theme.fg("success", "✓")
						: theme.fg("error", "✗");

				const totalDuration = Math.max(...details.results.map((r) => r.progress?.durationMs || 0));
				const totalTokens = details.results.reduce((s, r) => s + (r.progress?.tokens || 0), 0);
				c.addChild(
					new Text(
						truncLine(
							`${totalIcon} ${theme.fg("toolTitle", theme.bold("parallel"))} ${ok}/${details.results.length} completed · ${formatTokens(totalTokens)} tok · ${formatDuration(totalDuration)}`,
							w,
						),
						0, 0,
					),
				);
				c.addChild(new Spacer(1));

				for (let i = 0; i < details.results.length; i++) {
					const r = details.results[i];
					c.addChild(renderAgentProgress(r, theme, expanded, w));
					if (i < details.results.length - 1) c.addChild(new Spacer(1));
				}
			} else {
				// Single agent
				const r = details.results[0];
				c.addChild(renderAgentProgress(r, theme, expanded, w));
			}

			return c;
		},
	});
}
