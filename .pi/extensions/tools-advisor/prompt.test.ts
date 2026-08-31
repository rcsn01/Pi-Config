import { describe, expect, it } from "vitest";
import {
	ADVISOR_SYSTEM_PROMPT,
	ADVISOR_TOOL_DESCRIPTION,
	ADVISOR_WORD_LIMIT_INSTRUCTION,
	buildAdvisorFocusMessage,
} from "./prompt.ts";

describe("advisor prompts", () => {
	it("describes a read-only consultation", () => {
		expect(ADVISOR_TOOL_DESCRIPTION).toContain("stronger read-only model");
		expect(ADVISOR_SYSTEM_PROMPT).toContain("cannot edit files");
	});

	it("builds a default or question-specific focus message", () => {
		expect(buildAdvisorFocusMessage()).toContain("most important next step");
		expect(buildAdvisorFocusMessage("  Check the parser  ")).toBe(
			`Check the parser\n\n${ADVISOR_WORD_LIMIT_INSTRUCTION}`,
		);
	});
});
