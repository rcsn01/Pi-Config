import { describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentMode } from "./plan-state.ts";
import { createPlanPendingMode, type PendingModeHost } from "./plan-pending-mode.ts";

const ctx = {
	ui: { setStatus: vi.fn(), notify: vi.fn() },
} as unknown as ExtensionContext;

function createHost(overrides: Partial<PendingModeHost> = {}): PendingModeHost {
	return {
		currentMode: vi.fn((): AgentMode => "default"),
		enter: vi.fn(async (_ctx: ExtensionContext, _prompt?: string) => true),
		exit: vi.fn(async (_ctx: ExtensionContext) => true),
		activateTask: vi.fn((_ctx: ExtensionContext, _task: string) => {}),
		notifyEntered: vi.fn((_ctx: ExtensionContext) => {}),
		...overrides,
	};
}

describe("Plan pending-mode queue", () => {
	it("queue records the request, sets the plan-pending status, and notifies", () => {
		const host = createHost();
		const pending = createPlanPendingMode(host);

		pending.queue(ctx, "plan", { prompt: "design the parser" });

		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("plan-pending", "Plan Mode queued");
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			"Mode switch to Plan Mode queued until the current run finishes.",
			"info",
		);
	});

	it("queuing the current mode without a task cancels the switch", () => {
		const host = createHost({ currentMode: vi.fn((): AgentMode => "default") });
		const pending = createPlanPendingMode(host);

		pending.queue(ctx, "default");

		expect(ctx.ui.notify).toHaveBeenCalledWith("Queued Plan Mode switch cancelled.", "info");
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("plan-pending", undefined);
	});

	it("two toggles coalesce against the private queued target and cancel the switch", () => {
		const host = createHost();
		const pending = createPlanPendingMode(host);

		pending.toggle(ctx);
		pending.toggle(ctx);

		expect(ctx.ui.notify).toHaveBeenLastCalledWith("Queued Plan Mode switch cancelled.", "info");
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("plan-pending", undefined);
		expect(host.enter).not.toHaveBeenCalled();
	});

	it("toggle forwards the prompt only when the resulting target is Plan Mode", () => {
		const host = createHost();
		const pending = createPlanPendingMode(host);

		pending.toggle(ctx, { prompt: "design the parser" });
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("plan-pending", "Plan Mode queued");

		pending.toggle(ctx);
		expect(ctx.ui.notify).toHaveBeenLastCalledWith("Queued Plan Mode switch cancelled.", "info");
	});

	it("apply with a queued plan switch enters with the queued prompt and notifies entry", async () => {
		const host = createHost();
		const pending = createPlanPendingMode(host);
		pending.queue(ctx, "plan", { prompt: "design the parser" });

		await expect(pending.apply(ctx)).resolves.toBe(true);

		expect(host.enter).toHaveBeenCalledWith(ctx, "design the parser");
		expect(host.notifyEntered).toHaveBeenCalledWith(ctx);
		expect(host.activateTask).not.toHaveBeenCalled();
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("plan-pending", undefined);
	});

	it("apply with a queued /plan task activates the task instead of notifying entry", async () => {
		const host = createHost();
		const pending = createPlanPendingMode(host);
		pending.queue(ctx, "plan", { task: "inspect auth handling" });

		await expect(pending.apply(ctx)).resolves.toBe(true);

		expect(host.enter).toHaveBeenCalledWith(ctx, "inspect auth handling");
		expect(host.activateTask).toHaveBeenCalledWith(ctx, "inspect auth handling");
		expect(host.notifyEntered).not.toHaveBeenCalled();
	});

	it("apply with a queued normal-mode switch exits and notifies the exit", async () => {
		const host = createHost({ currentMode: vi.fn((): AgentMode => "plan") });
		const pending = createPlanPendingMode(host);
		pending.queue(ctx, "default");
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("plan-pending", "normal mode queued");

		await expect(pending.apply(ctx)).resolves.toBe(true);

		expect(host.exit).toHaveBeenCalledWith(ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith("Plan mode exited.", "info");
	});

	it("apply with no request returns false and does not touch the host", async () => {
		const host = createHost();
		const pending = createPlanPendingMode(host);

		await expect(pending.apply(ctx)).resolves.toBe(false);

		expect(host.enter).not.toHaveBeenCalled();
		expect(host.exit).not.toHaveBeenCalled();
		expect(host.activateTask).not.toHaveBeenCalled();
		expect(host.notifyEntered).not.toHaveBeenCalled();
	});

	it("clear drops the request and a later apply is a no-op", async () => {
		const host = createHost();
		const pending = createPlanPendingMode(host);
		pending.queue(ctx, "plan", { prompt: "design the parser" });

		pending.clear(ctx);
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("plan-pending", undefined);
		await expect(pending.apply(ctx)).resolves.toBe(false);
		expect(host.enter).not.toHaveBeenCalled();
	});

	it("apply consumes the request even when host.enter refuses the transition", async () => {
		const host = createHost({ enter: vi.fn(async (_ctx: ExtensionContext, _prompt?: string) => false) });
		const pending = createPlanPendingMode(host);
		pending.queue(ctx, "plan", { prompt: "design the parser" });

		await expect(pending.apply(ctx)).resolves.toBe(true);

		expect(host.enter).toHaveBeenCalledTimes(1);
		expect(host.notifyEntered).not.toHaveBeenCalled();
		await expect(pending.apply(ctx)).resolves.toBe(false);
	});
});