/**
 * Feature Flags Extension - Recreates Codex's feature flags management
 *
 * Commands:
 *   /features               - List all feature flags and their status
 *   /features enable <flag> - Enable a feature flag
 *   /features disable <flag>- Disable a feature flag
 *   /features reset <flag>  - Reset to default
 *
 * Feature flags are stored in ~/.pi/features.json and control
 * experimental or optional behaviors across extensions.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const FEATURES_FILE = path.join(os.homedir(), ".pi", "features.json");

interface FeatureFlag {
	name: string;
	description: string;
	default: boolean;
	stage: "experimental" | "beta" | "stable";
}

interface FeatureState {
	flags: Record<string, boolean>;
}

// Registry of known feature flags
const KNOWN_FLAGS: FeatureFlag[] = [
	{
		name: "unified_exec",
		description: "Use unified execution model for bash commands",
		default: false,
		stage: "experimental",
	},
	{
		name: "shell_snapshot",
		description: "Snapshot shell environment before each turn",
		default: false,
		stage: "experimental",
	},
	{
		name: "auto_commit",
		description: "Automatically git commit after each successful turn",
		default: false,
		stage: "experimental",
	},
	{
		name: "parallel_tools",
		description: "Execute independent tool calls in parallel",
		default: true,
		stage: "beta",
	},
	{
		name: "stream_responses",
		description: "Stream LLM responses token by token",
		default: true,
		stage: "stable",
	},
	{
		name: "smart_compaction",
		description: "Use intelligent compaction heuristic",
		default: true,
		stage: "beta",
	},
];

function loadFeatures(): FeatureState {
	try {
		if (fs.existsSync(FEATURES_FILE)) {
			return JSON.parse(fs.readFileSync(FEATURES_FILE, "utf-8"));
		}
	} catch {
		// Corrupt, start fresh
	}
	return { flags: {} };
}

function saveFeatures(state: FeatureState): void {
	const dir = path.dirname(FEATURES_FILE);
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(FEATURES_FILE, JSON.stringify(state, null, 2));
}

function getFlag(name: string): boolean {
	const state = loadFeatures();
	if (name in state.flags) return state.flags[name];
	const flag = KNOWN_FLAGS.find((f) => f.name === name);
	return flag?.default ?? false;
}

function setFlag(name: string, value: boolean): void {
	const state = loadFeatures();
	state.flags[name] = value;
	saveFeatures(state);
}

function resetFlag(name: string): void {
	const state = loadFeatures();
	delete state.flags[name];
	saveFeatures(state);
}

export default function (pi: ExtensionAPI) {
	// ── Command: /features ────────────────────────────────────────────────

	pi.registerCommand("features", {
		description: "Manage feature flags (list|enable|disable|reset)",
		handler: async (args, ctx) => {
			const trimmed = (args || "").trim();
			const parts = trimmed.split(/\s+/);
			const subcmd = parts[0];
			const flagName = parts.slice(1).join(" ");

			const currentState = loadFeatures();

			switch (subcmd) {
				case "enable": {
					if (!flagName) {
						ctx.ui.notify("Usage: /features enable <flag-name>", "warning");
						return;
					}
					const found = KNOWN_FLAGS.find((f) => f.name === flagName);
					if (!found) {
						ctx.ui.notify(`Unknown feature: "${flagName}". Use /features list to see available flags.`, "warning");
						return;
					}
					setFlag(flagName, true);
					ctx.ui.notify(
						`Feature "${flagName}" enabled (${found.stage}). /reload to apply.`,
						"info",
					);
					return;
				}

				case "disable": {
					if (!flagName) {
						ctx.ui.notify("Usage: /features disable <flag-name>", "warning");
						return;
					}
					setFlag(flagName, false);
					ctx.ui.notify(
						`Feature "${flagName}" disabled. /reload to apply.`,
						"info",
					);
					return;
				}

				case "reset": {
					if (!flagName) {
						ctx.ui.notify("Usage: /features reset <flag-name>", "warning");
						return;
					}
					resetFlag(flagName);
					const def = KNOWN_FLAGS.find((f) => f.name === flagName)?.default ?? false;
					ctx.ui.notify(
						`Feature "${flagName}" reset to default (${def ? "enabled" : "disabled"}).`,
						"info",
					);
					return;
				}

				case "list":
				default: {
					const lines: string[] = [];
					lines.push("Feature Flags:");
					lines.push("─".repeat(60));

					for (const flag of KNOWN_FLAGS) {
						const state = currentState.flags[flag.name];
						const enabled = state !== undefined ? state : flag.default;
						const icon = enabled ? "●" : "○";
						const stageColor = flag.stage === "stable" ? "" : flag.stage === "beta" ? "[beta] " : "[exp] ";

						const modified = state !== undefined ? " (custom)" : "";
						lines.push(
							`  ${icon} ${stageColor}${flag.name}${modified}`,
						);
						lines.push(`      ${flag.description}`);
						if (modified) {
							lines.push(`      default: ${flag.default ? "enabled" : "disabled"}`);
						}
					}

					lines.push("");
					lines.push("Commands: /features enable|disable|reset <name>");

					ctx.ui.notify(lines.join("\n"), "info");
					return;
				}
			}
		},
	});
}
