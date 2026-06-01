/**
 * Unified Command Safety Extension
 *
 * Single owner for command/tool-call safety. Preserves public commands:
 *   /permissions - approval mode
 *   /execpolicy  - regex allow/prompt/block rules
 *   /sandbox     - sandboxed ad-hoc command runner and sandbox mode status
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import {
	dangerousShellReason,
	detectSandboxTools,
	evaluateExecPolicy,
	isExternalWritePath,
	isReadOnlyShellCommand,
	loadExecPolicy,
	runSandboxedCommand,
	saveExecPolicy,
	type ExecPolicyAction,
	type ExecPolicyConfig,
	type SandboxMode,
	type SandboxState,
} from "../_shared/command-policy.ts";

type ApprovalMode = "read-only" | "auto" | "full-access";

interface ModeState {
	mode: ApprovalMode;
	setAt: number;
}

const MODE_CUSTOM_TYPE = "approval-mode-state";
const SANDBOX_CUSTOM_TYPE = "sandbox-state";
const READ_ONLY_BLOCKED_TOOLS = new Set(["bash", "write", "edit"]);

export default function (pi: ExtensionAPI) {
	let mode: ModeState = { mode: "auto", setAt: Date.now() };
	let sandboxState: SandboxState = { mode: "danger-full-access", setAt: Date.now() };

	function reconstruct(ctx: ExtensionContext) {
		mode = { mode: "auto", setAt: Date.now() };
		sandboxState = { mode: "danger-full-access", setAt: Date.now() };
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom") continue;
			if (entry.customType === MODE_CUSTOM_TYPE) {
				const data = entry.data as ModeState | undefined;
				if (data?.mode) mode = data;
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

	function updateStatus(ctx: ExtensionContext) {
		const modeLabels: Record<ApprovalMode, string> = {
			"read-only": "READ-ONLY",
			auto: "AUTO",
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

	pi.on("session_start", async (_event, ctx) => { reconstruct(ctx); updateStatus(ctx); });
	pi.on("session_tree", async (_event, ctx) => { reconstruct(ctx); updateStatus(ctx); });
	pi.on("turn_end", async (_event, ctx) => updateStatus(ctx));

	pi.on("tool_call", async (event, ctx) => {
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

			if (mode.mode === "read-only" && !isReadOnlyShellCommand(command)) {
				return {
					block: true,
					reason: `Approval mode is read-only. Command blocked: ${command.slice(0, 80)}. Use /permissions auto to allow writes.`,
				};
			}

			if (mode.mode === "auto") {
				const reason = dangerousShellReason(command);
				if (reason) {
					if (!ctx.hasUI) return { block: true, reason: `Auto mode blocked: ${reason}` };
					const proceed = await ctx.ui.confirm(
						"Dangerous Command",
						`Auto mode detected: ${reason}\n\nCommand: ${command.slice(0, 200)}\n\nProceed?`,
					);
					if (!proceed) return { block: true, reason: `User declined: ${reason}` };
				}
			}
		} else if (mode.mode === "read-only" && READ_ONLY_BLOCKED_TOOLS.has(event.toolName)) {
			return {
				block: true,
				reason: `Approval mode is read-only. Tool \`${event.toolName}\` is blocked. Use /permissions auto to allow modifications.`,
			};
		}

		if (mode.mode === "auto" && (event.toolName === "write" || event.toolName === "edit")) {
			const input = event.input as { path?: string } | undefined;
			const targetPath = input?.path || "";
			if (targetPath && isExternalWritePath(targetPath)) {
				if (!ctx.hasUI) {
					return { block: true, reason: `Auto mode: writing to ${targetPath} requires approval.` };
				}
				const proceed = await ctx.ui.confirm("External Path", `Auto mode: path "${targetPath}" is outside workspace.\nAllow write?`);
				if (!proceed) return { block: true, reason: "User declined write to external path." };
			}
		}
	});

	pi.on("before_agent_start", async (event) => {
		const modeInstructions: Record<ApprovalMode, string> = {
			"read-only": `\n\n## Approval Mode: READ-ONLY\nYou CANNOT modify files, run write commands, or execute shell commands that change the system.\nYou MAY read files, search code, list directories, and run read-only commands (ls, cat, grep, git log, etc.).\nDo NOT attempt to use write, edit, or bash for destructive operations.\nInform the user if a task requires write access. They can switch mode with /permissions auto.`,
			auto: `\n\n## Approval Mode: AUTO\nYou may read, write, and edit files within the workspace. For destructive operations\n(sudo, rm -rf, curl piped to shell, writing outside workspace), you must confirm with\nthe user or face blocking. Prefer safe alternatives when possible.`,
			"full-access": `\n\n## Approval Mode: FULL ACCESS\nNo restrictions. You have full access to read, write, and execute any command.\nExercise caution and always inform the user of destructive operations.`,
		};
		return { systemPrompt: event.systemPrompt + modeInstructions[mode.mode] };
	});

	pi.registerCommand("permissions", {
		description: "Switch approval mode: read-only | auto | full-access",
		handler: async (args, ctx) => {
			const trimmed = (args || "").trim().toLowerCase();
			const validModes: ApprovalMode[] = ["read-only", "auto", "full-access"];

			if (!trimmed) {
				if (!ctx.hasUI) {
					ctx.ui.notify(`Current mode: ${mode.mode}. Use /permissions read-only|auto|full-access`, "info");
					return;
				}
				const choices = validModes.map((m) => `${m === mode.mode ? "● " : "  "}${m}${m === mode.mode ? " (current)" : ""}`);
				const choice = await ctx.ui.select("Approval Mode:", choices);
				const newMode = choice && validModes.find((m) => choice.includes(m));
				if (!newMode || newMode === mode.mode) return;
				mode = { mode: newMode, setAt: Date.now() };
				persistMode();
				updateStatus(ctx);
				ctx.ui.notify(`Mode: ${newMode}`, "info");
				return;
			}

			if (!validModes.includes(trimmed as ApprovalMode)) {
				ctx.ui.notify("Invalid mode. Use: read-only, auto, or full-access", "warning");
				return;
			}
			if (trimmed === mode.mode) {
				ctx.ui.notify(`Already in ${mode.mode} mode.`, "info");
				return;
			}
			if (trimmed === "full-access" && ctx.hasUI) {
				const confirmed = await ctx.ui.confirm("⚠️ Full Access Mode", "This removes ALL restrictions. The agent can run any command, write anywhere, and access the network without confirmation.\n\nAre you sure?");
				if (!confirmed) return;
			}
			mode = { mode: trimmed as ApprovalMode, setAt: Date.now() };
			persistMode();
			updateStatus(ctx);
			ctx.ui.notify(`Mode changed: ${mode.mode}`, "info");
		},
	});

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
