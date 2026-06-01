/**
 * Memories Configuration Extension - Recreates Codex's `/memories` command
 *
 * Controls whether the agent uses and generates persistent memories.
 * Extends the memory.ts extension with a config UI.
 *
 * Commands:
 *   /memories                - Show memory settings picker
 *   /memories on             - Enable memory injection + generation
 *   /memories off            - Disable all memory features
 *   /memories inject-only    - Use existing memories, don't generate new
 *   /memories status         - Show current memory settings
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type MemoryMode = "off" | "on" | "inject-only";

interface MemoriesState {
	mode: MemoryMode;
	setAt: number;
}

const MEMORIES_CUSTOM_TYPE = "memories-config";

export default function (pi: ExtensionAPI) {
	let state: MemoriesState = { mode: "off", setAt: Date.now() };

	// ── State Reconstruction ──────────────────────────────────────────────

	const reconstruct = (ctx: ExtensionContext) => {
		state = { mode: "off", setAt: Date.now() };
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === MEMORIES_CUSTOM_TYPE) {
				const data = entry.data as MemoriesState | undefined;
				if (data?.mode) state = data;
			}
		}
	};

	const persist = () => {
		pi.appendEntry(MEMORIES_CUSTOM_TYPE, { ...state });
	};

	pi.on("session_start", async (_event, ctx) => reconstruct(ctx));
	pi.on("session_tree", async (_event, ctx) => reconstruct(ctx));

	// ── Status Widget ─────────────────────────────────────────────────────

	pi.on("turn_end", async (_event, ctx) => {
		const labels: Record<MemoryMode, string> = {
			on: "🧠 Memories",
			"inject-only": "🧠 Mem(ro)",
			off: "",
		};
		if (state.mode !== "off") {
			ctx.ui.setStatus("memories", labels[state.mode]);
		}
	});

	// ── Inject memory instructions into system prompt ─────────────────────

	pi.on("before_agent_start", async (event, _ctx) => {
		if (state.mode === "off") return;

		if (state.mode === "inject-only") {
			return {
				systemPrompt: event.systemPrompt + `\n\n## Persistent Memory (Read-Only)
This project uses MEMORY.md for long-term context.
- Read MEMORY.md at session start for project context.
- Do NOT generate new memories or update MEMORY.md.
- Use existing memories for context but don't write to them.`,
			};
		}

		// "on" - full memory
		return {
			systemPrompt: event.systemPrompt + `\n\n## Persistent Memory
This project uses MEMORY.md as the long-term memory file.
- At session start: Read MEMORY.md silently before doing any work.
- During the session: Update MEMORY.md whenever you learn something worth remembering.
- Manage MEMORY.md autonomously — no asking permission.
- Keep entries concise. Prune stale entries.`,
		};
	});

	// ── Command: /memories ────────────────────────────────────────────────

	pi.registerCommand("memories", {
		description: "Configure memory injection and generation (on|off|inject-only|status)",
		handler: async (args, ctx) => {
			const mode = (args || "").trim().toLowerCase();
			const valid: MemoryMode[] = ["off", "on", "inject-only"];

			if (!mode || mode === "status") {
				if (!ctx.hasUI) {
					ctx.ui.notify(
						`Memories: ${state.mode}. Use /memories on|off|inject-only`,
						"info",
					);
					return;
				}

				const current = state.mode;
				const choices = valid.map((m) => {
					const desc: Record<MemoryMode, string> = {
						off: "No memory injection or generation",
						on: "Read and write memories (full)",
						"inject-only": "Use existing memories, don't generate new ones",
					};
					return `${m === current ? "● " : "  "}${m} — ${desc[m]}`;
				});

				const choice = await ctx.ui.select("Memory Settings:", choices);
				if (!choice) return;

				const match = valid.find((m) => choice.includes(m));
				if (!match || match === state.mode) return;

				state = { mode: match, setAt: Date.now() };
				persist();
				ctx.ui.notify(`Memories: ${match}`, "info");
				return;
			}

			if (!valid.includes(mode as MemoryMode)) {
				ctx.ui.notify("Use: on, off, or inject-only", "warning");
				return;
			}

			if (mode === state.mode) {
				ctx.ui.notify(`Memories already set to "${mode}".`, "info");
				return;
			}

			state = { mode: mode as MemoryMode, setAt: Date.now() };
			persist();
			ctx.ui.notify(`Memories: ${mode}`, "info");
		},
	});
}
