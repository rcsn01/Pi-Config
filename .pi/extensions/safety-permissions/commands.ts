/**
 * Slash commands for the Safety Permissions extension: `/permissions`,
 * `/approve`, and `/execpolicy`, plus the `switchMode` helper.
 *
 * Commands are registered through a factory that receives a `CommandService`
 * exposing the extension's live mode state and approval tracking, so all
 * side-effecting state stays in `index.ts`.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	evaluateExecPolicy,
	loadExecPolicy,
	saveExecPolicy,
	type ApprovalMode,
	type ExecPolicyAction,
	type ExecPolicyConfig,
} from "../_shared/command-policy.ts";
import { pickGuiOption } from "../_shared/gui-option-list.ts";
import type { ModeState } from "./mode-store.ts";

export interface DeniedAction {
	key: string;
	title: string;
	message: string;
	at: number;
}

export interface CommandService {
	getMode(): ModeState;
	setModeAndPersist(mode: ModeState): void;
	updateStatus(ctx: ExtensionContext): void;
	lastDeniedAction(): DeniedAction | undefined;
	approveLastDenied(): DeniedAction | undefined;
}

const VALID_MODES: ApprovalMode[] = ["read-only", "default", "auto-review", "full-access"];

const ALIAS_MAP: Record<string, ApprovalMode> = {
	auto: "default",
	full: "full-access",
	ro: "read-only",
	review: "auto-review",
};

const MODE_LABELS: Record<ApprovalMode, string> = {
	"read-only": "Read-only browsing – read in current directory only",
	default: "Default – read, edit, and run commands in workspace; approval for internet and external writes",
	"auto-review": "Auto-review – full auto; only prompts you for edits outside the workspace",
	"full-access": "Full Access – no restrictions, no approval prompts (use with caution)",
};

export function registerPermissionCommands(pi: ExtensionAPI, service: CommandService): void {
	const { getMode, setModeAndPersist, updateStatus } = service;

	async function switchMode(newMode: ApprovalMode, ctx: ExtensionContext): Promise<boolean> {
		if (newMode === "full-access" && ctx.hasUI) {
			const confirmed = await ctx.ui.confirm(
				"⚠️ Full Access Mode",
				"This removes ALL restrictions. The agent can run any command, write anywhere, and access the network without confirmation.\n\nExercise caution when using.\n\nAre you sure?",
			);
			if (!confirmed) return false;
		}
		const mode = { mode: newMode, setAt: Date.now() };
		setModeAndPersist(mode);
		updateStatus(ctx);
		ctx.ui.notify(`Mode changed: ${mode.mode}`, "info");
		return true;
	}

	pi.registerCommand("permissions", {
		description: "Switch approval mode: read-only | default | auto-review | full-access",
		handler: async (args, ctx) => {
			const trimmed = (args || "").trim().toLowerCase();
			const current = getMode();

			if (!trimmed) {
				if (!ctx.hasUI) {
					ctx.ui.notify(`Current mode: ${current.mode}. Use /permissions read-only|default|auto-review|full-access`, "info");
					return;
				}
				const newMode = await pickGuiOption<ApprovalMode>(ctx, {
					title: "Permission Mode:",
					message: `Current mode: ${current.mode}`,
					options: VALID_MODES.map((m) => ({
						label: m,
						value: m,
						description: MODE_LABELS[m],
						checked: m === current.mode,
					})),
				});
				if (!newMode || newMode === current.mode) return;
				if (!(await switchMode(newMode, ctx))) return;
				return;
			}

			// Resolve aliases
			let requestedMode: ApprovalMode =
				ALIAS_MAP[trimmed] ?? (VALID_MODES.includes(trimmed as ApprovalMode) ? trimmed as ApprovalMode : "" as ApprovalMode);
			if (!VALID_MODES.includes(requestedMode)) {
				ctx.ui.notify("Invalid mode. Use: read-only, default, auto-review, or full-access", "warning");
				return;
			}
			if (requestedMode === current.mode) {
				ctx.ui.notify(`Already in ${current.mode} mode.`, "info");
				return;
			}
			await switchMode(requestedMode, ctx);
		},
	});

	pi.registerCommand("approve", {
		description: "Allow the last denied action once, then retry it",
		handler: async (_args, ctx) => {
			const approved = service.approveLastDenied();
			if (!approved) {
				ctx.ui.notify("No denied action to approve.", "info");
				return;
			}
			ctx.ui.notify(
				`Approved once: ${approved.title}\nRetry the same action now. This approval will be consumed by the next matching tool call.`,
				"info",
			);
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
}
