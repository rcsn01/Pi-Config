import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface BackgroundNotification {
	source: "monitor" | "subagent";
	runId: string;
	timestamp: number;
	customType: string;
	content: string;
	details: object;
	wake: boolean;
}
interface Pending {
	notification: BackgroundNotification;
	isAcknowledged?: () => boolean;
}

export interface BackgroundNotifications {
	publish(notification: BackgroundNotification, ctx: ExtensionContext, isAcknowledged?: () => boolean): void;
}

const queues = new WeakMap<ExtensionAPI, BackgroundNotifications>();
const DISCOVER = "pi-config:background-notifications:discover";

export function backgroundNotifications(pi: ExtensionAPI): BackgroundNotifications {
	let existing = queues.get(pi);
	if (existing) return existing;
	// Each extension has a different events facade. Discover the coordinator
	// through the shared synchronous bus rather than comparing facade identities.
	pi.events?.emit(DISCOVER, (queue: BackgroundNotifications) => { existing = queue; });
	if (existing) {
		queues.set(pi, existing);
		return existing;
	}
	let pending: Pending[] = [];
	const message = (notifications: BackgroundNotification[]) => {
		const first = notifications[0];
		return {
			customType: notifications.length === 1 ? first.customType : "background-notifications",
			content: notifications.map((n) =>
				`[${n.source} run ${n.runId} at ${new Date(n.timestamp).toISOString()}]\n${n.content}`,
			).join("\n\n"),
			display: true,
			details: notifications.length === 1
				? { ...first.details, notifications }
				: { notifications },
		};
	};
	pi.on("agent_before_settle", (event) => {
		// Swap before inspecting entries or building the message. Later arrivals
		// belong to the next batch, including any reentrant publication.
		const batch = pending;
		pending = [];
		const notifications = batch.filter((item) => !item.isAcknowledged?.()).map((item) => item.notification);
		if (notifications.length === 0) return;
		return {
			entries: [...event.entries, { type: "custom_message" as const, ...message(notifications) }],
			continue: event.continue || notifications.some((n) => n.wake),
		};
	});
	pi.on("session_tree", () => { pending = []; });
	pi.on("session_shutdown", () => { pending = []; });
	const queue: BackgroundNotifications = {
		publish(notification, ctx, isAcknowledged) {
			if (!notification.wake || ctx.isIdle()) {
				pi.sendMessage(message([notification]), { deliverAs: "followUp", triggerTurn: notification.wake });
			} else {
				pending.push({ notification, isAcknowledged });
			}
		},
	};
	pi.events?.on(DISCOVER, (accept) => {
		if (typeof accept === "function") accept(queue);
	});
	queues.set(pi, queue);
	return queue;
}
