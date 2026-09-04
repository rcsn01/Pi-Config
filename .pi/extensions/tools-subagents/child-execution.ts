import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { createChildObservation } from "../_shared/child-observation/index.ts";
import { getObservabilityService } from "../_shared/observability.ts";
import type {
	AgentConfig,
	AgentResult,
	RunSubagentOptions,
} from "../_shared/subagent-service.ts";
import { createSubagentChildEventIngestion, type SubagentChildProcessOutcome } from "./child-event-ingestion.ts";
import {
	appendChildModelArgument,
	appendChildThinkingArgument,
	type ResolvedLaunchConfiguration,
} from "./config.ts";

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

export function createSubagentChildExecution(
	dependencies: SubagentChildExecutionDependencies = {},
): SubagentChildExecution {
	return {
		async execute(request) {
			const { agent, task, launch } = request;
			const timeout = withTimeoutSignal(request.signal, request.timeoutMs);
			let tempDir: string | undefined;
			let cancelProcessWait: () => void = () => undefined;
			try {
				await request.onProgress?.({ type: "started", agent: agent.name, task });
				const prepared = await buildPiArgs(agent, task, launch, request.cacheSessionId, dependencies.tempRoot ?? os.tmpdir());
				tempDir = prepared.tempDir;
				const [command, ...spawnArgs] = prepared.args;
				const childObservation = createChildObservation(getObservabilityService()).prepare(
					{ args: spawnArgs, stdio: ["ignore", "pipe", "pipe"] },
					{ channel: "subagent", displayLabel: agent.name },
				);

				const ingestion = createSubagentChildEventIngestion({
					agentName: agent.name,
					task,
					model: launch.model,
					thinkingLevel: launch.thinkingLevel,
					maxOutputBytes: request.maxOutputBytes,
					onUpdate: request.onUpdate,
					onProgress: request.onProgress,
				});

				let cancelAbort: () => void = () => undefined;
				let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
				cancelProcessWait = () => {
					cancelAbort();
					if (forceKillTimer) clearTimeout(forceKillTimer);
					forceKillTimer = undefined;
				};

				const outcome = await new Promise<SubagentChildProcessOutcome>((resolve) => {
					const spawnProcess = dependencies.spawnProcess ?? spawn;
					const proc = spawnProcess(command, childObservation.args, {
						cwd: request.cwd,
						...(childObservation.env === undefined ? {} : { env: childObservation.env }),
						stdio: childObservation.stdio,
					});
					childObservation.attach(proc);
					let stderr = "";

					proc.stdout!.on("data", (chunk: Buffer) => ingestion.write(chunk));
					proc.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
					proc.on("close", (code) => resolve({ exitCode: code ?? 1, stderr }));
					proc.on("error", (error) => resolve({ exitCode: 1, stderr, processError: error.message }));

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
				return await ingestion.finish(outcome);
			} finally {
				cancelProcessWait();
				timeout.cleanup();
				removeTempDirectory(tempDir);
			}
		},
	};
}
