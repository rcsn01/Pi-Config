import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ModelSelectionPersistence } from "../_shared/model-selection-persistence.ts";
import { DEFAULT_SENTINEL } from "../_shared/pi-defaults.ts";
import type { ModelSelectionSettings, StoredModelSelectionSettings } from "../_shared/model-selection.ts";
import { applyModelSelection } from "../_shared/model-selection.ts";
import { createPlanProfileTransition } from "./plan-profile-transition.ts";
import type { PlanSession } from "./plan-currency.ts";

vi.mock("../_shared/model-selection.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../_shared/model-selection.ts")>();
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

function createSession(): PlanSession {
	const persistence = {
		load: vi.fn(),
		save: vi.fn(async () => {}),
	} as unknown as ModelSelectionPersistence & { save: ReturnType<typeof vi.fn> };
	return {
		binding: { profileName: undefined, settingsPath: "/settings.json" },
		sessionId: "session-a",
		persistence,
		generation: 1,
	} as PlanSession;
}

function createHost() {
	const isCurrent = vi.fn(() => true);
	const preserveDefaults = vi.fn(async () => {});
	return { isCurrent, preserveDefaults };
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
		const session = createSession();

		const outcome = await transition.apply(ctx(), session, {
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
		const { transition } = createTransition();
		mockApplyProfile();
		const session = createSession();

		const outcome = await transition.apply(ctx(), session, {
			target: storedTarget,
			label: "Plan Mode profile",
			persist: { session },
		});

		expect(outcome.ok).toBe(true);
		expect(session.persistence.save).toHaveBeenCalledWith("plan", appliedProfile);
	});

	it("skips persistence when the stored profile defers to Pi's defaults", async () => {
		const { transition } = createTransition();
		mockApplyProfile();
		const session = createSession();

		const outcome = await transition.apply(ctx(), session, {
			target: { provider: DEFAULT_SENTINEL, modelId: "m", thinkingLevel: "medium" },
			label: "Plan Mode profile",
			persist: { session, unlessSentinel: { provider: DEFAULT_SENTINEL, modelId: "m", thinkingLevel: "medium" } },
		});

		expect(outcome.ok).toBe(true);
		expect(session.persistence.save).not.toHaveBeenCalled();
	});

	it("preserves the request's captured normal defaults", async () => {
		const { transition, host } = createTransition();
		mockApplyProfile();

		const outcome = await transition.apply(ctx(), createSession(), {
			target: storedTarget,
			label: "Plan Mode profile",
			defaults: normalProfile,
		});

		expect(outcome.ok).toBe(true);
		expect(host.preserveDefaults).toHaveBeenCalledWith(expect.anything(), normalProfile);
	});

	it("abandons silently when the session goes stale after the apply", async () => {
		const { transition, host } = createTransition();
		mockApplyProfile();
		const session = createSession();
		host.isCurrent.mockReturnValue(false);

		const outcome = await transition.apply(ctx(), session, {
			target: storedTarget,
			label: "Plan Mode profile",
			persist: { session },
			defaults: normalProfile,
		});

		expect(outcome).toEqual({ ok: true, profile: appliedProfile });
		expect(session.persistence.save).not.toHaveBeenCalled();
		expect(host.preserveDefaults).not.toHaveBeenCalled();
	});

	it("abandons the remaining effects when the session goes stale after persisting", async () => {
		const { transition, host } = createTransition();
		mockApplyProfile();
		const session = createSession();
		// current after apply, stale after persist
		host.isCurrent.mockReturnValueOnce(true).mockReturnValue(false);

		const outcome = await transition.apply(ctx(), session, {
			target: storedTarget,
			label: "Plan Mode profile",
			persist: { session },
			defaults: normalProfile,
		});

		expect(outcome).toEqual({ ok: true, profile: appliedProfile });
		expect(session.persistence.save).toHaveBeenCalledTimes(1);
		expect(host.preserveDefaults).not.toHaveBeenCalled();
	});

	it("abandons with a plain result when the session goes stale after preserving defaults", async () => {
		const { transition, host } = createTransition();
		mockApplyProfile();
		const session = createSession();
		host.isCurrent.mockReturnValue(true);

		const outcome = await transition.apply(ctx(), session, {
			target: storedTarget,
			label: "Plan Mode profile",
			persist: { session },
			defaults: normalProfile,
		});

		expect(outcome).toEqual({ ok: true, profile: appliedProfile });
		expect(host.preserveDefaults).toHaveBeenCalledTimes(1);
	});

	it("rolls back to the fallback when a later step fails and reports both errors as data", async () => {
		const { transition, host } = createTransition();
		const failure = new Error("preserve failed");
		vi.mocked(applyModelSelection).mockResolvedValueOnce(appliedProfile).mockResolvedValueOnce(normalProfile);
		const session = createSession();
		host.preserveDefaults.mockRejectedValueOnce(failure).mockResolvedValueOnce(undefined);

		const outcome = await transition.apply(ctx(), session, {
			target: storedTarget,
			label: "Plan Mode profile",
			persist: { session },
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
		const { transition } = createTransition();
		const failure = new Error("apply failed");
		vi.mocked(applyModelSelection).mockRejectedValue(failure);

		const outcome = await transition.apply(ctx(), createSession(), {
			target: storedTarget,
			label: "Plan Mode profile",
			rollback: { target: normalProfile, label: "Normal profile" },
		});

		expect(outcome).toEqual({ ok: false, error: failure, profile: undefined });
		expect(applyModelSelection).toHaveBeenCalledTimes(1);
	});

	it("reports the rollback failure without throwing", async () => {
		const { transition } = createTransition();
		const saveFailure = new Error("save failed");
		const rollbackFailure = new Error("rollback failed");
		vi.mocked(applyModelSelection).mockResolvedValueOnce(appliedProfile).mockRejectedValueOnce(rollbackFailure);
		const session = createSession();
		session.persistence.save = vi.fn(async () => {
			throw saveFailure;
		}) as unknown as ModelSelectionPersistence["save"];

		const outcome = await transition.apply(ctx(), session, {
			target: storedTarget,
			label: "Plan Mode profile",
			persist: { session },
			rollback: { target: normalProfile, label: "Normal profile" },
		});

		expect(outcome.ok).toBe(false);
		expect(outcome.error).toBe(saveFailure);
		expect(outcome.rollbackError).toBe(rollbackFailure);
		expect(outcome.profile).toBeUndefined();
	});

	it("reports the failure without attempting a rollback when none is supplied", async () => {
		const { transition } = createTransition();
		const failure = new Error("save failed");
		mockApplyProfile();
		const session = createSession();
		session.persistence.save = vi.fn(async () => {
			throw failure;
		}) as unknown as ModelSelectionPersistence["save"];

		const outcome = await transition.apply(ctx(), session, {
			target: storedTarget,
			label: "Plan Mode profile",
			persist: { session },
		});

		expect(outcome).toEqual({ ok: false, error: failure, profile: appliedProfile });
		expect(applyModelSelection).toHaveBeenCalledTimes(1);
	});

	it("skips the rollback when the session went stale before it could start", async () => {
		const { transition, host } = createTransition();
		const failure = new Error("save failed");
		mockApplyProfile();
		const session = createSession();
		session.persistence.save = vi.fn(async () => {
			throw failure;
		}) as unknown as ModelSelectionPersistence["save"];
		// current after apply, stale when the failure is handled
		host.isCurrent.mockReturnValueOnce(true).mockReturnValueOnce(false);

		const outcome = await transition.apply(ctx(), session, {
			target: storedTarget,
			label: "Plan Mode profile",
			persist: { session },
			rollback: { target: normalProfile, label: "Normal profile" },
		});

		expect(outcome.ok).toBe(false);
		expect(outcome.rollbackError).toBeUndefined();
		expect(outcome.profile).toBeUndefined();
		expect(applyModelSelection).toHaveBeenCalledTimes(1);
	});

	it("holds the Plan selection transition marker while a transition is in flight", async () => {
		const { transition } = createTransition();
		let release!: (value: ModelSelectionSettings) => void;
		vi.mocked(applyModelSelection).mockReturnValueOnce(
			new Promise((resolve) => {
				release = resolve;
			}),
		);

		const pending = transition.apply(ctx(), createSession(), {
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