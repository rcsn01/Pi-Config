import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { truncateHead, withFileMutationQueue, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
import type {
	AgentConfig,
	AgentProgress,
	AgentResult,
	RunSubagentOptions,
	SubagentProgressEvent,
} from "../_shared/subagent-service.ts";
import { agentRegistry, type AgentRegistry } from "./agent-registry.ts";
import {
	appendChildModelArgument,
	appendChildThinkingArgument,
	subagentConfig,
	type ResolvedLaunchConfiguration,
	type SubagentConfigStore,
} from "./config.ts";
import { deriveSubagentSessionId } from "./cache-affinity.ts";
import { formatToolArgsPreview } from "./formatting.ts";

const EXT_DIR = path.dirname(fileURLToPath(import.meta.url));
const TOOLS_DIR = path.join(EXT_DIR, "tools");
export const BUILTIN_TOOLS = new Set(["read", "write", "edit", "bash", "grep", "find", "ls"]);
export const EXT_BASE = path.dirname(EXT_DIR);
export const CUSTOM_TOOL_EXTENSIONS: Record<string, string> = {
	ddg_search: path.join(EXT_BASE, "tools-web-search", "index.ts"),
	ddg_fetch: path.join(EXT_BASE, "tools-web-fetch", "index.ts"),
	safe_bash: path.join(TOOLS_DIR, "safe-bash.ts"),
	repo_query: path.join(TOOLS_DIR, "repo-query.ts"),
};

export type SpawnSubagentProcess = (
	command: string,
	args: string[],
	options: { cwd: string; stdio: ["ignore", "pipe", "pipe"] },
) => ChildProcessWithoutNullStreams;

export interface SubagentRunnerDependencies {
	registry?: AgentRegistry;
	config?: SubagentConfigStore;
	spawnProcess?: SpawnSubagentProcess;
}

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


async function buildPiArgs(
	agent: AgentConfig,
	task: string,
	cwd: string,
	launch: ResolvedLaunchConfiguration,
	sessionId?: string,
): Promise<{ args: string[]; tempDir: string }> {
	const piBin = resolvePiBinary();
	const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-sub-"));

	// Write system prompt to temp file
	const promptPath = path.join(tempDir, `${agent.name}.md`);
	await withFileMutationQueue(promptPath, async () => {
		await fs.promises.writeFile(promptPath, agent.systemPrompt, { encoding: "utf-8", mode: 0o600 });
	});

	let args = [...piBin.baseArgs, "--mode", "json", "-p", "--no-session", "--no-skills"];
	if (sessionId) args.push("--session-id", sessionId);

	// Separate the requested tool names from the extensions that provide custom tools.
	// Pi's --tools allowlist applies to built-in and custom tools alike.
	const enabledTools: string[] = [];
	const extensionPaths = new Set<string>();

	for (const tool of agent.tools) {
		if (BUILTIN_TOOLS.has(tool)) {
			enabledTools.push(tool);
		} else if (CUSTOM_TOOL_EXTENSIONS[tool]) {
			enabledTools.push(tool);
			extensionPaths.add(CUSTOM_TOOL_EXTENSIONS[tool]);
		}
	}

	// Use --no-extensions then add only what we need
	args.push("--no-extensions");

	if (enabledTools.length > 0) {
		args.push("--tools", enabledTools.join(","));
	} else {
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

async function executeSubagent(
	agentOrOptions: AgentConfig | RunSubagentOptions,
	taskArg?: string,
	cwdArg?: string,
	signalArg?: AbortSignal,
	onUpdateArg?: (progress: AgentProgress) => void,
	dependencies: SubagentRunnerDependencies = {},
): Promise<AgentResult> {
	const options: RunSubagentOptions = "cwd" in (agentOrOptions as any)
		? agentOrOptions as RunSubagentOptions
		: { agent: agentOrOptions as AgentConfig, task: taskArg, cwd: cwdArg || process.cwd(), signal: signalArg, onUpdate: onUpdateArg };
	const registry = dependencies.registry ?? agentRegistry;
	const config = dependencies.config ?? subagentConfig;
	const agent = registry.resolve(options.agent);
	const task = options.task ?? options.prompt ?? "";
	const launch = config.resolveLaunch(agent, options.model, options.thinkingLevel);
	const { signal, cleanup } = withTimeoutSignal(options.signal, options.timeoutMs);
	await options.onProgress?.({ type: "started", agent: agent.name, task });
	const cacheSessionId = options.cacheAffinitySeed
		? deriveSubagentSessionId(options.cacheAffinitySeed, launch.model)
		: undefined;
	const { args, tempDir } = await buildPiArgs(agent, task, options.cwd, launch, cacheSessionId);
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
	let streamedText = "";

	const recordAssistantText = (content: unknown) => {
		const text = extractTextFromContent(content);
		if (!text) return;
		result.output = text;
		// Extract just the prose "thinking" text — skip code blocks
		const proseLines: string[] = [];
		let inCodeBlock = false;
		for (const line of text.split("\n")) {
			if (line.trimStart().startsWith("```")) {
				inCodeBlock = !inCodeBlock;
				continue;
			}
			if (!inCodeBlock && line.trim()) proseLines.push(line.trim());
		}
		if (proseLines.length > 0) {
			progress.lastMessage = proseLines.slice(0, 3).join(" ");
			if (progress.lastMessage !== lastMessage) {
				lastMessage = progress.lastMessage;
				emitProgress({ type: "message", agent: agent.name, message: lastMessage, tokens: progress.tokens });
			}
		}
	};

	const emitProgress = (event: SubagentProgressEvent) => { void options.onProgress?.(event, progress); };
	const fireUpdate = throttle(() => {
		progress.durationMs = Date.now() - startTime;
		options.onUpdate?.(progress);
	}, 150);

	const exitCode = await new Promise<number>((resolve) => {
		const spawnProcess = dependencies.spawnProcess ?? spawn;
		const proc = spawnProcess(command, spawnArgs, {
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
					progress.currentToolArgs = formatToolArgsPreview((evt.args || {}) as Record<string, unknown>);
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

				if (evt.type === "message_start" && evt.message?.role === "assistant") {
					streamedText = "";
				}

				if (evt.type === "message_update") {
					if (evt.message?.role === "assistant") {
						recordAssistantText(evt.message.content);
						if (evt.message.errorMessage) progress.error = evt.message.errorMessage;
					} else if (evt.assistantMessageEvent?.type === "text_delta" && typeof evt.assistantMessageEvent.delta === "string") {
						streamedText += evt.assistantMessageEvent.delta;
						recordAssistantText(streamedText);
					}
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
						recordAssistantText(evt.message.content);
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

		proc.on("error", (error) => {
				if (!progress.error) progress.error = error.message;
				resolve(1);
			});

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

export function throttle<T extends (...args: any[]) => void>(fn: T, ms: number): T {
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


export function createSubagentRunner(dependencies: SubagentRunnerDependencies = {}) {
	return (options: RunSubagentOptions): Promise<AgentResult> => executeSubagent(options, undefined, undefined, undefined, undefined, dependencies);
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
	return executeSubagent(agentOrOptions, taskArg, cwdArg, signalArg, onUpdateArg);
}
