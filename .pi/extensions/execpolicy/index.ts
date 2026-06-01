/**
 * Execpolicy Extension - Recreates Codex's execpolicy feature
 *
 * Rule-based command evaluation. Define rules that allow, prompt, or block
 * specific commands based on patterns. Rules are stored as JSON files.
 *
 * Commands:
 *   /execpolicy check <command>   - Check if a command would be allowed
 *   /execpolicy rules             - List active rules
 *   /execpolicy add <rule>        - Add a rule
 *   /execpolicy remove <id>       - Remove a rule
 *
 * Rules format (stored in ~/.pi/execpolicy.json):
 * {
 *   "rules": [
 *     { "id": "1", "pattern": "rm -rf /", "action": "block", "reason": "Destructive" },
 *     { "id": "2", "pattern": "git push --force", "action": "prompt", "reason": "Force push" }
 *   ],
 *   "defaultAction": "allow"
 * }
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const RULES_FILE = path.join(os.homedir(), ".pi", "execpolicy.json");

interface Rule {
	id: string;
	pattern: string;
	action: "allow" | "prompt" | "block";
	reason: string;
}

interface RulesConfig {
	rules: Rule[];
	defaultAction: "allow" | "prompt" | "block";
}

function loadRules(): RulesConfig {
	try {
		if (fs.existsSync(RULES_FILE)) {
			const data = JSON.parse(fs.readFileSync(RULES_FILE, "utf-8"));
			return {
				rules: data.rules || [],
				defaultAction: data.defaultAction || "allow",
			};
		}
	} catch {
		// Corrupt file, start fresh
	}
	return { rules: [], defaultAction: "allow" };
}

function saveRules(config: RulesConfig): void {
	const dir = path.dirname(RULES_FILE);
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(RULES_FILE, JSON.stringify(config, null, 2));
}

function evaluateCommand(command: string, rules: Rule[]): { matched: boolean; action: string; rule?: Rule } {
	for (const rule of rules) {
		try {
			const regex = new RegExp(rule.pattern, "i");
			if (regex.test(command)) {
				return { matched: true, action: rule.action, rule };
			}
		} catch {
			// Invalid regex, skip
		}
	}
	return { matched: false, action: "allow" };
}

export default function (pi: ExtensionAPI) {
	const config = loadRules();

	// ── Tool Call Interception ────────────────────────────────────────────

	pi.on("tool_call", async (event, ctx) => {
		if (!isToolCallEventType("bash", event)) return;

		const command = event.input.command;
		const result = evaluateCommand(command, config.rules);

		if (result.matched) {
			if (result.action === "block") {
				return {
					block: true,
					reason: `Execpolicy blocked: ${result.rule?.reason || "Matched rule"}`,
				};
			}
			if (result.action === "prompt") {
				if (!ctx.hasUI) {
					return {
						block: true,
						reason: `Execpolicy requires prompt: ${result.rule?.reason || "Matched rule"}`,
					};
				}
				const proceed = await ctx.ui.confirm(
					"Execpolicy Check",
					`Rule matched: ${result.rule?.reason || result.rule?.pattern}\n\nCommand: ${command.slice(0, 200)}\n\nProceed?`,
				);
				if (!proceed) {
					return { block: true, reason: "User declined via execpolicy prompt." };
				}
			}
			// "allow" - pass through
		} else if (config.defaultAction === "block") {
			return {
				block: true,
				reason: "Execpolicy: default action is block. No allow rule matched.",
			};
		} else if (config.defaultAction === "prompt" && ctx.hasUI) {
			const proceed = await ctx.ui.confirm(
				"Execpolicy - Default Prompt",
				`No specific rule matches. Default action is prompt.\n\nCommand: ${command.slice(0, 200)}\n\nProceed?`,
			);
			if (!proceed) {
				return { block: true, reason: "User declined via execpolicy default prompt." };
			}
		}
	});

	// ── Command: /execpolicy ──────────────────────────────────────────────

	pi.registerCommand("execpolicy", {
		description: "Manage command execution policies (check|rules|add|remove|default)",
		handler: async (args, ctx) => {
			const trimmed = (args || "").trim();
			const parts = trimmed.split(/\s+/);
			const subcmd = parts[0];
			const rest = parts.slice(1).join(" ");

			const currentConfig = loadRules();

			switch (subcmd) {
				case "check": {
					if (!rest) {
						ctx.ui.notify("Usage: /execpolicy check <command>", "warning");
						return;
					}
					const result = evaluateCommand(rest, currentConfig.rules);
					if (result.matched) {
						ctx.ui.notify(
							`MATCHED: ${result.action.toUpperCase()} — ${result.rule?.reason || result.rule?.pattern}`,
							result.action === "block" ? "error" : result.action === "prompt" ? "warning" : "info",
						);
					} else {
						ctx.ui.notify(
							`NO MATCH — Default: ${currentConfig.defaultAction.toUpperCase()}`,
							"info",
						);
					}
					return;
				}

				case "rules": {
					if (currentConfig.rules.length === 0) {
						ctx.ui.notify(
							`No rules defined. Default action: ${currentConfig.defaultAction}. Use /execpolicy add to add rules.`,
							"info",
						);
						return;
					}
					const lines = currentConfig.rules.map(
						(r) => `[${r.id}] ${r.action.toUpperCase()}: ${r.pattern} — ${r.reason}`,
					);
					lines.push(`\nDefault action: ${currentConfig.defaultAction.toUpperCase()}`);
					ctx.ui.notify(lines.join("\n"), "info");
					return;
				}

				case "add": {
					if (!rest) {
						ctx.ui.notify(
							"Usage: /execpolicy add <pattern> | <action> | <reason>\nExample: /execpolicy add 'rm -rf' block 'Destructive delete'",
							"warning",
						);
						return;
					}
					// Parse: pattern | action | reason
					const ruleParts = rest.split("|").map((s) => s.trim());
					const pattern = ruleParts[0];
					const action = (ruleParts[1] || "prompt") as Rule["action"];
					const reason = ruleParts[2] || pattern;

					if (!["allow", "prompt", "block"].includes(action)) {
						ctx.ui.notify("Action must be: allow, prompt, or block", "warning");
						return;
					}

					const id = String(currentConfig.rules.length + 1);
					currentConfig.rules.push({ id, pattern, action, reason });
					saveRules(currentConfig);

					ctx.ui.notify(
						`Rule added: [${id}] ${action.toUpperCase()}: ${pattern}`,
						"info",
					);
					return;
				}

				case "remove": {
					if (!rest) {
						ctx.ui.notify("Usage: /execpolicy remove <id>", "warning");
						return;
					}
					const id = rest;
					const idx = currentConfig.rules.findIndex((r) => r.id === id);
					if (idx < 0) {
						ctx.ui.notify(`Rule with id "${id}" not found.`, "warning");
						return;
					}
					const removed = currentConfig.rules[idx];
					currentConfig.rules.splice(idx, 1);
					saveRules(currentConfig);
					ctx.ui.notify(
						`Removed rule [${id}]: ${removed.pattern}`,
						"info",
					);
					return;
				}

				case "default": {
					const action = rest as Rule["action"];
					if (!["allow", "prompt", "block"].includes(action)) {
						ctx.ui.notify("Default action must be: allow, prompt, or block", "warning");
						return;
					}
					currentConfig.defaultAction = action;
					saveRules(currentConfig);
					ctx.ui.notify(`Default action set to: ${action.toUpperCase()}`, "info");
					return;
				}

				default:
					ctx.ui.notify(
						"/execpolicy check|rules|add|remove|default — Manage command execution policies",
						"info",
					);
			}
		},
	});
}
