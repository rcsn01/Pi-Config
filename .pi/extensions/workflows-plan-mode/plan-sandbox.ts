import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import { SandboxManager, type SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import type { PlanWorkspace } from "./plan-workspace.ts";

interface SandboxRuntime {
	initialize(config: SandboxRuntimeConfig): Promise<void>;
	wrapWithSandboxArgv(
		command: string,
		binShell?: string,
		customConfig?: Partial<SandboxRuntimeConfig>,
		abortSignal?: AbortSignal,
		cwd?: string,
		options?: { commandId?: string; commandText?: string },
	): Promise<{ argv: string[]; env: NodeJS.ProcessEnv }>;
	annotateStderrWithSandboxFailures(commandId: string, stderr: string): string;
	cleanupAfterCommand(): void;
	reset(): Promise<void>;
	isSupportedPlatform?(): boolean;
}

interface RunOptions {
	cwd: string;
	env: NodeJS.ProcessEnv;
	onData: (data: Buffer) => void;
	signal?: AbortSignal;
	timeout?: number;
}

interface RunResult {
	exitCode: number | null;
	stderr: string;
}

type RunSandboxed = (argv: string[], options: RunOptions) => Promise<RunResult>;

export interface PlanSandboxController {
	operations: BashOperations;
	initialize(): Promise<void>;
	dispose(): Promise<void>;
}

function killProcessGroup(child: ReturnType<typeof spawn>): void {
	if (!child.pid) return;
	try {
		if (process.platform === "win32") child.kill("SIGKILL");
		else process.kill(-child.pid, "SIGKILL");
	} catch {
		try { child.kill("SIGKILL"); } catch { /* already exited */ }
	}
}

const runSandboxed: RunSandboxed = (argv, options) => new Promise((resolvePromise, rejectPromise) => {
	const [executable, ...args] = argv;
	if (!executable) {
		rejectPromise(new Error("Sandbox runtime returned an empty command."));
		return;
	}
	if (options.signal?.aborted) {
		rejectPromise(new Error("aborted"));
		return;
	}

	const child = spawn(executable, args, {
		cwd: options.cwd,
		env: options.env,
		detached: process.platform !== "win32",
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stderr = "";
	let timedOut = false;
	let settled = false;
	let timer: NodeJS.Timeout | undefined;

	const finish = (callback: () => void) => {
		if (settled) return;
		settled = true;
		if (timer) clearTimeout(timer);
		options.signal?.removeEventListener("abort", onAbort);
		// A shell can exit while descendants remain alive. Never let them outlive
		// a Plan Mode tool call or retain access to the disposable workspace.
		killProcessGroup(child);
		callback();
	};
	const onAbort = () => killProcessGroup(child);
	options.signal?.addEventListener("abort", onAbort, { once: true });

	if (options.timeout !== undefined && options.timeout > 0) {
		timer = setTimeout(() => {
			timedOut = true;
			killProcessGroup(child);
		}, options.timeout * 1000);
	}
	child.stdout?.on("data", (chunk: Buffer) => options.onData(chunk));
	child.stderr?.on("data", (chunk: Buffer) => {
		stderr += chunk.toString("utf8");
		options.onData(chunk);
	});
	child.on("error", (error) => finish(() => rejectPromise(error)));
	child.on("close", (code) => finish(() => {
		if (options.signal?.aborted) rejectPromise(new Error("aborted"));
		else if (timedOut) rejectPromise(new Error(`timeout:${options.timeout}`));
		else resolvePromise({ exitCode: code, stderr });
	}));
});

function mapWorkingDirectory(workspace: PlanWorkspace, cwd: string): string {
	const resolved = isAbsolute(cwd) ? resolve(cwd) : resolve(workspace.hostRoot, cwd);
	let absolute = resolved;
	try { absolute = realpathSync(resolved); } catch { /* spawn reports missing directories */ }
	const relativePath = relative(workspace.hostRoot, absolute);
	if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
		throw new Error(`Plan Bash working directory is outside the host workspace: ${cwd}`);
	}
	return resolve(workspace.sandboxRoot, relativePath);
}

function sandboxConfig(workspace: PlanWorkspace): SandboxRuntimeConfig {
	const home = homedir();
	return {
		network: {
			allowedDomains: ["localhost", "127.0.0.1", "[::1]"],
			deniedDomains: [],
			allowLocalBinding: true,
		},
		filesystem: {
			denyRead: [resolve(home, ".ssh"), resolve(home, ".aws"), resolve(home, ".gnupg")],
			allowWrite: [workspace.sandboxRoot, workspace.tempRoot],
			denyWrite: [workspace.hostRoot],
		},
	};
}

export function createPlanSandboxController(
	workspace: PlanWorkspace,
	dependencies: { runtime?: SandboxRuntime; run?: RunSandboxed } = {},
): PlanSandboxController {
	const runtime = dependencies.runtime ?? SandboxManager;
	const run = dependencies.run ?? runSandboxed;
	let initialized = false;
	let initializationAttempted = false;
	let disposed = false;

	const operations: BashOperations = {
		async exec(command, cwd, options) {
			if (!initialized || disposed) throw new Error("Plan Bash sandbox is not initialized.");
			const sandboxCwd = mapWorkingDirectory(workspace, cwd);
			const commandId = `plan-bash-${randomUUID()}`;
			try {
				const wrapped = await runtime.wrapWithSandboxArgv(
					command,
					undefined,
					undefined,
					options.signal,
					sandboxCwd,
					{ commandId, commandText: command },
				);
				const result = await run(wrapped.argv, {
					cwd: sandboxCwd,
					env: {
						...wrapped.env,
						...options.env,
						TMPDIR: workspace.tempRoot,
						TEMP: workspace.tempRoot,
						TMP: workspace.tempRoot,
						PI_PLAN_WORKSPACE: workspace.sandboxRoot,
					},
					onData: options.onData,
					signal: options.signal,
					timeout: options.timeout,
				});
				const annotated = runtime.annotateStderrWithSandboxFailures(commandId, result.stderr);
				if (annotated !== result.stderr) options.onData(Buffer.from(`\n${annotated}\n`));
				return { exitCode: result.exitCode };
			} finally {
				runtime.cleanupAfterCommand();
			}
		},
	};

	return {
		operations,
		async initialize() {
			if (initialized) return;
			if (runtime.isSupportedPlatform && !runtime.isSupportedPlatform()) {
				throw new Error(`Plan Bash sandbox is not supported on ${process.platform}.`);
			}
			initializationAttempted = true;
			try {
				await runtime.initialize(sandboxConfig(workspace));
				initialized = true;
			} catch (error) {
				initializationAttempted = false;
				try { await runtime.reset(); } catch { /* preserve initialization error */ }
				throw error;
			}
		},
		async dispose() {
			if (disposed) return;
			disposed = true;
			if (!initializationAttempted && !initialized) return;
			initialized = false;
			initializationAttempted = false;
			await runtime.reset();
		},
	};
}
