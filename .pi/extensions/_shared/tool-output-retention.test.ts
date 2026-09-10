import { afterEach, describe, expect, it, vi } from "vitest";
import {
	clearToolOutputRetention,
	getToolOutputRetention,
	registerToolOutputRetention,
	type ToolOutputRetention,
} from "./tool-output-retention.ts";

function retention(): ToolOutputRetention {
	return {
		rewriteFresh: vi.fn((input) => ({
			changed: false,
			content: [...input.content],
			details: input.details,
		})),
		projectHistory: vi.fn((messages) => ({ changed: false, messages: [...messages] })),
		retrieve: vi.fn((hash) => ({ found: false as const, hash })),
	};
}

afterEach(() => {
	clearToolOutputRetention();
});

describe("tool-output retention registry", () => {
	it("is empty before registration and resolves the registered module", () => {
		expect(getToolOutputRetention()).toBeUndefined();
		const registered = retention();
		registerToolOutputRetention(registered);
		expect(getToolOutputRetention()).toBe(registered);
	});

	it("unregisters only the exact module it registered", () => {
		const first = retention();
		const unregisterFirst = registerToolOutputRetention(first);
		unregisterFirst();
		expect(getToolOutputRetention()).toBeUndefined();

		const stale = retention();
		const unregisterStale = registerToolOutputRetention(stale);
		const replacement = retention();
		registerToolOutputRetention(replacement);
		unregisterStale();
		expect(getToolOutputRetention()).toBe(replacement);
	});

	it("lets a later registration replace the prior module", () => {
		const first = retention();
		const replacement = retention();
		registerToolOutputRetention(first);
		registerToolOutputRetention(replacement);
		expect(getToolOutputRetention()).toBe(replacement);
	});

	it("clear resets global state", () => {
		registerToolOutputRetention(retention());
		clearToolOutputRetention();
		expect(getToolOutputRetention()).toBeUndefined();
	});

	it("shares registration across module re-imports", async () => {
		const registered = retention();
		registerToolOutputRetention(registered);
		vi.resetModules();
		const reimported = await import("./tool-output-retention.ts");
		expect(reimported.getToolOutputRetention()).toBe(registered);
	});
});
