import { beforeEach, describe, expect, it, vi } from "vitest";
import { getObservabilityService, resetObservabilityServiceForTests } from "./observability.ts";

const source = { channel: "main", invocationId: "main-1", displayLabel: "Main agent" } as const;

beforeEach(() => resetObservabilityServiceForTests());

describe("process-global observability service", () => {
	it("shares activation and events across callers and deactivates on unsubscribe", () => {
		const first = getObservabilityService();
		const second = getObservabilityService();
		const listener = vi.fn();
		expect(first.isActive()).toBe(false);
		const unsubscribe = first.activate(listener);
		expect(second.isActive()).toBe(true);
		second.publish({ type: "agent_start", source });
		expect(listener).toHaveBeenCalledWith({ type: "agent_start", source });
		unsubscribe();
		unsubscribe();
		expect(second.isActive()).toBe(false);
	});

	it("does not activate capture for passive subscribers and isolates listener failures", () => {
		const service = getObservabilityService();
		const healthy = vi.fn();
		service.subscribe(() => { throw new Error("observer failed"); });
		service.subscribe(healthy);
		expect(service.isActive()).toBe(false);
		expect(() => service.publish({ type: "agent_start", source })).not.toThrow();
		expect(healthy).toHaveBeenCalledOnce();
	});
});
