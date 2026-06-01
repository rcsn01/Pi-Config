/**
 * Plan Mode Extension - Recreates Codex's `/plan` command
 *
 * Puts the agent into plan mode where it proposes an execution plan
 * before making any changes. Optionally accepts an inline prompt.
 *
 * Commands:
 *   /plan                  - Enter plan mode
 *   /plan <prompt>         - Enter plan mode with inline prompt
 *   /plan off              - Exit plan mode
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

interface PlanState {
	active: boolean;
	prompt?: string;
	setAt: number;
}

const PLAN_CUSTOM_TYPE = "plan-mode-state";

const PLAN_MODE_PROMPT = `\n\n## Plan Mode Active

You are in PLAN MODE. Before implementing any changes, you MUST:

1. **Understand** - Read relevant files and understand the current state
2. **Propose** - Present a clear, structured plan with:
   - What files will be changed/created
   - The order of operations
   - Risks and edge cases to watch for
   - Expected outcome
3. **Wait** - After presenting the plan, wait for the user to approve before
   making any edits or running any non-read-only commands

Do NOT write code, edit files, or run commands until the plan is approved.
You MAY read files, search code, and gather information to craft the plan.

The user will say "approved", "go ahead", "proceed", or similar to approve.
If the user provides feedback, refine the plan and present it again.`;

export default function (pi: ExtensionAPI) {
	let planState: PlanState = { active: false, setAt: Date.now() };

	// ── State Reconstruction ──────────────────────────────────────────────

	const reconstruct = (ctx: ExtensionContext) => {
		planState = { active: false, setAt: Date.now() };
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === PLAN_CUSTOM_TYPE) {
				const data = entry.data as PlanState | undefined;
				if (data) planState = data;
			}
		}
	};

	const persist = () => {
		pi.appendEntry(PLAN_CUSTOM_TYPE, { ...planState });
	};

	pi.on("session_start", async (_event, ctx) => reconstruct(ctx));
	pi.on("session_tree", async (_event, ctx) => reconstruct(ctx));

	// ── Status Widget ─────────────────────────────────────────────────────

	pi.on("turn_end", async (_event, ctx) => {
		ctx.ui.setStatus("plan", planState.active ? "📋 PLAN MODE" : undefined);
	});

	// ── Inject plan mode into system prompt ───────────────────────────────

	pi.on("before_agent_start", async (event, _ctx) => {
		if (!planState.active) return;
		return { systemPrompt: event.systemPrompt + PLAN_MODE_PROMPT };
	});

	// ── Command: /plan ────────────────────────────────────────────────────

	pi.registerShortcut("shift+tab", {
		description: "Toggle plan mode",
		handler: async (ctx) => {
			// Toggle plan mode
			if (planState.active) {
				planState = { active: false, setAt: Date.now() };
				persist();
				ctx.ui.notify("Plan mode exited.", "info");
			} else {
				planState = { active: true, setAt: Date.now() };
				persist();
				ctx.ui.notify("📋 Plan mode active. The agent will propose before implementing.", "info");
			}
		},
	});

	pi.registerCommand("plan", {
		description: "Enter plan mode - propose before implementing",
		handler: async (args, ctx) => {
			const trimmed = (args || "").trim();

			if (trimmed === "off" || trimmed === "exit") {
				if (!planState.active) {
					ctx.ui.notify("Plan mode is not active.", "info");
					return;
				}
				planState = { active: false, setAt: Date.now() };
				persist();
				ctx.ui.notify("Plan mode exited.", "info");
				return;
			}

			// Toggle or set
			if (trimmed === "" && planState.active) {
				// Turn off
				planState = { active: false, setAt: Date.now() };
				persist();
				ctx.ui.notify("Plan mode exited.", "info");
				return;
			}

			if (!trimmed && !planState.active && ctx.hasUI) {
				const choice = await ctx.ui.select("Plan Mode:", [
					"Enter plan mode (propose before implementing)",
					"Enter plan mode with inline prompt",
				]);
				if (!choice) return;

				if (choice.includes("inline")) {
					const prompt = await ctx.ui.input("What should be planned?");
					if (!prompt) return;
					planState = { active: true, prompt, setAt: Date.now() };
					persist();
					ctx.ui.notify("📋 Plan mode active", "info");
					pi.sendUserMessage(`Plan mode is active. Plan this: ${prompt}`);
				} else {
					planState = { active: true, setAt: Date.now() };
					persist();
					ctx.ui.notify("📋 Plan mode active. The agent will propose before implementing.", "info");
				}
				return;
			}

			planState = { active: true, prompt: trimmed || undefined, setAt: Date.now() };
			persist();
			ctx.ui.notify("📋 Plan mode active", "info");

			if (trimmed) {
				pi.sendUserMessage(`Plan mode is active. Plan this: ${trimmed}`);
			}
		},
	});
}
