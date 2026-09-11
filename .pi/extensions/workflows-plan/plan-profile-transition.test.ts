import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ModelSelectionPersistence } from "../_shared/model-selection-persistence.ts";
import { DEFAULT_SENTINEL } from "../_shared/pi-defaults.ts";
import type { ModelSelectionSettings, StoredModelSelectionSettings } from "../_shared/model-selection.ts";
import { applyModelSelection } from "../_shared/model-selection-runtime.ts";
import { createPlanProfileTransition } from "./plan-profile-transition.ts";
import { createPlanCurrency, type PlanSession } from "./plan-currency.ts";

vi.mock("../_shared/model-selection-runtime.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../_shared/model-selection-runtime.ts")>();
	return { ...actual, applyModelSelection: vi.fn() };
});

const planProfile: ModelSelectionSettings = {
	provider: "anthropic",
	modelId: "claude-opus",
	thinkingLevel: "high",
	contextWindow: 200_000,
};

const normalProfile: ModelSelectionSettings = {
	provider: "anthropic",
	modelId: "claude-sonnet",
	thinkingLevel: "medium",
	contextWindow: 128_000,
};

const appliedProfile = { ...planProfile };

function ctx(): ExtensionContext {
	return {} as ExtensionContext;
}

function ctxFor(sessionId: string): ExtensionContext {
	return { sessionManager: { getSessionId: () => sessionId } } as unknown as ExtensionContext;
}

const hostBinding = { profileName: undefined, settingsPath: "/settings.json" };

/** A host whose guard wraps a real Plan session currency; staleness is
 *  scripted by advancing the currency. */
function createHost() {
	const persistence = {
		load: vi.fn(),
		save: vi.fn(async () => {}),
	} as unknown as ModelSelectionPersistence & { save: ReturnType<typeof vi.fn> };
	const currency = createPlanCurrency({ createPersistence: () => persistence });
	const session = currency.begin(hostBinding, ctxFor("session-a"));
	const goStale = () => {
		currency.advance(session);
	};
	const preserveDefaults = vi.fn(async () => {});
	return { persistence, currency, session, goStale, preserveDefaults, createGuard: (s: PlanSession) => currency.guard(s) };
}

function createTransition(host = createHost()) {
	const pi = {} as ExtensionAPI;
	const transition = createPlanProfileTransition(pi, host, { nativeDefaults: undefined });
	return { transition, host, pi };
}

const storedTarget: StoredModelSelectionSettings = { ...planProfile };

beforeEach(() => {
	vi.mocked(applyModelSelection).mockReset();
});

function mockApplyProfile(profile: ModelSelectionSettings = appliedProfile) {
	return vi.mocked(applyModelSelection).mockResolvedValue(profile);
}

describe("Plan profile transition", () => {
	it("applies the target through Pi with the request label and reports it as data", async () => {
		const { transition, host, pi } = createTransition();
		mockApplyProfile();

		const outcome = await transition.apply(ctx(), host.session, {
			target: storedTarget,
			label: "Plan Mode profile",
		});

		expect(outcome).toEqual({ ok: true, profile: appliedProfile });
		expect(applyModelSelection).toHaveBeenCalledWith(pi, expect.anything(), storedTarget, {
			label: "Plan Mode profile",
			nativeDefaults: undefined,
		});
		expect(host.preserveDefaults).toHaveBeenCalledWith(expect.anything(), undefined);
	});

	it("persists the applied profile to the Session's Plan-mode persistence", async () => {
		const { transition, host } = createTransition();
		mockApplyProfile();

		const outcome = await transition.apply(ctx(), host.session, {
			target: storedTarget,
			label: "Plan Mode profile",
			persist: { session: host.session },
		});

		expect(outcome.ok).toBe(true);
		expect(host.persistence.save).toHaveBeenCalledWith("plan", appliedProfile);
	});

	it("skips persistence when the stored profile defers to Pi's defaults", async () => {
		const { transition, host } = createTransition();
		mockApplyProfile();

		const outcome = await transition.apply(ctx(), host.session, {
			target: { provider: DEFAULT_SENTINEL, modelId: "m", thinkingLevel: "medium" },
			label: "Plan Mode profile",
			persist: { session: host.session, unlessSentinel: { provider: DEFAULT_SENTINEL, modelId: "m", thinkingLevel: "medium" } },
		});

		expect(outcome.ok).toBe(true);
		expect(host.persistence.save).not.toHaveBeenCalled();
	});

	it("preserves the request's captured normal defaults", async () => {
		const { transition, host } = createTransition();
		mockApplyProfile();

		const outcome = await transition.apply(ctx(), host.session, {
			target: storedTarget,
			label: "Plan Mode profile",
			defaults: normalProfile,
		});

		expect(outcome.ok).toBe(true);
		expect(host.preserveDefaults).toHaveBeenCalledWith(expect.anything(), normalProfile);
	});

	it("abandons silently when the session goes stale after the apply", async () => {
		const { transition, host } = createTransition();
		vi.mocked(applyModelSelection).mockImplementationOnce(async () => {
			host.goStale();
			return appliedProfile;
		});

		const outcome = await transition.apply(ctx(), host.session, {
			target: storedTarget,
			label: "Plan Mode profile",
			persist: { session: host.session },
			defaults: normalProfile,
		});

		expect(outcome).toEqual({ ok: true, profile: appliedProfile });
		expect(host.persistence.save).not.toHaveBeenCalled();
		expect(host.preserveDefaults).not.toHaveBeenCalled();
	});

	it("abandons the remaining effects when the session goes stale after persisting", async () => {
		const { transition, host } = createTransition();
		mockApplyProfile();
		host.persistence.save.mockImplementationOnce(async () => {
			host.goStale();
		});

		const outcome = await transition.apply(ctx(), host.session, {
			target: storedTarget,
			label: "Plan Mode profile",
			persist: { session: host.session },
			defaults: normalProfile,
		});

		expect(outcome).toEqual({ ok: true, profile: appliedProfile });
		expect(host.persistence.save).toHaveBeenCalledTimes(1);
		expect(host.preserveDefaults).not.toHaveBeenCalled();
	});

	it("abandons with a plain result when the session goes stale after preserving defaults", async () => {
		const { transition, host } = createTransition();
		mockApplyProfile();
		host.preserveDefaults.mockImplementationOnce(async () => {
			host.goStale();
		});

		const outcome = await transition.apply(ctx(), host.session, {
			target: storedTarget,
			label: "Plan Mode profile",
			persist: { session: host.session },
			defaults: normalProfile,
		});

		expect(outcome).toEqual({ ok: true, profile: appliedProfile });
		expect(host.preserveDefaults).toHaveBeenCalledTimes(1);
	});

	it("rolls back to the fallback when a later step fails and reports both errors as data", async () => {
		const { transition, host } = createTransition();
		const failure = new Error("preserve failed");
		vi.mocked(applyModelSelection).mockResolvedValueOnce(appliedProfile).mockResolvedValueOnce(normalProfile);
		host.preserveDefaults.mockRejectedValueOnce(failure).mockResolvedValueOnce(undefined);

		const outcome = await transition.apply(ctx(), host.session, {
			target: storedTarget,
			label: "Plan Mode profile",
			persist: { session: host.session },
			defaults: normalProfile,
			rollback: { target: normalProfile, label: "Normal profile", defaults: normalProfile },
		});

		expect(outcome.ok).toBe(false);
		expect(outcome.error).toBe(failure);
		expect(outcome.rollbackError).toBeUndefined();
		expect(outcome.profile).toEqual(normalProfile);
		expect(applyModelSelection).toHaveBeenCalledTimes(2);
		expect(applyModelSelection).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), normalProfile, {
			label: "Normal profile",
			nativeDefaults: undefined,
		});
		expect(host.preserveDefaults).toHaveBeenCalledTimes(2);
		expect(host.preserveDefaults).toHaveBeenNthCalledWith(1, expect.anything(), normalProfile);
		expect(host.preserveDefaults).toHaveBeenNthCalledWith(2, expect.anything(), normalProfile);
	});

	it("does not roll back when the apply itself failed", async () => {
		const { transition, host } = createTransition();
		const failure = new Error("apply failed");
		vi.mocked(applyModelSelection).mockRejectedValue(failure);

		const outcome = await transition.apply(ctx(), host.session, {
			target: storedTarget,
			label: "Plan Mode profile",
			rollback: { target: normalProfile, label: "Normal profile" },
		});

		expect(outcome).toEqual({ ok: false, error: failure, profile: undefined });
		expect(applyModelSelection).toHaveBeenCalledTimes(1);
	});

	it("reports the rollback failure without throwing", async () => {
		const { transition, host } = createTransition();
		const saveFailure = new Error("save failed");
		const rollbackFailure = new Error("rollback failed");
		vi.mocked(applyModelSelection).mockResolvedValueOnce(appliedProfile).mockRejectedValueOnce(rollbackFailure);
		host.persistence.save.mockImplementationOnce(async () => {
			throw saveFailure;
		});

		const outcome = await transition.apply(ctx(), host.session, {
			target: storedTarget,
			label: "Plan Mode profile",
			persist: { session: host.session },
			rollback: { target: normalProfile, label: "Normal profile" },
		});

		expect(outcome.ok).toBe(false);
		expect(outcome.error).toBe(saveFailure);
		expect(outcome.rollbackError).toBe(rollbackFailure);
		expect(outcome.profile).toBeUndefined();
	});

	it("reports the failure without attempting a rollback when none is supplied", async () => {
		const { transition, host } = createTransition();
		const failure = new Error("save failed");
		mockApplyProfile();
		host.persistence.save.mockImplementationOnce(async () => {
			throw failure;
		});

		const outcome = await transition.apply(ctx(), host.session, {
			target: storedTarget,
			label: "Plan Mode profile",
			persist: { session: host.session },
		});

		expect(outcome).toEqual({ ok: false, error: failure, profile: appliedProfile });
		expect(applyModelSelection).toHaveBeenCalledTimes(1);
	});

	it("skips the rollback when the session went stale before it could start", async () => {
		const { transition, host } = createTransition();
		const failure = new Error("save failed");
		mockApplyProfile();
		host.persistence.save.mockImplementationOnce(async () => {
			host.goStale();
			throw failure;
		});

		const outcome = await transition.apply(ctx(), host.session, {
			target: storedTarget,
			label: "Plan Mode profile",
			persist: { session: host.session },
			rollback: { target: normalProfile, label: "Normal profile" },
		});

		expect(outcome.ok).toBe(false);
		expect(outcome.rollbackError).toBeUndefined();
		expect(outcome.profile).toBeUndefined();
		expect(applyModelSelection).toHaveBeenCalledTimes(1);
	});

	it("holds the Plan selection transition marker while a transition is in flight", async () => {
		const { transition, host } = createTransition();
		let release!: (value: ModelSelectionSettings) => void;
		vi.mocked(applyModelSelection).mockReturnValueOnce(
			new Promise((resolve) => {
				release = resolve;
			}),
		);

		const pending = transition.apply(ctx(), host.session, {
			target: storedTarget,
			label: "Plan Mode profile",
		});
		expect(transition.inTransition()).toBe(true);
		release(appliedProfile);
		const outcome = await pending;

		expect(outcome.ok).toBe(true);
		expect(transition.inTransition()).toBe(false);
	});

	it("reports the marker as clear before and after transitions", () => {
		const { transition } = createTransition();
		expect(transition.inTransition()).toBe(false);
	});
});