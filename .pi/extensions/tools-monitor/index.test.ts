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
	it("keeps progress in the status line and reports alerts and the exit with output tail", async () => {
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

		const [alert, final] = h.sent;
		expect(h.sent).toHaveLength(2);
		expect(alert.message.customType).toBe(MONITOR_MESSAGE_TYPE);
		expect(alert.message.content).toContain("ALERT: Error: boom");
		expect(alert.message.content).toContain("Latest progress: Jira: 2/3");
		expect(alert.options).toEqual({ triggerTurn: true, deliverAs: "followUp" });
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

	it("caps alert reports and summarizes the rest at the end", async () => {
		const h = setup();
		await h.start({ command: "for i in $(seq 1 40); do echo \"Error $i\"; sleep 0.04; done" });
		await waitFor(() => finalReport(h.sent) !== undefined, 10_000);
		const alertReports = h.sent.filter((entry) => entry.message.details.snapshot.state === "running");
		expect(alertReports.length).toBeLessThanOrEqual(5);
		const final = finalReport(h.sent)!;
		expect(final.message.content).toContain("Alerts: 40");
		expect(final.message.content).toMatch(/\(\d+ not reported individually\)/);
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
		await h.start({ log_path: log, done: "^done" });
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
		expect(final.content).toContain("DONE: wrote dashboard.html");
		expect(final.content).not.toContain("old failure");
		expect(final.details.severity).toBe("success");
	});

	it("reads a log that appears after the monitor starts, and restarts after truncation", async () => {
		const h = setup();
		const log = path.join(h.cwd, "later.log");
		await h.start({ log_path: log, include: "step" });
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
		await h.start({ log_path: log, pid: child.pid });
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
