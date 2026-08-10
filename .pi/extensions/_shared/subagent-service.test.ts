import { afterEach, describe, expect, it, vi } from "vitest";
import {
	clearSubagentService,
	getSubagentService,
	registerSubagentService,
	requireSubagentService,
	type SubagentService,
} from "./subagent-service.ts";

function service(id = "tools-subagents"): SubagentService {
	return {
		id,
		registerAgent: vi.fn(),
		unregisterAgent: vi.fn(),
		loadAgents: vi.fn(() => []),
		runSubagent: vi.fn(),
		runSubagentsParallel: vi.fn(),
	};
}

afterEach(clearSubagentService);

describe("subagent service registry", () => {
	it("registers, resolves, and disposes one typed service", () => {
		const registered = service();
		const dispose = registerSubagentService(registered);
		expect(getSubagentService()).toBe(registered);
		expect(requireSubagentService()).toBe(registered);
		dispose();
		expect(getSubagentService()).toBeUndefined();
		expect(requireSubagentService).toThrow(/Enable and reload/);
	});

	it("allows same-owner replacement for reload and protects the replacement from stale disposal", () => {
		const first = service();
		const disposeFirst = registerSubagentService(first);
		const replacement = service();
		registerSubagentService(replacement);
		disposeFirst();
		expect(getSubagentService()).toBe(replacement);
	});

	it("rejects a competing runner", () => {
		registerSubagentService(service());
		expect(() => registerSubagentService(service("other-runner"))).toThrow(/already registered/);
	});
});