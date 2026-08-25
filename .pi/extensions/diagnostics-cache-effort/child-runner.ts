import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { describeTrial } from "./experiment.ts";
import type {
	PayloadObservation,
	RuntimeObservation,
	TokenUsage,
	TrialResult,
	TrialRunner,
	TrialSpec,
	TurnObservation,
	WireMode,
} from "./experiment.ts";
import { parseProbeLine, type ProbeEvent } from "./probe-protocol.ts";

const EXTENSION_DIR = path.dirname(fileURLToPath(import.meta.url));
const CHILD_PROBE_PATH = path.join(EXTENSION_DIR, "child-probe.ts");
const DEFAULT_TURN_TIMEOUT_MS = 5 * 60 * 1000;

type SpawnProcess = typeof spawn;

export interface ChildRunnerDependencies {
	spawnProcess?: SpawnProcess;
	makeTempDirectory?: () => Promise<string>;
	removeDirectory?: (directory: string) => Promise<void>;
	turnTimeoutMs?: number;
}

export interface PiInvocation {
	command: string;
	baseArgs: string[];
	exact: boolean;
}

export function resolvePiInvocation(argvEntry = process.argv[1]): PiInvocation {
	if (argvEntry) {
		try {
			const realEntry = fs.realpathSync(argvEntry);
			if (/\.(?:mjs|cjs|js)$/i.test(realEntry)) {
				return { command: process.execPath, baseArgs: [realEntry], exact: true };
			}
		} catch {}
	}
	if (process.versions.bun) return { command: process.execPath, baseArgs: [], exact: true };
	return { command: "pi", baseArgs: [], exact: false };
}

function sanitizeError(value: unknown): string {
	return (value instanceof Error ? value.message : String(value))
		.replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
		.replace(/\bsk-[A-Za-z0-9_-]+/g, "[redacted]")
		.slice(0, 1000);
}

function attachLineReader(stream: NodeJS.ReadableStream, onLine: (line: string) => void): () => void {
	const decoder = new StringDecoder("utf8");
	let buffer = "";
	const onData = (chunk: Buffer | string) => {
		buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
		let newline = buffer.indexOf("\n");
		while (newline >= 0) {
			const line = buffer.slice(0, newline).replace(/\r$/, "");
			buffer = buffer.slice(newline + 1);
			if (line) onLine(line);
			newline = buffer.indexOf("\n");
		}
	};
	const onEnd = () => {
		buffer += decoder.end();
		if (buffer) onLine(buffer.replace(/\r$/, ""));
		buffer = "";
	};
	stream.on("data", onData);
	stream.on("end", onEnd);
	return () => {
		stream.off("data", onData);
		stream.off("end", onEnd);
	};
}

interface PendingRequest {
	resolve(value: any): void;
	reject(error: Error): void;
	timer: NodeJS.Timeout;
}

class RpcProcess {
	private readonly pending = new Map<string, PendingRequest>();
	private readonly listeners = new Set<(event: any) => void>();
	private readonly turnRejectors = new Set<(error: Error) => void>();
	private readonly probeWaiters = new Set<{ check: () => void; reject: (error: Error) => void }>();
	private readonly probeEvents: ProbeEvent[] = [];
	private nextId = 0;
	private stopPromise?: Promise<void>;
	private stderrTail = "";
	private exited = false;
	private stopStdout: () => void;
	private stopStderr: () => void;

	constructor(
		private readonly child: ChildProcessWithoutNullStreams,
		private readonly timeoutMs: number,
	) {
		this.stopStdout = attachLineReader(child.stdout, (line) => this.handleStdout(line));
		this.stopStderr = attachLineReader(child.stderr, (line) => this.handleStderr(line));
		child.once("error", (error) => this.failAll(new Error(`Child Pi failed: ${sanitizeError(error)}`)));
		child.once("exit", (code, signal) => {
			this.exited = true;
			this.failAll(new Error(`Child Pi exited (${code ?? signal ?? "unknown"}). ${this.stderrTail}`.trim()));
		});
	}

	private handleStdout(line: string): void {
		let message: any;
		try { message = JSON.parse(line); } catch { return; }
		if (message?.type === "response" && typeof message.id === "string") {
			const pending = this.pending.get(message.id);
			if (!pending) return;
			clearTimeout(pending.timer);
			this.pending.delete(message.id);
			if (message.success) pending.resolve(message.data);
			else pending.reject(new Error(message.error ?? `RPC command ${message.command ?? "unknown"} failed.`));
			return;
		}
		for (const listener of this.listeners) listener(message);
	}

	private handleStderr(line: string): void {
		const probe = parseProbeLine(line);
		if (probe) {
			this.probeEvents.push(probe);
			for (const waiter of this.probeWaiters) waiter.check();
			return;
		}
		this.stderrTail = `${this.stderrTail}\n${sanitizeError(line)}`.slice(-4000);
	}

	private failAll(error: Error): void {
		for (const reject of this.turnRejectors) reject(error);
		this.turnRejectors.clear();
		for (const waiter of this.probeWaiters) waiter.reject(error);
		this.probeWaiters.clear();
		for (const request of this.pending.values()) {
			clearTimeout(request.timer);
			request.reject(error);
		}
		this.pending.clear();
	}

	async send(command: Record<string, unknown>): Promise<any> {
		if (this.exited) throw new Error(`Child Pi is not running. ${this.stderrTail}`.trim());
		const id = `cache-effort-${++this.nextId}`;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`Child Pi RPC command timed out after ${this.timeoutMs} ms.`));
			}, this.timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			this.child.stdin.write(`${JSON.stringify({ id, ...command })}\n`, (error) => {
				if (!error) return;
				clearTimeout(timer);
				this.pending.delete(id);
				reject(error);
			});
		});
	}

	async prompt(message: string): Promise<{ assistant: any; latencyMs: number; firstTokenMs?: number }> {
		const started = Date.now();
		let assistant: any;
		let firstTokenAt: number | undefined;
		let settledResolve!: () => void;
		let settledReject!: (error: Error) => void;
		const settled = new Promise<void>((resolve, reject) => {
			settledResolve = resolve;
			settledReject = reject;
		});
		this.turnRejectors.add(settledReject);
		const timer = setTimeout(() => settledReject(new Error(`Provider turn timed out after ${this.timeoutMs} ms.`)), this.timeoutMs);
		const listener = (event: any) => {
			if (event?.type === "message_update" && firstTokenAt === undefined) firstTokenAt = Date.now();
			if (event?.type === "message_end" && event.message?.role === "assistant") assistant = event.message;
			if (event?.type === "agent_settled") settledResolve();
		};
		this.listeners.add(listener);
		try {
			await this.send({ type: "prompt", message });
			await settled;
			if (!assistant) throw new Error("Child Pi settled without an assistant message.");
			return {
				assistant,
				latencyMs: Date.now() - started,
				firstTokenMs: firstTokenAt === undefined ? undefined : firstTokenAt - started,
			};
		} finally {
			clearTimeout(timer);
			this.listeners.delete(listener);
			this.turnRejectors.delete(settledReject);
		}
	}

	getProbeEvents(): readonly ProbeEvent[] {
		return this.probeEvents;
	}

	async waitForProbeTurn(requestIndex: number): Promise<void> {
		const complete = () => {
			const request = this.probeEvents.some(
				(event) => event.type === "request" && event.observation.requestIndex === requestIndex,
			);
			const turn = this.probeEvents.some(
				(event) => event.type === "turn" && event.requestIndex === requestIndex,
			);
			return request && turn;
		};
		if (complete()) return;
		await new Promise<void>((resolve, reject) => {
			let waiter: { check: () => void; reject: (error: Error) => void };
			const finishError = (error: Error) => {
				clearTimeout(timer);
				this.probeWaiters.delete(waiter);
				reject(error);
			};
			const check = () => {
				if (!complete()) return;
				clearTimeout(timer);
				this.probeWaiters.delete(waiter);
				resolve();
			};
			waiter = { check, reject: finishError };
			const timer = setTimeout(() => {
				finishError(new Error(`Timed out waiting for instrumentation for request ${requestIndex}.`));
			}, Math.min(this.timeoutMs, 5000));
			this.probeWaiters.add(waiter);
			check();
		});
	}

	stop(): Promise<void> {
		this.stopPromise ??= this.stopOnce();
		return this.stopPromise;
	}

	private async stopOnce(): Promise<void> {
		if (this.exited) {
			this.stopStdout();
			this.stopStderr();
			return;
		}
		this.child.kill("SIGTERM");
		await new Promise<void>((resolve) => {
			const forceTimer = setTimeout(() => {
				try { this.child.kill("SIGKILL"); } catch {}
			}, 1000);
			const giveUpTimer = setTimeout(resolve, 2000);
			this.child.once("exit", () => {
				clearTimeout(forceTimer);
				clearTimeout(giveUpTimer);
				resolve();
			});
		});
		this.stopStdout();
		this.stopStderr();
	}
}

function isPrefix(previous: readonly string[], current: readonly string[]): boolean {
	return previous.every((hash, index) => current[index] === hash);
}

export function validatePayloads(payloads: readonly PayloadObservation[]): string[] {
	const issues: string[] = [];
	if (payloads.length !== 4) return [`Expected four provider requests, observed ${payloads.length}.`];
	const first = payloads[0]!;
	if (!first.promptCacheKeyHash) issues.push("The provider payload omitted prompt_cache_key.");
	for (const payload of payloads.slice(1)) {
		if (payload.promptCacheKeyHash !== first.promptCacheKeyHash) issues.push("prompt_cache_key changed within the trial.");
		if (payload.staticBodyHash !== first.staticBodyHash) issues.push("A non-input, non-effort request field changed within the trial.");
		if (payload.instructionsHash !== first.instructionsHash) issues.push("Provider instructions changed within the trial.");
	}
	for (let index = 1; index < payloads.length; index++) {
		if (!isPrefix(payloads[index - 1]!.inputItemHashes, payloads[index]!.inputItemHashes)) {
			issues.push(`Provider input at turn ${index + 1} did not preserve the previous input prefix.`);
		}
	}
	const efforts = payloads.map((payload) => payload.effectiveEffort);
	if (efforts[0] !== efforts[1] || efforts[2] !== efforts[3]) issues.push("Same-effort controls produced different effective effort payloads.");
	if (efforts[1] === efforts[2]) issues.push("The selected levels did not produce a provider-level effort change.");
	return [...new Set(issues)];
}

function usageFrom(message: any): TokenUsage {
	const usage = message?.usage;
	if (!usage) throw new Error("Assistant response omitted usage metrics.");
	return {
		input: Number(usage.input ?? 0),
		output: Number(usage.output ?? 0),
		cacheRead: Number(usage.cacheRead ?? 0),
		cacheWrite: Number(usage.cacheWrite ?? 0),
		reasoning: usage.reasoning === undefined ? undefined : Number(usage.reasoning),
		totalTokens: Number(usage.totalTokens ?? 0),
		cost: {
			input: Number(usage.cost?.input ?? 0),
			output: Number(usage.cost?.output ?? 0),
			cacheRead: Number(usage.cost?.cacheRead ?? 0),
			cacheWrite: Number(usage.cost?.cacheWrite ?? 0),
			total: Number(usage.cost?.total ?? 0),
		},
	};
}

async function defaultTempDirectory(): Promise<string> {
	return fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-cache-effort-"));
}

export function createChildTrialRunner(
	config: { provider: "openai" | "openai-codex"; modelId: string },
	dependencies: ChildRunnerDependencies = {},
): TrialRunner {
	const spawnProcess = dependencies.spawnProcess ?? spawn;
	const makeTempDirectory = dependencies.makeTempDirectory ?? defaultTempDirectory;
	const removeDirectory = dependencies.removeDirectory ?? ((directory) => fs.promises.rm(directory, { recursive: true, force: true }));
	const timeoutMs = dependencies.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;

	return async (spec: TrialSpec, options): Promise<TrialResult> => {
		const tempDirectory = await makeTempDirectory();
		const descriptor = describeTrial(spec);
		const turns: TurnObservation[] = [];
		let rpc: RpcProcess | undefined;
		const abort = () => { void rpc?.stop(); };
		try {
			const settingsDirectory = path.join(tempDirectory, ".pi");
			await fs.promises.mkdir(settingsDirectory, { recursive: true });
			await fs.promises.writeFile(path.join(settingsDirectory, "settings.json"), JSON.stringify({
				transport: spec.transport,
				compaction: { enabled: false },
				retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0, timeoutMs } },
			}), { mode: 0o600 });

			const invocation = resolvePiInvocation();
			if (!invocation.exact) throw new Error("Could not resolve the exact installed Pi executable for the child experiment.");
			const args = [
				...invocation.baseArgs,
				"--mode", "rpc",
				"--no-session", "--session-id", spec.id,
				"--provider", config.provider,
				"--model", config.modelId,
				"--thinking", spec.efforts[0],
				"--no-tools", "--no-extensions", "--extension", CHILD_PROBE_PATH,
				"--no-skills", "--no-prompt-templates", "--no-context-files",
				"--approve", "--offline",
			];
			const child = spawnProcess(invocation.command, args, {
				cwd: tempDirectory,
				env: { ...process.env, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_CACHE_EFFORT_TRANSPORT: spec.transport },
				stdio: ["pipe", "pipe", "pipe"],
				detached: process.platform !== "win32",
			}) as ChildProcessWithoutNullStreams;
			rpc = new RpcProcess(child, timeoutMs);
			options.signal?.addEventListener("abort", abort, { once: true });
			const state = await rpc.send({ type: "get_state" });
			if (state?.sessionId !== spec.id || state?.model?.provider !== config.provider || state?.model?.id !== config.modelId) {
				throw new Error("Child Pi did not start with the requested session, provider, and model.");
			}
			await rpc.send({ type: "set_auto_compaction", enabled: false });
			await rpc.send({ type: "set_auto_retry", enabled: false });

			for (let index = 0; index < spec.prompts.length; index++) {
				if (options.signal?.aborted) throw new Error("Experiment cancelled.");
				await rpc.send({ type: "set_thinking_level", level: spec.efforts[index] });
				const response = await rpc.prompt(spec.prompts[index]);
				const requestIndex = index + 1;
				await rpc.waitForProbeTurn(requestIndex);
				const requestEvent = rpc.getProbeEvents().find(
					(event): event is Extract<ProbeEvent, { type: "request" }> => event.type === "request" && event.observation.requestIndex === requestIndex,
				);
				const turnEvent = rpc.getProbeEvents().find(
					(event): event is Extract<ProbeEvent, { type: "turn" }> => event.type === "turn" && event.requestIndex === requestIndex,
				);
				const turn: TurnObservation = {
					index,
					effort: spec.efforts[index]!,
					provider: typeof response.assistant.provider === "string" ? response.assistant.provider : undefined,
					model: typeof response.assistant.model === "string" ? response.assistant.model : undefined,
					usage: usageFrom(response.assistant),
					stopReason: String(response.assistant.stopReason ?? "unknown"),
					latencyMs: response.latencyMs,
					firstTokenMs: response.firstTokenMs,
					payload: requestEvent?.observation,
					wireMode: turnEvent?.wireMode as WireMode | undefined,
					websocketStats: turnEvent?.websocketStats,
				};
				turns.push(turn);
				if (turn.provider !== config.provider || turn.model !== config.modelId) {
					throw new Error(`Turn ${index + 1} used an unexpected provider or model.`);
				}
				if (turn.stopReason !== "stop") throw new Error(`Turn ${index + 1} stopped with ${turn.stopReason}.`);
				if (turn.usage.input + turn.usage.cacheRead + turn.usage.cacheWrite <= 0) {
					throw new Error(`Turn ${index + 1} reported no prompt usage.`);
				}
			}

			const payloads = turns.flatMap((turn) => turn.payload ? [turn.payload] : []);
			const payloadIssues = validatePayloads(payloads);
			const runtime = rpc.getProbeEvents().find(
				(event): event is Extract<ProbeEvent, { type: "runtime" }> => event.type === "runtime",
			)?.observation as RuntimeObservation | undefined;
			return {
				spec: descriptor,
				turns,
				runtime,
				payloadValid: payloadIssues.length === 0,
				payloadIssues,
			};
		} catch (error) {
			return {
				spec: descriptor,
				turns,
				payloadValid: false,
				payloadIssues: [],
				error: options.signal?.aborted ? "Experiment cancelled." : sanitizeError(error),
			};
		} finally {
			options.signal?.removeEventListener("abort", abort);
			await rpc?.stop();
			await removeDirectory(tempDirectory);
		}
	};
}
