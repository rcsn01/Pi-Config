import { describe, expect, it } from "vitest";
import {
	buildPlanModeSystemPrompt,
	DEFAULT_MODE_PROMPT,
	MODE_POLICY_PROMPT,
	PLAN_MODE_PROMPT,
} from "./plan-prompt.ts";

const snapshot = (mode: "default" | "plan", revision: number, phase?: "planning" | "awaiting_review") => ({
	mode,
	revision,
	changedAt: "2026-01-01T00:00:00.000Z",
	phase,
});

const LEGACY_MODE_POLICY_PROMPT = `
<mode_policy>
The final runtime mode marker is authoritative.
A runtime mode of plan means follow Plan Mode behavior.
A runtime mode of default means Plan Mode is inactive.
When asked about the current mode, answer from the final runtime marker.
</mode_policy>`;

describe("Plan Mode prompt", () => {
	it("builds explicit inactive context with one exact authoritative marker", () => {
		const result = buildPlanModeSystemPrompt("BASE", snapshot("default", 7));
		expect(result).toBe(
			`BASE${MODE_POLICY_PROMPT}${DEFAULT_MODE_PROMPT}\n\n<runtime mode="default" revision="7"/>`,
		);
		expect(result).toContain("Plan Mode is inactive for this turn");
		expect(result).toContain("Normal execution is allowed");
		expect(result).toContain("Do not refuse work on the grounds that Plan Mode is active");
		expect(result).not.toContain("You are in **Plan Mode**");
	});

	it("builds active planning context with collaboration instructions", () => {
		const result = buildPlanModeSystemPrompt("BASE", snapshot("plan", 8, "planning"));
		expect(result).toBe(
			`BASE${MODE_POLICY_PROMPT}${PLAN_MODE_PROMPT}\n\n<runtime mode="plan" revision="8"/>`,
		);
		expect(result.match(/<runtime mode=/g)).toHaveLength(1);
	});

	it("adds review guidance only while awaiting review", () => {
		const result = buildPlanModeSystemPrompt("BASE", snapshot("plan", 9, "awaiting_review"));
		expect(result).toContain("<plan_review_state>");
		expect(result).toContain("Only emit a new <proposed_plan> block");
		expect(result.endsWith('<runtime mode="plan" revision="9"/>')).toBe(true);
	});

	it("removes current and legacy generated context before appending one final marker", () => {
		const stale = `BASE${MODE_POLICY_PROMPT}${DEFAULT_MODE_PROMPT}${PLAN_MODE_PROMPT}\n\n<plan_mode_state>legacy</plan_mode_state>\n\n<runtime mode="plan" revision="3"/>`;
		const result = buildPlanModeSystemPrompt(stale, snapshot("default", 4));
		expect(result.match(/<plan_mode_policy>/g)).toHaveLength(1);
		expect(result.match(/<runtime mode=/g)).toHaveLength(1);
		expect(result).not.toContain("<plan_mode_state>");
		expect(result).not.toContain("revision=\"3\"");
	});

	it("preserves unrelated mode_policy blocks", () => {
		const result = buildPlanModeSystemPrompt(
			"BASE\n\n<mode_policy>FOREIGN POLICY</mode_policy>",
			snapshot("default", 7),
		);
		expect(result).toContain("<mode_policy>FOREIGN POLICY</mode_policy>");
	});

	it("removes the legacy generated mode_policy block", () => {
		const result = buildPlanModeSystemPrompt(`BASE${LEGACY_MODE_POLICY_PROMPT}`, snapshot("default", 7));
		expect(result).not.toContain("<mode_policy>");
		expect(result).not.toContain("The final runtime mode marker is authoritative");
	});

	it("prefers live evidence over a stale marker", () => {
		const result = buildPlanModeSystemPrompt("BASE", snapshot("default", 7));
		expect(result).toContain("The runtime mode marker reflects the mode at the start of this turn");
		expect(result).toContain("trust the live evidence and the user");
	});

	it("emits no mode-change note by default", () => {
		const result = buildPlanModeSystemPrompt("BASE", snapshot("default", 7));
		expect(result).not.toContain("<mode_change_note>");
	});

	it("emits a mode-change note when Plan Mode was exited since the previous turn", () => {
		const result = buildPlanModeSystemPrompt("BASE", snapshot("default", 4), "exited");
		expect(result).toContain(
			"\n\n<mode_change_note>Plan Mode was exited since the previous turn.</mode_change_note>",
		);
		expect(result.indexOf("<mode_change_note>")).toBeLessThan(result.indexOf(DEFAULT_MODE_PROMPT));
		expect(result).not.toContain("You are in **Plan Mode**");
	});

	it("emits a mode-change note when Plan Mode was entered since the previous turn", () => {
		const result = buildPlanModeSystemPrompt("BASE", snapshot("plan", 5, "planning"), "entered");
		expect(result).toContain(
			"\n\n<mode_change_note>Plan Mode was entered since the previous turn.</mode_change_note>",
		);
		expect(result.indexOf("<mode_change_note>")).toBeLessThan(result.indexOf(PLAN_MODE_PROMPT));
	});

	it("strips stale mode-change notes before rebuilding", () => {
		const stale = `BASE${MODE_POLICY_PROMPT}\n\n<mode_change_note>Plan Mode was exited since the previous turn.</mode_change_note>\n\n<runtime mode="plan" revision="3"/>`;
		const result = buildPlanModeSystemPrompt(stale, snapshot("default", 4));
		expect(result).not.toContain("<mode_change_note>");
		expect(result.match(/<runtime mode=/g)).toHaveLength(1);
	});
});
