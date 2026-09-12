import { spawn, type ChildProcess, type StdioOptions } from "node:child_process";
import { realpathSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";

/**
 * The deep in-process module for repeated child-process mechanics: how Pi
 * re-invokes itself, how child output is framed into lines, how child process
 * lifetimes end, and how children are spawned into their own process group.
 * Protocol parsing, event meaning, output accumulation, and caller policy stay
 * with the consumers.
 */

export interface PiInvocation {
	command: string;
	baseArgs: string[];
	/** False when the command is a PATH guess that cannot be verified. */
	exact: boolean;
}

/**
 * Resolve how to launch a child Pi in this checkout. A JavaScript entry file
 * (resolved through its real path, case-insensitively) re-uses the running
 * executable; under Bun every other entry still does; otherwise the command is
 * a PATH guess (`pi`) that callers may refuse.
 */
export function resolvePiInvocation(argvEntry: string | undefined = process.argv[1]): PiInvocation {
	if (argvEntry) {
		try {
			const realEntry = realpathSync(argvEntry);
			if (/\.(?:mjs|cjs|js)$/i.test(realEntry)) {
				return { command: process.execPath, baseArgs: [realEntry], exact: true };
			}
		} catch {}
	}
	if (process.versions.bun) return { command: process.execPath, baseArgs: [], exact: true };
	return { command: "pi", baseArgs: [], exact: false };
}

export interface LineReader {
	push(chunk: Buffer | string): void;
	end(): void;
}

/**
 * Incrementally decode UTF-8 chunks and deliver LF-framed lines. One CR
 * immediately before LF or at the final tail is removed; empty lines are
 * skipped; other whitespace is retained. Parsing, trimming beyond one CR, size
 * policy beyond the optional byte cap, and stream wiring stay with the caller.
 * With `maxLineBytes`, a line over the limit is discarded through its next LF
 * (byte counts include a trailing CR and all other whitespace); an overlong
 * tail is discarded. `onLine` exceptions propagate from `push` and `end`.
 */
export function createLineReader(
	onLine: (line: string) => void,
	options: { maxLineBytes?: number } = {},
): LineReader {
	const maxLineBytes = options.maxLineBytes;
	if (maxLineBytes !== undefined && (!Number.isInteger(maxLineBytes) || maxLineBytes <= 0)) {
		throw new Error(`maxLineBytes must be a positive integer, received ${maxLineBytes}.`);
	}
	const decoder = new StringDecoder("utf8");
	let buffer = "";
	let discarding = false;
	let ended = false;

	const exceedsLimit = (accumulated: string, part: string): boolean =>
		maxLineBytes !== undefined
		&& Buffer.byteLength(accumulated, "utf8") + Buffer.byteLength(part, "utf8") > maxLineBytes;

	const feed = (text: string): void => {
		let rest = text;
		while (rest.length > 0) {
			const newline = rest.indexOf("\n");
			const part = newline < 0 ? rest : rest.slice(0, newline);
			rest = newline < 0 ? "" : rest.slice(newline + 1);
			if (!discarding) {
				if (exceedsLimit(buffer, part)) {
					buffer = "";
					discarding = true;
				} else {
					buffer += part;
				}
			}
			if (newline >= 0) {
				if (!discarding) {
					const line = buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
					if (line) onLine(line);
				}
				buffer = "";
				discarding = false;
			}
		}
	};

	return {
		push(chunk) {
			if (ended) return;
			feed(decoder.write(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk));
		},
		end() {
			if (ended) return;
			ended = true;
			feed(decoder.end());
			if (!discarding && buffer.length > 0) {
				const tail = buffer;
				buffer = "";
				if (maxLineBytes === undefined || Buffer.byteLength(tail, "utf8") <= maxLineBytes) {
					const line = tail.endsWith("\r") ? tail.slice(0, -1) : tail;
					if (line) onLine(line);
				}
			}
			buffer = "";
			discarding = false;
		},
	};
}

/**
 * Immediate process-group SIGKILL with no grace period and no await. Plan
 * teardown requires this synchronous invariant. A child without a pid is a
 * no-op; Windows and a failed POSIX group signal fall back to pid signaling.
 */
export function killProcessGroup(child: ChildProcess): void {
	if (!child.pid) return;
	try {
		if (process.platform === "win32") child.kill("SIGKILL");
		else process.kill(-child.pid, "SIGKILL");
	} catch {
		try { child.kill("SIGKILL"); } catch { /* already exited */ }
	}
}

export type SpawnProcess = typeof spawn;

export type GroupSpawnOutcome =
	| { kind: "exit"; exitCode: number | null }
	| { kind: "aborted" }
	| { kind: "timed-out" }
	| { kind: "spawn-error"; error: Error };

export interface SpawnInGroupOptions {
	command: string;
	args: readonly string[];
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	/** Caller-owned stdio policy, passed verbatim to spawn. Must be node's own
	 *  `StdioOptions`: `@types/node` 26 exports no `StdioOption`, and a readonly
	 *  array is not assignable to `spawn`'s mutable `stdio` option. */
	stdio: StdioOptions;
	signal?: AbortSignal;
	/** Positive value kills the process group at the deadline and reports `timed-out`. */
	timeoutSeconds?: number;
	/** Kill the surviving process group when the child settles (descendant policy). */
	killGroupOnSettle?: boolean;
	onStdout?: (chunk: Buffer) => void;
	onStderr?: (chunk: Buffer) => void;
	/** Injectable spawn, typed as `typeof spawn`. */
	spawnProcess?: SpawnProcess;
}

/**
 * Spawn a child into its own process group and settle exactly once with a
 * total outcome; the promise never rejects. The module owns the detached
 * spawn decision (off Windows), the immediate group kill on abort and on the
 * optional deadline, the post-attach aborted re-check, settle-once, and the
 * caller-declared kill-at-settle descendant policy. Stream consumption,
 * executable selection, and result-to-error mapping stay with the caller.
 * Outcome marks accumulate, so an abort after the deadline still reports
 * `aborted`, and the abort listener is removed at settle.
 */
export function spawnInGroup(options: SpawnInGroupOptions): Promise<GroupSpawnOutcome> {
	return new Promise((resolve) => {
		if (options.signal?.aborted) {
			resolve({ kind: "aborted" });
			return;
		}

		let child: ChildProcess;
		try {
			child = (options.spawnProcess ?? spawn)(options.command, options.args, {
				cwd: options.cwd,
				env: options.env,
				detached: process.platform !== "win32",
				stdio: options.stdio,
			});
		} catch (error) {
			resolve({ kind: "spawn-error", error: error instanceof Error ? error : new Error(String(error)) });
			return;
		}

		let abortInitiated = false;
		let deadlineInitiated = false;
		let settled = false;
		let timer: NodeJS.Timeout | undefined;

		const onAbort = () => {
			abortInitiated = true;
			killProcessGroup(child);
		};
		options.signal?.addEventListener("abort", onAbort, { once: true });
		// A listener attached to an already-aborted signal never fires; the
		// re-check covers the window between the pre-check and this attach.
		if (options.signal?.aborted) onAbort();

		if (options.timeoutSeconds !== undefined && options.timeoutSeconds > 0) {
			timer = setTimeout(() => {
				deadlineInitiated = true;
				killProcessGroup(child);
			}, options.timeoutSeconds * 1000);
		}

		child.stdout?.on("data", (chunk: Buffer) => options.onStdout?.(chunk));
		child.stderr?.on("data", (chunk: Buffer) => options.onStderr?.(chunk));

		const finish = (outcome: GroupSpawnOutcome) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
			if (options.killGroupOnSettle) killProcessGroup(child);
			resolve(outcome);
		};

		child.on("error", (error) => finish({ kind: "spawn-error", error }));
		child.on("close", (code) => finish(
			abortInitiated
				? { kind: "aborted" }
				: deadlineInitiated
					? { kind: "timed-out" }
					: { kind: "exit", exitCode: code },
		));
	});
}

export interface TerminateChildProcessOptions {
	/** Milliseconds between SIGTERM and SIGKILL. Zero sends both in one turn. */
	graceMs: number;
	/** When supplied, resolve this many milliseconds after the SIGKILL attempt even if no exit event arrives. */
	killWaitMs?: number;
	/** Target the detached process group on POSIX instead of the pid. */
	group?: boolean;
}

/**
 * Graceful termination escalation: SIGTERM immediately, SIGKILL at `graceMs`
 * (unless the child already exited), and resolution on `exit` or `close` — or,
 * with `killWaitMs`, that long after the SIGKILL attempt. Every signal failure
 * is contained, so the call is safe to fire-and-forget with `void`. Invalid
 * options throw synchronously before any listener or timer is installed.
 */
export function terminateChildProcess(
	child: ChildProcess,
	options: TerminateChildProcessOptions,
): Promise<void> {
	if (!Number.isInteger(options.graceMs) || options.graceMs < 0) {
		throw new Error(`graceMs must be a nonnegative integer, received ${options.graceMs}.`);
	}
	if (options.killWaitMs !== undefined && (!Number.isInteger(options.killWaitMs) || options.killWaitMs < 0)) {
		throw new Error(`killWaitMs must be a nonnegative integer, received ${options.killWaitMs}.`);
	}
	if ((child.exitCode ?? null) !== null || (child.signalCode ?? null) !== null) return Promise.resolve();

	return new Promise<void>((resolve) => {
		let settled = false;
		let killTimer: NodeJS.Timeout | undefined;
		let giveUpTimer: NodeJS.Timeout | undefined;
		const onExit = () => finish();
		const onClose = () => finish();
		const finish = (): void => {
			if (settled) return;
			settled = true;
			if (killTimer) clearTimeout(killTimer);
			if (giveUpTimer) clearTimeout(giveUpTimer);
			child.off("exit", onExit);
			child.off("close", onClose);
			resolve();
		};
		const sendSignal = (signal: NodeJS.Signals): void => {
			try {
				if (options.group && process.platform !== "win32" && child.pid) {
					try {
						process.kill(-child.pid, signal);
						return;
					} catch { /* fall back to the pid signal */ }
				}
				child.kill(signal);
			} catch { /* signaling failures never reject the termination promise */ }
		};

		child.once("exit", onExit);
		child.once("close", onClose);
		if (options.graceMs > 0) {
			killTimer = setTimeout(() => {
				killTimer = undefined;
				sendSignal("SIGKILL");
				if (options.killWaitMs !== undefined) giveUpTimer = setTimeout(finish, options.killWaitMs);
			}, options.graceMs);
		}
		sendSignal("SIGTERM");
		if (options.graceMs === 0 && !settled) {
			sendSignal("SIGKILL");
			if (options.killWaitMs !== undefined) giveUpTimer = setTimeout(finish, options.killWaitMs);
		}
	});
}