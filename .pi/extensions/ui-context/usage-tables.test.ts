import { describe, expect, it } from "vitest";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { emptyGlobalModeTotals } from "../_shared/global-usage.ts";
import { emptyUsageTotals } from "../_shared/usage.ts";
import { globalTotalsLines, sortedUsageRows, usageTableLines } from "./usage-tables.ts";

/** Minimal theme: no ANSI codes so assertions see plain text. */
const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;

const rows = [
	{ model: "ollama/flash", usage: { input: 1_234, cacheRead: 900, output: 5 } },
	{ model: "openai/gpt-5", usage: { input: 200, cacheRead: 0, output: 10 } },
];

describe("usageTableLines", () => {
	it("renders a header table with full column names at wide widths", () => {
		expect(usageTableLines("Test usage", rows, theme, 60)).toEqual([
			"┌─ Test usage ─────────────────────────────────────────────┐",
			"│ Model                  Input  Cache input  Output  Total │",
			"├──────────────────────────────────────────────────────────┤",
			"│ ollama/flash           1,234          900       5  2,139 │",
			"│ openai/gpt-5             200            0      10    210 │",
			"└──────────────────────────────────────────────────────────┘",
		]);
	});

	it("falls back to shortened headers when the model column gets too narrow", () => {
		const lines = usageTableLines("Test usage", rows, theme, 46);
		expect(lines[1]).toBe("│ Model          Input  Cache  Output  Total │");
		expect(lines.join("\n")).not.toContain("Cache input");
	});

	it("falls back to a label list at narrow widths", () => {
		expect(usageTableLines("Test usage", rows, theme, 40)).toEqual([
			"┌─ Test usage ─────────────────────────┐",
			"│ ollama/flash                         │",
			"│   Input        1,234                 │",
			"│   Cache input  900                   │",
			"│   Output       5                     │",
			"│   Total        2,139                 │",
			"│ openai/gpt-5                         │",
			"│   Input        200                   │",
			"│   Cache input  0                     │",
			"│   Output       10                    │",
			"│   Total        210                   │",
			"└──────────────────────────────────────┘",
		]);
	});

	it("shows an empty state when there are no rows", () => {
		expect(usageTableLines("Test usage", [], theme, 40)).toEqual([
			"┌─ Test usage ─────────────────────────┐",
			"│ No usage recorded                    │",
			"└──────────────────────────────────────┘",
		]);
	});

	it("truncates long model names with an ellipsis in the label list", () => {
		const lines = usageTableLines("Test usage", [
			{ model: "anthropic/claude-sonnet-4-20250514-very-long-name", usage: { input: 100, cacheRead: 0, output: 0 } },
		], theme, 30);
		expect(lines[1]).toContain("…");
		expect(lines[1]).toContain("anthropic/claude-sonnet-4");
	});
});

describe("globalTotalsLines", () => {
	const totals = emptyGlobalModeTotals();
	totals.main = { ...emptyUsageTotals(), input: 1_000, cacheRead: 200, output: 50, tokens: 1_250, cost: 1.2345, turns: 3 };
	totals.plan = { ...emptyUsageTotals(), input: 100, cacheRead: 0, output: 10, tokens: 110, cost: 0.5, turns: 1 };
	const grandTotal = { ...emptyUsageTotals(), input: 1_100, cacheRead: 200, output: 60, tokens: 1_360, cost: 1.7345, turns: 4 };

	it("renders a header table with right-aligned cost and turns columns", () => {
		expect(globalTotalsLines(totals, grandTotal, theme, 60)).toEqual([
			"┌─ Global token usage ─────────────────────────────────────┐",
			"│ Mode              Input  Cache in  Output    Cost  Turns │",
			"├──────────────────────────────────────────────────────────┤",
			"│ Main              1,000       200      50  $1.234      3 │",
			"│ Plan mode           100         0      10  $0.500      1 │",
			"│ Subagent              0         0       0  $0.000      0 │",
			"│ Advisor               0         0       0  $0.000      0 │",
			"│ Guardian              0         0       0  $0.000      0 │",
			"│ Total             1,100       200      60  $1.734      4 │",
			"└──────────────────────────────────────────────────────────┘",
		]);
	});

	it("falls back to a label list at narrow widths", () => {
		const lines = globalTotalsLines(totals, grandTotal, theme, 30);
		expect(lines).toContain("│ Main                       │");
		expect(lines).toContain("│   Input     1,000          │");
		expect(lines).toContain("│   Cost      $1.234         │");
		expect(lines).toContain("│   Turns     3              │");
	});
});

describe("sortedUsageRows", () => {
	it("filters zero-total rows, sorts by total tokens descending, and keeps unknown last", () => {
		expect(sortedUsageRows([
			{ model: "b", usage: { input: 10, cacheRead: 0, output: 0 } },
			{ model: "unknown", usage: { input: 5, cacheRead: 0, output: 0 } },
			{ model: "a", usage: { input: 0, cacheRead: 0, output: 0 } },
			{ model: "c", usage: { input: 20, cacheRead: 0, output: 0 } },
		])).toEqual([
			{ model: "c", usage: { input: 20, cacheRead: 0, output: 0 } },
			{ model: "b", usage: { input: 10, cacheRead: 0, output: 0 } },
			{ model: "unknown", usage: { input: 5, cacheRead: 0, output: 0 } },
		]);
	});
});
