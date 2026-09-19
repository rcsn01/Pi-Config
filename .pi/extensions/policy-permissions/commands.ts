/**
 * Slash commands for the Safety Permissions extension: `/permissions`,
 * `/approve`, and `/execpolicy`, plus the `switchMode` helper.
 *
 * Commands are registered through a factory that adapts the permission
 * enforcement lifecycle to Pi notifications and full-access confirmation.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	evaluateExecPolicy,
	loadExecPolicy,
	loadExecPolicyLayers,
	saveExecPolicy,
	saveProjectExecPolicyRules,
	type ExecPolicyAction,
	type ExecPolicyRule,
} from "../_shared/command-policy.ts";
import { isProjectTrustedContext } from "../_shared/pi-config.ts";
import { pickGuiOption } from "../_shared/gui-option-list.ts";
import {
	APPROVAL_MODES,
	modePickerDescription,
	modeSwitchConfirmation,
	resolveModeInput,
	type ApprovalMode,
} from "./mode-registry.ts";
import type { ModeState } from "./mode-store.ts";
import type { ApprovalIssueOutcome } from "./permission-enforcement-lifecycle.ts";

export interface CommandService {
	getMode(): ModeState;
	changeMode(mode: ModeState, ctx: ExtensionContext): void;
	updateStatus(ctx: ExtensionContext): void;
	approveLastDenied(): ApprovalIssueOutcome;
}

/** Comma-separated or-list over the canonical modes: "read-only, default, auto-review, or full-access". */
function orList(modes: readonly ApprovalMode[]): string {
	const last = modes[modes.length - 1];
	return `${modes.slice(0, -1).join(", ")}, or ${last}`;
}

function formatExecPolicyRules(rules: readonly ExecPolicyRule[], tag: "p" | "g"): string[] {
	return rules.map((rule) => `[${tag}${rule.id || "?"}] ${rule.action.toUpperCase()}: ${rule.pattern} — ${rule.reason}`);
}

/** `p2`/`g2` are layer-explicit; a bare numeric id means global (back-compat). */
function parseExecPolicyRuleRef(ref: string): { layer: "project" | "global"; id: string } | undefined {
	if (/^p\d+$/.test(ref)) return { layer: "project", id: ref.slice(1) };
	if (/^g\d+$/.test(ref)) return { layer: "global", id: ref.slice(1) };
	if (/^\d+$/.test(ref)) return { layer: "global", id: ref };
	return undefined;
}

export function registerPermissionCommands(pi: ExtensionAPI, service: CommandService): void {
	const { getMode, changeMode, updateStatus } = service;

	async function switchMode(newMode: ApprovalMode, ctx: ExtensionContext): Promise<boolean> {
		const confirmation = modeSwitchConfirmation(newMode);
		if (confirmation && ctx.hasUI) {
			const confirmed = await ctx.ui.confirm(confirmation.title, confirmation.message);
			if (!confirmed) return false;
		}
		const mode = { mode: newMode, setAt: Date.now() };
		changeMode(mode, ctx);
		updateStatus(ctx);
		ctx.ui.notify(`Mode changed: ${mode.mode}`, "info");
		return true;
	}

	pi.registerCommand("permissions", {
		description: `Switch approval mode: ${APPROVAL_MODES.join(" | ")}`,
		handler: async (args, ctx) => {
			const trimmed = (args || "").trim().toLowerCase();
			const current = getMode();

			if (!trimmed) {
				if (!ctx.hasUI) {
					ctx.ui.notify(`Current mode: ${current.mode}. Use /permissions ${APPROVAL_MODES.join("|")}`, "info");
					return;
				}
				const newMode = await pickGuiOption<ApprovalMode>(ctx, {
					title: "Permission Mode:",
					message: `Current mode: ${current.mode}`,
					options: APPROVAL_MODES.map((m) => ({
						label: m,
						value: m,
						description: modePickerDescription(m),
						checked: m === current.mode,
					})),
				});
				if (!newMode || newMode === current.mode) return;
				if (!(await switchMode(newMode, ctx))) return;
				return;
			}

			const resolution = resolveModeInput(trimmed);
			if (!resolution.ok) {
				ctx.ui.notify(`Invalid mode. Use: ${orList(APPROVAL_MODES)}`, "warning");
				return;
			}
			const requestedMode = resolution.mode;
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
			const outcome = service.approveLastDenied();
			if (outcome.kind === "none") {
				ctx.ui.notify("No denied action to approve.", "info");
				return;
			}
			ctx.ui.notify(
				`Approved once: ${outcome.action.title}\nRetry the same action now. This approval will be consumed by the next matching tool call.`,
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
			// Trusted projects write and list a per-project rule layer in
			// .pi/pi-config.json; the global file stays authoritative.
			const projectTrusted = isProjectTrustedContext(ctx);
			const layers = loadExecPolicyLayers({ cwd: ctx.cwd, projectTrusted });

			switch (subcmd) {
				case "check": {
					if (!rest) return ctx.ui.notify("Usage: /execpolicy check <command>", "warning");
					const result = evaluateExecPolicy(rest, loadExecPolicy({ cwd: ctx.cwd, projectTrusted }));
					ctx.ui.notify(result.matched
						? `MATCHED: ${result.action.toUpperCase()} — ${result.rule?.reason || result.rule?.pattern}`
						: `NO MATCH — Default: ${layers.global.defaultAction.toUpperCase()}`,
						result.action === "block" ? "error" : result.action === "prompt" ? "warning" : "info");
					return;
				}
				case "rules": {
					if (!projectTrusted) {
						if (layers.global.rules.length === 0) return ctx.ui.notify(`No rules defined. Default action: ${layers.global.defaultAction}. Use /execpolicy add to add rules.`, "info");
						ctx.ui.notify([...layers.global.rules.map((r) => `[${r.id}] ${r.action.toUpperCase()}: ${r.pattern} — ${r.reason}`), `\nDefault action: ${layers.global.defaultAction.toUpperCase()}`].join("\n"), "info");
						return;
					}
					const lines = [
						"Project rules (.pi/pi-config.json):",
						...(layers.project.length > 0 ? formatExecPolicyRules(layers.project, "p") : ["  (none)"]),
						"",
						"Global rules (~/.pi/execpolicy.json):",
						...(layers.global.rules.length > 0 ? formatExecPolicyRules(layers.global.rules, "g") : ["  (none)"]),
						"",
						`Default action: ${layers.global.defaultAction.toUpperCase()} (global)`,
					];
					ctx.ui.notify(lines.join("\n"), "info");
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
					if (projectTrusted) {
						const id = String(Math.max(0, ...layers.project.map((r) => Number(r.id) || 0)) + 1);
						saveProjectExecPolicyRules(ctx.cwd, [...layers.project, { id, pattern, action, reason }]);
						ctx.ui.notify(`Project rule added (.pi/pi-config.json): [p${id}] ${action.toUpperCase()}: ${pattern}`, "info");
						return;
					}
					const id = String(Math.max(0, ...layers.global.rules.map((r) => Number(r.id) || 0)) + 1);
					layers.global.rules.push({ id, pattern, action, reason });
					saveExecPolicy(layers.global);
					ctx.ui.notify(`Rule added: [${id}] ${action.toUpperCase()}: ${pattern}`, "info");
					return;
				}
				case "remove": {
					if (!rest) return ctx.ui.notify("Usage: /execpolicy remove <id>", "warning");
					const ref = parseExecPolicyRuleRef(rest);
					if (!ref) return ctx.ui.notify(`Rule not found: ${rest}`, "warning");
					if (ref.layer === "project") {
						if (!projectTrusted) return ctx.ui.notify("Project rules require a trusted project.", "warning");
						const index = layers.project.findIndex((r) => r.id === ref.id);
						if (index < 0) return ctx.ui.notify(`Project rule not found: p${ref.id}`, "warning");
						const [removed] = layers.project.splice(index, 1);
						saveProjectExecPolicyRules(ctx.cwd, layers.project);
						ctx.ui.notify(`Removed project rule [p${removed.id}]: ${removed.pattern}`, "info");
						return;
					}
					const idx = layers.global.rules.findIndex((r) => r.id === ref.id);
					if (idx < 0) return ctx.ui.notify(`Rule not found: ${rest}`, "warning");
					const [removed] = layers.global.rules.splice(idx, 1);
					saveExecPolicy(layers.global);
					ctx.ui.notify(`Removed rule [${removed.id}]: ${removed.pattern}`, "info");
					return;
				}
				case "default": {
					const action = rest as ExecPolicyAction;
					if (!["allow", "prompt", "block"].includes(action)) return ctx.ui.notify("Usage: /execpolicy default allow|prompt|block", "warning");
					layers.global.defaultAction = action;
					saveExecPolicy(layers.global);
					ctx.ui.notify(`Default action: ${action.toUpperCase()}`, "info");
					return;
				}
				default:
					ctx.ui.notify("Usage: /execpolicy check|rules|add|remove|default", "warning");
			}
		},
	});
}
