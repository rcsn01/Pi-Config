/**
 * Approval Modes Extension - Recreates Codex's `/permissions` feature
 *
 * Modes:
 *   - read-only: Agent can only read files, no writes or commands
 *   - auto (default): Workspace writes allowed, asks before external operations
 *   - full-access: No restrictions (dangerous, use with caution)
 *
 * Commands:
 *   /permissions              - Show current mode and switch
 *   /permissions read-only    - Switch to read-only
 *   /permissions auto         - Switch to auto (workspace write)
 *   /permissions full-access  - Switch to full access (no restrictions)
 *
 * The mode is persisted across sessions and enforced via tool_call interception.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";

type ApprovalMode = "read-only" | "auto" | "full-access";

interface ModeState {
	mode: ApprovalMode;
	setAt: number;
}

const MODE_CUSTOM_TYPE = "approval-mode-state";

// Commands blocked in read-only mode
const READ_ONLY_BLOCKED_TOOLS = new Set(["bash", "write", "edit"]);
const READ_ONLY_BLOCKED_COMMANDS = new Set([
	"rm", "mv", "cp", "mkdir", "touch", "npm install", "npm uninstall",
	"pip install", "pip uninstall", "brew install", "brew uninstall",
]);

// External paths that require approval in auto mode
const AUTO_APPROVAL_REQUIRED_PATTERNS = [
	/^\/etc\//,
	/^\/usr\//,
	/^\/bin\//,
	/^\/sbin\//,
	/^\/opt\//,
	/^\/var\//,
	/^\/tmp\//,
	/^\/System\//,
	/^\/Library\//,
	/^~\/\.ssh\//,
	/^~\/\.gnupg\//,
	/^~\/\.aws\//,
];

export default function (pi: ExtensionAPI) {
	let mode: ModeState = { mode: "auto", setAt: Date.now() };

	// ── State Reconstruction ──────────────────────────────────────────────

	const reconstruct = (ctx: ExtensionContext) => {
		mode = { mode: "auto", setAt: Date.now() };
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === MODE_CUSTOM_TYPE) {
				const data = entry.data as ModeState | undefined;
				if (data?.mode) mode = data;
			}
		}
	};

	const persist = () => {
		pi.appendEntry(MODE_CUSTOM_TYPE, { ...mode });
	};

	pi.on("session_start", async (_event, ctx) => reconstruct(ctx));
	pi.on("session_tree", async (_event, ctx) => reconstruct(ctx));

	// ── Tool Call Interception ────────────────────────────────────────────

	pi.on("tool_call", async (event, ctx) => {
		// Read-only: block write/edit/bash
		if (mode.mode === "read-only") {
			if (event.toolName === "bash") {
				if (isToolCallEventType("bash", event)) {
					const cmd = event.input.command || "";
					// Allow read-only commands
					const isReadOnly = /^(ls|cat|head|tail|find|grep|git\s+(log|status|diff|show|branch|tag|stash\s+list)|wc|sort|uniq|file|which|type|echo|pwd|whoami|date|env|printenv|du|df|ps|top|htop|tree|stat)\b/.test(cmd);
					if (!isReadOnly) {
						return {
							block: true,
							reason: `Approval mode is read-only. Command blocked: ${cmd.slice(0, 80)}. Use /permissions auto to allow writes.`,
						};
					}
				}
			} else if (READ_ONLY_BLOCKED_TOOLS.has(event.toolName)) {
				return {
					block: true,
					reason: `Approval mode is read-only. Tool \`${event.toolName}\` is blocked. Use /permissions auto to allow modifications.`,
				};
			}
		}

		// Auto: block operations outside workspace
		if (mode.mode === "auto") {
			if (event.toolName === "bash") {
				if (isToolCallEventType("bash", event)) {
					const cmd = event.input.command || "";
					// Check for dangerous patterns
					const dangerousPatterns = [
						{ pattern: /\bsudo\b/, reason: "sudo (elevated privileges)" },
						{ pattern: /\brm\s+-rf?\b/, reason: "rm -rf (recursive deletion)" },
						{ pattern: /\bcurl\b.*\|.*\b(ba?sh|zsh|fish|sh)\b/, reason: "curl pipe to shell (RCE)" },
						{ pattern: /\b>\/etc\//, reason: "writing outside workspace" },
					];
					for (const { pattern, reason } of dangerousPatterns) {
						if (pattern.test(cmd)) {
							if (!ctx.hasUI) {
								return { block: true, reason: `Auto mode blocked: ${reason}` };
							}
							const proceed = await ctx.ui.confirm(
								"Dangerous Command",
								`Auto mode detected: ${reason}\n\nCommand: ${cmd.slice(0, 200)}\n\nProceed?`,
							);
							if (!proceed) {
								return { block: true, reason: `User declined: ${reason}` };
							}
						}
					}
				}
			}

			// Check read paths for workspace boundaries
			if (event.toolName === "read" || event.toolName === "write" || event.toolName === "edit") {
				const input = event.input as { path?: string } | undefined;
				const path = input?.path || "";
				if (path) {
					const resolved = path.startsWith("~")
						? path.replace(/^~/, process.env.HOME || "/Users")
						: path;
					const isExternal = AUTO_APPROVAL_REQUIRED_PATTERNS.some((p) =>
						p.test(resolved),
					);
					if (isExternal && event.toolName !== "read") {
						if (!ctx.hasUI) {
							return {
								block: true,
								reason: `Auto mode: writing to ${path} requires approval. Switch to full-access or approve.`,
							};
						}
						const proceed = await ctx.ui.confirm(
							"External Path",
							`Auto mode: path "${path}" is outside workspace.\nAllow write?`,
						);
						if (!proceed) {
							return { block: true, reason: "User declined write to external path." };
						}
					}
				}
			}
		}
	});

	// ── Mode Status Widget ────────────────────────────────────────────────

	pi.on("turn_end", async (_event, ctx) => {
		const labels: Record<ApprovalMode, string> = {
			"read-only": "READ-ONLY",
			"auto": "AUTO",
			"full-access": "FULL ACCESS",
		};
		const colors: Record<ApprovalMode, string> = {
			"read-only": "info",
			"auto": "success",
			"full-access": "warning",
		};
		const label = labels[mode.mode] || mode.mode;
		ctx.ui.setStatus("approval-mode", `${label}`);
	});

	// ── Inject mode into system prompt ────────────────────────────────────

	pi.on("before_agent_start", async (event, _ctx) => {
		const modeInstructions: Record<ApprovalMode, string> = {
			"read-only": `\n\n## Approval Mode: READ-ONLY
You CANNOT modify files, run write commands, or execute shell commands that change the system.
You MAY read files, search code, list directories, and run read-only commands (ls, cat, grep, git log, etc.).
Do NOT attempt to use write, edit, or bash for destructive operations.
Inform the user if a task requires write access. They can switch mode with /permissions auto.`,

			"auto": `\n\n## Approval Mode: AUTO
You may read, write, and edit files within the workspace. For destructive operations
(sudo, rm -rf, curl piped to shell, writing outside workspace), you must confirm with
the user or face blocking. Prefer safe alternatives when possible.`,

			"full-access": `\n\n## Approval Mode: FULL ACCESS
No restrictions. You have full access to read, write, and execute any command.
Exercise caution and always inform the user of destructive operations.`,
		};

		return {
			systemPrompt: event.systemPrompt + modeInstructions[mode.mode],
		};
	});

	// ── Command: /permissions ─────────────────────────────────────────────

	pi.registerCommand("permissions", {
		description: "Switch approval mode: read-only | auto | full-access",
		handler: async (args, ctx) => {
			const trimmed = (args || "").trim().toLowerCase();

			const validModes: ApprovalMode[] = ["read-only", "auto", "full-access"];

			if (!trimmed) {
				if (!ctx.hasUI) {
					ctx.ui.notify(
						`Current mode: ${mode.mode}. Use /permissions read-only|auto|full-access`,
						"info",
					);
					return;
				}

				const currentLabel = ` (current)`;
				const choices = validModes.map((m) => {
					const desc: Record<string, string> = {
						"read-only": "Browse files, no writes or command execution",
						"auto": "Workspace writes allowed, asks before external ops",
						"full-access": "No restrictions - use with caution",
					};
					return `${m === mode.mode ? "● " : "  "}${m}${m === mode.mode ? currentLabel : ""} — ${desc[m]}`;
				});

				const choice = await ctx.ui.select("Approval Mode:", choices);
				if (!choice) return;

				const newMode = validModes.find((m) => choice.includes(m));
				if (!newMode || newMode === mode.mode) return;

				mode = { mode: newMode, setAt: Date.now() };
				persist();

				const labels: Record<string, string> = {
					"read-only": "🔒 Read-Only",
					"auto": "🔓 Auto",
					"full-access": "⚠️ Full Access",
				};
				ctx.ui.notify(`Mode: ${labels[newMode]}`, "info");
				return;
			}

			if (!validModes.includes(trimmed as ApprovalMode)) {
				ctx.ui.notify(
					`Invalid mode. Use: read-only, auto, or full-access`,
					"warning",
				);
				return;
			}

			if (trimmed === mode.mode) {
				ctx.ui.notify(`Already in ${mode.mode} mode.`, "info");
				return;
			}

			// Warn about full-access
			if (trimmed === "full-access" && ctx.hasUI) {
				const confirm = await ctx.ui.confirm(
					"⚠️ Full Access Mode",
					"This removes ALL restrictions. The agent can run any command, write anywhere, and access the network without confirmation.\n\nAre you sure?",
				);
				if (!confirm) return;
			}

			mode = { mode: trimmed as ApprovalMode, setAt: Date.now() };
			persist();

			const labels: Record<string, string> = {
				"read-only": "🔒 Read-Only",
				"auto": "🔓 Auto",
				"full-access": "⚠️ Full Access",
			};
			ctx.ui.notify(`Mode changed: ${labels[trimmed]}`, "info");
		},
	});
}
