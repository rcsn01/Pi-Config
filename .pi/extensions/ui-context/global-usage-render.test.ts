import { describe, expect, it } from "vitest";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	buildGlobalUsageSnapshot,
	type GlobalSessionRecord,
	type SessionUsageEntry,
} from "../_shared/global-usage.ts";
import { ContextDiagnosticsComponent } from "./index.ts";

/** Minimal theme: no ANSI codes so assertions see plain text. */
const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;
const keybindings = { matches: () => false } as never;
const noop = () => {};

function entry(
	id: string,
	mode: SessionUsageEntry["mode"],
	model: string,
	input: number,
	cacheRead = 0,
	cacheWrite = 0,
): SessionUsageEntry {
	return { id, mode, model, input, output: 0, cacheRead, cacheWrite, cost: 0, turns: 1 };
}

function record(entries: SessionUsageEntry[], id = "s1"): GlobalSessionRecord {
	return { file: "/sessions/s.jsonl", id, cwd: "/repo", created: "2026-01-01T00:00:00.000Z", firstMessage: "hi", messageCount: entries.length, entries };
}

describe("ContextDiagnosticsComponent global view", () => {
	it("shows totals and per-mode model tables with a Total column, ordered by total tokens, and no session list", async () => {
		const snapshot = buildGlobalUsageSnapshot([record([
			entry("a1", "main", "ollama/flash", 1_000, 0, 0),
			entry("a2", "main", "openai/gpt-5", 400, 0, 300), // 700 total, behind flash's 1,000
			entry("a3", "main", "openai/gpt-5", 100, 50, 0), // same model accumulates: 450 + 50 cache
			entry("a4", "plan", "ollama/flash", 200),
		])]);
		const component = new ContextDiagnosticsComponent(
			{} as never,
			theme,
			keybindings,
			noop,
			noop,
			() => 40,
			async () => snapshot,
			{ initialView: "global" },
		);
		await new Promise((resolve) => setTimeout(resolve, 10));
		const lines = component.render(100);

		expect(lines.join("\n")).not.toContain("Sessions");
		expect(lines.join("\n")).toContain("Total");
		expect(lines.some((line) => line.includes("Global token usage"))).toBe(true);

		// Models in each mode table are ordered by total tokens (descending):
		// flash 1,000 > gpt-5 850 (500 input + 50 cacheRead + 300 cacheWrite).
		// Side-by-side blocks share a line, so assert on the full text.
		const text = lines.join("\n");
		const flashTotal = text.indexOf("1,000");
		const gptTotal = text.indexOf("850");
		expect(flashTotal).toBeGreaterThan(-1);
		expect(gptTotal).toBeGreaterThan(-1);
		expect(flashTotal).toBeLessThan(gptTotal);
	});

	it("keeps the summary view rendering with the shared table renderer", () => {
		const diagnostics = {
			modelUsage: [
				{ model: "ollama/flash", session: { input: 100, cacheRead: 900, output: 5 }, subagent: { input: 0, cacheRead: 0, output: 0 }, advisor: { input: 0, cacheRead: 0, output: 0 }, guardian: { input: 0, cacheRead: 0, output: 0 } },
				{ model: "openai/gpt-5", session: { input: 200, cacheRead: 0, output: 10 }, subagent: { input: 0, cacheRead: 0, output: 0 }, advisor: { input: 0, cacheRead: 0, output: 0 }, guardian: { input: 0, cacheRead: 0, output: 0 } },
			],
			usedTokens: 1215,
			usedIsEstimated: false,
			contextWindow: 200000,
			percent: 0.6,
			categories: { systemPrompt: 300, builtinTools: 100, extensionTools: 200, contextFiles: 0, skills: 15, messages: 600 },
			systemPromptDetails: [],
			extensionTools: [],
		} as never;
		const component = new ContextDiagnosticsComponent(diagnostics, theme, keybindings, noop, noop, () => 40);
		const lines = component.render(100);
		const table = lines.join("\n");
		expect(table).toContain("Current context token usage");
		expect(table).toContain("1,005"); // flash total: 100 input + 900 cacheRead + 5 output
		expect(table.indexOf("ollama/flash")).toBeLessThan(table.indexOf("openai/gpt-5"));
	});
});
