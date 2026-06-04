/**
 * Thinking Level Extension — `/thinking` command
 *
 * Lets the user pick or set a thinking level.
 * Commands:
 *   /thinking        — show picker with all levels
 *   /thinking high   — set a level directly
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

const LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

const LABELS: Record<ThinkingLevel, string> = {
	off: "No thinking — fastest responses",
	minimal: "Minimal — quick thinking",
	low: "Low — light thinking",
	medium: "Medium — balanced (default for thinking-capable models)",
	high: "High — deeper analysis",
	xhigh: "Extra high — thorough thinking (slowest)",
};

function isThinkingLevel(value: string): value is ThinkingLevel {
	return LEVELS.includes(value as ThinkingLevel);
}

function normalizeThinkingLevel(input: string): ThinkingLevel | null {
	const normalized = input.trim().toLowerCase().replace(/^extra[-_ ]?high$/, "xhigh");
	return isThinkingLevel(normalized) ? normalized : null;
}

/** Build a choice string with a numeric key for reliable parsing. */
function buildChoice(level: ThinkingLevel, idx: number, isCurrent: boolean): string {
	const marker = isCurrent ? "●" : "○";
	return `${marker} ${idx}. ${level} — ${LABELS[level]}${isCurrent ? " (current)" : ""}`;
}

/** Parse the selected level from the choice string using the numeric key, with a level-name fallback. */
function parseChoice(choice: string): ThinkingLevel | null {
	const idxMatch = choice.match(/\b(\d+)\./);
	if (idxMatch) {
		const idx = parseInt(idxMatch[1], 10);
		if (LEVELS[idx]) return LEVELS[idx];
	}

	return LEVELS.find((level) => choice.includes(`${level} —`)) ?? null;
}

function setThinkingLevel(pi: ExtensionAPI, ctx: ExtensionCommandContext, selected: ThinkingLevel): void {
	const before = pi.getThinkingLevel() as ThinkingLevel;

	if (selected === before) {
		ctx.ui.notify(`Already using thinking level: ${selected}`, "info");
		return;
	}

	pi.setThinkingLevel(selected);

	// Verify the change took effect. Pi can clamp unsupported levels based on model capabilities.
	const actual = pi.getThinkingLevel() as ThinkingLevel;
	if (actual === selected) {
		ctx.ui.notify(`Thinking level: ${selected}`, "info");
	} else {
		ctx.ui.notify(
			`Requested thinking level ${selected}, but current model clamped it to ${actual}`,
			"warning",
		);
	}
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("thinking", {
		description: "Select or set a thinking level",
		handler: async (args, ctx) => {
			const requested = normalizeThinkingLevel(args);
			if (requested) {
				setThinkingLevel(pi, ctx, requested);
				return;
			}

			if (args.trim()) {
				ctx.ui.notify(
					`Unknown thinking level: ${args.trim()} (use ${LEVELS.join(", ")})`,
					"error",
				);
				return;
			}

			const current = pi.getThinkingLevel() as ThinkingLevel;
			const choices = LEVELS.map((level, idx) => buildChoice(level, idx, level === current));

			const choice = await ctx.ui.select("Thinking Level:", choices);
			if (!choice) return;

			const selected = parseChoice(choice);
			if (!selected) {
				ctx.ui.notify(`Failed to parse selection: ${choice}`, "error");
				return;
			}

			setThinkingLevel(pi, ctx, selected);
		},
	});

	// Show current thinking level in status bar.
	pi.on("thinking_level_select", async (event, ctx) => {
		ctx.ui.setStatus("thinking", `think: ${event.level}`);
	});
	pi.on("turn_end", async (_event, ctx) => {
		ctx.ui.setStatus("thinking", `think: ${pi.getThinkingLevel()}`);
	});
}
