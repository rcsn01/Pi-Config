import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { truncateHead, withFileMutationQueue, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
import { createChildObservation } from "../_shared/child-observation/index.ts";
import { getObservabilityService } from "../_shared/observability.ts";
import type {
	AgentConfig,
	AgentProgress,
	AgentResult,
	RunSubagentOptions,
	SubagentProgressEvent,
} from "../_shared/subagent-service.ts";
import {
	appendChildModelArgument,
	appendChildThinkingArgument,
	type ResolvedLaunchConfiguration,
} from "./config.ts";
import { formatToolArgsPreview } from "./formatting.ts";
import { createSubagentTimingRecorder } from "./subagent-timing.ts";

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
	options: { cwd: string; env?: NodeJS.ProcessEnv; stdio: ["ignore", "pipe", "pipe"] | ["ignore", "pipe", "pipe", "pipe"] },
) => ChildProcess;

export interface SubagentChildExecutionRequest {
	agent: AgentConfig;
	task: string;
	cwd: string;
	launch: ResolvedLaunchConfiguration;
	cacheSessionId?: string;
	signal?: AbortSignal;
	timeoutMs?: number;
	maxOutputBytes?: number;
	onUpdate?: RunSubagentOptions["onUpdate"];
	onProgress?: RunSubagentOptions["onProgress"];
}

export interface SubagentChildExecution {
	execute(request: SubagentChildExecutionRequest): Promise<AgentResult>;
}

export interface SubagentChildExecutionDependencies {
	spawnProcess?: SpawnSubagentProcess;
	tempRoot?: string;
}

function resolvePiBinary(): { command: string; baseArgs: string[] } {
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
	launch: ResolvedLaunchConfiguration,
	sessionId: string | undefined,
	tempRoot: string,
): Promise<{ args: string[]; tempDir: string }> {
	const piBin = resolvePiBinary();
	const tempDir = await fs.promises.mkdtemp(path.join(tempRoot, "pi-sub-"));
	try {
		const promptPath = path.join(tempDir, `${agent.name}.md`);
		await withFileMutationQueue(promptPath, async () => {
			await fs.promises.writeFile(promptPath, agent.systemPrompt, { encoding: "utf-8", mode: 0o600 });
		});

		let args = [...piBin.baseArgs, "--mode", "json", "-p", "--no-session", "--no-skills"];
		if (sessionId) args.push("--session-id", sessionId);

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

		args.push("--no-extensions");
		if (enabledTools.length > 0) args.push("--tools", enabledTools.join(","));
		else args.push("--no-tools");
		for (const extensionPath of extensionPaths) args.push("--extension", extensionPath);

		args = appendChildModelArgument(args, launch.model);
		args = appendChildThinkingArgument(args, launch.thinkingLevel);
		args.push("--append-system-prompt", promptPath);

		if (task.length > 8000) {
			const taskPath = path.join(tempDir, "task.md");
			await withFileMutationQueue(taskPath, async () => {
				await fs.promises.writeFile(taskPath, `Task: ${task}`, { encoding: "utf-8", mode: 0o600 });
			});
			args.push(`@${taskPath}`);
		} else {
			args.push(`Task: ${task}`);
		}
		return { args: [piBin.command, ...args], tempDir };
	} catch (error) {
		removeTempDirectory(tempDir);
		throw error;
	}
}

function removeTempDirectory(tempDir: string | undefined): void {
	if (!tempDir) return;
	try {
		fs.rmSync(tempDir, { recursive: true, force: true });
	} catch {}
}

function extractTextFromContent(content: unknown): string {
	if (!content) return "";
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((part: any) => part.type === "text")
			.map((part: any) => part.text)
			.join("\n");
	}
	return "";
}

function withTimeoutSignal(signal: AbortSignal | undefined, timeoutMs: number | undefined): { signal?: AbortSignal; cleanup: () => void } {
	if (!timeoutMs) return { signal, cleanup: () => undefined };
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(
		() => controller.abort(new Error(`Subagent timed out after ${timeoutMs}ms`)),
		timeoutMs,
	);
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

function createThrottle(fn: () => void, ms: number): { fire(): void; cancel(): void } {
	let lastCall = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	return {
		fire() {
			const now = Date.now();
			const remaining = ms - (now - lastCall);
			if (remaining <= 0) {
				lastCall = now;
				if (timer) clearTimeout(timer);
				timer = undefined;
				fn();
			} else if (!timer) {
				timer = setTimeout(() => {
					lastCall = Date.now();
					timer = undefined;
					fn();
				}, remaining);
			}
		},
		cancel() {
			if (timer) clearTimeout(timer);
			timer = undefined;
		},
	};
}

export function createSubagentChildExecution(
	dependencies: SubagentChildExecutionDependencies = {},
): SubagentChildExecution {
	return {
		async execute(request) {
			const { agent, task, launch } = request;
			const timeout = withTimeoutSignal(request.signal, request.timeoutMs);
			let tempDir: string | undefined;
			let cancelProcessWait: () => void = () => undefined;
			let cancelUpdates: () => void = () => undefined;
			try {
				await request.onProgress?.({ type: "started", agent: agent.name, task });
				const prepared = await buildPiArgs(agent, task, launch, request.cacheSessionId, dependencies.tempRoot ?? os.tmpdir());
				tempDir = prepared.tempDir;
				const [command, ...spawnArgs] = prepared.args;
				const childObservation = createChildObservation(getObservabilityService()).prepare(
					{ args: spawnArgs, stdio: ["ignore", "pipe", "pipe"] },
					{ channel: "subagent", displayLabel: agent.name },
				);

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
				const timing = createSubagentTimingRecorder();
				const progress = result.progress;
				let lastTool: string | undefined;
				let lastToolArgs: string | undefined;
				let recentToolCount = 0;
				let lastMessage = "";
				let streamedText = "";
				const emitProgress = (event: SubagentProgressEvent) => { void request.onProgress?.(event, progress); };
				const updateThrottle = createThrottle(() => {
					progress.durationMs = Date.now() - startTime;
					request.onUpdate?.(progress);
				}, 150);
				cancelUpdates = updateThrottle.cancel;

				const recordAssistantText = (content: unknown) => {
					const text = extractTextFromContent(content);
					if (!text) return;
					result.output = text;
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

				let cancelAbort: () => void = () => undefined;
				let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
				cancelProcessWait = () => {
					cancelAbort();
					if (forceKillTimer) clearTimeout(forceKillTimer);
					forceKillTimer = undefined;
				};

				const exitCode = await new Promise<number>((resolve) => {
					const spawnProcess = dependencies.spawnProcess ?? spawn;
					const proc = spawnProcess(command, childObservation.args, {
						cwd: request.cwd,
						...(childObservation.env === undefined ? {} : { env: childObservation.env }),
						stdio: childObservation.stdio,
					});
					childObservation.attach(proc);
					let buffer = "";
					let stderr = "";

					const processLine = (line: string) => {
						if (!line.trim()) return;
						try {
							const event = JSON.parse(line) as any;
							timing.recordEvent(event);
							progress.durationMs = Date.now() - startTime;
							if (event.type === "tool_execution_start") {
								progress.toolCount++;
								progress.currentTool = event.toolName;
								progress.currentToolArgs = formatToolArgsPreview((event.args || {}) as Record<string, unknown>);
								if (progress.currentTool && (progress.currentTool !== lastTool || progress.currentToolArgs !== lastToolArgs)) {
									lastTool = progress.currentTool;
									lastToolArgs = progress.currentToolArgs;
									emitProgress({ type: "tool_call", agent: agent.name, tool: progress.currentTool, args: progress.currentToolArgs });
								}
								updateThrottle.fire();
							}
							if (event.type === "tool_execution_end") {
								if (progress.currentTool) {
									progress.recentTools.push({ tool: progress.currentTool, args: progress.currentToolArgs || "" });
									for (const tool of progress.recentTools.slice(recentToolCount)) {
										emitProgress({ type: "tool_result", agent: agent.name, tool: tool.tool, args: tool.args });
									}
									recentToolCount = progress.recentTools.length;
									if (progress.recentTools.length > 20) {
										progress.recentTools.splice(0, progress.recentTools.length - 20);
										recentToolCount = Math.min(recentToolCount, progress.recentTools.length);
									}
								}
								progress.currentTool = undefined;
								progress.currentToolArgs = undefined;
								updateThrottle.fire();
							}
							if (event.type === "tool_result_end") updateThrottle.fire();
							if (event.type === "message_start" && event.message?.role === "assistant") streamedText = "";
							if (event.type === "message_update") {
								if (event.message?.role === "assistant") {
									recordAssistantText(event.message.content);
									if (event.message.errorMessage) progress.error = event.message.errorMessage;
								} else if (event.assistantMessageEvent?.type === "text_delta" && typeof event.assistantMessageEvent.delta === "string") {
									streamedText += event.assistantMessageEvent.delta;
									recordAssistantText(streamedText);
								}
								updateThrottle.fire();
							}
							if (event.type === "message_end" && event.message) {
								if (event.message.role === "assistant") {
									result.usage.turns++;
									const usage = event.message.usage;
									if (usage) {
										result.usage.input += usage.input || 0;
										result.usage.output += usage.output || 0;
										result.usage.cacheRead += usage.cacheRead || 0;
										result.usage.cacheWrite += usage.cacheWrite || 0;
										result.usage.cost += usage.cost?.total || 0;
										progress.tokens = result.usage.input + result.usage.output;
									}
									if (event.message.model) result.model = event.message.model;
									if (event.message.errorMessage) progress.error = event.message.errorMessage;
									recordAssistantText(event.message.content);
								}
								updateThrottle.fire();
							}
						} catch {}
					};

					proc.stdout!.on("data", (chunk: Buffer) => {
						buffer += chunk.toString();
						const lines = buffer.split("\n");
						buffer = lines.pop() || "";
						lines.forEach(processLine);
					});
					proc.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
					proc.on("close", (code) => {
						if (buffer.trim()) processLine(buffer);
						if (code !== 0 && stderr.trim() && !progress.error) progress.error = stderr.trim();
						resolve(code ?? 1);
					});
					proc.on("error", (error) => {
						if (!progress.error) progress.error = error.message;
						resolve(1);
					});

					if (timeout.signal) {
						const kill = () => {
							proc.kill("SIGTERM");
							forceKillTimer = setTimeout(() => !proc.killed && proc.kill("SIGKILL"), 3000);
						};
						if (timeout.signal.aborted) kill();
						else {
							timeout.signal.addEventListener("abort", kill, { once: true });
							cancelAbort = () => timeout.signal?.removeEventListener("abort", kill);
						}
					}
				});
				cancelProcessWait();
				cancelUpdates();

				result.exitCode = exitCode;
				result.timing = timing.finish();
				progress.status = exitCode === 0 && !progress.error ? "completed" : "failed";
				progress.durationMs = Date.now() - startTime;
				if (progress.error) result.output = result.output || `Error: ${progress.error}`;

				const maxBytes = request.maxOutputBytes ?? DEFAULT_MAX_BYTES;
				result.originalOutputBytes = Buffer.byteLength(result.output, "utf-8");
				if (result.originalOutputBytes > maxBytes) {
					const truncation = truncateHead(result.output, { maxLines: DEFAULT_MAX_LINES, maxBytes });
					result.output = truncation.content;
					if (truncation.truncated) {
						result.output += "\n\n[Output truncated]";
						result.truncated = true;
					}
				}

				if (progress.status === "completed") {
					await request.onProgress?.({ type: "completed", agent: agent.name, result }, progress);
				} else {
					await request.onProgress?.({
						type: "failed",
						agent: agent.name,
						result,
						error: progress.error || result.output || `Subagent ${agent.name} failed`,
					}, progress);
				}
				return result;
			} finally {
				cancelProcessWait();
				cancelUpdates();
				timeout.cleanup();
				removeTempDirectory(tempDir);
			}
		},
	};
}
