import { describe, expect, it } from "vitest";
import { deriveSubagentSessionId } from "./cache-affinity.ts";

describe("subagent cache affinity", () => {
	it("shares one isolated ID per main session and resolved model", () => {
		const mainSessionId = "main-session-123";
		const first = deriveSubagentSessionId(mainSessionId, "openai/gpt-5.4");
		const repeated = deriveSubagentSessionId(mainSessionId, "openai/gpt-5.4");
		expect(repeated).toBe(first);
		expect(first).not.toBe(mainSessionId);
		expect(first).toMatch(/^subagent-[a-f0-9]{32}$/);
	});

	it("separates different models and different main sessions", () => {
		const baseline = deriveSubagentSessionId("main-one", "openai/gpt-5.4");
		expect(deriveSubagentSessionId("main-one", "anthropic/claude-sonnet-4-6")).not.toBe(baseline);
		expect(deriveSubagentSessionId("main-two", "openai/gpt-5.4")).not.toBe(baseline);
	});

	it("rejects missing cache-affinity inputs", () => {
		expect(() => deriveSubagentSessionId("", "openai/gpt-5.4")).toThrow("Main session ID");
		expect(() => deriveSubagentSessionId("main", "")).toThrow("Resolved subagent model");
	});
});
