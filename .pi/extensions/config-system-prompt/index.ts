import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildGuidelines, insertGuidelines } from "./sections.ts";

/**
 * Restores the "Guidelines" system-prompt section that pi drops when a
 * custom prompt (SYSTEM.md, --system-prompt) replaces the default build.
 * The "Available tools" list is intentionally not restored: tool discovery
 * rides on the provider payload's function schemas. Guidelines are re-rendered
 * from systemPromptOptions every turn (the before_agent_start chain resets to
 * the base prompt each turn), so they stay truthful when tools change: advisor
 * toggles, profile switches, plan-mode tool swaps.
 */
export default function configSystemPromptExtensionFactory(pi: ExtensionAPI): void {
	pi.on("before_agent_start", (event) => {
		if (!event.systemPromptOptions.customPrompt) return;
		const guidelines = buildGuidelines(event.systemPromptOptions);
		const systemPrompt = insertGuidelines(event.systemPrompt, guidelines);
		if (systemPrompt === event.systemPrompt) return;
		return { systemPrompt };
	});

	pi.registerCommand("system-prompt", {
		description: "Write the current system prompt to a temp file",
		handler: async (_args, ctx) => {
			const prompt = ctx.getSystemPrompt() ?? "";
			const path = join(tmpdir(), `pi-system-prompt-${Date.now()}.txt`);
			writeFileSync(path, prompt, { encoding: "utf-8" });
			if (ctx.hasUI) {
				ctx.ui.notify(`System prompt (${prompt.length} chars) written to ${path}`, "info");
			}
		},
	});
}