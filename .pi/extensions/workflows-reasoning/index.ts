/**
 * Reasoning Level Extension — `/reasoning` command
 *
 * Lets the user pick a thinking/reasoning level from a select menu.
 * Commands:
 *   /reasoning  — show picker with all levels
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

const LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

const LABELS: Record<ThinkingLevel, string> = {
	off: "No reasoning — fastest responses",
	minimal: "Minimal — quick thinking",
	low: "Low — light reasoning",
	medium: "Medium — balanced (default for reasoning models)",
	high: "High — deeper analysis",
	xhigh: "Extra high — thorough reasoning (slowest)",
};

export default function (pi: ExtensionAPI) {
	pi.registerCommand("reasoning", {
		description: "Select a thinking/reasoning level",
		handler: async (_args, ctx) => {
			const current = pi.getThinkingLevel() as ThinkingLevel;

			const choices = LEVELS.map((level) => {
				const prefix = level === current ? "● " : "  ";
				const label = LABELS[level];
				return `${prefix}${level} — ${label}${level === current ? " (current)" : ""}`;
			});

			const choice = await ctx.ui.select("Reasoning Level:", choices);
			if (!choice) return;

			const selected = LEVELS.find((l) => choice.startsWith(`  ${l}`) || choice.startsWith(`● ${l}`));
			if (!selected || selected === current) return;

			pi.setThinkingLevel(selected);
			ctx.ui.notify(`Reasoning level: ${selected}`, "info");
		},
	});

	// Show current thinking level in status bar
	pi.on("thinking_level_select", async (event, ctx) => {
		ctx.ui.setStatus("thinking", `think: ${event.level}`);
	});
	pi.on("turn_end", async (_event, ctx) => {
		ctx.ui.setStatus("thinking", `think: ${pi.getThinkingLevel()}`);
	});
}
