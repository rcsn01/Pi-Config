/**
 * Personality Extension - Recreates Codex's `/personality` command
 *
 * Chooses a communication style for agent responses.
 *
 * Commands:
 *   /personality            - Show current personality and picker
 *   /personality concise    - Brief, to-the-point responses
 *   /personality detailed   - Thorough, explanatory responses
 *   /personality friendly   - Warm, conversational tone
 *   /personality pragmatic  - Direct, no-nonsense responses
 *   /personality none       - No personality instructions
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type Personality = "none" | "concise" | "detailed" | "friendly" | "pragmatic";

interface PersonalityState {
	style: Personality;
	setAt: number;
}

const PERSONALITY_CUSTOM_TYPE = "personality-state";

const PERSONALITY_PROMPTS: Record<Personality, string> = {
	none: "",
	concise: `\n\n## Communication Style: CONCISE
Be brief and to the point. Prioritize actionable information over explanation.
Use short sentences. Skip fluff, pleasantries, and unnecessary context.
State conclusions first, then back them up only if asked.`,
	
	detailed: `\n\n## Communication Style: DETAILED
Provide thorough, structured explanations. Break complex ideas into sections.
Include rationale, trade-offs, and alternatives when making recommendations.
Use examples and references where helpful. Be complete rather than terse.`,
	
	friendly: `\n\n## Communication Style: FRIENDLY
Maintain a warm, conversational tone. Use encouraging language.
Celebrate progress and wins. Be supportive when suggesting changes.
Keep the collaborative spirit while staying productive.`,
	
	pragmatic: `\n\n## Communication Style: PRAGMATIC
Be direct and no-nonsense. Focus on what works and what ships.
Avoid over-engineering. Prioritize practical solutions over perfect ones.
Call out risks bluntly. Respect the user's time above all else.`,
};

export default function (pi: ExtensionAPI) {
	let personality: PersonalityState = { style: "none", setAt: Date.now() };

	// ── State Reconstruction ──────────────────────────────────────────────

	const reconstruct = (ctx: ExtensionContext) => {
		personality = { style: "none", setAt: Date.now() };
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === PERSONALITY_CUSTOM_TYPE) {
				const data = entry.data as PersonalityState | undefined;
				if (data?.style) personality = data;
			}
		}
	};

	const persist = () => {
		pi.appendEntry(PERSONALITY_CUSTOM_TYPE, { ...personality });
	};

	pi.on("session_start", async (_event, ctx) => reconstruct(ctx));
	pi.on("session_tree", async (_event, ctx) => reconstruct(ctx));

	// ── Status Widget ─────────────────────────────────────────────────────

	pi.on("turn_end", async (_event, ctx) => {
		const labels: Record<string, string | undefined> = {
			none: undefined,
			concise: "💬 concise",
			detailed: "📖 detailed",
			friendly: "😊 friendly",
			pragmatic: "🎯 pragmatic",
		};
		ctx.ui.setStatus("personality", labels[personality.style]);
	});

	// ── Inject into system prompt ─────────────────────────────────────────

	pi.on("before_agent_start", async (event, _ctx) => {
		const prompt = PERSONALITY_PROMPTS[personality.style];
		if (!prompt) return;
		return { systemPrompt: event.systemPrompt + prompt };
	});

	// ── Command: /personality ─────────────────────────────────────────────

	pi.registerCommand("personality", {
		description: "Set communication style: concise|detailed|friendly|pragmatic|none",
		handler: async (args, ctx) => {
			const style = (args || "").trim().toLowerCase();
			const valid: Personality[] = ["none", "concise", "detailed", "friendly", "pragmatic"];

			if (!style) {
				if (!ctx.hasUI) {
					ctx.ui.notify(
						`Current: ${personality.style}. Use /personality concise|detailed|friendly|pragmatic|none`,
						"info",
					);
					return;
				}

				const current = personality.style;
				const choices = valid.map((s) => {
					const desc: Record<string, string> = {
						none: "No special instructions",
						concise: "Brief, to-the-point responses",
						detailed: "Thorough, comprehensive explanations",
						friendly: "Warm, encouraging tone",
						pragmatic: "Direct, practical, no-fluff",
					};
					return `${s === current ? "● " : "  "}${s} — ${desc[s]}`;
				});

				const choice = await ctx.ui.select("Communication Style:", choices);
				if (!choice) return;

				const match = valid.find((s) => choice.includes(s));
				if (!match || match === current) return;

				personality = { style: match, setAt: Date.now() };
				persist();
				ctx.ui.notify(`Personality: ${match}`, "info");
				return;
			}

			if (!valid.includes(style as Personality)) {
				ctx.ui.notify("Use: concise, detailed, friendly, pragmatic, or none", "warning");
				return;
			}

			if (style === personality.style) {
				ctx.ui.notify(`Already set to "${style}".`, "info");
				return;
			}

			personality = { style: style as Personality, setAt: Date.now() };
			persist();
			ctx.ui.notify(`Personality set to: ${style}`, "info");
		},
	});
}
