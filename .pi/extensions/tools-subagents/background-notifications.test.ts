import { describe, expect, it, vi } from "vitest";
import { createSubagentBackgroundNotifications } from "./background-notifications.ts";
import type { SubagentRunSnapshot } from "./subagent-runs.ts";
import { agentResult } from "./test-harness.ts";

const snapshot = (status: SubagentRunSnapshot["status"] = "completed"): SubagentRunSnapshot => ({
	runId: "run", sessionId: "session", agent: "explorer", task: "inspect", cwd: "/", model: "test/model", status, createdAt: 1,
	result: agentResult({ output: "Final report" }),
});
describe("background completion notifications", () => {
	it.each(["busy", "idle"])("requests follow-up delivery and idle wake-up when %s", () => {
		const pi = { sendMessage: vi.fn() };
		const notifier = createSubagentBackgroundNotifications(pi, { sessionId: "session", isCurrent: () => true });
		notifier.complete(snapshot()); notifier.complete(snapshot());
		expect(pi.sendMessage).toHaveBeenCalledOnce();
		expect(pi.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ customType: "subagent-completion", content: expect.stringContaining("Final report"), display: true }), { deliverAs: "followUp", triggerTurn: true });
	});
	it.each(["failed", "cancelled"] as const)("reports %s outcomes without intermediate messages", (status) => {
		const pi = { sendMessage: vi.fn() };
		const notifier = createSubagentBackgroundNotifications(pi, { sessionId: "session", isCurrent: () => true });
		const run = { ...snapshot(status), result: undefined, error: "reason" };
		notifier.complete(run);
		expect(pi.sendMessage.mock.calls[0][0].content).toContain(status);
		expect(pi.sendMessage.mock.calls[0][0].content).toContain("reason");
	});
	it("suppresses stale generations, sessions, and disabled delivery", () => {
		const pi = { sendMessage: vi.fn() }; let current = false;
		const notifier = createSubagentBackgroundNotifications(pi, { sessionId: "session", isCurrent: () => current });
		notifier.complete(snapshot()); current = true;
		notifier.complete({ ...snapshot(), sessionId: "old" });
		notifier.disable(); notifier.complete(snapshot());
		expect(pi.sendMessage).not.toHaveBeenCalled();
	});
	it("contains notification errors without mutating terminal outcomes", () => {
		const pi = { sendMessage: vi.fn(() => { throw new Error("closed host"); }) };
		const notifier = createSubagentBackgroundNotifications(pi, { sessionId: "session", isCurrent: () => true });
		const run = snapshot(); expect(() => notifier.complete(run)).not.toThrow();
		expect(run.status).toBe("completed"); notifier.complete(run); expect(pi.sendMessage).toHaveBeenCalledOnce();
	});
});
