/**
 * Experimental Features Extension - Recreates Codex's `/experimental` command
 *
 * Toggle experimental features on/off. These are stored as session state
 * and can be enabled/disabled at runtime.
 *
 * Commands:
 *   /experimental             - Show experimental features picker
 *   /experimental on <feat>   - Enable an experimental feature
 *   /experimental off <feat>  - Disable an experimental feature
 *   /experimental list        - List all experimental features
 *
 * Features tracked:
 *   - subagents: Parallel subagent execution
 *   - memories: Persistent memory generation
 *   - sandbox: Sandbox command execution
 *   - imagegen: Local image generation
 *   - websearch: DuckDuckGo web search (no API key)
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

interface ExpFeature {
	name: string;
	description: string;
	enabled: boolean;
}

interface ExpState {
	features: Record<string, boolean>;
	setAt: number;
}

const EXP_CUSTOM_TYPE = "experimental-state";

const KNOWN_FEATURES: ExpFeature[] = [
	{ name: "subagents", description: "Parallel subagent delegation (scout/researcher/worker)", enabled: true },
	{ name: "memories", description: "Read and write persistent project memory (MEMORY.md)", enabled: false },
	{ name: "sandbox", description: "Run commands in sandbox (macOS sandbox-exec / Linux bubblewrap)", enabled: false },
	{ name: "imagegen", description: "Generate images locally (no API key needed)", enabled: false },
	{ name: "websearch", description: "Search the web via DuckDuckGo (no API key)", enabled: false },
];

export default function (pi: ExtensionAPI) {
	let state: ExpState = {
		features: Object.fromEntries(KNOWN_FEATURES.map((f) => [f.name, f.enabled])),
		setAt: Date.now(),
	};

	// ── State Reconstruction ──────────────────────────────────────────────

	const reconstruct = (ctx: ExtensionContext) => {
		state = {
			features: Object.fromEntries(KNOWN_FEATURES.map((f) => [f.name, f.enabled])),
			setAt: Date.now(),
		};
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === EXP_CUSTOM_TYPE) {
				const data = entry.data as ExpState | undefined;
				if (data?.features) state = data;
			}
		}
	};

	const persist = () => {
		pi.appendEntry(EXP_CUSTOM_TYPE, { ...state });
	};

	pi.on("session_start", async (_event, ctx) => reconstruct(ctx));
	pi.on("session_tree", async (_event, ctx) => reconstruct(ctx));

	// ── Status Widget ─────────────────────────────────────────────────────

	pi.on("turn_end", async (_event, ctx) => {
		const enabledCount = Object.values(state.features).filter(Boolean).length;
		if (enabledCount > 0) {
			ctx.ui.setStatus("experimental", `⚙️ ${enabledCount} exp`);
		}
	});

	// ── Inject experimental instructions ──────────────────────────────────

	pi.on("before_agent_start", async (event, _ctx) => {
		const enabledFeatures = Object.entries(state.features)
			.filter(([, v]) => v)
			.map(([k]) => k);

		if (enabledFeatures.length === 0) return;

		const featureHints: Record<string, string> = {
			subagents: "Use subagents to delegate reasoning tasks (scout, researcher, worker).",
			memories: "Read and update MEMORY.md for persistent project context.",
			sandbox: "Commands are sandboxed for safety.",
			imagegen: "Use image_generate tool for image creation.",
			websearch: "Use ddg_search for web queries when needed.",
		};

		const hints = enabledFeatures
			.map((f) => featureHints[f])
			.filter(Boolean);

		if (hints.length > 0) {
			return {
				systemPrompt: event.systemPrompt + "\n\n## Experimental Features Enabled\n" +
					hints.map((h) => `- ${h}`).join("\n"),
			};
		}
	});

	// ── Command: /experimental ────────────────────────────────────────────

	pi.registerCommand("experimental", {
		description: "Toggle experimental features (subagents, memories, etc.)",
		handler: async (args, ctx) => {
			const trimmed = (args || "").trim().toLowerCase();
			const parts = trimmed.split(/\s+/);
			const subcmd = parts[0];
			const featName = parts.slice(1).join(" ");

			if (subcmd === "on" || subcmd === "enable") {
				if (!featName) {
					ctx.ui.notify("Usage: /experimental on <feature-name>", "warning");
					return;
				}
				const found = KNOWN_FEATURES.find((f) => f.name === featName);
				if (!found) {
					ctx.ui.notify(`Unknown feature: "${featName}". Use /experimental list.`, "warning");
					return;
				}
				state.features[featName] = true;
				persist();
				ctx.ui.notify(`Experimental: ${featName} ENABLED`, "info");
				return;
			}

			if (subcmd === "off" || subcmd === "disable") {
				if (!featName) {
					ctx.ui.notify("Usage: /experimental off <feature-name>", "warning");
					return;
				}
				state.features[featName] = false;
				persist();
				ctx.ui.notify(`Experimental: ${featName} DISABLED`, "info");
				return;
			}

			if (subcmd === "list") {
				const lines = ["Experimental Features:"];
				for (const f of KNOWN_FEATURES) {
					const enabled = state.features[f.name] ?? f.enabled;
					const icon = enabled ? "●" : "○";
					lines.push(`  ${icon} ${f.name} — ${f.description}`);
				}
				lines.push("\nUse /experimental on|off <feature> to toggle.");
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}

			// Interactive picker
			if (!ctx.hasUI) {
				const lines = KNOWN_FEATURES.map((f) => {
					const enabled = state.features[f.name] ?? f.enabled;
					return `${enabled ? "●" : "○"} ${f.name}`;
				});
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}

			const choices = KNOWN_FEATURES.map((f) => {
				const enabled = state.features[f.name] ?? f.enabled;
				return `${enabled ? "✓" : "✗"} ${f.name} — ${f.description}`;
			});

			const choice = await ctx.ui.select("Toggle Experimental Features:", choices);
			if (!choice) return;

			const match = KNOWN_FEATURES.find((f) => choice.includes(f.name));
			if (!match) return;

			const current = state.features[match.name] ?? match.enabled;
			state.features[match.name] = !current;
			persist();

			ctx.ui.notify(
				`${match.name}: ${!current ? "ENABLED" : "DISABLED"}`,
				"info",
			);
		},
	});
}
