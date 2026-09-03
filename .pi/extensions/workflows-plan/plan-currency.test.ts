import { describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ModelSelectionPersistence } from "../_shared/model-selection-persistence.ts";
import type { SessionProfileBinding } from "../_shared/session-profile-binding.ts";
import { createPlanCurrency } from "./plan-currency.ts";

const binding: SessionProfileBinding = {
	profileName: undefined,
	settingsPath: "/settings/profiles/a.json",
};

const persistence = {
	load: vi.fn(),
	save: vi.fn(),
} as unknown as ModelSelectionPersistence;

function ctxFor(sessionId: string): ExtensionContext {
	return { sessionManager: { getSessionId: () => sessionId } } as unknown as ExtensionContext;
}

function createCurrency() {
	const createPersistence = vi.fn(() => persistence);
	return { currency: createPlanCurrency({ createPersistence }), createPersistence };
}

describe("Plan session currency", () => {
	it("begin binds a fresh session, constructs persistence from the binding, and is current", () => {
		const { currency, createPersistence } = createCurrency();
		const ctx = ctxFor("session-a");

		const session = currency.begin(binding, ctx);

		expect(session).toMatchObject({ binding, sessionId: "session-a", generation: 1 });
		expect(createPersistence).toHaveBeenCalledWith("/settings/profiles/a.json");
		expect(currency.isCurrent(session)).toBe(true);
		expect(currency.resolve(ctx)).toBe(session);
	});

	it("resolve returns the session only while the ctx Session id matches", () => {
		const { currency } = createCurrency();
		const session = currency.begin(binding, ctxFor("session-a"));

		expect(currency.resolve(ctxFor("session-a"))).toBe(session);
		expect(currency.resolve(ctxFor("session-b"))).toBeUndefined();
	});

	it("require throws the uninitialized error when unresolved or never begun", () => {
		const { currency } = createCurrency();

		expect(() => currency.require(ctxFor("session-a")))
			.toThrow("Plan Mode lifecycle is not initialized for this Session.");

		const session = currency.begin(binding, ctxFor("session-a"));
		expect(() => currency.require(ctxFor("session-b")))
			.toThrow("Plan Mode lifecycle is not initialized for this Session.");
		expect(currency.require(ctxFor("session-a"))).toBe(session);
	});

	it("advance invalidates the prior identity and strictly increases the generation", () => {
		const { currency } = createCurrency();
		const session = currency.begin(binding, ctxFor("session-a"));

		const advanced = currency.advance(session);

		expect(advanced).toMatchObject({ binding, sessionId: "session-a" });
		expect(advanced.generation).toBeGreaterThan(session.generation);
		expect(currency.isCurrent(session)).toBe(false);
		expect(currency.isCurrent(advanced)).toBe(true);
		expect(currency.resolve(ctxFor("session-a"))).toBe(advanced);
	});

	it("end clears and invalidates only when the session is still current", () => {
		const { currency } = createCurrency();
		const session = currency.begin(binding, ctxFor("session-a"));

		expect(currency.end(session)).toBe(true);
		expect(currency.resolve(ctxFor("session-a"))).toBeUndefined();
		expect(currency.end(session)).toBe(false);

		const replaced = currency.advance(currency.begin(binding, ctxFor("session-a")));
		expect(currency.end(currency.resolve(ctxFor("session-a"))!)).toBe(true);
		expect(currency.end(replaced)).toBe(false);
	});

	it("snapshot isCurrent flips after advance and stays false after end", () => {
		const { currency } = createCurrency();
		const session = currency.begin(binding, ctxFor("session-a"));
		const snapshot = currency.snapshot();
		expect(snapshot.isCurrent()).toBe(true);

		currency.advance(session);
		expect(snapshot.isCurrent()).toBe(false);

		currency.end(currency.resolve(ctxFor("session-a"))!);
		expect(snapshot.isCurrent()).toBe(false);
	});
});