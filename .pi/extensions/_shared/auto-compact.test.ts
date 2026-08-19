import { describe, expect, it } from "vitest";
import {
	COMPACT_RESERVE_FRACTION,
	COMPACT_THRESHOLD,
} from "./auto-compact.ts";

describe("auto-compact config", () => {
	it("keeps the threshold and reserve fraction consistent", () => {
		expect(COMPACT_THRESHOLD).toBeGreaterThan(0);
		expect(COMPACT_THRESHOLD).toBeLessThan(1);
		expect(COMPACT_RESERVE_FRACTION).toBe(1 - COMPACT_THRESHOLD);
	});
});
