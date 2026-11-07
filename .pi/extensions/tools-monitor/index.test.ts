import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMonitorExtension, MONITOR_MESSAGE_TYPE, MONITOR_STATUS_ID } from "./index.ts";
import type { MonitorReport } from "./monitor.ts";

interface Sent {
	message: { customType: string; content: string; details: MonitorReport };
	options: { triggerTurn?: boolean; deliverAs?: string };
}

function harness(mode: "tui" | "print" = "tui") {
	const tools = new Map<string, any>();
	const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
	const emit = (name: string, event: any) => {
		let result: any;
		for (const handler of handlers.get(name) ?? []) result = handler(event, ctx) ?? result;
		return result;
	};
	const commands = new Map<string, any>();
	const sent: Sent[] = [];
	const statuses: Array<string | undefined> = [];
	const ui = { setStatus: (key: string, text: string | undefined) => { if (key === MONITOR_STATUS_ID) statuses.push(text); }, notify: () => {} };
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "monitor-test-"));
	let busy = false;
	const ctx = { cwd, mode, hasUI: mode === "tui", ui, isIdle: () => !busy };
	createMonitorExtension({ flushMs: 30, pollMs: 20 })({
		on: (name: string, handler: any) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
		registerTool: (tool: any) => tools.set(tool.name, tool),
		registerCommand: (name: string, command: any) => commands.set(name, command),
		registerMessageRenderer: () => {},
		sendMessage: (message: any, options: any) => sent.push({ message, options }),
	} as any);
	emit("session_start", { type: "session_start" });
	return {
		cwd,
		sent,
		statuses,
		setBusy: (value: boolean) => { busy = value; },
		settle: (entries: unknown[] = []) => emit("agent_before_settle", { type: "agent_before_settle", entries, continue: false }),
		start: (params: Record<string, unknown>) => tools.get("monitor_start").execute("call", params, undefined, undefined, ctx),
		status: (params: Record<string, unknown> = {}) => tools.get("monitor_status").execute("call", params, undefined, undefined, ctx),
		stop: (id: string) => tools.get("monitor_stop").execute("call", { id }, undefined, undefined, ctx),
		shutdown: () => emit("session_shutdown", { type: "session_shutdown" }),
	};
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("timed out waiting for condition");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

const finalReport = (sent: Sent[]) => sent.find((entry) => entry.message.details.snapshot.state === "finished");

let current: ReturnType<typeof harness> | undefined;
function setup(mode: "tui" | "print" = "tui") {
	current = harness(mode);
	return current;
}
afterEach(async () => {
	await current?.shutdown();
	current = undefined;
});

describe("command monitors", () => {
	it("keeps progress in the UI and reports command alerts only at exit", async () => {
		const h = setup();
		const result = await h.start({
			command: "echo 'Jira: 1/3'; echo 'Jira: 2/3'; sleep 0.1; echo 'Error: boom' >&2; sleep 0.1; echo 'wrote out.json'",
			include: "^Jira:",
			label: "build",
		});
		expect(result.content[0].text).toContain("Monitor m1 started");

		await waitFor(() => finalReport(h.sent) !== undefined);
		expect(h.statuses).toContain("⏱ build: Jira: 2/3");
		expect(h.statuses.at(-1)).toBeUndefined();

		const [final] = h.sent;
		expect(h.sent).toHaveLength(1);
		expect(final.message.customType).toBe(MONITOR_MESSAGE_TYPE);
		expect(final.message.content).toContain("Error: boom");
		expect(final.message.details.snapshot.latest).toBe("Jira: 2/3");
		expect(final.options).toEqual({ triggerTurn: true, deliverAs: "followUp" });
		expect(final.message.content).toContain("command exited successfully (code 0)");
		expect(final.message.content).toContain("wrote out.json");
		expect(final.message.details.severity).toBe("alert");
	});

	it("reports a failing exit as a failure", async () => {
		const h = setup();
		await h.start({ command: "echo working; exit 3" });
		await waitFor(() => finalReport(h.sent) !== undefined);
		const final = finalReport(h.sent)!;
		expect(final.message.content).toContain("exited with code 3");
		expect(final.message.details.severity).toBe("failure");
	});

	it("kills the command at the hard expiry and says so", async () => {
		const h = setup();
		const marker = path.join(h.cwd, "still-running");
		await h.start({ command: `sleep 1; touch ${marker}`, timeout_minutes: 0.003 });
		await waitFor(() => finalReport(h.sent) !== undefined);
		expect(finalReport(h.sent)!.message.content).toMatch(/expired after .* the command was killed/);
		await new Promise((resolve) => setTimeout(resolve, 1200));
		expect(fs.existsSync(marker)).toBe(false);
	});

	it("stops quietly and kills the command", async () => {
		const h = setup();
		const marker = path.join(h.cwd, "still-running");
		await h.start({ command: `sleep 0.5; touch ${marker}` });
		const stopped = await h.stop("m1");
		expect(stopped.content[0].text).toContain("Stopped: m1 [finished]");
		await new Promise((resolve) => setTimeout(resolve, 800));
		expect(fs.existsSync(marker)).toBe(false);
		expect(h.sent).toEqual([]);
	});

	it("reports a noisy command only once", async () => {
		const h = setup();
		await h.start({ command: "for i in $(seq 1 40); do echo \"Error $i\"; sleep 0.04; done" });
		await waitFor(() => finalReport(h.sent) !== undefined, 10_000);
		expect(h.sent).toHaveLength(1);
		const final = finalReport(h.sent)!;
		expect(final.message.content).toContain("Alerts: 40");
	});

	it("kills running commands on session shutdown", async () => {
		const h = setup();
		const marker = path.join(h.cwd, "still-running");
		await h.start({ command: `sleep 0.5; touch ${marker}` });
		await h.shutdown();
		await new Promise((resolve) => setTimeout(resolve, 800));
		expect(fs.existsSync(marker)).toBe(false);
		expect(h.sent).toEqual([]);
	});
});

describe("completion acknowledgement", () => {
	it.each([0, 3])("suppresses a queued exit %i completion read through status", async (code) => {
		const h = setup();
		h.setBusy(true);
		await h.start({ command: `echo result; exit ${code}` });
		await waitFor(() => h.statuses.length > 0 && h.statuses.at(-1) === undefined);
		const status = await h.status({ id: "m1" });
		expect(status.details.monitors[0].finish).toEqual({ kind: "exited", code });
		expect(status.content[0].text).toContain(`"code":${code}`);
		expect(h.settle()).toBeUndefined();
		expect(h.sent).toEqual([]);
	});

	it("delivers an unread completion once at settlement", async () => {
		const h = setup();
		h.setBusy(true);
		await h.start({ command: "echo result; exit 3" });
		await waitFor(() => h.statuses.length > 0 && h.statuses.at(-1) === undefined);
		const delivery = h.settle();
		expect(delivery.continue).toBe(true);
		expect(delivery.entries).toHaveLength(1);
		expect(delivery.entries[0]).toMatchObject({ type: "custom_message", customType: MONITOR_MESSAGE_TYPE });
		expect(delivery.entries[0].content).toContain("exited with code 3");
		expect(h.sent).toEqual([]);
		expect(h.settle()).toBeUndefined();
	});

	it("does not acknowledge completion when status only reads progress", async () => {
		const h = setup();
		h.setBusy(true);
		const log = path.join(h.cwd, "progress.log");
		fs.writeFileSync(log, "step 1\n");
		await h.start({ log_path: log, from_start: true, include: "^step", done: "^done" });
		await waitFor(() => h.statuses.some((text) => text?.includes("step 1")));
		expect((await h.status()).details.monitors[0].state).toBe("running");
		fs.appendFileSync(log, "done\n");
		await waitFor(() => h.statuses.at(-1) === undefined);
		expect(h.settle().entries[0].content).toContain("completion line seen");
	});

	it("acknowledges every finished result in an all-monitor status read", async () => {
		const h = setup();
		h.setBusy(true);
		await h.start({ command: "true" });
		await h.start({ command: "exit 3" });
		await waitFor(() => h.statuses.at(-1) === undefined);
		expect((await h.status()).details.monitors.map((s: any) => s.state)).toEqual(["finished", "finished"]);
		expect(h.settle()).toBeUndefined();
		expect(h.sent).toEqual([]);
	});

	it("leaves other monitors unread when status selects one", async () => {
		const h = setup();
		h.setBusy(true);
		await h.start({ command: "true" });
		await h.start({ command: "exit 3" });
		await waitFor(() => h.statuses.at(-1) === undefined);
		await h.status({ id: "m1", tail_lines: 0 });
		const existing = { type: "custom", customType: "other-extension", data: {} };
		const delivery = h.settle([existing]);
		expect(delivery.entries).toHaveLength(2);
		expect(delivery.entries[0]).toEqual(existing);
		expect(delivery.entries[1].details.id).toBe("m2");
		expect(h.sent).toEqual([]);
	});

	it("retains running alerts when a later completion is explicitly acknowledged", async () => {
		const h = setup();
		h.setBusy(true);
		const log = path.join(h.cwd, "alerts.log");
		fs.writeFileSync(log, "");
		await h.start({ log_path: log, done: "^done", continuous: true });
		fs.appendFileSync(log, "Error: boom\n");
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(h.sent).toEqual([]);
		fs.appendFileSync(log, "done\n");
		await waitFor(() => h.statuses.at(-1) === undefined);
		await h.status();
		const delivery = h.settle();
		expect(delivery.entries).toHaveLength(1);
		expect(delivery.entries[0].details.snapshot.state).toBe("running");
		expect(h.sent).toEqual([]);
	});

	it("discards queued continuous alerts when the watch is stopped", async () => {
		const h = setup();
		h.setBusy(true);
		const log = path.join(h.cwd, "stopped.log");
		fs.writeFileSync(log, "");
		await h.start({ log_path: log, continuous: true });
		fs.appendFileSync(log, "Error: no longer relevant\n");
		await new Promise((resolve) => setTimeout(resolve, 100));
		await h.stop("m1");
		expect(h.settle()).toBeUndefined();
		expect(h.sent).toEqual([]);
	});

	it("acknowledges a finished result returned by stop", async () => {
		const h = setup();
		h.setBusy(true);
		await h.start({ command: "true" });
		await waitFor(() => h.statuses.length > 0 && h.statuses.at(-1) === undefined);
		expect((await h.stop("m1")).content[0].text).toContain("Already finished");
		expect(h.settle()).toBeUndefined();
	});

	it("discards pending completions on shutdown", async () => {
		const h = setup();
		h.setBusy(true);
		await h.start({ command: "true" });
		await waitFor(() => h.statuses.length > 0 && h.statuses.at(-1) === undefined);
		await h.shutdown();
		expect(h.settle()).toBeUndefined();
		expect(h.sent).toEqual([]);
	});
});

describe("log monitors", () => {
	it("ends on the first failure without waiting for the success marker", async () => {
		const h = setup();
		const log = path.join(h.cwd, "failure.log");
		fs.writeFileSync(log, "");
		await h.start({ log_path: log, done: "^ready", include: "^step" });
		fs.appendFileSync(log, "step 1\nError: crashed\nready\n");
		await waitFor(() => finalReport(h.sent) !== undefined);
		expect(h.sent).toHaveLength(1);
		expect(finalReport(h.sent)!.message.details).toMatchObject({
			severity: "failure",
			snapshot: { finish: { kind: "alert", line: "Error: crashed" } },
		});
		fs.appendFileSync(log, "Error: later\n");
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(h.sent).toHaveLength(1);
	});

	it("caps continuous alerts, keeps watching, and stops on done", async () => {
		const h = setup();
		const log = path.join(h.cwd, "continuous.log");
		fs.writeFileSync(log, "");
		await h.start({ log_path: log, continuous: true, done: "^done" });
		for (let i = 0; i < 8; i++) {
			fs.appendFileSync(log, `Error: ${i}\n`);
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		expect(h.sent).toHaveLength(5);
		expect(finalReport(h.sent)).toBeUndefined();
		fs.appendFileSync(log, "done\n");
		await waitFor(() => finalReport(h.sent) !== undefined);
		expect(h.sent).toHaveLength(6);
		expect(finalReport(h.sent)!.message.details.snapshot).toMatchObject({
			alertCount: 8, suppressedAlerts: 3, finish: { kind: "done" },
		});
	});

	it("follows only new lines and ends on the done line", async () => {
		const h = setup();
		const log = path.join(h.cwd, "build.log");
		fs.writeFileSync(log, "Error: old failure\n");
		await h.start({ log_path: "build.log", include: "^GitLab", done: "^wrote " });
		fs.appendFileSync(log, "GitLab activity 2700/3226\n");
		await waitFor(() => h.statuses.some((text) => text?.includes("GitLab activity 2700/3226")));
		fs.appendFileSync(log, "wrote dashboard.html\n");
		await waitFor(() => finalReport(h.sent) !== undefined);

		expect(h.sent).toHaveLength(1);
		const final = h.sent[0].message;
		expect(final.content).toContain("completion line seen");
		expect(final.details.snapshot.tail).toContain("wrote dashboard.html");
		expect(final.content).not.toContain("Last ");
		expect(final.content).not.toContain("old failure");
		expect(final.details.severity).toBe("success");
	});

	it("reads a log that appears after the monitor starts, and restarts after truncation", async () => {
		const h = setup();
		const log = path.join(h.cwd, "later.log");
		await h.start({ log_path: log, include: "step", continuous: true });
		fs.writeFileSync(log, "step 1 of a long first run\n");
		await waitFor(() => h.statuses.some((text) => text?.includes("step 1 of a long first run")));
		fs.writeFileSync(log, "step 2\n");
		await waitFor(() => h.statuses.some((text) => text?.includes("step 2")));
	});

	it("ends when the watched pid exits", async () => {
		const h = setup();
		const log = path.join(h.cwd, "pid.log");
		fs.writeFileSync(log, "");
		const child = spawn("bash", ["-c", `sleep 0.2; echo 'Traceback (most recent call last)' >> ${log}`]);
		await h.start({ log_path: log, pid: child.pid, continuous: true });
		await waitFor(() => finalReport(h.sent) !== undefined);
		const final = finalReport(h.sent)!.message;
		expect(final.content).toContain(`watched process ${child.pid} exited`);
		expect(final.content).toContain("Traceback");
	});

	it("rejects a pid that is not running", async () => {
		const h = setup();
		await expect(h.start({ log_path: "x.log", pid: 999_999 })).rejects.toThrow("not running");
	});
});

describe("validation and status", () => {
	it("requires a bounded log watch unless continuous monitoring is explicit", async () => {
		const h = setup();
		await expect(h.start({ log_path: "x.log" })).rejects.toThrow("requires done, pid, or continuous: true");
		await expect(h.start({ log_path: "x.log", done: "" })).rejects.toThrow("requires done, pid, or continuous: true");
		await expect(h.start({ command: "true", continuous: true })).rejects.toThrow("continuous only applies with log_path");
	});

	it("keeps successful completion compact and retains output on demand", async () => {
		const h = setup();
		await h.start({ command: "echo useful-result", done: ".*", label: "build" });
		await waitFor(() => finalReport(h.sent) !== undefined);
		expect(h.sent).toHaveLength(1);
		expect(finalReport(h.sent)!.message.content).not.toContain("useful-result");
		expect((await h.status({ id: "m1" })).content[0].text).toContain("useful-result");
	});

	it("retains an early command alert even when it falls outside the final excerpt", async () => {
		const h = setup();
		await h.start({ command: "echo 'Error: early'; for i in $(seq 1 20); do echo noise; done", label: "build" });
		await waitFor(() => finalReport(h.sent) !== undefined);
		expect(h.sent).toHaveLength(1);
		expect(finalReport(h.sent)!.message.content).toContain("Last alert: Error: early");
	});

	it("does not wake on command alerts or done markers before exit", async () => {
		const h = setup();
		await h.start({ command: "echo Error: early; echo ready; sleep 0.5; echo finished", done: "^ready" });
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(h.sent).toEqual([]);
		expect((await h.status({ id: "m1" })).details.monitors[0].state).toBe("running");
		await waitFor(() => finalReport(h.sent) !== undefined);
		expect(h.sent).toHaveLength(1);
		expect(finalReport(h.sent)!.message.content).toContain("finished");
	});

	it("requires exactly one source and valid regexes", async () => {
		const h = setup();
		await expect(h.start({})).rejects.toThrow("exactly one of command or log_path");
		await expect(h.start({ command: "true", log_path: "x" })).rejects.toThrow("exactly one");
		await expect(h.start({ command: "true", pid: 1 })).rejects.toThrow("only apply with log_path");
		await expect(h.start({ command: "true", include: "(" })).rejects.toThrow("Invalid include regex");
		await expect(h.start({ command: "true", timeout_minutes: 0 })).rejects.toThrow("timeout_minutes");
	});

	it("refuses print and JSON sessions", async () => {
		const h = setup("print");
		await expect(h.start({ command: "true" })).rejects.toThrow("interactive or RPC session");
	});

	it("reports latest progress and recent output on demand", async () => {
		const h = setup();
		await h.start({ command: "echo 'step 1'; echo noise; sleep 5", include: "^step", label: "slow" });
		await waitFor(() => h.statuses.some((text) => text?.includes("step 1")));
		const status = await h.status({ id: "m1", tail_lines: 5 });
		expect(status.content[0].text).toContain("m1 [running] slow");
		expect(status.content[0].text).toContain("latest: step 1");
		expect(status.content[0].text).toContain("noise");
		await expect(h.status({ id: "m9" })).rejects.toThrow("Unknown monitor: m9");
	});
});
