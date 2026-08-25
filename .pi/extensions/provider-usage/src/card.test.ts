import { describe, expect, it } from "vitest";
import { planHeader, usageRow } from "./card.ts";

describe("usageRow", () => {
	it("renders the bar, rounded percentage, and reset phrase", () => {
		expect(usageRow("Weekly limit", 58, "resets in 7d 4h on 24 Aug"))
			.toBe("Weekly limit: [████████████░░░░░░░░] 58% used · resets in 7d 4h on 24 Aug");
	});

	it("rounds fractional percentages and omits the reset phrase when absent", () => {
		expect(usageRow("Session usage", 16.2)).toBe("Session usage: [███░░░░░░░░░░░░░░░░░] 16% used");
		expect(usageRow("Weekly usage", 2.9)).toBe("Weekly usage: [█░░░░░░░░░░░░░░░░░░░] 3% used");
	});
});

describe("planHeader", () => {
	it("renders the provider name with the plan", () => {
		expect(planHeader("ChatGPT Codex", "Pro", false)).toBe("ChatGPT Codex · Plan: Pro");
	});

	it("omits the plan when unknown and marks stale snapshots", () => {
		expect(planHeader("Ollama Cloud", undefined, false)).toBe("Ollama Cloud");
		expect(planHeader("ChatGPT Codex", "Pro", true)).toBe("ChatGPT Codex · Plan: Pro (stale)");
		expect(planHeader("Ollama Cloud", undefined, true)).toBe("Ollama Cloud (stale)");
	});
});
