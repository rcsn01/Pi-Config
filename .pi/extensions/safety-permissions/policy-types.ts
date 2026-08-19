/**
 * Shared decision and context types for the Safety Permissions extension.
 */
import type { ApprovalMode, ExecPolicyConfig } from "../_shared/command-policy.ts";

/** A permission decision produced by `evaluateToolCall`. */
export type PermissionDecision =
	| { action: "allow" }
	| { action: "block"; reason: string };

/** The tool call being evaluated. */
export interface ToolCallInput {
	toolName: string;
	input: unknown;
}

/** Read-only inputs to permission evaluation (no mutable state). */
export interface EvaluateContext {
	mode: ApprovalMode;
	cwd: string;
	hasUI: boolean;
	execPolicy: ExecPolicyConfig;
}

/** Result of a user/guardian approval flow. */
export interface ApprovalResult {
	allowed: boolean;
	reason?: string;
}

/** Side-effecting dependencies injected so `evaluateToolCall` stays pure/testable. */
export interface EvaluateDeps {
	/** Prompt the user for approval (default mode). */
	requestApproval(title: string, message: string): Promise<ApprovalResult>;
	/** Run the guardian reviewer (auto-review mode). */
	guardianReview(title: string, actionDescription: string, triggers: string[]): Promise<ApprovalResult>;
	/** Record a denied action so /approve can retry it once. */
	onDenied(input: ToolCallInput, title: string, message: string): void;
}
