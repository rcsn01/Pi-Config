import { describe, expect, it } from "vitest";
import { stripAnsi, styleUsageText } from "./style.ts";

const SAMPLE = [
	"ChatGPT Codex · Plan: Pro",
	"Weekly limit: [██████░░░░] 58% used · resets 14:30 on 24 Aug",
	"Rate-limit reset credits: 1 available",
	"",
	"Ollama Cloud",
	"Session usage: [██░░░░░░░░] 16% used · resets in 40 minutes",
	"Weekly usage: [░░░░░░░░░░] 3% used · resets in 6 days",
].join("\n");

describe("usage text styling", () => {
	it("styles headers, bars, and percents without changing the plain text", () => {
		const styled = styleUsageText(SAMPLE);
		expect(styled).toContain("\x1b[97m\x1b[1mChatGPT Codex · Plan: Pro\x1b[0m");
		expect(styled).toContain("\x1b[97m\x1b[1m[██████░░░░]\x1b[0m");
		expect(styled).toContain("\x1b[1m58% used\x1b[0m");
		expect(styled).toContain("\x1b[1m16% used\x1b[0m");
		expect(styled).toContain("\x1b[1m3% used\x1b[0m");
		expect(stripAnsi(styled)).toBe(SAMPLE);
	});

	it("leaves non-usage lines unstyled", () => {
		const styled = styleUsageText("Rate-limit reset credits: 1 available");
		expect(styled).toBe("Rate-limit reset credits: 1 available");
	});

	it("round-trips through stripAnsi", () => {
		expect(stripAnsi("\x1b[1m\x1b[97mbold bright\x1b[0m plain")).toBe("bold bright plain");
	});
});
