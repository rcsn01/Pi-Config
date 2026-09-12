import { describe, expect, it } from "vitest";
import {
	buildModeChangeMessage,
	modeChangeMarker,
	PLAN_MODE_PROMPT,
} from "./plan-prompt.ts";

describe("Plan Mode change messages", () => {
	it("uses the requested internal marker for default mode", () => {
		expect(modeChangeMarker("default")).toBe(
			"This is an internal marker, user has changed to default mode",
		);
		expect(buildModeChangeMessage("default")).toBe(modeChangeMarker("default"));
	});

	it("combines the plan marker with collaboration instructions", () => {
		const result = buildModeChangeMessage("plan");

		expect(result).toBe(`${modeChangeMarker("plan")}${PLAN_MODE_PROMPT}`);
		expect(result.startsWith("This is an internal marker, user has changed to plan mode")).toBe(true);
		expect(result).toContain("implementation dossier");
		expect(result).toContain("track exploration, clarification, and plan preparation");
		expect(result).toContain("Clear planning todos before presenting the final plan");
		expect(result).not.toContain("Do not use todo/update_plan-style tools");
		expect(result).not.toContain("<runtime mode=");
		expect(result).not.toContain("revision=");
	});
});
