import { describe, expect, it } from "vitest";
import {
	buildPlanModeRequestPrompt,
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
