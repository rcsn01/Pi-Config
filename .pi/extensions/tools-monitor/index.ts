/**
 * Monitor Extension
 *
 * Watches long-running work (builds, test suites, migrations) in the
 * background and reports only what matters: failure signs, a completion line,
 * and the end of the process with the last lines of output. Progress lines
 * update the status line without waking the agent.
 *
 * Tools:
 *   monitor_start   - run a command, or follow a log file (optionally tied to a pid)
 *   monitor_status  - latest progress and recent output of one or all monitors
 *   monitor_stop    - stop a monitor (kills a command the monitor started)
 *
 * Command:
 *   /monitors              - list monitors
 *   /monitors stop <id>    - stop one
 *
 * Monitors belong to the session: commands they started are killed on
 * session shutdown, reload, or session switch. Work that must outlive the
 * session should run under nohup/launchd and be followed with `log_path`.
 */

import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { declareStatus } from "../_shared/status-registry.ts";
import { renderTranscriptCard, normalizeTranscriptContent, type TranscriptCardState } from "../_shared/transcript-card.ts";
import {
	DEFAULT_ALERT,
	DEFAULT_TIMEOUT_MINUTES,
	MAX_TIMEOUT_MINUTES,
	Monitor,
	type MonitorReport,
	type MonitorSnapshot,
	type MonitorSource,
	type MonitorTiming,
} from "./monitor.ts";

export const MONITOR_STATUS_ID = "monitor";
export const MONITOR_MESSAGE_TYPE = "monitor-event";
const MAX_ACTIVE = 8;

declareStatus({ id: MONITOR_STATUS_ID, style: "accent", order: 100 });

const StartParams = Type.Object({
	command: Type.Optional(Type.String({
		description: "Shell command to run and watch (bash -c, in the session cwd). Its stdout and stderr are filtered. Mutually exclusive with log_path.",
	})),
	log_path: Type.Optional(Type.String({
		description: "Log file to follow instead of running a command, e.g. output of a build started with nohup or by launchd.",
	})),
	pid: Type.Optional(Type.Number({
		description: "With log_path: process id to watch; the monitor ends when it exits.",
	})),
	from_start: Type.Optional(Type.Boolean({
		description: "With log_path: read existing content too. Default false (only new lines).",
	})),
	label: Type.Optional(Type.String({ description: "Short name shown in the status line and reports." })),
	include: Type.Optional(Type.String({
		description: "Regex for progress lines. Shown in the status line and kept as latest progress; never wakes you.",
	})),
	alert: Type.Optional(Type.String({
		description: `Regex for failure signs that are reported to you. Default: ${DEFAULT_ALERT}. Empty string disables alerts.`,
	})),
	done: Type.Optional(Type.String({
		description: "Regex for the completion line (e.g. '^wrote '). Reported to you; ends a log_path monitor.",
	})),
	timeout_minutes: Type.Optional(Type.Number({
		description: `Hard expiry; the monitor ends (and kills its command) after this. Default ${DEFAULT_TIMEOUT_MINUTES}, max ${MAX_TIMEOUT_MINUTES}.`,
	})),
});

const StatusParams = Type.Object({
	id: Type.Optional(Type.String({ description: "Monitor id; omit for all monitors." })),
	tail_lines: Type.Optional(Type.Number({ description: "Recent output lines to include (default 10, max 100)." })),
});

const StopParams = Type.Object({
	id: Type.String({ description: "Monitor id to stop." }),
});

function formatSnapshot(snapshot: MonitorSnapshot, now: number): string {
	const end = snapshot.finishedAt ?? now;
	const lines = [
		`${snapshot.id} [${snapshot.state}] ${snapshot.label} — ${snapshot.source}, ${Math.round((end - snapshot.startedAt) / 1000)}s, alerts ${snapshot.alertCount}`,
	];
	if (snapshot.finish) lines.push(`  finish: ${JSON.stringify(snapshot.finish)}`);
	if (snapshot.latest) lines.push(`  latest: ${snapshot.latest}`);
	if (snapshot.tail.length > 0) lines.push(`  recent output:\n${snapshot.tail.map((line) => `    ${line}`).join("\n")}`);
	return lines.join("\n");
}

function cardState(severity: MonitorReport["severity"]): TranscriptCardState {
	if (severity === "failure") return "error";
	if (severity === "alert") return "warning";
	if (severity === "success") return "success";
	return "neutral";
}

export function createMonitorExtension(timing: Partial<MonitorTiming> = {}) {
	return function monitorExtension(pi: ExtensionAPI): void {
		const monitors = new Map<string, Monitor>();
		const pendingCompletions = new Map<string, MonitorReport>();
		const acknowledgedCompletions = new Set<string>();
		let context: ExtensionContext | undefined;
		let nextId = 1;
		let ui: ExtensionContext["ui"] | undefined;

		const active = () => [...monitors.values()].filter((monitor) => monitor.running);

		const refreshStatus = () => {
			if (!ui) return;
			const running = active();
			const text = running.length === 0
				? undefined
				: running.length === 1
					? `⏱ ${running[0].statusText()}`.slice(0, 80)
					: `⏱ ${running.length} monitors`;
			ui.setStatus(MONITOR_STATUS_ID, text);
		};

		const host = {
			publish(report: MonitorReport) {
				// Pi's follow-up queue cannot retract messages. Keep busy-session
				// completions here so status reads can acknowledge them before delivery.
				if (report.snapshot.state === "finished" && context && !context.isIdle()) {
					pendingCompletions.set(report.id, report);
					return;
				}
				pi.sendMessage(
					{ customType: MONITOR_MESSAGE_TYPE, content: report.content, display: true, details: report },
					{ triggerTurn: report.wake, deliverAs: "followUp" },
				);
			},
			statusChanged: refreshStatus,
		};

		const stopAll = async () => {
			const running = active();
			await Promise.all(running.map((monitor) => monitor.stop()));
			ui?.setStatus(MONITOR_STATUS_ID, undefined);
		};

		const find = (id: string): Monitor => {
			const monitor = monitors.get(id.trim());
			if (!monitor) throw new Error(`Unknown monitor: ${id}. Known: ${[...monitors.keys()].join(", ") || "none"}.`);
			return monitor;
		};

		pi.on("session_start", (_event, ctx) => {
			context = ctx;
			ui = ctx.hasUI ? ctx.ui : undefined;
		});
		pi.on("agent_before_settle", (event) => {
			const unread = [...pendingCompletions.values()].filter((report) => !acknowledgedCompletions.has(report.id));
			pendingCompletions.clear();
			if (unread.length === 0) return;
			return {
				entries: [...event.entries, ...unread.map((report) => ({
					type: "custom_message" as const,
					customType: MONITOR_MESSAGE_TYPE,
					content: report.content,
					display: true,
					details: report,
				}))],
				continue: event.continue || unread.some((report) => report.wake),
			};
		});
		pi.on("session_shutdown", async () => {
			await stopAll();
			monitors.clear();
			pendingCompletions.clear();
			acknowledgedCompletions.clear();
			context = undefined;
			ui = undefined;
		});

		pi.registerMessageRenderer(MONITOR_MESSAGE_TYPE, (message, options, theme) => {
			const report = message.details as MonitorReport | undefined;
			return renderTranscriptCard(theme, {
				title: `Monitor ${report?.id ?? ""}${report ? ` · ${report.label}` : ""}`,
				state: report ? cardState(report.severity) : "neutral",
				body: "```\n" + normalizeTranscriptContent(message.content) + "\n```",
				summary: normalizeTranscriptContent(message.content).split("\n")[0],
				expanded: options.expanded || report?.snapshot.state === "running" || report?.severity === "failure",
			});
		});

		pi.registerTool({
			name: "monitor_start",
			label: "Monitor",
			description:
				"Watch long-running work (builds, test suites, migrations) in the background instead of blocking or polling. "
				+ "Give either `command` (run and watched by the monitor) or `log_path` (follow a file written by work started elsewhere, optionally with `pid`). "
				+ "Returns immediately. Alert lines, the done line, and the final result (exit, last output lines) arrive later as follow-up messages that wake you; "
				+ "progress lines only update the status line, read them with monitor_status. Always keep failure patterns in `alert` so a crash is not mistaken for silence. "
				+ "Commands are killed when the monitor stops, expires, or the session ends; for work that must outlive the session, start it with nohup writing to a log and follow that log.",
			promptSnippet: "Watch long-running builds/logs in the background",
			parameters: StartParams,
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				if (ctx.mode === "print" || ctx.mode === "json") {
					throw new Error("monitor_start needs an interactive or RPC session; print/JSON runs end before the work does.");
				}
				if (ctx.hasUI) ui = ctx.ui;
				const hasCommand = typeof params.command === "string" && params.command.trim() !== "";
				const hasLog = typeof params.log_path === "string" && params.log_path.trim() !== "";
				if (hasCommand === hasLog) throw new Error("Provide exactly one of command or log_path.");
				if (!hasLog && (params.pid !== undefined || params.from_start !== undefined)) {
					throw new Error("pid and from_start only apply with log_path.");
				}
				if (active().length >= MAX_ACTIVE) throw new Error(`At most ${MAX_ACTIVE} monitors can run at once; stop one first.`);

				const source: MonitorSource = hasCommand
					? { kind: "command", command: params.command!, cwd: ctx.cwd }
					: {
						kind: "log",
						path: path.resolve(ctx.cwd, params.log_path!.replace(/^~(?=$|\/)/, process.env.HOME ?? "~")),
						pid: params.pid,
						fromStart: params.from_start ?? false,
					};
				const id = `m${nextId}`;
				const monitor = new Monitor(id, {
					label: params.label,
					source,
					include: params.include,
					alert: params.alert,
					done: params.done,
					timeoutMinutes: params.timeout_minutes,
				}, host, timing);
				await monitor.start();
				nextId++;
				monitors.set(id, monitor);
				refreshStatus();

				const snapshot = monitor.snapshot(0);
				return {
					content: [{
						type: "text",
						text: `Monitor ${id} started (${snapshot.source}). Expires in ${params.timeout_minutes ?? DEFAULT_TIMEOUT_MINUTES} min. `
							+ "Alerts and the final result will arrive as follow-up messages; continue with other work or end your turn.",
					}],
					details: snapshot,
				};
			},
		});

		pi.registerTool({
			name: "monitor_status",
			label: "Monitor Status",
			description: "Show latest progress and recent output for one or all monitors started with monitor_start. Reading a finished result acknowledges it and suppresses its pending completion notification.",
			promptSnippet: "Check background monitors",
			parameters: StatusParams,
			async execute(_toolCallId, params) {
				const tail = Math.max(0, Math.min(100, Math.floor(params.tail_lines ?? 10)));
				const selected = params.id ? [find(params.id)] : [...monitors.values()];
				const snapshots = selected.map((monitor) => monitor.snapshot(tail));
				for (const snapshot of snapshots) {
					if (snapshot.state === "finished") acknowledgedCompletions.add(snapshot.id);
				}
				const now = Date.now();
				return {
					content: [{ type: "text", text: snapshots.length === 0 ? "No monitors." : snapshots.map((s) => formatSnapshot(s, now)).join("\n\n") }],
					details: { monitors: snapshots },
				};
			},
		});

		pi.registerTool({
			name: "monitor_stop",
			label: "Stop Monitor",
			description: "Stop a monitor. A command started by the monitor is killed; a followed log's writer is left alone.",
			promptSnippet: "Stop a background monitor",
			parameters: StopParams,
			async execute(_toolCallId, params) {
				const monitor = find(params.id);
				const wasRunning = monitor.running;
				await monitor.stop();
				refreshStatus();
				const snapshot = monitor.snapshot(10);
				return {
					content: [{ type: "text", text: `${wasRunning ? "Stopped" : "Already finished"}: ${formatSnapshot(snapshot, Date.now())}` }],
					details: snapshot,
				};
			},
		});

		pi.registerCommand("monitors", {
			description: "List background monitors, or stop one: /monitors stop <id>",
			handler: async (args, ctx) => {
				const [verb, id] = args.trim().split(/\s+/);
				if (verb === "stop") {
					if (!id) return ctx.ui.notify("Usage: /monitors stop <id>", "warning");
					try {
						const monitor = find(id);
						await monitor.stop();
						refreshStatus();
						ctx.ui.notify(`Stopped monitor ${monitor.id}.`, "info");
					} catch (error) {
						ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
					}
					return;
				}
				const now = Date.now();
				const text = monitors.size === 0
					? "No monitors."
					: [...monitors.values()].map((monitor) => formatSnapshot(monitor.snapshot(0), now)).join("\n");
				ctx.ui.notify(text, "info");
			},
		});
	};
}

export default createMonitorExtension();
