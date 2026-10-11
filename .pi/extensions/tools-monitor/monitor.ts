/**
 * Monitor core: watches a long-running command or a growing log file, keeps
 * only the lines worth knowing about, and reports them as batched events.
 *
 * Line classes, checked in order:
 *   alert    - failure signs; reported and wakes the agent
 *   done     - completion line; reported and wakes the agent (ends log monitors)
 *   progress - shown in the status line and kept as `latest`; never wakes the agent
 * Every line goes into a bounded tail that the final report quotes.
 *
 * A monitor ends when its command exits, its watched pid exits, a log monitor
 * sees a done line, it is stopped, or its hard expiry fires. Pi wiring stays in
 * index.ts; this module only needs a `publish` callback and a status callback.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createLineReader, spawnInGroup, type SpawnProcess } from "../_shared/child-process.ts";

export const DEFAULT_ALERT = String.raw`Traceback|\bError\b|\bERROR\b|\bFAIL(ED)?\b|\bfailed\b|panic:|Exception`;
export const DEFAULT_TIMEOUT_MINUTES = 30;
export const MAX_TIMEOUT_MINUTES = 240;

const TAIL_LINES = 200;
const FINAL_TAIL_LINES = 15;
const MAX_LINE_CHARS = 500;
const MAX_LINE_BYTES = 64 * 1024;
const LINES_PER_REPORT = 10;
const MAX_ALERT_REPORTS = 5;
const READ_CHUNK_BYTES = 1024 * 1024;

export type MonitorSource =
	| { kind: "command"; command: string; cwd: string }
	| { kind: "log"; path: string; pid?: number; fromStart: boolean };

export interface MonitorSpec {
	label?: string;
	source: MonitorSource;
	include?: string;
	alert?: string;
	done?: string;
	timeoutMinutes?: number;
}

export type FinishReason =
	| { kind: "exited"; code: number | null }
	| { kind: "pid-exited"; pid: number }
	| { kind: "done" }
	| { kind: "expired"; minutes: number }
	| { kind: "stopped" }
	| { kind: "spawn-error"; message: string }
	| { kind: "read-error"; message: string };

export interface MonitorSnapshot {
	id: string;
	label: string;
	source: string;
	state: "running" | "finished";
	startedAt: number;
	finishedAt?: number;
	latest?: string;
	alertCount: number;
	suppressedAlerts: number;
	finish?: FinishReason;
	tail: string[];
}

export interface MonitorReport {
	id: string;
	label: string;
	/** Model-facing text. */
	content: string;
	/** True when the report should wake the agent. */
	wake: boolean;
	severity: "info" | "alert" | "success" | "failure";
	snapshot: MonitorSnapshot;
}

export interface MonitorHost {
	publish(report: MonitorReport): void;
	statusChanged(): void;
}

export interface MonitorTiming {
	/** Batch window for reportable lines. */
	flushMs: number;
	/** Log polling interval. */
	pollMs: number;
	spawnProcess?: SpawnProcess;
	now?: () => number;
}

const DEFAULT_TIMING: MonitorTiming = { flushMs: 2000, pollMs: 1000 };

function compile(name: string, pattern: string | undefined): RegExp | undefined {
	if (pattern === undefined || pattern === "") return undefined;
	try {
		return new RegExp(pattern);
	} catch (error) {
		throw new Error(`Invalid ${name} regex: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function clip(line: string): string {
	return line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line;
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function describeSource(source: MonitorSource): string {
	if (source.kind === "command") return `command: ${source.command}`;
	return `log: ${source.path}${source.pid ? ` (pid ${source.pid})` : ""}`;
}

function describeFinish(reason: FinishReason, source: MonitorSource): string {
	switch (reason.kind) {
		case "exited": return reason.code === 0 ? "command exited successfully (code 0)" : `command exited with code ${reason.code ?? "unknown (signal)"}`;
		case "pid-exited": return `watched process ${reason.pid} exited (exit code unknown)`;
		case "done": return "completion line seen";
		case "expired": return `monitor expired after ${reason.minutes} minutes${source.kind === "command" ? "; the command was killed" : ""}`;
		case "stopped": return "monitor stopped";
		case "spawn-error": return `command could not start: ${reason.message}`;
		case "read-error": return `log could not be read: ${reason.message}`;
	}
}

export class Monitor {
	readonly id: string;
	readonly label: string;
	private readonly source: MonitorSource;
	private readonly include?: RegExp;
	private readonly alert?: RegExp;
	private readonly done?: RegExp;
	private readonly timeoutMinutes: number;
	private readonly host: MonitorHost;
	private readonly timing: MonitorTiming;
	private readonly now: () => number;
	private readonly startedAt: number;
	private readonly tail: string[] = [];
	private latest?: string;
	private pending: Array<{ kind: "alert" | "done"; line: string }> = [];
	private flushTimer?: NodeJS.Timeout;
	private expiryTimer?: NodeJS.Timeout;
	private pollTimer?: NodeJS.Timeout;
	private alertCount = 0;
	private alertReports = 0;
	private suppressedAlerts = 0;
	private finishReason?: FinishReason;
	private finishedAt?: number;
	private readonly abort = new AbortController();
	private finished!: Promise<void>;

	constructor(id: string, spec: MonitorSpec, host: MonitorHost, timing: Partial<MonitorTiming> = {}) {
		this.id = id;
		this.source = spec.source;
		this.label = spec.label?.trim()
			|| (spec.source.kind === "command" ? spec.source.command.slice(0, 40) : path.basename(spec.source.path));
		this.include = compile("include", spec.include);
		this.alert = compile("alert", spec.alert ?? DEFAULT_ALERT);
		this.done = compile("done", spec.done);
		const minutes = spec.timeoutMinutes ?? DEFAULT_TIMEOUT_MINUTES;
		if (!(minutes > 0) || minutes > MAX_TIMEOUT_MINUTES) {
			throw new Error(`timeout_minutes must be between 0 and ${MAX_TIMEOUT_MINUTES}.`);
		}
		this.timeoutMinutes = minutes;
		this.host = host;
		this.timing = { ...DEFAULT_TIMING, ...timing };
		this.now = this.timing.now ?? Date.now;
		this.startedAt = this.now();
	}

	/** Starts watching. Resolves when watching has begun; `whenFinished()` resolves at the end. */
	async start(): Promise<void> {
		if (this.source.kind === "log") {
			const { pid } = this.source;
			if (pid !== undefined && (!Number.isInteger(pid) || pid <= 0 || !pidAlive(pid))) {
				throw new Error(`Process ${pid} is not running.`);
			}
		}
		// Fix the log offset before returning so lines written right after start are not skipped.
		const offset = this.source.kind === "log" ? await this.initialOffset(this.source) : 0;
		this.expiryTimer = setTimeout(() => this.finish({ kind: "expired", minutes: this.timeoutMinutes }), this.timeoutMinutes * 60_000);
		this.finished = this.source.kind === "command"
			? this.runCommand(this.source)
			: this.followLog(this.source, offset);
	}

	whenFinished(): Promise<void> {
		return this.finished;
	}

	get running(): boolean {
		return this.finishReason === undefined;
	}

	/** Stops watching (and kills an owned command) without publishing a report. */
	stop(): Promise<void> {
		this.finish({ kind: "stopped" });
		return this.finished ?? Promise.resolve();
	}

	snapshot(tailLines = 10): MonitorSnapshot {
		return {
			id: this.id,
			label: this.label,
			source: describeSource(this.source),
			state: this.running ? "running" : "finished",
			startedAt: this.startedAt,
			finishedAt: this.finishedAt,
			latest: this.latest,
			alertCount: this.alertCount,
			suppressedAlerts: this.suppressedAlerts,
			finish: this.finishReason,
			tail: tailLines > 0 ? this.tail.slice(-tailLines) : [],
		};
	}

	statusText(): string {
		return this.latest ? `${this.label}: ${this.latest}` : `${this.label}: running`;
	}

	// ── Line handling ─────────────────────────────────────────────

	private onLine(raw: string): void {
		if (!this.running) return;
		const line = clip(raw);
		this.tail.push(line);
		if (this.tail.length > TAIL_LINES) this.tail.shift();

		if (this.alert?.test(line)) {
			this.alertCount++;
			if (this.alertReports >= MAX_ALERT_REPORTS) {
				this.suppressedAlerts++;
				return;
			}
			this.queue({ kind: "alert", line });
		} else if (this.done?.test(line)) {
			this.queue({ kind: "done", line });
			if (this.source.kind === "log") this.finish({ kind: "done" });
		} else if (this.include?.test(line)) {
			this.latest = line;
			this.host.statusChanged();
		}
	}

	private queue(event: { kind: "alert" | "done"; line: string }): void {
		this.pending.push(event);
		this.flushTimer ??= setTimeout(() => this.flush(), this.timing.flushMs);
	}

	private flush(): void {
		if (this.flushTimer) clearTimeout(this.flushTimer);
		this.flushTimer = undefined;
		if (this.pending.length === 0 || !this.running) return;
		const events = this.pending;
		this.pending = [];
		const alerts = events.filter((event) => event.kind === "alert");
		if (alerts.length > 0) this.alertReports++;
		const shown = events.slice(0, LINES_PER_REPORT).map((event) => `${event.kind === "alert" ? "ALERT" : "DONE"}: ${event.line}`);
		const more = events.length - shown.length;
		const budget = alerts.length > 0 && this.alertReports >= MAX_ALERT_REPORTS
			? "\n(Alert report limit reached; further alerts are counted and summarized when the monitor ends.)"
			: "";
		this.host.publish({
			id: this.id,
			label: this.label,
			content: `Monitor ${this.id} (${this.label}):\n${shown.join("\n")}${more > 0 ? `\n… ${more} more` : ""}${this.progressLine()}${budget}`,
			wake: true,
			severity: alerts.length > 0 ? "alert" : "success",
			snapshot: this.snapshot(0),
		});
	}

	private progressLine(): string {
		return this.latest ? `\nLatest progress: ${this.latest}` : "";
	}

	// ── Finishing ─────────────────────────────────────────────────

	private finish(reason: FinishReason): void {
		if (!this.running) return;
		// Queued lines go into the final report instead of a separate one.
		if (this.flushTimer) clearTimeout(this.flushTimer);
		this.flushTimer = undefined;
		const unreported = this.pending;
		this.pending = [];
		this.finishReason = reason;
		this.finishedAt = this.now();
		if (this.expiryTimer) clearTimeout(this.expiryTimer);
		if (this.pollTimer) clearTimeout(this.pollTimer);
		this.abort.abort();
		this.host.statusChanged();
		if (reason.kind === "stopped") return;

		const failed = reason.kind === "spawn-error" || reason.kind === "read-error" || reason.kind === "expired"
			|| (reason.kind === "exited" && reason.code !== 0);
		const seconds = Math.round((this.finishedAt - this.startedAt) / 1000);
		const tail = this.tail.slice(-FINAL_TAIL_LINES);
		const lines = [
			`Monitor ${this.id} (${this.label}) ended: ${describeFinish(reason, this.source)} after ${seconds}s.`,
			`Alerts: ${this.alertCount}${this.suppressedAlerts > 0 ? ` (${this.suppressedAlerts} not reported individually)` : ""}.`,
		];
		if (unreported.length > 0) {
			lines.push(...unreported.slice(0, LINES_PER_REPORT).map((event) => `${event.kind === "alert" ? "ALERT" : "DONE"}: ${event.line}`));
		}
		if (this.latest) lines.push(`Latest progress: ${this.latest}`);
		lines.push(tail.length > 0 ? `Last ${tail.length} lines:\n${tail.join("\n")}` : "No output captured.");
		this.host.publish({
			id: this.id,
			label: this.label,
			content: lines.join("\n"),
			wake: true,
			severity: failed ? "failure" : this.alertCount > 0 ? "alert" : "success",
			snapshot: this.snapshot(FINAL_TAIL_LINES),
		});
	}

	// ── Command mode ──────────────────────────────────────────────

	private async runCommand(source: Extract<MonitorSource, { kind: "command" }>): Promise<void> {
		const stdout = createLineReader((line) => this.onLine(line), { maxLineBytes: MAX_LINE_BYTES });
		const stderr = createLineReader((line) => this.onLine(line), { maxLineBytes: MAX_LINE_BYTES });
		const outcome = await spawnInGroup({
			command: "bash",
			args: ["-c", source.command],
			cwd: source.cwd,
			// Pipes make many runtimes block-buffer; ask Python to flush per line.
			env: { ...process.env, PYTHONUNBUFFERED: "1" },
			stdio: ["ignore", "pipe", "pipe"],
			signal: this.abort.signal,
			onStdout: (chunk) => stdout.push(chunk),
			onStderr: (chunk) => stderr.push(chunk),
			spawnProcess: this.timing.spawnProcess,
		});
		stdout.end();
		stderr.end();
		if (outcome.kind === "exit") this.finish({ kind: "exited", code: outcome.exitCode });
		else if (outcome.kind === "spawn-error") this.finish({ kind: "spawn-error", message: outcome.error.message });
		// "aborted": finish() already ran (stop or expiry) and triggered the abort.
	}

	// ── Log mode ──────────────────────────────────────────────────

	private async initialOffset(source: Extract<MonitorSource, { kind: "log" }>): Promise<number> {
		if (source.fromStart) return 0;
		try {
			return (await fs.stat(source.path)).size;
		} catch {
			return 0; // Not created yet: read it from the start once it appears.
		}
	}

	private async followLog(source: Extract<MonitorSource, { kind: "log" }>, startOffset: number): Promise<void> {
		let offset = startOffset;
		let reader = createLineReader((line) => this.onLine(line), { maxLineBytes: MAX_LINE_BYTES });

		const readNew = async (): Promise<void> => {
			let size: number;
			try {
				size = (await fs.stat(source.path)).size;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
				throw error;
			}
			if (size < offset) {
				// Truncated or rotated: start over.
				reader.end();
				reader = createLineReader((line) => this.onLine(line), { maxLineBytes: MAX_LINE_BYTES });
				offset = 0;
			}
			if (size === offset) return;
			const handle = await fs.open(source.path, "r");
			try {
				while (offset < size && this.running) {
					const buffer = Buffer.alloc(Math.min(READ_CHUNK_BYTES, size - offset));
					const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
					if (bytesRead === 0) break;
					offset += bytesRead;
					reader.push(buffer.subarray(0, bytesRead));
				}
			} finally {
				await handle.close();
			}
		};

		await new Promise<void>((resolve) => {
			const tick = async () => {
				this.pollTimer = undefined;
				if (!this.running) return resolve();
				try {
					await readNew();
					if (this.running && source.pid !== undefined && !pidAlive(source.pid)) {
						await readNew();
						reader.end();
						this.finish({ kind: "pid-exited", pid: source.pid });
					}
				} catch (error) {
					this.finish({ kind: "read-error", message: error instanceof Error ? error.message : String(error) });
				}
				if (!this.running) return resolve();
				this.pollTimer = setTimeout(tick, this.timing.pollMs);
			};
			this.abort.signal.addEventListener("abort", () => resolve(), { once: true });
			void tick();
		});
	}
}
