import { describe, expect, it } from "vitest";
import {
	ADVISOR_NUDGE_MESSAGE,
	ADVISOR_SYSTEM_PROMPT,
	ADVISOR_TOOL_DESCRIPTION,
	ADVISOR_WORD_LIMIT_INSTRUCTION,
	buildAdvisorFocusMessage,
} from "./prompt.ts";

describe("advisor prompts", () => {
	it("keeps advisor discovery and strict-mode guidance in advisor-owned text", () => {
		expect(ADVISOR_TOOL_DESCRIPTION).toContain("stronger read-only model");
		expect(ADVISOR_NUDGE_MESSAGE).toContain("call advisor now");
		expect(ADVISOR_SYSTEM_PROMPT).toContain("read-only engineering advisor");
	});

	it("builds a default or question-specific focus message with the word limit", () => {
		expect(buildAdvisorFocusMessage()).toContain("Review the current task");
		expect(buildAdvisorFocusMessage("  Check the parser  ")).toBe(
			`Check the parser\n\n${ADVISOR_WORD_LIMIT_INSTRUCTION}`,
		);
	});
});
