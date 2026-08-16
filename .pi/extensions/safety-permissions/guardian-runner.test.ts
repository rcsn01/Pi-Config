import { describe, expect, it } from "vitest";
import { parseGuardianDefinition, parseGuardianVerdict } from "./guardian-runner.ts";

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
