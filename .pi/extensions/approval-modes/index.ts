/**
 * Unified Command Safety Extension
 *
 * Four approval modes:
 *   /permissions read-only    — Read-only browsing in current directory
 *   /permissions default      — Workspace-write with user approval prompts
 *   /permissions auto-review  — Workspace-write with subagent-reviewed approvals
 *   /permissions full-access  — No restrictions (dangerous; confirm to enable)
 *
 * Preserves:
 *   /execpolicy  — regex allow/prompt/block rules
 *   /sandbox     — sandboxed ad-hoc command runner and sandbox mode status
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	dangerousShellReason,
	detectSandboxTools,
	evaluateExecPolicy,
	isExternalWritePath,
	isNetworkCommand,
	isNetworkToolName,
	isPathWithinCwd,
	isReadOnlyShellCommand,
	loadExecPolicy,
	resolveToolPath,
	runSandboxedCommand,
	saveExecPolicy,
	type ApprovalMode,
	type ExecPolicyAction,
	type ExecPolicyConfig,
	type SandboxMode,
	type SandboxState,
} from "../_shared/command-policy.ts";

interface ModeState {
	mode: ApprovalMode;
	setAt: number;
}

const MODE_CUSTOM_TYPE = "approval-mode-state";
const SANDBOX_CUSTOM_TYPE = "sandbox-state";

// Tools that read paths
const PATH_READ_TOOLS = new Set(["read", "grep", "find"]);
// Tools that write/edit paths — blocked entirely in read-only
const WRITE_TOOLS = new Set(["bash", "write", "edit"]);
// All tools that accept paths
const ALL_PATH_TOOLS = new Set([...PATH_READ_TOOLS, "write", "edit", "ls"]);
// Field names that might contain paths
const PATH_FIELDS = ["path", "file", "output", "target", "dest", "destination", "dir", "directory"];

// ── Auto-reviewer prompt path ─────────────────────────────────────────

const REVIEWER_PROMPT_PATH = path.join(
	path.dirname(new URL(import.meta.url).pathname),
	"auto-reviewer.md",
);

// ── Extension ──────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	let mode: ModeState = { mode: "default", setAt: Date.now() };
	let sandboxState: SandboxState = { mode: "danger-full-access", setAt: Date.now() };

	// ── Persistence ────────────────────────────────────────────────────

	function reconstruct(ctx: ExtensionContext) {
		mode = { mode: "default", setAt: Date.now() };
		sandboxState = { mode: "danger-full-access", setAt: Date.now() };
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom") continue;
			if (entry.customType === MODE_CUSTOM_TYPE) {
				const data = entry.data as ModeState | undefined;
				if (data?.mode) {
					// Migrate legacy "auto" → "default"
					mode = { mode: data.mode === "auto" ? "default" : data.mode, setAt: data.setAt };
				}
			}
			if (entry.customType === SANDBOX_CUSTOM_TYPE) {
				const data = entry.data as SandboxState | undefined;
				if (data?.mode) sandboxState = data;
			}
		}
	}

	function persistMode() {
		pi.appendEntry(MODE_CUSTOM_TYPE, { ...mode });
	}

	function persistSandbox() {
		pi.appendEntry(SANDBOX_CUSTOM_TYPE, { ...sandboxState });
	}

	// ── Status display ─────────────────────────────────────────────────

	function updateStatus(ctx: ExtensionContext) {
		const modeLabels: Record<ApprovalMode, string> = {
			"read-only": "READ-ONLY",
			default: "DEFAULT",
			"auto-review": "AUTO-REVIEW",
			"full-access": "FULL ACCESS",
		};
		ctx.ui.setStatus("approval-mode", modeLabels[mode.mode]);
		const sandboxLabels: Record<SandboxMode, string | undefined> = {
			"read-only": "SANDBOX: RO",
			"workspace-write": "SANDBOX: WS",
			"danger-full-access": undefined,
		};
		ctx.ui.setStatus("sandbox", sandboxLabels[sandboxState.mode]);
	}

	// ── Path extraction from tool inputs ───────────────────────────────

	function extractPathsFromInput(toolName: string, input: unknown): string[] {
		if (!input || typeof input !== "object") return [];
		const obj = input as Record<string, unknown>;
		const paths: string[] = [];

		// Primary path field
		if (typeof obj.path === "string") paths.push(obj.path);
		// edits array (edit tool)
		if (toolName === "edit" && Array.isArray(obj.edits)) {
			// edit doesn't have per-edit paths but the primary path is the target
			// already captured above
		}

		// For other path-containing fields
		for (const field of PATH_FIELDS) {
			if (typeof obj[field] === "string" && field !== "path") paths.push(obj[field] as string);
		}

		return paths.filter(Boolean);
	}

	// ── Approval helpers ───────────────────────────────────────────────

	/**
	 * Get the approval decision for the current mode.
	 *
	 * read-only   → block (shouldn't reach here; mutations are pre-blocked)
	 * default     → prompt user
	 * auto-review → reviewer subagent
	 * full-access → allow
	 */
	async function requestApproval(
		ctx: ExtensionContext,
		title: string,
		message: string,
	): Promise<{ allowed: boolean; reason?: string }> {
		switch (mode.mode) {
			case "read-only":
				return { allowed: false, reason: "Read-only mode." };

			case "default":
				if (!ctx.hasUI) return { allowed: false, reason: "No UI available for approval." };
				const ok = await ctx.ui.confirm(title, `${message}\n\nProceed?`);
				return { allowed: ok, reason: ok ? undefined : "User declined." };

			case "auto-review":
				return await runAutoReviewer(title, message);

			case "full-access":
				return { allowed: true };
		}
	}

	// ── Auto-reviewer subprocess ───────────────────────────────────────

	async function runAutoReviewer(
		title: string,
		message: string,
	): Promise<{ allowed: boolean; reason?: string }> {
		const promptContent = `${title}\n\n${message}`;

		// Resolve pi binary
		const entry = process.argv[1];
		let command = "pi";
		let baseArgs: string[] = [];
		if (entry) {
			try {
				const realEntry = fs.realpathSync(entry);
				if (/\.(?:mjs|cjs|js)$/i.test(realEntry)) {
					command = process.execPath;
					baseArgs = [realEntry];
				}
			} catch {}
		}

		const args = [
			...baseArgs,
			"--mode", "json",
			"-p",
			"--no-session",
			"--no-extensions",
			"--no-skills",
			"--no-tools",
			"--models", "anthropic/claude-haiku-4-5",
			"--append-system-prompt", REVIEWER_PROMPT_PATH,
			`Review this approval request and respond APPROVE or DENY with a reason:\n\n${promptContent}`,
		];

		try {
			const output = await new Promise<string>((resolve, reject) => {
				const proc = cp.spawn(command, args, {
					stdio: ["ignore", "pipe", "pipe"],
					timeout: 30000,
				});

				let stdout = "";
				let stderr = "";

				proc.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
				proc.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });

				proc.on("error", (err: Error) => reject(err));
				proc.on("close", () => resolve(stdout));
			});

			// Parse the JSON stream output to find the final assistant message
			const lines = output.split("\n");
			for (const line of lines) {
				if (!line.trim()) continue;
				try {
					const evt = JSON.parse(line);
					if (evt.type === "message_end" && evt.message?.role === "assistant") {
						const content = typeof evt.message.content === "string"
							? evt.message.content
							: Array.isArray(evt.message.content)
								? evt.message.content
									.filter((c: any) => c.type === "text")
									.map((c: any) => c.text)
									.join("\n")
								: "";

						const normalized = content.trim().toUpperCase();
						if (normalized.startsWith("APPROVE")) {
							const reason = content.replace(/^APPROVE:?\s*/i, "").trim() || "Approved by reviewer.";
							return { allowed: true, reason };
						}
						if (normalized.startsWith("DENY")) {
							const reason = content.replace(/^DENY:?\s*/i, "").trim() || "Denied by reviewer.";
							return { allowed: false, reason };
						}
						// Fallback: try to find APPROVE/DENY anywhere
						if (normalized.includes("APPROVE")) return { allowed: true, reason: "Approved by reviewer." };
						if (normalized.includes("DENY")) return { allowed: false, reason: "Denied by reviewer." };
					}
				} catch {}
			}

			// If no clear signal, check raw output
			const upper = output.toUpperCase();
			if (upper.includes("APPROVE")) return { allowed: true, reason: "Approved by reviewer." };
			if (upper.includes("DENY")) return { allowed: false, reason: "Denied by reviewer." };

			// Timeout or unclear response — fail closed
			return { allowed: false, reason: "Reviewer returned ambiguous response; blocked for safety." };
		} catch (err: any) {
			return { allowed: false, reason: `Reviewer error: ${err.message || String(err)}` };
		}
	}

	// ── Events ──────────────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => { reconstruct(ctx); updateStatus(ctx); });
	pi.on("session_tree", async (_event, ctx) => { reconstruct(ctx); updateStatus(ctx); });
	pi.on("turn_end", async (_event, ctx) => updateStatus(ctx));

	pi.on("tool_call", async (event, ctx) => {
		// ── ExecPolicy check (bash only, all modes) ────────────────────
		if (isToolCallEventType("bash", event)) {
			const command = event.input.command || "";
			const policyConfig = loadExecPolicy();
			const policy = evaluateExecPolicy(command, policyConfig);

			if (policy.matched || policyConfig.defaultAction !== "allow") {
				if (policy.action === "block") {
					return { block: true, reason: `Execpolicy blocked: ${policy.rule?.reason || "default block"}` };
				}
				if (policy.action === "prompt") {
					if (!ctx.hasUI) {
						return { block: true, reason: `Execpolicy requires prompt: ${policy.rule?.reason || "default prompt"}` };
					}
					const proceed = await ctx.ui.confirm(
						policy.matched ? "Execpolicy Check" : "Execpolicy - Default Prompt",
						`${policy.matched ? `Rule matched: ${policy.rule?.reason || policy.rule?.pattern}` : "No allow rule matched; default action is prompt."}\n\nCommand: ${command.slice(0, 200)}\n\nProceed?`,
					);
					if (!proceed) return { block: true, reason: "User declined via execpolicy prompt." };
				}
			}
		}

		// ── Read-only mode: block mutations ────────────────────────────
		if (mode.mode === "read-only") {
			// Block write/mutating tools entirely
			if (WRITE_TOOLS.has(event.toolName)) {
				return {
					block: true,
					reason: `Approval mode is read-only. Tool \`${event.toolName}\` is blocked. Use /permissions default to allow modifications.`,
				};
			}

			// Block network tools
			if (isNetworkToolName(event.toolName)) {
				return {
					block: true,
					reason: `Approval mode is read-only. Network tool \`${event.toolName}\` is blocked.`,
				};
			}

			// Restrict path-based read tools to cwd only
			if (ALL_PATH_TOOLS.has(event.toolName)) {
				const inputPaths = extractPathsFromInput(event.toolName, event.input);
				for (const inputPath of inputPaths) {
					if (!isPathWithinCwd(inputPath, ctx.cwd)) {
						return {
							block: true,
							reason: `Read-only mode: path "${inputPath}" is outside current directory (${ctx.cwd}). Only paths within the workspace are accessible.`,
						};
					}
				}
			}
		}

		// ── Bash-specific checks across modes ──────────────────────────
		if (isToolCallEventType("bash", event)) {
			const command = event.input.command || "";
			const trimmedCmd = command.trim();

			// Read-only bash: only read-only commands allowed
			if (mode.mode === "read-only" && !isReadOnlyShellCommand(trimmedCmd)) {
				return {
					block: true,
					reason: `Approval mode is read-only. Command blocked: ${trimmedCmd.slice(0, 80)}. Use /permissions default to allow writes.`,
				};
			}

			// Default / auto-review: dangerous commands need approval
			if (mode.mode === "default" || mode.mode === "auto-review") {
				const dangerReason = dangerousShellReason(trimmedCmd);
				if (dangerReason) {
					const { allowed, reason } = await requestApproval(
						ctx,
						"Dangerous Command",
						`${mode.mode === "default" ? "Default" : "Auto-review"} mode detected: ${dangerReason}\n\nCommand: ${trimmedCmd.slice(0, 200)}`,
					);
					if (!allowed) return { block: true, reason: reason ?? "Blocked." };
				}

				// Network command detection
				if (isNetworkCommand(trimmedCmd)) {
					const { allowed, reason } = await requestApproval(
						ctx,
						"Network Access",
						`Command appears to require network access.\n\nCommand: ${trimmedCmd.slice(0, 200)}`,
					);
					if (!allowed) return { block: true, reason: reason ?? "Network access blocked." };
				}
			}
		}

		// ── Network tool checks for default / auto-review ──────────────
		if ((mode.mode === "default" || mode.mode === "auto-review") &&
			isNetworkToolName(event.toolName)) {
			const { allowed, reason } = await requestApproval(
				ctx,
				"Network Tool",
				`Tool \`${event.toolName}\` requires network access.`,
			);
			if (!allowed) return { block: true, reason: reason ?? "Network access blocked." };
		}

		// ── External path writes for default / auto-review ─────────────
		if ((mode.mode === "default" || mode.mode === "auto-review") &&
			(event.toolName === "write" || event.toolName === "edit")) {
			const inputPaths = extractPathsFromInput(event.toolName, event.input);
			for (const inputPath of inputPaths) {
				if (inputPath && isExternalWritePath(inputPath)) {
					const { allowed, reason } = await requestApproval(
						ctx,
						"External Path",
						`${mode.mode === "default" ? "Default" : "Auto-review"} mode: path "${inputPath}" is outside workspace.\nAllow write?`,
					);
					if (!allowed) return { block: true, reason: reason ?? "Write to external path blocked." };
				}
				// Also catch non-external paths that are still outside cwd
				if (inputPath && !isPathWithinCwd(inputPath, ctx.cwd) && !isExternalWritePath(inputPath)) {
					const resolved = resolveToolPath(inputPath, ctx.cwd);
					const { allowed, reason } = await requestApproval(
						ctx,
						"External Path",
						`${mode.mode === "default" ? "Default" : "Auto-review"} mode: path "${inputPath}" (resolved: ${resolved}) is outside workspace.\nAllow write?`,
					);
					if (!allowed) return { block: true, reason: reason ?? "Write to external path blocked." };
				}
			}
		}
	});

	// ── System prompt injection ────────────────────────────────────────

	pi.on("before_agent_start", async (event) => {
		const modeInstructions: Record<ApprovalMode, string> = {
			"read-only": `\n\n## Permission Mode: READ-ONLY\nYou are in read-only browsing mode, limited to the current directory.\n- You CAN read files, search code, list directories, and run read-only commands within ${event.systemPrompt.includes("cwd") ? "the workspace" : "the current directory"}.\n- You CANNOT modify files, run write commands, execute shell commands that change the system, or access the network.\n- Do NOT attempt to use write, edit, or bash for destructive operations.\n- Inform the user if a task requires write access. They can switch mode with /permissions default.`,
			default: `\n\n## Permission Mode: DEFAULT\nYou may read, write, and edit files within the current workspace, and run commands.\nApproval is required to:\n- Access the internet (curl, fetch, package installs, git push/pull/clone, etc.)\n- Write or edit files outside the workspace\n- Run dangerous commands (sudo, rm -rf, curl piped to shell)\nPrefer safe alternatives when possible.`,
			"auto-review": `\n\n## Permission Mode: AUTO-REVIEW\nSame workspace-write permissions as Default, but eligible approval requests are routed through an automatic reviewer subagent instead of prompting the user.\nYou may read, write, and edit files within the workspace.\nActions requiring network access, external writes, or dangerous commands will be reviewed automatically and may be denied without user involvement.`,
			"full-access": `\n\n## Permission Mode: FULL ACCESS\nNo restrictions. You have full access to read, write, and execute any command, including network access and writing outside the workspace.\nExercise caution and always inform the user of destructive operations.`,
		};
		return { systemPrompt: event.systemPrompt + modeInstructions[mode.mode] };
	});

	// ── /permissions command ────────────────────────────────────────────

	pi.registerCommand("permissions", {
		description: "Switch approval mode: read-only | default | auto-review | full-access",
		handler: async (args, ctx) => {
			const trimmed = (args || "").trim().toLowerCase();
			const validModes: ApprovalMode[] = ["read-only", "default", "auto-review", "full-access"];
			// Aliases
			const aliasMap: Record<string, ApprovalMode> = {
				auto: "default",
				full: "full-access",
				ro: "read-only",
				review: "auto-review",
			};

			const modeLabels: Record<ApprovalMode, string> = {
				"read-only": "Read-only browsing – read in current directory only",
				default: "Default – read, edit, and run commands in workspace; approval for internet and external writes",
				"auto-review": "Auto-review – same as Default but approvals are auto-reviewed by a subagent",
				"full-access": "Full Access – no restrictions, no approval prompts (use with caution)",
			};

			if (!trimmed) {
				if (!ctx.hasUI) {
					ctx.ui.notify(`Current mode: ${mode.mode}. Use /permissions read-only|default|auto-review|full-access`, "info");
					return;
				}
				const choices = validModes.map((m) =>
					`${m === mode.mode ? "● " : "  "}${m} — ${modeLabels[m]}${m === mode.mode ? " (current)" : ""}`
				);
				const choice = await ctx.ui.select("Permission Mode:", choices);
				const newMode = choice && validModes.find((m) => choice.includes(m));
				if (!newMode || newMode === mode.mode) return;
				if (!(await switchMode(newMode, ctx))) return;
				return;
			}

			// Resolve aliases
			let requestedMode: ApprovalMode = aliasMap[trimmed] ?? (validModes.includes(trimmed as ApprovalMode) ? trimmed as ApprovalMode : "" as ApprovalMode);
			if (!validModes.includes(requestedMode)) {
				ctx.ui.notify("Invalid mode. Use: read-only, default, auto-review, or full-access", "warning");
				return;
			}
			if (requestedMode === mode.mode) {
				ctx.ui.notify(`Already in ${mode.mode} mode.`, "info");
				return;
			}
			await switchMode(requestedMode, ctx);
		},
	});

	async function switchMode(newMode: ApprovalMode, ctx: ExtensionContext): Promise<boolean> {
		if (newMode === "full-access" && ctx.hasUI) {
			const confirmed = await ctx.ui.confirm(
				"⚠️ Full Access Mode",
				"This removes ALL restrictions. The agent can run any command, write anywhere, and access the network without confirmation.\n\nExercise caution when using.\n\nAre you sure?",
			);
			if (!confirmed) return false;
		}
		mode = { mode: newMode, setAt: Date.now() };
		persistMode();
		updateStatus(ctx);
		ctx.ui.notify(`Mode changed: ${mode.mode}`, "info");
		return true;
	}

	// ── /execpolicy command ─────────────────────────────────────────────

	pi.registerCommand("execpolicy", {
		description: "Manage command execution policies (check|rules|add|remove|default)",
		handler: async (args, ctx) => {
			const trimmed = (args || "").trim();
			const parts = trimmed.split(/\s+/);
			const subcmd = parts[0];
			const rest = parts.slice(1).join(" ");
			const config: ExecPolicyConfig = loadExecPolicy();

			switch (subcmd) {
				case "check": {
					if (!rest) return ctx.ui.notify("Usage: /execpolicy check <command>", "warning");
					const result = evaluateExecPolicy(rest, config);
					ctx.ui.notify(result.matched
						? `MATCHED: ${result.action.toUpperCase()} — ${result.rule?.reason || result.rule?.pattern}`
						: `NO MATCH — Default: ${config.defaultAction.toUpperCase()}`,
						result.action === "block" ? "error" : result.action === "prompt" ? "warning" : "info");
					return;
				}
				case "rules": {
					if (config.rules.length === 0) return ctx.ui.notify(`No rules defined. Default action: ${config.defaultAction}. Use /execpolicy add to add rules.`, "info");
					ctx.ui.notify([...config.rules.map((r) => `[${r.id}] ${r.action.toUpperCase()}: ${r.pattern} — ${r.reason}`), `\nDefault action: ${config.defaultAction.toUpperCase()}`].join("\n"), "info");
					return;
				}
				case "add": {
					if (!rest) return ctx.ui.notify("Usage: /execpolicy add <pattern> | <action> | <reason>", "warning");
					const ruleParts = rest.split("|").map((s) => s.trim());
					const pattern = ruleParts[0];
					const action = (ruleParts[1] || "prompt") as ExecPolicyAction;
					const reason = ruleParts[2] || pattern;
					if (!["allow", "prompt", "block"].includes(action)) return ctx.ui.notify("Action must be: allow, prompt, or block", "warning");
					try { new RegExp(pattern); } catch (error: any) { return ctx.ui.notify(`Invalid regex pattern: ${error.message || String(error)}`, "warning"); }
					const id = String(Math.max(0, ...config.rules.map((r) => Number(r.id) || 0)) + 1);
					config.rules.push({ id, pattern, action, reason });
					saveExecPolicy(config);
					ctx.ui.notify(`Rule added: [${id}] ${action.toUpperCase()}: ${pattern}`, "info");
					return;
				}
				case "remove": {
					if (!rest) return ctx.ui.notify("Usage: /execpolicy remove <id>", "warning");
					const idx = config.rules.findIndex((r) => r.id === rest);
					if (idx < 0) return ctx.ui.notify(`Rule not found: ${rest}`, "warning");
					const [removed] = config.rules.splice(idx, 1);
					saveExecPolicy(config);
					ctx.ui.notify(`Removed rule [${removed.id}]: ${removed.pattern}`, "info");
					return;
				}
				case "default": {
					const action = rest as ExecPolicyAction;
					if (!["allow", "prompt", "block"].includes(action)) return ctx.ui.notify("Usage: /execpolicy default allow|prompt|block", "warning");
					config.defaultAction = action;
					saveExecPolicy(config);
					ctx.ui.notify(`Default action: ${action.toUpperCase()}`, "info");
					return;
				}
				default:
					ctx.ui.notify("Usage: /execpolicy check|rules|add|remove|default", "info");
			}
		},
	});

	// ── /sandbox command ────────────────────────────────────────────────

	pi.registerCommand("sandbox", {
		description: "Run command in sandbox or change sandbox mode",
		handler: async (args, ctx) => {
			const trimmed = (args || "").trim();
			const parts = trimmed.split(/\s+/);
			const subcmd = parts[0];
			const rest = parts.slice(1).join(" ");

			if (subcmd === "mode") {
				const sandboxMode = rest as SandboxMode;
				const validModes: SandboxMode[] = ["read-only", "workspace-write", "danger-full-access"];
				if (!validModes.includes(sandboxMode)) return ctx.ui.notify("Usage: /sandbox mode read-only|workspace-write|danger-full-access", "warning");
				if (sandboxMode === "danger-full-access" && ctx.hasUI) {
					const confirmed = await ctx.ui.confirm("⚠️ Full Access Sandbox", "This disables ALL sandbox restrictions. Commands can access anything.\n\nAre you sure?");
					if (!confirmed) return;
				}
				sandboxState = { mode: sandboxMode, setAt: Date.now() };
				persistSandbox();
				updateStatus(ctx);
				ctx.ui.notify(`Sandbox mode: ${sandboxMode}`, "info");
				return;
			}

			if (!trimmed || subcmd === "status") {
				const sandbox = detectSandboxTools();
				ctx.ui.notify(`Current mode: ${sandboxState.mode}\n${sandbox.available ? `Sandbox available: ${sandbox.tool}` : "No sandbox tools detected"}\nUsage: /sandbox mode <mode> | /sandbox <command>`, "info");
				return;
			}

			ctx.ui.notify(`Running in ${sandboxState.mode} sandbox: ${trimmed.slice(0, 80)}...`, "info");
			const result = await runSandboxedCommand(trimmed, sandboxState.mode, ctx.cwd);
			ctx.ui.notify([
				`Sandbox mode: ${sandboxState.mode}`,
				`Exit code: ${result.code}`,
				"",
				"stdout:",
				result.stdout || "(empty)",
				"",
				"stderr:",
				result.stderr || "(none)",
			].join("\n"), "info");
		},
	});
}
