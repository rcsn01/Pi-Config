import { describe, expect, it, vi } from "vitest";
import { createNotificationExtension } from "./index.ts";

function harness() {
	const handlers = new Map<string, (event: any, ctx: any) => unknown>();
	const commands = new Map<string, any>();
	const notify = vi.fn(async (_title: string, _message: string) => {});
	createNotificationExtension(notify)({
		on: (name: string, handler: any) => handlers.set(name, handler),
		registerCommand: (name: string, command: any) => commands.set(name, command),
	} as any);
	return {
		commands,
		notify,
		async emit(type: string, fields = {}) {
			await handlers.get(type)?.({ type, ...fields }, {});
		},
	};
}

function assistant(text: string, stopReason = "stop") {
	return { role: "assistant", content: [{ type: "text", text }], stopReason };
}

describe("completion notifications", () => {
	it("waits through overflow compaction and notifies only after the retry settles", async () => {
		const h = harness();
		await h.emit("agent_start");
		await h.emit("agent_end", { messages: [assistant("Partial response", "length")] });
		expect(h.notify).not.toHaveBeenCalled();
		await h.emit("session_before_compact", { reason: "overflow", willRetry: true });
		await h.emit("session_compact", { reason: "overflow", willRetry: true });
		expect(h.notify).not.toHaveBeenCalled();
		await h.emit("agent_start");
		await h.emit("agent_end", { messages: [assistant("Actually finished")] });
		expect(h.notify).not.toHaveBeenCalled();
		await h.emit("agent_settled");
		expect(h.notify).toHaveBeenCalledExactlyOnceWith("Pi - Turn Complete", "Actually finished");
	});

	it("stays silent during between-turn threshold compaction", async () => {
		const h = harness();
		await h.emit("agent_start");
		await h.emit("turn_end", { message: assistant("Still working", "toolUse"), toolResults: [{}] });
		await h.emit("session_before_compact", { reason: "threshold", willRetry: false });
		await h.emit("session_compact", { reason: "threshold", willRetry: false });
		expect(h.notify).not.toHaveBeenCalled();
		await h.emit("agent_end", { messages: [assistant("Done after compaction")] });
		await h.emit("agent_settled");
		expect(h.notify).toHaveBeenCalledExactlyOnceWith("Pi - Turn Complete", "Done after compaction");
	});

	it("waits through an automatic provider retry", async () => {
		const h = harness();
		await h.emit("agent_start");
		await h.emit("agent_end", { messages: [assistant("", "error")] });
		expect(h.notify).not.toHaveBeenCalled();
		await h.emit("agent_start");
		await h.emit("agent_end", { messages: [assistant("Retry succeeded")] });
		await h.emit("agent_settled");
		expect(h.notify).toHaveBeenCalledExactlyOnceWith("Pi - Turn Complete", "Retry succeeded");
	});

	it("uses the final queued follow-up response and consumes it only once", async () => {
		const h = harness();
		await h.emit("agent_end", { messages: [assistant("First response")] });
		await h.emit("agent_start");
		await h.emit("agent_end", { messages: [assistant("Final\nresponse")] });
		expect(h.notify).not.toHaveBeenCalled();
		await h.emit("agent_settled");
		await h.emit("agent_settled");
		expect(h.notify).toHaveBeenCalledTimes(1);
		expect(h.notify).toHaveBeenCalledWith("Pi - Turn Complete", "Final response");
	});

	it("does not notify for standalone compaction, failed compaction, or idle settlement", async () => {
		const h = harness();
		await h.emit("session_before_compact", { reason: "manual" });
		await h.emit("session_compact", { reason: "manual" });
		await h.emit("session_before_compact", { reason: "manual" });
		await h.emit("session_compact_failed", { reason: "manual", aborted: true });
		await h.emit("agent_settled");
		expect(h.notify).not.toHaveBeenCalled();
	});

	it.each(["session_start", "session_shutdown"])("clears pending notification on %s", async (type) => {
		const h = harness();
		await h.emit("agent_end", { messages: [assistant("Old session")] });
		await h.emit(type);
		await h.emit("agent_settled");
		expect(h.notify).not.toHaveBeenCalled();
	});

	it("preserves preview truncation and fallback messages", async () => {
		const h = harness();
		await h.emit("agent_end", { messages: [assistant("x".repeat(121))] });
		await h.emit("agent_settled");
		expect(h.notify).toHaveBeenNthCalledWith(1, "Pi - Turn Complete", "x".repeat(120) + "…");
		await h.emit("agent_end", { messages: [assistant("")] });
		await h.emit("agent_settled");
		expect(h.notify).toHaveBeenNthCalledWith(2, "Pi - Turn Complete", "Task completed");
		await h.emit("agent_end", { messages: [] });
		await h.emit("agent_settled");
		expect(h.notify).toHaveBeenNthCalledWith(3, "Pi - Turn Complete", "Agent finished processing");
	});

	it("keeps /notify available without an agent run", async () => {
		const h = harness();
		const notify = vi.fn();
		await h.commands.get("notify").handler("", { ui: { notify } });
		expect(h.notify).toHaveBeenCalledTimes(1);
		expect(h.notify).toHaveBeenCalledWith("Pi", "Notifications are enabled ✓");
		expect(notify).toHaveBeenCalledWith("Sent desktop and cmux notification test.", "info");
	});
});
