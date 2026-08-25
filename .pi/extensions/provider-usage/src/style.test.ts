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
	it("keeps the notification boundary plain text", () => {
		expect(styleUsageText(SAMPLE)).toBe(SAMPLE);
		expect(styleUsageText(SAMPLE)).not.toMatch(/\x1b\[/);
	});

	it("leaves non-usage lines unstyled", () => {
		const styled = styleUsageText("Rate-limit reset credits: 1 available");
		expect(styled).toBe("Rate-limit reset credits: 1 available");
	});

	it("still strips legacy ANSI when plain-text consumers receive it", () => {
		expect(stripAnsi("\x1b[1m\x1b[97mbold bright\x1b[0m plain")).toBe("bold bright plain");
	});
});
