/**
 * Approval flows: user prompting (`requestApproval`) and guardian review with a
 * user-prompt fallback (`guardianReview`). Both are constructed through a factory
 * that closes over the extension's live state and message sink.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { runAutoReviewer } from "./guardian-runner.ts";
import type { ModeState } from "./mode-store.ts";
import type { ApprovalResult } from "./policy-types.ts";

export interface ApprovalServiceOptions {
	getMode: () => ModeState;
	getContext: () => { lastUserPrompt: string; precedingAssistantMessage: string };
	appendEntry: (customType: string, data: Record<string, unknown>) => void;
}

export interface ApprovalService {
	requestApproval(
		ctx: ExtensionContext,
		title: string,
		message: string,
	): Promise<ApprovalResult>;
	guardianReview(
		ctx: ExtensionContext,
		title: string,
		actionDescription: string,
		triggers: string[],
	): Promise<ApprovalResult>;
}

/**
 * Create the approval service bound to the extension's live state.
 */
export function createApprovalService(options: ApprovalServiceOptions): ApprovalService {
	const { getMode, getContext, appendEntry } = options;

	/**
	 * Get the approval decision for the current mode.
	 *
	 * read-only   → block (shouldn't reach here; mutations are pre-blocked)
	 * default     → prompt user
	 * auto-review → allow all (external writes handled directly)
	 * full-access → allow
	 */
	async function requestApproval(
		ctx: ExtensionContext,
		title: string,
		message: string,
	): Promise<ApprovalResult> {
		const { mode } = getMode();
		switch (mode) {
			case "read-only":
				return { allowed: false, reason: "Read-only mode." };

			case "default":
				if (!ctx.hasUI) return { allowed: false, reason: "No UI available for approval." };
				const ok = await ctx.ui.confirm(title, `${message}\n\nProceed?`);
				return { allowed: ok, reason: ok ? undefined : "User declined." };

			case "auto-review": {
				// Full auto except external writes are handled directly in tool_call
				return { allowed: true };
			}

			case "full-access":
				return { allowed: true };
		}
	}

	/**
	 * Run the guardian LLM to evaluate an action. If the guardian allows, proceed
	 * silently. If denied, block with notification. If it needs user approval,
	 * prompt the user directly.
	 */
	async function guardianReview(
		ctx: ExtensionContext,
		title: string,
		actionDescription: string,
		triggers: string[],
	): Promise<ApprovalResult> {
		if (!ctx.hasUI) {
			return { allowed: false, reason: "Auto-review: no UI available for guardian fallback." };
		}

		// Extract user's last request for authorization context
		const { lastUserPrompt, precedingAssistantMessage } = getContext();
		const userRequest = lastUserPrompt || "(unknown)";
		const precedingTurn = precedingAssistantMessage || "(none)";

		// Build evaluation message with user + agent context. Include the agent's
		// preceding turn (e.g. a proposal/options) so the guardian can judge whether
		// the user's reply agreed to the action being reviewed.
		const evaluationMessage =
			`User request: ${userRequest}\n\nAgent's preceding turn:\n${precedingTurn}\n\nAction: ${title}\n${actionDescription}`;

		try {
			const result = await runAutoReviewer(title, evaluationMessage);

			// Persist the verdict as a custom entry: rendered in the transcript by
			// registerEntryRenderer, but NOT sent to the LLM and not queued through
			// the steering queue (so it can never arrive late, after the turn ends).
			appendEntry("auto-review-verdict", {
				title,
				allowed: result.allowed,
				reason: result.reason,
				...(result.model ? { model: result.model } : {}),
				...(result.usage ? { usage: result.usage } : {}),
				...(triggers && triggers.length > 0 ? { triggers } : {}),
			});

			if (result.allowed) {
				return { allowed: true, reason: result.reason };
			}

			// Guardian denied
			return { allowed: false, reason: result.reason || "Guardian denied." };
		} catch (err: any) {
			// Guardian failed — fall back to direct user prompt
			const ok = await ctx.ui.confirm(
				`Auto-review: ${title} (guardian unavailable)`,
				`${actionDescription}\n\nGuardian could not evaluate. Proceed?`,
			);
			if (!ok) {
				return { allowed: false, reason: "Auto-review: user declined (guardian fallback)." };
			}
			return { allowed: true, reason: "User approved (guardian fallback)." };
		}
	}

	return { requestApproval, guardianReview };
}
