/**
 * Pending-mode queue for the Plan Mode lifecycle.
 *
 * Defers mode switches and /plan tasks issued while the agent is busy, owns
 * the queued request and its `plan-pending` status surface, applies the
 * request at agent settle, and cancels it on Session start, branch change,
 * and Session stop. The enter/exit transitions it defers stay in the
 * lifecycle and are injected through the host.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentMode } from "./plan-state.ts";

export interface PendingModeHost {
	/** Lifecycle-owned Plan State read used for queue cancellation and toggle coalescing. */
	currentMode(): AgentMode;
	enter(ctx: ExtensionContext, prompt?: string): Promise<boolean>;
	exit(ctx: ExtensionContext): Promise<boolean>;
	/** Lifecycle-owned task activation for a queued /plan task. */
	activateTask(ctx: ExtensionContext, task: string): void;
	/** The lifecycle's activePlanProfile-based "Plan mode active" notify after entering. */
	notifyEntered(ctx: ExtensionContext): void;
}

export interface PlanPendingMode {
	queue(ctx: ExtensionContext, target: AgentMode, options?: { prompt?: string; task?: string }): void;
	/** Queue the opposite of the queued target, or currentMode() when no request exists. */
	toggle(ctx: ExtensionContext, options?: { prompt?: string }): void;
	clear(ctx: ExtensionContext): void;
	/** Returns true if a queued request was applied. */
	apply(ctx: ExtensionContext): Promise<boolean>;
}

export function createPlanPendingMode(host: PendingModeHost): PlanPendingMode {
	let pendingRequest: { target: AgentMode; prompt?: string; task?: string } | undefined;

	function clear(ctx: ExtensionContext): void {
		pendingRequest = undefined;
		ctx.ui.setStatus("plan-pending", undefined);
	}

	function queue(
		ctx: ExtensionContext,
		target: AgentMode,
		options: { prompt?: string; task?: string } = {},
	): void {
		if (target === host.currentMode() && !options.task) {
			clear(ctx);
			ctx.ui.notify("Queued Plan Mode switch cancelled.", "info");
			return;
		}
		pendingRequest = { target, ...options };
		if (options.task) {
			ctx.ui.setStatus("plan-pending", "plan task queued");
			ctx.ui.notify("Plan task will start after the current run.", "info");
			return;
		}
		const label = target === "plan" ? "Plan Mode" : "normal mode";
		ctx.ui.setStatus("plan-pending", `${label} queued`);
		ctx.ui.notify(`Mode switch to ${label} queued until the current run finishes.`, "info");
	}

	function toggle(ctx: ExtensionContext, options: { prompt?: string } = {}): void {
		const effectiveTarget = pendingRequest?.target ?? host.currentMode();
		const target = effectiveTarget === "plan" ? "default" : "plan";
		if (target === "plan") {
			queue(ctx, target, { prompt: options.prompt });
			return;
		}
		queue(ctx, target);
	}

	async function apply(ctx: ExtensionContext): Promise<boolean> {
		const request = pendingRequest;
		if (!request) return false;
		clear(ctx);
		if (request.target === "plan") {
			if (!(host.currentMode() === "plan" || await host.enter(ctx, request.prompt ?? request.task))) return true;
			if (request.task) {
				host.activateTask(ctx, request.task);
				return true;
			}
			host.notifyEntered(ctx);
			return true;
		}
		if (await host.exit(ctx)) ctx.ui.notify("Plan mode exited.", "info");
		return true;
	}

	return { queue, toggle, clear, apply };
}