/**
 * Unified Command Safety Extension
 *
 * Four approval modes:
 *   /permissions read-only    — Read-only browsing in current directory
 *   /permissions default      — Workspace-write with user approval prompts
 *   /permissions auto-review  — Full auto; only prompts you for edits outside the workspace
 *   /permissions full-access  — No restrictions (dangerous; confirm to enable)
 *
 * Preserves:
 *   /execpolicy  — regex allow/prompt/block rules
 *
 * This module wires together the focused policy modules:
 *   - permission-policy.ts  — pure evaluateToolCall decision seam
 *   - path-policy.ts        — tool/path tables and extraction
 *   - guardian-runner.ts    — guardian in-process session + verdict parsing
 *   - approvals.ts          — user + guardian approval flows
 *   - mode-store.ts         — approval-mode persistence
 *   - commands.ts           — /permissions, /approve, /execpolicy
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { loadExecPolicy } from "../_shared/command-policy.ts";
import { createProfileStore } from "../config-profiles/profile-store.ts";
import { createApprovalService } from "./approvals.ts";
import { registerPermissionCommands, type CommandService, type DeniedAction } from "./commands.ts";
import {
	parseGuardianDefinition,
	resolveGuardianPath,
} from "./guardian-runner.ts";
import {
	DEFAULT_MODE_STATE,
	loadModeFromFile,
	saveModeToFile,
	type ModeState,
} from "./mode-store.ts";
import { actionKey, evaluateToolCall } from "./permission-policy.ts";

// Re-exported for backward compatibility (guardian-config.test.ts and external
// importers depend on these public functions).
export { parseGuardianDefinition, resolveGuardianPath };
export type { GuardianDefinition } from "./guardian-runner.ts";

export { actionKey, evaluateToolCall };

// ── Extension ──────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	let mode: ModeState = { mode: "default", setAt: Date.now() };
	let lastDeniedAction: DeniedAction | undefined;
	let lastUserPrompt = "";
	let lastAssistantMessage = ""; // most recent assistant message text (updated via message_end)
	let precedingAssistantMessage = ""; // snapshot of lastAssistantMessage at turn start — the prior turn's final assistant message (e.g. a proposal the user is replying to)
	const oneShotApprovals = new Set<string>();
	let projectCwd = process.cwd();

	// ── Persistence ────────────────────────────────────────────────────

	function reconstruct(ctx: ExtensionContext) {
		projectCwd = ctx.cwd;
		mode = loadModeFromFile(ctx.cwd) ?? DEFAULT_MODE_STATE;
	}

	function persistMode() {
		saveModeToFile(projectCwd, mode);
	}

	// ── Status display ─────────────────────────────────────────────────

	const profileStore = createProfileStore();

	function updateStatus(ctx: ExtensionContext) {
		const modeLabels: Record<string, string> = {
			"read-only": "READ-ONLY",
			default: "DEFAULT",
			"auto-review": "AUTO-REVIEW",
			"full-access": "FULL ACCESS",
		};
		let label = modeLabels[mode.mode];
		try {
			const profile = profileStore.getActiveProfile();
			if (profile) label = `${profile} · ${label}`;
		} catch {
			// settings.json may be temporarily invalid; show the mode alone.
		}
		ctx.ui.setStatus("approval-mode", label);
	}

	// ── Approval service (user + guardian flows) ───────────────────────

	const approvals = createApprovalService({
		getMode: () => mode,
		getContext: () => ({ lastUserPrompt, precedingAssistantMessage }),
		sendMessage: (message) => pi.sendMessage(message),
	});

	// ── Command service (shared state for /permissions, /approve) ─────

	const commandService: CommandService = {
		getMode: () => mode,
		setModeAndPersist: (m) => {
			mode = m;
			persistMode();
		},
		updateStatus,
		lastDeniedAction: () => lastDeniedAction,
		approveLastDenied: () => {
			if (!lastDeniedAction) return undefined;
			const approved = lastDeniedAction;
			lastDeniedAction = undefined;
			oneShotApprovals.add(approved.key);
			return approved;
		},
	};

	// ── Events ──────────────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => { reconstruct(ctx); updateStatus(ctx); });
	pi.on("session_tree", async (_event, ctx) => { reconstruct(ctx); updateStatus(ctx); });
	pi.on("turn_end", async (_event, ctx) => updateStatus(ctx));

	// Track the most recent assistant message text so the guardian can see the agent's
	// preceding turn (e.g. a proposal/options the user is replying to).
	pi.on("message_end", async (event) => {
		if (event.message?.role !== "assistant") return;
		const text = extractAssistantText(event.message);
		if (text) lastAssistantMessage = text.slice(-2000);
	});

	// ── Custom rendering for auto-review verdict messages ─────────────

	pi.registerMessageRenderer("auto-review-verdict", (message, _expanded, theme) => {
		const details = message.details as { allowed?: boolean } | undefined;
		const bg = details?.allowed ? "toolSuccessBg" : "toolErrorBg";
		const text = theme.fg("warning", message.content as string);
		const box = new Box(1, 1, (t) => theme.bg(bg, t));
		box.addChild(new Text(text, 0, 0));
		return box;
	});

	// ── tool_call handler ──────────────────────────────────────────────

	pi.on("tool_call", async (event, ctx) => {
		const key = actionKey(event.toolName, event.input);
		if (oneShotApprovals.has(key)) {
			oneShotApprovals.delete(key);
			return;
		}

		const decision = await evaluateToolCall(
			{ toolName: event.toolName, input: event.input },
			{ mode: mode.mode, cwd: ctx.cwd, hasUI: ctx.hasUI, execPolicy: loadExecPolicy() },
			{
				requestApproval: (title, message) => approvals.requestApproval(ctx, title, message),
				guardianReview: (title, desc) => approvals.guardianReview(ctx, title, desc),
				onDenied: (input, title, message) => {
					lastDeniedAction = { key: actionKey(input.toolName, input.input), title, message, at: Date.now() };
				},
			},
		);

		if (decision.action === "block") {
			return { block: true, reason: decision.reason };
		}
	});

	// ── System prompt injection ────────────────────────────────────────

	pi.on("before_agent_start", async (event) => {
		// Snapshot the prior turn's final assistant message before this turn begins.
		// This is the agent's preceding turn (e.g. a proposal/options the user is now
		// replying to) and gives the guardian authorization context. Snapshotted here so
		// current-turn assistant text cannot overwrite it before a tool_call fires.
		precedingAssistantMessage = lastAssistantMessage;
		lastUserPrompt = (event.prompt || "").slice(0, 500);
		const modeInstructions: Record<string, string> = {
			"read-only": `\n\n## Permission Mode: READ-ONLY\nYou are in read-only browsing mode, limited to the current directory.\n- You CAN read files, search code, list directories, and run read-only commands within ${event.systemPrompt.includes("cwd") ? "the workspace" : "the current directory"}.\n- You CANNOT modify files, run write commands, execute shell commands that change the system, or access the network.\n- Do NOT attempt to use write, edit, or bash for destructive operations.\n- Inform the user if a task requires write access. They can switch mode with /permissions default.`,
			default: `\n\n## Permission Mode: DEFAULT\nYou may read, write, and edit files within the current workspace, and run commands.\nApproval is required to:\n- Access the internet (curl, fetch, package installs, git push/pull/clone, etc.)\n- Write or edit files outside the workspace\n- Run dangerous commands (sudo, rm -rf, curl piped to shell)\nPrefer safe alternatives when possible.`,
			"auto-review": `\n\n## Permission Mode: AUTO-REVIEW\nFull auto — no restrictions on reading, writing within the workspace, web searches, or running commands.\nA guardian LLM reviews dangerous commands, network installs, and writes outside the workspace.\nSafe actions pass silently. Risky actions may trigger a user prompt.`,
			"full-access": `\n\n## Permission Mode: FULL ACCESS\nNo restrictions. You have full access to read, write, and execute any command, including network access and writing outside the workspace.\nExercise caution and always inform the user of destructive operations.`,
		};
		return { systemPrompt: event.systemPrompt + modeInstructions[mode.mode] };
	});

	// ── Commands ────────────────────────────────────────────────────────

	registerPermissionCommands(pi, commandService);
}

// Extract readable text from an assistant message (content may be a string or an array of content blocks).
function extractAssistantText(message: any): string {
	if (!message) return "";
	const content = message.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((block: any) => block && block.type === "text" && typeof block.text === "string")
			.map((block: any) => block.text)
			.join("\n");
	}
	return "";
}
