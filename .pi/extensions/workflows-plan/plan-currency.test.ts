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

	it("guard.run executes steps in order and resolves true when current throughout", async () => {
		const { currency } = createCurrency();
		const session = currency.begin(binding, ctxFor("session-a"));
		const guard = currency.guard(session);
		const order: string[] = [];

		const held = await guard.run(
			() => {
				order.push("one");
			},
			async () => {
				await Promise.resolve();
				order.push("two");
			},
			() => {
				order.push("three");
			},
		);

		expect(held).toBe(true);
		expect(order).toEqual(["one", "two", "three"]);
	});

	it("guard.run abandons at entry when the predicate is false before the first step", async () => {
		const { currency } = createCurrency();
		const session = currency.begin(binding, ctxFor("session-a"));
		const guard = currency.guard(session);
		const step = vi.fn();
		currency.advance(session);

		const held = await guard.run(step, step);

		expect(held).toBe(false);
		expect(step).not.toHaveBeenCalled();
	});

	it("guard.run abandons the remaining steps when the predicate flips mid-run", async () => {
		const { currency } = createCurrency();
		const session = currency.begin(binding, ctxFor("session-a"));
		const guard = currency.guard(session);
		const later = vi.fn();

		const held = await guard.run(
			() => {},
			() => {
				currency.advance(session);
			},
			later,
		);

		expect(held).toBe(false);
		expect(later).not.toHaveBeenCalled();
	});

	it("guard.run applies the trailing boundary: all steps ran but a late flip resolves false", async () => {
		const { currency } = createCurrency();
		const session = currency.begin(binding, ctxFor("session-a"));
		const guard = currency.guard(session);
		const final = vi.fn(() => {
			currency.advance(session);
		});

		const held = await guard.run(() => {}, final);

		expect(held).toBe(false);
		expect(final).toHaveBeenCalledTimes(1);
	});

	it("guard whileValid abandons live: a flip abandons and a flip back does not resurrect a finished run", async () => {
		const { currency } = createCurrency();
		const session = currency.begin(binding, ctxFor("session-a"));
		let planMode = false;
		const guard = currency.guard(session, () => planMode);
		const step = vi.fn();

		// Currency current but compound predicate false: abandoned at entry.
		await expect(guard.run(step)).resolves.toBe(false);
		expect(step).not.toHaveBeenCalled();

		// Compound predicate flips true mid-run: later boundaries re-evaluate.
		planMode = true;
		const abandoned: boolean[] = [];
		abandoned.push(await guard.run(
			() => {
				planMode = false;
			},
			step,
		));
		expect(abandoned[0]).toBe(false);
		expect(step).not.toHaveBeenCalled();

		// Flip back to true: a fresh run proceeds — the predicate is never latched.
		planMode = true;
		await expect(guard.run(step, step)).resolves.toBe(true);
		expect(step).toHaveBeenCalledTimes(2);
	});

	it("guard evaluates currency before whileValid", async () => {
		const { currency } = createCurrency();
		const session = currency.begin(binding, ctxFor("session-a"));
		const whileValid = vi.fn(() => true);
		const guard = currency.guard(session, whileValid);
		currency.advance(session);

		await expect(guard.run(() => {})).resolves.toBe(false);

		expect(whileValid).not.toHaveBeenCalled();
	});

	it("guard propagates a throwing step and later steps never run", async () => {
		const { currency } = createCurrency();
		const session = currency.begin(binding, ctxFor("session-a"));
		const guard = currency.guard(session);
		const failure = new Error("step failed");
		const later = vi.fn();

		await expect(guard.run(
			() => {
				throw failure;
			},
			later,
		)).rejects.toBe(failure);
		expect(later).not.toHaveBeenCalled();
		// The guard stays live after a caller-owned error boundary.
		expect(guard.isCurrent()).toBe(true);
	});

	it("guard treats sync void steps as boundaries", async () => {
		const { currency } = createCurrency();
		const session = currency.begin(binding, ctxFor("session-a"));
		const guard = currency.guard(session);
		const later = vi.fn();

		const held = await guard.run(
			() => {
				currency.advance(session);
			},
			later,
		);

		expect(held).toBe(false);
		expect(later).not.toHaveBeenCalled();
	});

	it("guard.isCurrent reflects the live predicate", () => {
		const { currency } = createCurrency();
		const session = currency.begin(binding, ctxFor("session-a"));
		const guard = currency.guard(session);

		expect(guard.isCurrent()).toBe(true);
		currency.advance(session);
		expect(guard.isCurrent()).toBe(false);
	});

	it("a guard bound to a stale session abandons at entry", async () => {
		const { currency } = createCurrency();
		const session = currency.begin(binding, ctxFor("session-a"));
		currency.advance(session);
		const guard = currency.guard(session);
		const step = vi.fn();

		await expect(guard.run(step)).resolves.toBe(false);
		expect(step).not.toHaveBeenCalled();
	});

	it("a run never mutates currency state", async () => {
		const { currency } = createCurrency();
		const session = currency.begin(binding, ctxFor("session-a"));
		const guard = currency.guard(session);

		await expect(guard.run(() => {}, async () => {})).resolves.toBe(true);
		expect(currency.isCurrent(session)).toBe(true);

		currency.advance(session);
		await expect(guard.run(() => {})).resolves.toBe(false);
		expect(currency.isCurrent(session)).toBe(false);
	});
});