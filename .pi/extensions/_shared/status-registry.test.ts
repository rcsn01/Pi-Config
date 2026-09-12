import { describe, expect, it } from "vitest";
import { createStatusRegistry, declareStatus, getStatusRegistry } from "./status-registry.ts";

describe("status registry", () => {
	it("returns declarations sorted by order and then id", () => {
		const registry = createStatusRegistry();
		registry.declare({ id: "zeta", style: "muted", order: 20 });
		registry.declare({ id: "alpha", style: "accent", order: 20 });
		registry.declare({ id: "first", style: "warning", order: 10 });

		expect(registry.declarations().map(({ id }) => id)).toEqual(["first", "alpha", "zeta"]);
	});

	it("keeps identical re-declarations as one entry", () => {
		const registry = createStatusRegistry();
		const declaration = { id: "status", style: "muted" as const, order: 10 };

		registry.declare(declaration);
		registry.declare(declaration);

		expect(registry.declarations()).toEqual([declaration]);
	});

	it("uses the last declaration when an id is re-declared", () => {
		const registry = createStatusRegistry();
		registry.declare({ id: "status", style: "muted", order: 10 });
		registry.declare({ id: "status", style: "accent", order: 30, placement: "right" });

		expect(registry.declarations()).toEqual([
			{ id: "status", style: "accent", order: 30, placement: "right" },
		]);
		expect(registry.style("status")).toBe("accent");
		expect(registry.order("status")).toBe(30);
		expect(registry.placement("status")).toBe("right");
	});

	it("falls back for undeclared ids", () => {
		const registry = createStatusRegistry();

		expect(registry.style("unknown")).toBe("muted");
		expect(registry.order("unknown")).toBe(Number.POSITIVE_INFINITY);
		expect(registry.placement("unknown")).toBe("left");
	});

	it("shares declarations through the default global registry", () => {
		const declaration = { id: "status-registry-test", style: "warning" as const, order: 100 };

		declareStatus(declaration);

		expect(getStatusRegistry().declarations()).toContainEqual(declaration);
	});
});
