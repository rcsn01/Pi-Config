/**
 * Feature Flags Extension
 *
 * /features — interactive toggle UI (or: list|enable|disable|reset|status <name>)
 *
 * Interactive UI:
 *   Typing /features (no args) opens a toggle list.
 *   ↑/↓ arrows change which item is highlighted.
 *   Space toggles the highlighted feature on/off.
 *   Enter saves all changes.
 *   Escape discards all changes.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { pickGuiOptions } from "../_shared/gui-option-list.ts";

const FEATURES_DIR = ".pi";
const FEATURES_FILE = "features.json";
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

const KNOWN_FLAGS: FeatureFlag[] = [];

function featuresFilePath(cwd: string): string {
	return path.join(cwd, FEATURES_DIR, FEATURES_FILE);
}

function loadFeatures(cwd: string): FeatureState {
	try {
		const filePath = featuresFilePath(cwd);
		if (fs.existsSync(filePath)) return JSON.parse(fs.readFileSync(filePath, "utf-8"));
	} catch {
		// Corrupt, start fresh.
	}
	return { flags: {} };
}

function saveFeatures(cwd: string, state: FeatureState): void {
	const filePath = featuresFilePath(cwd);
	const dir = path.dirname(filePath);
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(state, null, 2));
}

function defaultFeatureState(): Record<string, boolean> {
	return {};
}

function getFlag(name: string, cwd: string, exp?: ExpState): boolean {
	if (exp && name in exp.features) return exp.features[name];
	const state = loadFeatures(cwd);
	if (name in state.flags) return state.flags[name];
	return KNOWN_FLAGS.find((f) => f.name === name)?.default ?? false;
}

function setFlag(cwd: string, name: string, value: boolean): void {
	const state = loadFeatures(cwd);
	state.flags[name] = value;
	saveFeatures(cwd, state);
}

function resetFlag(cwd: string, name: string): void {
	const state = loadFeatures(cwd);
	delete state.flags[name];
	saveFeatures(cwd, state);
}

// ── Stage label ─────────────────────────────────────────────────────────────

function stageLabel(stage: string): string {
	if (stage === "experimental") return "exp";
	if (stage === "beta") return "beta";
	return "stable";
}

// ── Interactive toggle UI ───────────────────────────────────────────────────

async function featuresToggleUI(ctx: ExtensionContext, expState: ExpState, persistExperimental: () => void): Promise<void> {
	const cwd = ctx.cwd;

	// Snapshot current effective state
	const pending: Record<string, boolean> = {};
	const original: Record<string, boolean> = {};
	for (const flag of KNOWN_FLAGS) {
		pending[flag.name] = getFlag(flag.name, cwd, expState);
		original[flag.name] = pending[flag.name];
	}

	const selected = await pickGuiOptions(ctx, {
		title: "Feature Flags",
		message: `Repository: ${cwd}`,
		options: KNOWN_FLAGS.map((flag) => ({
			label: flag.name,
			value: flag.name,
			description: `[${stageLabel(flag.stage)}] ${flag.description}`,
			checked: pending[flag.name],
		})),
	});

	if (selected) {
		const selectedSet = new Set(selected);
		for (const flag of KNOWN_FLAGS) {
			pending[flag.name] = selectedSet.has(flag.name);
		}

		// Persist pending values
		const state = loadFeatures(cwd);
		for (const flag of KNOWN_FLAGS) {
			state.flags[flag.name] = pending[flag.name];
		}
		saveFeatures(cwd, state);

		// Update session experimental overrides
		for (const flag of KNOWN_FLAGS) {
			if (flag.stage === "experimental") {
				expState.features[flag.name] = pending[flag.name];
			}
		}
		expState.setAt = Date.now();
		persistExperimental();

		const summary = KNOWN_FLAGS
			.map((f) => `${pending[f.name] ? "●" : "○"} ${f.name}`)
			.join("\n");
		ctx.ui.notify(`Feature flags saved:\n${summary}`, "info");
	} else {
		ctx.ui.notify("Changes discarded.", "info");
	}
}

// ── Plain-text list (non-interactive fallback) ─────────────────────────────

function featuresListText(cwd: string, expState: ExpState): string {
	const configPath = featuresFilePath(cwd);
	const lines = ["Feature Flags:", `Repository: ${cwd}`, `Config: ${configPath}`, "─".repeat(60)];
	const currentState = loadFeatures(cwd);
	for (const flag of KNOWN_FLAGS) {
		const repoValue = currentState.flags[flag.name];
		const enabled = getFlag(flag.name, cwd, expState);
		const modified = repoValue !== undefined ? " (repo custom)" : "";
		lines.push(`  ${enabled ? "●" : "○"} ${flag.stage === "stable" ? "" : flag.stage === "beta" ? "[beta] " : "[exp] "}${flag.name}${modified}`);
		lines.push(`      ${flag.description}`);
	}
	lines.push("", "Commands: /features enable|disable|reset|status <name>");
	return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
	let currentCwd = process.cwd();
	let expState: ExpState = { features: defaultFeatureState(), setAt: Date.now() };

	function reconstruct(ctx: ExtensionContext) {
		currentCwd = ctx.cwd;
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
		get: (name: string) => getFlag(name, currentCwd, expState),
		set: (name: string, value: boolean) => setFlag(currentCwd, name, value),
		reset: (name: string) => resetFlag(currentCwd, name),
		list: () => KNOWN_FLAGS.map((flag) => ({ ...flag, enabled: getFlag(flag.name, currentCwd, expState) })),
		cwd: () => currentCwd,
		path: () => featuresFilePath(currentCwd),
	};

	pi.on("session_start", async (_event, ctx) => { reconstruct(ctx); });
	pi.on("session_tree", async (_event, ctx) => { reconstruct(ctx); });

	pi.on("before_agent_start", async (event) => {
		const hints = KNOWN_FLAGS
			.filter((f) => f.promptHint && getFlag(f.name, currentCwd, expState))
			.map((f) => f.promptHint as string);
		if (hints.length === 0) return;
		return { systemPrompt: event.systemPrompt + "\n\n## Experimental Features Enabled\n" + hints.map((h) => `- ${h}`).join("\n") };
	});

	// ── /features command ─────────────────────────────────────────────────

	pi.registerCommand("features", {
		description: "Manage repository feature flags — interactive toggle UI (or: list|enable|disable|reset|status <name>)",
		handler: async (args, ctx) => {
			const cwd = ctx.cwd;
			const configPath = featuresFilePath(cwd);
			const trimmed = (args || "").trim();
			const parts = trimmed.split(/\s+/);
			const subcmd = parts[0];
			const flagName = parts.slice(1).join(" ");
			const found = flagName ? KNOWN_FLAGS.find((f) => f.name === flagName) : undefined;

			// ── No args: launch interactive toggle UI ──────────────────────────
			if (!trimmed) {
				if (ctx.hasUI) {
					return featuresToggleUI(ctx, expState, persistExperimental);
				}
				// No UI — fall back to plain text list
				ctx.ui.notify(featuresListText(cwd, expState), "info");
				return;
			}

			// ── Subcommands ────────────────────────────────────────────────────
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
					setFlag(cwd, flagName, true);
					ctx.ui.notify(`Feature "${flagName}" enabled for this repository (${found?.stage}).`, "info");
					return;
				case "disable":
					setFlag(cwd, flagName, false);
					ctx.ui.notify(`Feature "${flagName}" disabled for this repository.`, "info");
					return;
				case "reset":
					resetFlag(cwd, flagName);
					ctx.ui.notify(`Feature "${flagName}" reset to default (${found?.default ? "enabled" : "disabled"}) for this repository.`, "info");
					return;
				case "status":
					ctx.ui.notify(`${flagName}: ${getFlag(flagName, cwd, expState) ? "enabled" : "disabled"} (${found?.stage})\n${found?.description}\nConfig: ${configPath}`, "info");
					return;
				case "list":
				default:
					ctx.ui.notify(featuresListText(cwd, expState), "info");
			}
		},
	});


}
