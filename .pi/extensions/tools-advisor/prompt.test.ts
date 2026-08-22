import { describe, expect, it } from "vitest";
import {
	ADVISOR_EXECUTOR_ROLE,
	PI_DEFAULT_OPENING,
	transformAdvisorPrompt,
} from "./prompt.ts";

describe("transformAdvisorPrompt", () => {
	it("replaces Pi's default opening with the executor-advisor role", () => {
		const remainder = "\n\nAvailable tools:\n- read";

		expect(transformAdvisorPrompt(`${PI_DEFAULT_OPENING}${remainder}`)).toBe(
			`${ADVISOR_EXECUTOR_ROLE}${remainder}`,
		);
	});

	it("removes the old expert coding assistant identity", () => {
		const transformed = transformAdvisorPrompt(PI_DEFAULT_OPENING);

		expect(transformed).not.toContain("You are an expert coding assistant");
		expect(transformed.startsWith(ADVISOR_EXECUTOR_ROLE)).toBe(true);
	});

	it("preserves everything after Pi's opening exactly", () => {
		const remainder = "\n\nGuidelines:\n\tKeep this spacing.\n\nCurrent directory: /workspace\n";

		expect(transformAdvisorPrompt(`${PI_DEFAULT_OPENING}${remainder}`)).toBe(
			`${ADVISOR_EXECUTOR_ROLE}${remainder}`,
		);
	});

	it("prepends the role to a custom prompt without changing the custom text", () => {
		const customPrompt = "Use the repository's custom instructions.\n\nDo not rewrite this.";

		expect(transformAdvisorPrompt(customPrompt)).toBe(
			`${ADVISOR_EXECUTOR_ROLE}\n\n${customPrompt}`,
		);
	});

	it("does not duplicate the role when transformed more than once", () => {
		const prompt = `${PI_DEFAULT_OPENING}\n\nAvailable tools:`;
		const transformed = transformAdvisorPrompt(prompt);

		expect(transformAdvisorPrompt(transformed)).toBe(transformed);
		expect(transformed.match(/executor-advisor workflow/g)).toHaveLength(1);
	});
});
