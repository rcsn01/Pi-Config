/**
 * Unified Feature Flags / Experimental Features Extension
 *
 * Single owner for:
 *   /features     - global persisted feature flags in ~/.pi/features.json
 *   /experimental - session-scoped experimental overrides and prompt hints
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const FEATURES_FILE = path.join(os.homedir(), ".pi", "features.json");
const EXP_CUSTOM_TYPE = "experimental-state";

interface FeatureFlag {
	name: string;
	description: string;
	default: boolean;
	stage: "experimental" | "beta" | "stable";
	promptHint?: string;
}

interface FeatureState {
	flags: Record<string, boolean>;
}

interface ExpState {
	features: Record<string, boolean>;
	setAt: number;
}

const KNOWN_FLAGS: FeatureFlag[] = [
	{ name: "subagents", description: "Parallel subagent delegation (scout/researcher/worker)", default: true, stage: "experimental", promptHint: "Use subagents to delegate reasoning tasks (scout, researcher, worker)." },
	{ name: "memories", description: "Read and write persistent project memory (MEMORY.md)", default: false, stage: "experimental", promptHint: "Read and update MEMORY.md for persistent project context when memory is enabled." },
	{ name: "imagegen", description: "Generate images locally (no API key needed)", default: false, stage: "experimental", promptHint: "Use image_generate tool for image creation." },
	{ name: "websearch", description: "Search the web via DuckDuckGo (no API key)", default: false, stage: "experimental", promptHint: "Use ddg_search for web queries when needed." },
	{ name: "unified_exec", description: "Use unified execution model for bash commands", default: false, stage: "experimental" },
	{ name: "shell_snapshot", description: "Snapshot shell environment before each turn", default: false, stage: "experimental" },
	{ name: "auto_commit", description: "Automatically git commit after each successful turn", default: false, stage: "experimental" },
	{ name: "parallel_tools", description: "Execute independent tool calls in parallel", default: true, stage: "beta" },
	{ name: "stream_responses", description: "Stream LLM responses token by token", default: true, stage: "stable" },
	{ name: "smart_compaction", description: "Use intelligent compaction heuristic", default: true, stage: "beta" },
];

function loadFeatures(): FeatureState {
	try {
		if (fs.existsSync(FEATURES_FILE)) return JSON.parse(fs.readFileSync(FEATURES_FILE, "utf-8"));
	} catch {
		// Corrupt, start fresh.
	}
	return { flags: {} };
}

function saveFeatures(state: FeatureState): void {
	const dir = path.dirname(FEATURES_FILE);
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(FEATURES_FILE, JSON.stringify(state, null, 2));
}

function defaultFeatureState(): Record<string, boolean> {
	// Session experimental state stores only overrides. Defaults and global
	// persisted values are resolved by getFlag().
	return {};
}

function getFlag(name: string, exp?: ExpState): boolean {
	if (exp && name in exp.features) return exp.features[name];
	const state = loadFeatures();
	if (name in state.flags) return state.flags[name];
	return KNOWN_FLAGS.find((f) => f.name === name)?.default ?? false;
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
	let expState: ExpState = { features: defaultFeatureState(), setAt: Date.now() };

	function reconstruct(ctx: ExtensionContext) {
		expState = { features: defaultFeatureState(), setAt: Date.now() };
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === EXP_CUSTOM_TYPE) {
				const data = entry.data as ExpState | undefined;
				if (data?.features) expState = data;
			}
		}
	}

	function persistExperimental() {
		pi.appendEntry(EXP_CUSTOM_TYPE, { ...expState });
	}

	(globalThis as any).__pi_features = {
		get: (name: string) => getFlag(name, expState),
		set: setFlag,
		reset: resetFlag,
		list: () => KNOWN_FLAGS.map((flag) => ({ ...flag, enabled: getFlag(flag.name, expState) })),
	};

	pi.on("session_start", async (_event, ctx) => { reconstruct(ctx); });
	pi.on("session_tree", async (_event, ctx) => { reconstruct(ctx); });

	pi.on("before_agent_start", async (event) => {
		const hints = KNOWN_FLAGS
			.filter((f) => f.promptHint && getFlag(f.name, expState))
			.map((f) => f.promptHint as string);
		if (hints.length === 0) return;
		return { systemPrompt: event.systemPrompt + "\n\n## Experimental Features Enabled\n" + hints.map((h) => `- ${h}`).join("\n") };
	});

	pi.registerCommand("features", {
		description: "Manage feature flags (list|enable|disable|reset|status)",
		handler: async (args, ctx) => {
			const trimmed = (args || "").trim();
			const parts = trimmed.split(/\s+/);
			const subcmd = parts[0] || "list";
			const flagName = parts.slice(1).join(" ");
			const found = flagName ? KNOWN_FLAGS.find((f) => f.name === flagName) : undefined;

			if (["enable", "disable", "reset", "status"].includes(subcmd) && !flagName) {
				ctx.ui.notify(`Usage: /features ${subcmd} <flag-name>`, "warning");
				return;
			}
			if (flagName && !found) {
				ctx.ui.notify(`Unknown feature: "${flagName}". Use /features list to see available flags.`, "warning");
				return;
			}

			switch (subcmd) {
				case "enable":
					setFlag(flagName, true);
					ctx.ui.notify(`Feature "${flagName}" enabled (${found?.stage}). /reload to apply globally.`, "info");
					return;
				case "disable":
					setFlag(flagName, false);
					ctx.ui.notify(`Feature "${flagName}" disabled. /reload to apply globally.`, "info");
					return;
				case "reset":
					resetFlag(flagName);
					ctx.ui.notify(`Feature "${flagName}" reset to default (${found?.default ? "enabled" : "disabled"}).`, "info");
					return;
				case "status":
					ctx.ui.notify(`${flagName}: ${getFlag(flagName, expState) ? "enabled" : "disabled"} (${found?.stage})\n${found?.description}`, "info");
					return;
				case "list":
				default: {
					const lines = ["Feature Flags:", "─".repeat(60)];
					const currentState = loadFeatures();
					for (const flag of KNOWN_FLAGS) {
						const globalValue = currentState.flags[flag.name];
						const enabled = getFlag(flag.name, expState);
						const modified = globalValue !== undefined ? " (global custom)" : "";
						lines.push(`  ${enabled ? "●" : "○"} ${flag.stage === "stable" ? "" : flag.stage === "beta" ? "[beta] " : "[exp] "}${flag.name}${modified}`);
						lines.push(`      ${flag.description}`);
					}
					lines.push("", "Commands: /features enable|disable|reset|status <name>");
					ctx.ui.notify(lines.join("\n"), "info");
				}
			}
		},
	});

	pi.registerCommand("experimental", {
		description: "Toggle session experimental features (list|on|off)",
		handler: async (args, ctx) => {
			const trimmed = (args || "").trim().toLowerCase();
			const parts = trimmed.split(/\s+/);
			const subcmd = parts[0];
			const featName = parts.slice(1).join(" ");
			const experimentalFlags = KNOWN_FLAGS.filter((f) => f.stage === "experimental");

			if (subcmd === "on" || subcmd === "enable" || subcmd === "off" || subcmd === "disable") {
				if (!featName) return ctx.ui.notify(`Usage: /experimental ${subcmd} <feature-name>`, "warning");
				const found = experimentalFlags.find((f) => f.name === featName);
				if (!found) return ctx.ui.notify(`Unknown experimental feature: "${featName}". Use /experimental list.`, "warning");
				expState.features[featName] = subcmd === "on" || subcmd === "enable";
				expState.setAt = Date.now();
				persistExperimental();
				ctx.ui.notify(`Experimental: ${featName} ${expState.features[featName] ? "ENABLED" : "DISABLED"}`, "info");
				return;
			}

			if (subcmd === "list" || !trimmed || subcmd === "status") {
				if (ctx.hasUI && !trimmed) {
					const choices = experimentalFlags.map((f) => `${getFlag(f.name, expState) ? "✓" : "✗"} ${f.name} — ${f.description}`);
					const choice = await ctx.ui.select("Toggle Experimental Features:", choices);
					if (!choice) return;
					const match = experimentalFlags.find((f) => choice.includes(f.name));
					if (!match) return;
					expState.features[match.name] = !getFlag(match.name, expState);
					expState.setAt = Date.now();
					persistExperimental();
					ctx.ui.notify(`${match.name}: ${expState.features[match.name] ? "ENABLED" : "DISABLED"}`, "info");
					return;
				}
				const lines = ["Experimental Features:"];
				for (const f of experimentalFlags) lines.push(`  ${getFlag(f.name, expState) ? "●" : "○"} ${f.name} — ${f.description}`);
				lines.push("\nUse /experimental on|off <feature> to set a session override.");
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}

			ctx.ui.notify("Usage: /experimental [list|on <feature>|off <feature>]", "warning");
		},
	});
}
