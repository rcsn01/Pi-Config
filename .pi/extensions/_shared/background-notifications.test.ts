import { describe, expect, it, vi } from "vitest";
import { backgroundNotifications, type BackgroundNotification } from "./background-notifications.ts";

function harness() {
	const handlers = new Map<string, Function>();
	const listeners = new Map<string, Function>();
	const events = {
		on: (name: string, handler: Function) => listeners.set(name, handler),
		emit: (name: string, data: unknown) => listeners.get(name)?.(data),
	};
	const sendMessage = vi.fn();
	const pi = { events, sendMessage, on: (name: string, handler: Function) => handlers.set(name, handler) } as any;
	const queue = backgroundNotifications(pi);
	const ctx = { isIdle: () => false } as any;
	const notification = (content: string, source: "monitor" | "subagent" = "monitor", runId = "m1"): BackgroundNotification => ({
		source, runId, timestamp: 1700000000000, content, details: { result: content }, wake: true,
		customType: source === "monitor" ? "monitor-event" : "subagent-completion",
	});
	const drain = () => handlers.get("agent_before_settle")!({ entries: [], continue: false });
	return { queue, ctx, notification, drain, sendMessage, handlers, pi };
}

describe("background notification delivery", () => {
	it("does nothing with an empty queue and delivers a single notification once", () => {
		const h = harness();
		expect(h.drain()).toBeUndefined();
		const notification = h.notification("failure");
		h.queue.publish(notification, h.ctx);
		const delivery = h.drain();
		expect(delivery.entries).toHaveLength(1);
		expect(delivery.entries[0].customType).toBe("monitor-event");
		expect(delivery.entries[0].details.notifications).toEqual([notification]);
		expect(delivery.continue).toBe(true);
		expect(h.drain()).toBeUndefined();
	});

	it("shares one queue across facades and delivers failures, fixes and verification together in order", () => {
		const h = harness();
		const other = backgroundNotifications({ ...h.pi, events: { ...h.pi.events } } as any);
		const notifications = [h.notification("test failure 1"), h.notification("test failure 2"),
			h.notification("review confirms fixes", "subagent", "run1"), h.notification("verification passed")];
		notifications.forEach((n, i) => (i % 2 ? other : h.queue).publish(n, h.ctx));
		expect(h.sendMessage).not.toHaveBeenCalled();
		const delivery = h.drain();
		expect(delivery.entries).toHaveLength(1);
		expect(delivery.entries[0].customType).toBe("background-notifications");
		expect(delivery.entries[0].details.notifications).toEqual(notifications);
		let previous = -1;
		for (const n of notifications) {
			const index = delivery.entries[0].content.indexOf(n.content);
			expect(index).toBeGreaterThan(previous); previous = index;
			expect(delivery.entries[0].content).toContain(`${n.source} run ${n.runId} at ${new Date(n.timestamp).toISOString()}`);
		}
		expect(h.drain()).toBeUndefined();
	});

	it("leaves notifications arriving during a drain for the next batch", () => {
		const h = harness();
		h.queue.publish(h.notification("first"), h.ctx, () => {
			h.queue.publish(h.notification("later"), h.ctx);
			return false;
		});
		expect(h.drain().entries[0].content).not.toContain("later");
		expect(h.drain().entries[0].content).toContain("later");
		expect(h.drain()).toBeUndefined();
	});

	it("wakes an idle agent immediately without timers or waiting for other jobs", () => {
		const h = harness();
		h.queue.publish(h.notification("ready"), { isIdle: () => true } as any);
		expect(h.sendMessage).toHaveBeenCalledOnce();
		expect(h.sendMessage.mock.calls[0][1]).toEqual({ deliverAs: "followUp", triggerTurn: true });
		expect(h.drain()).toBeUndefined();
	});

	it("only omits explicitly acknowledged reports, not earlier failures", () => {
		const h = harness();
		h.queue.publish(h.notification("failure"), h.ctx);
		h.queue.publish(h.notification("read completion"), h.ctx, () => true);
		expect(h.drain().entries[0].details.notifications.map((n: BackgroundNotification) => n.content)).toEqual(["failure"]);
	});
});
