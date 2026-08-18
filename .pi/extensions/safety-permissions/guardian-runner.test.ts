import { describe, expect, it } from "vitest";
import { collectGuardianUsage, parseGuardianDefinition, parseGuardianVerdict } from "./guardian-runner.ts";

describe("collectGuardianUsage", () => {
	it("aggregates assistant usage only from the current guardian request", () => {
		const messages = [
			{ role: "assistant", usage: { input: 999, output: 999, cacheRead: 999, cacheWrite: 0, totalTokens: 1_998, cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 0, total: 3 } } },
			{ role: "user" },
			{ role: "assistant", usage: { input: 10, output: 2, cacheRead: 3, cacheWrite: 1, totalTokens: 15, cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4, total: 1 } } },
			{ role: "assistant", usage: { input: 5, output: 4, cacheRead: 6, cacheWrite: 0, totalTokens: 15, cost: { input: 0.5, output: 0.4, cacheRead: 0.6, cacheWrite: 0, total: 1.5 } } },
		] as any;

		expect(collectGuardianUsage(messages, 1)).toEqual({
			input: 15,
			output: 6,
			cacheRead: 9,
			cacheWrite: 1,
			totalTokens: 30,
			cost: { input: 0.6, output: 0.6000000000000001, cacheRead: 0.8999999999999999, cacheWrite: 0.4, total: 2.5 },
		});
		expect(collectGuardianUsage(messages, 0)?.input).toBe(1014);
		expect(collectGuardianUsage([{ role: "user" }] as any, 0)).toBeUndefined();
	});
});

describe("parseGuardianVerdict", () => {
	it("parses a JSON allow verdict with rationale", () => {
		expect(parseGuardianVerdict('{"outcome":"allow","risk_level":"low","rationale":"safe read"}')).toEqual({
			allowed: true,
			reason: "safe read",
		});
	});

	it("parses a JSON deny verdict with risk and rationale", () => {
		const result = parseGuardianVerdict('{"outcome":"deny","risk_level":"high","rationale":"deletes files"}');
		expect(result).not.toBe("unclear");
		expect(result).toMatchObject({ allowed: false });
		expect((result as { reason: string }).reason).toContain("deletes files");
	});

	it("strips markdown fences around JSON verdicts", () => {
		expect(parseGuardianVerdict('```json\n{"outcome":"allow"}\n```')).toEqual({
			allowed: true,
			reason: "allowed",
		});
	});

	it("accepts a bare ALLOW token", () => {
		expect(parseGuardianVerdict("I think this is fine. ALLOW")).toEqual({
			allowed: true,
			reason: "Guardian: allowed.",
		});
	});

	it("accepts a bare DENY token", () => {
		expect(parseGuardianVerdict("This is unsafe. DENY.")).toEqual({
			allowed: false,
			reason: "Guardian: denied.",
		});
	});

	it("returns 'unclear' for ambiguous responses", () => {
		expect(parseGuardianVerdict("I am not sure what to do here.")).toBe("unclear");
	});
});

describe("parseGuardianDefinition", () => {
	it("parses CRLF frontmatter and the guardian system prompt", () => {
		const definition = parseGuardianDefinition(
			"---\r\nname: guardian\r\nmodel: test/model\r\ntools:\r\n---\r\n\r\nReview this action.\r\n",
		);

		expect(definition).toEqual({
			systemPrompt: "Review this action.",
			model: "test/model",
			tools: "",
		});
	});

	it("handles a definition without a model or tools", () => {
		expect(parseGuardianDefinition("---\n---\n\nJust a prompt.")).toEqual({
			systemPrompt: "Just a prompt.",
			model: "",
			tools: "",
		});
	});
});
