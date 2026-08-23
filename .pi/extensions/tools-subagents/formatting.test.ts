import { describe, expect, it } from "vitest";
import {
	formatContextWindow,
	formatDuration,
	formatTokens,
	formatToolArgsPreview,
	truncateDisplayLine,
} from "./formatting.ts";

describe("subagent formatting", () => {
	it("formats token and duration thresholds", () => {
		expect([999, 1000, 9500, 10000].map(formatTokens)).toEqual(["999", "1.0k", "9.5k", "10k"]);
		expect([999, 1000, 59999, 61000].map(formatDuration)).toEqual(["999ms", "1.0s", "60.0s", "1m1s"]);
	});

	it("formats repo_query progress by operation count", () => {
		expect(formatToolArgsPreview({ operations: [{ kind: "read" }, { kind: "grep" }] })).toBe("repo_query: 2 operations");
	});

	it("formats tool argument previews with existing precedence and limits", () => {
		expect(formatToolArgsPreview({ command: "echo ok", path: "/ignored" })).toBe("echo ok");
		expect(formatToolArgsPreview({ query: "term" })).toBe('"term"');
		expect(formatToolArgsPreview({ url: "https://example.com" })).toBe("https://example.com");
		expect(formatToolArgsPreview({ pattern: "*.ts" })).toBe("*.ts");
		expect(formatToolArgsPreview({ value: "x".repeat(100) })).toMatch(/…$/);
	});

	it("formats context windows", () => {
		expect([999, 1000, 1500, 1_000_000, 1_250_000].map(formatContextWindow)).toEqual([
			"999 context", "1K context", "1.5K context", "1M context", "1.25M context",
		]);
	});

	it("truncates visible text while retaining ANSI sequences", () => {
		expect(truncateDisplayLine("short", 10)).toBe("short");
		expect(truncateDisplayLine("abcdef", 4)).toBe("abc…");
		expect(truncateDisplayLine("\u001b[31mabcdef\u001b[0m", 4)).toContain("\u001b[31mabc…");
	});
});
