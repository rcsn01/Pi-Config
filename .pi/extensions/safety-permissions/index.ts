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
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Box, Text } from "@earendil-works/pi-tui";
import {
	dangerousShellReason,
	evaluateExecPolicy,
	extractExternalPathsFromCommand,
	isExternalWritePath,
	isNetworkCommand,
	isNetworkToolName,
	isPathWithinCwd,
	isReadOnlyShellCommand,
	isSensitivePath,
	loadExecPolicy,
	resolveToolPath,
	saveExecPolicy,
	type ApprovalMode,
	type ExecPolicyAction,
	type ExecPolicyConfig,
} from "../_shared/command-policy.ts";
import { pickGuiOption } from "../_shared/gui-option-list.ts";

interface ModeState {
	mode: ApprovalMode;
	setAt: number;
}

const MODE_FILE = path.join(".pi", "approval-mode.json");

// Tools that read paths
const PATH_READ_TOOLS = new Set(["read", "grep", "find"]);
// Tools that write/edit paths — blocked entirely in read-only
const WRITE_TOOLS = new Set(["bash", "write", "edit"]);
// All tools that accept paths
const ALL_PATH_TOOLS = new Set([...PATH_READ_TOOLS, "write", "edit", "ls"]);
// Field names that might contain paths
const PATH_FIELDS = ["path", "file", "output", "target", "dest", "destination", "dir", "directory"];

// ── Extension ──────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	let mode: ModeState = { mode: "default", setAt: Date.now() };
	let lastDeniedAction: { key: string; title: string; message: string; at: number } | undefined;
	let lastUserPrompt = "";
	const oneShotApprovals = new Set<string>();

	// ── Persistence ────────────────────────────────────────────────────

	function saveModeToFile() {
		try {
			const filePath = path.join(process.cwd(), MODE_FILE);
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			fs.writeFileSync(filePath, JSON.stringify(mode, null, "\t"), { encoding: "utf-8" });
		} catch {}
	}

	function loadModeFromFile(cwd: string): ModeState | null {
		try {
			const filePath = path.join(cwd, MODE_FILE);
			if (fs.existsSync(filePath)) {
				const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
				if (raw?.mode && ["read-only", "default", "auto-review", "full-access"].includes(raw.mode)) {
					return { mode: raw.mode, setAt: raw.setAt || Date.now() };
				}
			}
		} catch {}
		return null;
	}

	function reconstruct(ctx: ExtensionContext) {
		mode = loadModeFromFile(ctx.cwd) ?? { mode: "default", setAt: Date.now() };
	}

	function persistMode() {
		saveModeToFile();
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

	function actionKey(toolName: string, input: unknown): string {
		return `${toolName}:${JSON.stringify(input ?? {})}`;
	}

	function rememberDenied(toolName: string, input: unknown, title: string, message: string) {
		lastDeniedAction = { key: actionKey(toolName, input), title, message, at: Date.now() };
	}

	// ── Approval helpers ───────────────────────────────────────────────

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
	): Promise<{ allowed: boolean; reason?: string }> {
		switch (mode.mode) {
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

	// ── Guardian auto-reviewer ────────────────────────────────────────────

	async function runAutoReviewer(
		title: string,
		message: string,
	): Promise<{ allowed: boolean; reason?: string }> {
		const task = `Evaluate this action for safety.

You are operating in auto-review mode. You are the FINAL authority — your decision is never escalated to the user. Decide yourself: allow or deny.

Title: ${title}

${message}`;

		// Read guardian agent config
		const extDir = path.dirname(new URL(import.meta.url).pathname);
		const guardianPath = path.join(extDir, "guardian.md");

		let systemPrompt = "";
		let model = "";  // Empty = use pi's default model from settings
		let tools = "";

		try {
			const guardianContent = fs.readFileSync(guardianPath, "utf-8");
			// Parse YAML frontmatter
			const fmMatch = guardianContent.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
			if (fmMatch) {
				const fm = fmMatch[1];
				systemPrompt = fmMatch[2].trim();
				for (const line of fm.split("\n")) {
					if (line.startsWith("model:")) model = line.split(":").slice(1).join(":").trim();
					if (line.startsWith("tools:")) tools = line.split(":").slice(1).join(":").trim();
				}
			}
		} catch {
			// Guardian not found — fail closed
			return { allowed: false, reason: "Guardian agent not found; blocked for safety." };
		}

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

		const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-guardian-"));
		const promptPath = path.join(tempDir, "guardian.md");
		await fs.promises.writeFile(promptPath, systemPrompt, { encoding: "utf-8", mode: 0o600 });

		const args = [
			...baseArgs,
			"--mode", "json",
			"-p",
			"--no-session",
			"--no-skills",
		];
		if (tools) {
			args.push("--tools", tools);
		} else {
			args.push("--no-tools");
		}
		if (model) {
			args.push("--model", model);
		}
		args.push(
			"--append-system-prompt", promptPath,
			task,
		);

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

			// Parse JSON stream to find the final assistant message
			let content = "";
			const lines = output.split("\n");
			for (const line of lines) {
				if (!line.trim()) continue;
				try {
					const evt = JSON.parse(line);
					if (evt.type === "message_end" && evt.message?.role === "assistant") {
						const msg = evt.message.content;
						content = typeof msg === "string"
							? msg
							: Array.isArray(msg)
								? msg.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n")
								: "";
					}
				} catch {}
			}

			if (!content.trim()) {
				return { allowed: false, reason: "Guardian returned no response; blocked for safety." };
			}

			// Try to parse the guardian's JSON verdict — strip markdown fences first
			let jsonCandidate = content.trim()
				.replace(/```json\s*/gi, "")
				.replace(/```\s*/g, "")
				.trim();
			try {
				const verdict = JSON.parse(jsonCandidate);
				if (verdict.outcome === "allow") {
					const parts: string[] = [];
					if (verdict.risk_level) parts.push(`risk: ${verdict.risk_level}`);
					if (verdict.user_authorization) parts.push(`auth: ${verdict.user_authorization}`);
					const reason = verdict.rationale || parts.join(", ") || "allowed";
					return { allowed: true, reason };
				}
				if (verdict.outcome === "deny") {
					const parts: string[] = [];
					if (verdict.risk_level) parts.push(`risk: ${verdict.risk_level}`);
					if (verdict.user_authorization) parts.push(`auth: ${verdict.user_authorization}`);
					if (verdict.rationale) parts.push(verdict.rationale);
					return {
						allowed: false,
						reason: parts.join(" | ") || "Guardian: denied.",
					};
				}
			} catch {}

			// Super-lenient fallback: look for ALLOW or DENY anywhere in content
			// Strip markdown code fences, extra whitespace, and common prefixes
			let cleaned = content
				.replace(/```[\s\S]*?```/g, "")  // strip code blocks
				.replace(/^[\s\S]*?(ALLOW|DENY)/im, "$1")  // strip everything before ALLOW/DENY
				.trim()
				.toUpperCase();

			if (cleaned.startsWith("ALLOW")) {
				return { allowed: true, reason: "Guardian: allowed." };
			}
			if (cleaned.startsWith("DENY")) {
				return { allowed: false, reason: "Guardian: denied." };
			}

			// Last resort: check original JSON-style patterns
			const normalized = content.trim().toUpperCase();
			if (normalized.includes('"ALLOW"') || normalized.includes('"OUTCOME":"ALLOW"')) {
				return { allowed: true, reason: "Guardian: allowed." };
			}
			if (normalized.includes('"DENY"') || normalized.includes('"OUTCOME":"DENY"')) {
				return { allowed: false, reason: "Guardian: denied." };
			}

			// Unclear response - fail closed
			return { allowed: false, reason: "Guardian returned ambiguous response; blocked for safety." };
		} catch (err: any) {
			return { allowed: false, reason: `Guardian error: ${err.message || String(err)}` };
		} finally {
			// Cleanup temp dir
			try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
		}
	}

	// ── Guardian helper for auto-review ──────────────────────────────

	/**
	 * Run the guardian LLM to evaluate an action. If the guardian allows,
	 * proceed silently. If denied, block with notification. If it needs
	 * user approval, prompt the user directly.
	 */
	async function guardianReview(
		ctx: ExtensionContext,
		title: string,
		actionDescription: string,
	): Promise<{ allowed: boolean; reason?: string }> {
		if (!ctx.hasUI) {
			return { allowed: false, reason: "Auto-review: no UI available for guardian fallback." };
		}

		// Extract user's last request for authorization context
		const userRequest = lastUserPrompt || "(unknown)";

		// Build evaluation message with user context
		const evaluationMessage = `User request: ${userRequest}\n\nAction: ${title}\n${actionDescription}`;

		try {
			const result = await runAutoReviewer(title, evaluationMessage);

			// Emit custom verdict message in warning color
			const icon = result.allowed ? "✅" : "❌";
			const label = result.allowed ? "ALLOWED" : "DENIED";
			pi.sendMessage({
				customType: "auto-review-verdict",
				content: `${icon} ${label}: ${title} — ${result.reason || ""}`,
				display: true,
				details: { title, allowed: result.allowed, reason: result.reason },
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

	// ── Events ──────────────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => { reconstruct(ctx); updateStatus(ctx); });
	pi.on("session_tree", async (_event, ctx) => { reconstruct(ctx); updateStatus(ctx); });
	pi.on("turn_end", async (_event, ctx) => updateStatus(ctx));

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
					if (!proceed) {
						rememberDenied(event.toolName, event.input, "Execpolicy Check", command.slice(0, 200));
						return { block: true, reason: "User declined via execpolicy prompt." };
					}
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

		// ── Sensitive path reads for default ───────────────────────────
		if (mode.mode === "default" &&
			PATH_READ_TOOLS.has(event.toolName)) {
			const inputPaths = extractPathsFromInput(event.toolName, event.input);
			for (const inputPath of inputPaths) {
				if (inputPath && isSensitivePath(inputPath)) {
					const message = `Tool \`${event.toolName}\` appears to read a sensitive path.\n\nPath: ${inputPath}`;
					const { allowed, reason } = await requestApproval(ctx, "Sensitive Path", message);
					if (!allowed) {
						rememberDenied(event.toolName, event.input, "Sensitive Path", message);
						return { block: true, reason: reason ?? "Sensitive path access blocked." };
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

			// Default & auto-review: dangerous commands need approval
			if (mode.mode === "default" || mode.mode === "auto-review") {
				const dangerReason = dangerousShellReason(trimmedCmd);
				if (dangerReason) {
					if (mode.mode === "auto-review") {
						const { allowed, reason } = await guardianReview(
							ctx,
							"Dangerous Command",
							`Auto-review mode: ${dangerReason}\n\nCommand: ${trimmedCmd.slice(0, 200)}`,
						);
						if (!allowed) {
							rememberDenied(event.toolName, event.input, "Dangerous Command", trimmedCmd.slice(0, 200));
							return { block: true, reason: reason ?? "Auto-review: dangerous command blocked." };
						}
					} else {
						const { allowed, reason } = await requestApproval(
							ctx,
							"Dangerous Command",
							`Default mode detected: ${dangerReason}\n\nCommand: ${trimmedCmd.slice(0, 200)}`,
						);
						if (!allowed) {
							rememberDenied(event.toolName, event.input, "Dangerous Command", trimmedCmd.slice(0, 200));
							return { block: true, reason: reason ?? "Blocked." };
						}
					}
				}

				// Network command detection (default: prompt; auto-review: prompt for install/modify commands)
				if (isNetworkCommand(trimmedCmd)) {
					if (mode.mode === "auto-review") {
						const { allowed, reason } = await guardianReview(
							ctx,
							"Network Command",
							`Command may install/modify software outside the workspace.\n\nCommand: ${trimmedCmd.slice(0, 200)}`,
						);
						if (!allowed) {
							rememberDenied(event.toolName, event.input, "Network Access", trimmedCmd.slice(0, 200));
							return { block: true, reason: reason ?? "Auto-review: network command blocked." };
						}
					} else {
						const { allowed, reason } = await requestApproval(
							ctx,
							"Network Access",
							`Command appears to require network access.\n\nCommand: ${trimmedCmd.slice(0, 200)}`,
						);
						if (!allowed) {
							rememberDenied(event.toolName, event.input, "Network Access", trimmedCmd.slice(0, 200));
							return { block: true, reason: reason ?? "Network access blocked." };
						}
					}
				}

				// Auto-review: detect bash commands referencing paths outside the workspace
				if (mode.mode === "auto-review") {
					const externalPaths = extractExternalPathsFromCommand(trimmedCmd, ctx.cwd);
					if (externalPaths.length > 0) {
						const pathList = externalPaths.slice(0, 5).join("\n");
						const extra = externalPaths.length > 5 ? `\n... and ${externalPaths.length - 5} more` : "";
						const { allowed, reason } = await guardianReview(
							ctx,
							"External Path in Command",
							`Command references paths outside the workspace:\n${pathList}${extra}\n\nCommand: ${trimmedCmd.slice(0, 200)}`,
						);
						if (!allowed) {
							rememberDenied(event.toolName, event.input, "External Path", externalPaths[0]);
							return { block: true, reason: reason ?? "Auto-review: external path command blocked." };
						}
					}
				}
			}
		}

		// ── Network tool checks for default ────────────────────────────
		if (mode.mode === "default" &&
			isNetworkToolName(event.toolName)) {
			const { allowed, reason } = await requestApproval(
				ctx,
				"Network Tool",
				`Tool \`${event.toolName}\` requires network access.`,
			);
			if (!allowed) {
				rememberDenied(event.toolName, event.input, "Network Tool", `Tool \`${event.toolName}\` requires network access.`);
				return { block: true, reason: reason ?? "Network access blocked." };
			}
		}

		// ── External path writes for default / auto-review ─────────────
		if ((mode.mode === "default" || mode.mode === "auto-review") &&
			(event.toolName === "write" || event.toolName === "edit")) {
			const inputPaths = extractPathsFromInput(event.toolName, event.input);
			for (const inputPath of inputPaths) {
				if (inputPath && isExternalWritePath(inputPath)) {
					// Auto-review: prompt user directly for external writes (the ONE thing you care about)
					if (mode.mode === "auto-review") {
						const { allowed, reason } = await guardianReview(
							ctx,
							"External Write",
							`Path "${inputPath}" is outside the workspace.`,
						);
						if (!allowed) {
							rememberDenied(event.toolName, event.input, "External Path", inputPath);
						}
							return { block: true, reason: reason ?? "Auto-review: external write blocked." };
						continue;
					}
					// Default mode
					const { allowed, reason } = await requestApproval(
						ctx,
						"External Path",
						`Default mode: path "${inputPath}" is outside workspace.\nAllow write?`,
					);
					if (!allowed) {
						rememberDenied(event.toolName, event.input, "External Path", inputPath);
						return { block: true, reason: reason ?? "Write to external path blocked." };
					}
				}
				// Also catch non-external paths that are still outside cwd
				if (inputPath && !isPathWithinCwd(inputPath, ctx.cwd) && !isExternalWritePath(inputPath)) {
					const resolved = resolveToolPath(inputPath, ctx.cwd);
					// Auto-review: prompt user directly
					if (mode.mode === "auto-review") {
						const { allowed, reason } = await guardianReview(
							ctx,
							"External Write",
							`Path "${inputPath}" (resolved: ${resolved}) is outside the workspace.`,
						);
						if (!allowed) {
							rememberDenied(event.toolName, event.input, "External Path", inputPath);
							return { block: true, reason: reason ?? "Auto-review: external write blocked." };
						}
						continue;
					}
					// Default mode
					const { allowed, reason } = await requestApproval(
						ctx,
						"External Path",
						`Default mode: path "${inputPath}" (resolved: ${resolved}) is outside workspace.\nAllow write?`,
					);
					if (!allowed) {
						rememberDenied(event.toolName, event.input, "External Path", inputPath);
						return { block: true, reason: reason ?? "Write to external path blocked." };
					}
				}
			}
		}
	});

	// ── System prompt injection ────────────────────────────────────────

	pi.on("before_agent_start", async (event) => {
		lastUserPrompt = (event.prompt || "").slice(0, 500);
		const modeInstructions: Record<ApprovalMode, string> = {
			"read-only": `\n\n## Permission Mode: READ-ONLY\nYou are in read-only browsing mode, limited to the current directory.\n- You CAN read files, search code, list directories, and run read-only commands within ${event.systemPrompt.includes("cwd") ? "the workspace" : "the current directory"}.\n- You CANNOT modify files, run write commands, execute shell commands that change the system, or access the network.\n- Do NOT attempt to use write, edit, or bash for destructive operations.\n- Inform the user if a task requires write access. They can switch mode with /permissions default.`,
			default: `\n\n## Permission Mode: DEFAULT\nYou may read, write, and edit files within the current workspace, and run commands.\nApproval is required to:\n- Access the internet (curl, fetch, package installs, git push/pull/clone, etc.)\n- Write or edit files outside the workspace\n- Run dangerous commands (sudo, rm -rf, curl piped to shell)\nPrefer safe alternatives when possible.`,
			"auto-review": `\n\n## Permission Mode: AUTO-REVIEW\nFull auto — no restrictions on reading, writing within the workspace, web searches, or running commands.\nA guardian LLM reviews dangerous commands, network installs, and writes outside the workspace.\nSafe actions pass silently. Risky actions may trigger a user prompt.`,
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
				"auto-review": "Auto-review – full auto; only prompts you for edits outside the workspace",
				"full-access": "Full Access – no restrictions, no approval prompts (use with caution)",
			};

			if (!trimmed) {
				if (!ctx.hasUI) {
					ctx.ui.notify(`Current mode: ${mode.mode}. Use /permissions read-only|default|auto-review|full-access`, "info");
					return;
				}
				const newMode = await pickGuiOption<ApprovalMode>(ctx, {
					title: "Permission Mode:",
					message: `Current mode: ${mode.mode}`,
					options: validModes.map((m) => ({
						label: m,
						value: m,
						description: modeLabels[m],
						checked: m === mode.mode,
					})),
				});
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

	pi.registerCommand("approve", {
		description: "Allow the last denied action once, then retry it",
		handler: async (_args, ctx) => {
			if (!lastDeniedAction) {
				ctx.ui.notify("No denied action to approve.", "info");
				return;
			}
			const approved = lastDeniedAction;
			lastDeniedAction = undefined;
			oneShotApprovals.add(approved.key);
			ctx.ui.notify(
				`Approved once: ${approved.title}\nRetry the same action now. This approval will be consumed by the next matching tool call.`,
				"info",
			);
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

}
