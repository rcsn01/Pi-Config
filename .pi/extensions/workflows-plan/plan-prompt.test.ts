import { describe, expect, it } from "vitest";
import {
	buildPlanModeRequestPrompt,
	buildPlanModeSystemPrompt,
	MODE_POLICY_PROMPT,
	modeChangeNote,
	PLAN_MODE_PROMPT,
} from "./plan-prompt.ts";

const snapshot = (mode: "default" | "plan", revision: number, phase?: "planning" | "awaiting_review") => ({
	mode,
	revision,
	changedAt: "2026-01-01T00:00:00.000Z",
	phase,
});

const RUNTIME_DEFAULT = '\n\n<runtime mode="default" revision="7"/>';
const RUNTIME_PLAN = '\n\n<runtime mode="plan" revision="8"/>';

const LEGACY_MODE_POLICY_PROMPT = `
<mode_policy>
The final runtime mode marker is authoritative.
A runtime mode of plan means follow Plan Mode behavior.
A runtime mode of default means Plan Mode is inactive.
When asked about the current mode, answer from the final runtime marker.
</mode_policy>`;

const LEGACY_DEFAULT_MODE_PROMPT = `
<default_mode>
Plan Mode is inactive for this turn. Normal execution is allowed.
Do not refuse work on the grounds that Plan Mode is active.
</default_mode>`;

describe("Plan Mode stable system prompt", () => {
	it("adds one policy block without depending on the runtime mode", () => {
		const defaultPrompt = buildPlanModeSystemPrompt("BASE");
		const planPrompt = buildPlanModeSystemPrompt("BASE");

		expect(defaultPrompt).toBe(`BASE${MODE_POLICY_PROMPT}`);
		expect(planPrompt).toBe(defaultPrompt);
		expect(defaultPrompt.match(/<plan_mode_policy>/g)).toHaveLength(1);
		expect(defaultPrompt).toContain("final request-local mode block");
	});

	it("removes current and legacy generated context before appending the policy", () => {
		const stale = [
			"BASE",
			MODE_POLICY_PROMPT,
			LEGACY_DEFAULT_MODE_PROMPT,
			PLAN_MODE_PROMPT,
			"\n\n<plan_mode_state>legacy</plan_mode_state>",
			"\n\n<plan_review_state>legacy review</plan_review_state>",
			"\n\n<mode_change_note>legacy note</mode_change_note>",
			'\n\n<runtime mode="plan" revision="3"/>',
		].join("");

		const result = buildPlanModeSystemPrompt(stale);

		expect(result).toBe(`BASE${MODE_POLICY_PROMPT}`);
		expect(result.match(/<plan_mode_policy>/g)).toHaveLength(1);
		expect(result).not.toContain("<default_mode>");
		expect(result).not.toContain("<collaboration_mode>");
		expect(result).not.toContain("<plan_mode_state>");
		expect(result).not.toContain("<plan_review_state>");
		expect(result).not.toContain("<mode_change_note>");
		expect(result).not.toContain("revision=\"3\"");
	});

	it("preserves unrelated mode_policy blocks", () => {
		const result = buildPlanModeSystemPrompt(
			"BASE\n\n<mode_policy>FOREIGN POLICY</mode_policy>",
		);

		expect(result).toContain("<mode_policy>FOREIGN POLICY</mode_policy>");
		expect(result).toContain(MODE_POLICY_PROMPT);
	});

	it("removes the legacy generated mode_policy block", () => {
		const result = buildPlanModeSystemPrompt(`BASE${LEGACY_MODE_POLICY_PROMPT}`);

		expect(result).not.toContain("<mode_policy>");
		expect(result).not.toContain("The final runtime mode marker is authoritative");
	});

	it("prefers live evidence over a stale marker", () => {
		const result = buildPlanModeSystemPrompt("BASE");

		expect(result).toContain("trust the live evidence and the user");
	});
});

describe("Plan Mode request prompt", () => {
	it("adds only the runtime marker in default mode", () => {
		const result = buildPlanModeRequestPrompt(snapshot("default", 7));

		expect(result).toBe(RUNTIME_DEFAULT);
		expect(result).not.toContain("<default_mode>");
		expect(result).not.toContain("<collaboration_mode>");
		expect(result.endsWith(RUNTIME_DEFAULT)).toBe(true);
	});

	it("adds collaboration instructions before the final runtime marker in Plan Mode", () => {
		const result = buildPlanModeRequestPrompt(snapshot("plan", 8, "planning"));

		expect(result).toBe(`${PLAN_MODE_PROMPT}${RUNTIME_PLAN}`);
		expect(result).toContain("implementation dossier");
		expect(result.indexOf("<collaboration_mode>")).toBeLessThan(result.indexOf("<runtime mode="));
		expect(result.endsWith(RUNTIME_PLAN)).toBe(true);
	});

	it("adds review guidance only for an awaiting-review Plan request", () => {
		const result = buildPlanModeRequestPrompt(snapshot("plan", 9, "awaiting_review"));

		expect(result).toContain("<plan_review_state>");
		expect(result).toContain("Only emit a new <proposed_plan> block");
		expect(result.indexOf("<collaboration_mode>")).toBeLessThan(result.indexOf("<plan_review_state>"));
		expect(result.indexOf("<plan_review_state>")).toBeLessThan(result.indexOf("<runtime mode="));
		expect(result.endsWith('<runtime mode="plan" revision="9"/>')).toBe(true);
	});

	it("places an entry note before Plan Mode collaboration instructions", () => {
		const result = buildPlanModeRequestPrompt(snapshot("plan", 5, "planning"), "entered");

		expect(result).toBe(`${modeChangeNote("entered")}${PLAN_MODE_PROMPT}\n\n<runtime mode="plan" revision="5"/>`);
		expect(result.indexOf("<mode_change_note>")).toBeLessThan(result.indexOf("<collaboration_mode>"));
	});

	it("places an exit note before the default runtime marker", () => {
		const result = buildPlanModeRequestPrompt(snapshot("default", 4), "exited");

		expect(result).toBe(`${modeChangeNote("exited")}\n\n<runtime mode="default" revision="4"/>`);
		expect(result.indexOf("<mode_change_note>")).toBeLessThan(result.indexOf("<runtime mode="));
	});

	it("emits no mode-change note when the mode is stable", () => {
		const result = buildPlanModeRequestPrompt(snapshot("default", 7));

		expect(result).not.toContain("<mode_change_note>");
	});
});
