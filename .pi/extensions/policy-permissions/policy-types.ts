/**
 * Shared verdict and context types for the Safety Permissions extension.
 */
import type { ExecPolicyConfig } from "../_shared/command-policy.ts";
import type { ApprovalMode } from "./mode-registry.ts";

/** Why a denied ask blocks: fixed classifier text, or the approval result's reason with a site fallback. */
export type DeclinedReason =
	| { kind: "fixed"; reason: string }
	| { kind: "fallback"; reason: string };

/** An interaction ask (user prompt or Guardian review) as verdict data. */
export interface PermissionAsk {
	kind: "ask";
	/** Which lifecycle resolver handles the ask. */
	channel: "user" | "guardian";
	/** Prompt or review title and body, verbatim. */
	title: string;
	message: string;
	/** Guardian triggers; guardian asks carry non-empty triggers. */
	triggers?: readonly string[];
	/** What the lifecycle records on denial (differs from the prompt at several sites). */
	denial: { title: string; message: string };
	/** The block reason when the ask is denied. */
	declinedReason: DeclinedReason;
}

/** An unconditional block decision as verdict data. */
export interface PermissionBlock {
	kind: "block";
	reason: string;
}

/**
 * One ordered verdict step: steps resolve in order; the first denied ask
 * short-circuits with a block; a block step terminates; an empty list = allow.
 */
export type PermissionStep = PermissionAsk | PermissionBlock;

/** The tool call being classified. */
export interface ToolCallInput {
	toolName: string;
	input: unknown;
}

/** Read-only inputs to classification — precomputable, no interaction, no mutable state. */
export interface EvaluateContext {
	mode: ApprovalMode;
	cwd: string;
	hasUI: boolean;
	execPolicy: ExecPolicyConfig;
}

/** Result of a user/Guardian approval flow. */
export interface ApprovalResult {
	allowed: boolean;
	reason?: string;
}
