import { describe, expect, it, vi } from "vitest";
import type { ModelSelectionSettings } from "../_shared/model-selection.ts";
import {
	createAndActivateProfile,
	createProfileTransitionLifecycle,
	deleteActiveProfile,
	switchProfile,
	type ProfileTransitionLifecycleAdapter,
	type ProfileTransitionNotice,
} from "./profile-transition-lifecycle.ts";

const selection: ModelSelectionSettings = {
	provider: "ollama",
	modelId: "model",
	thinkingLevel: "high",
	contextWindow: 256_000,
};

function createHarness(options: {
	currentModelKey?: string;
	selection?: ModelSelectionSettings;
	applyError?: unknown;
	switchError?: unknown;
	createError?: unknown;
	deleteError?: unknown;
	publishError?: unknown;
	reloadError?: unknown;
} = {}) {
	const calls: string[] = [];
	const notices: ProfileTransitionNotice[] = [];
	const adapter: ProfileTransitionLifecycleAdapter = {
		switchProfile: vi.fn(async (name) => {
			calls.push(`switch:${name}`);
			if (options.switchError) throw options.switchError;
		}),
		createProfile: vi.fn(async (name, source) => {
			calls.push(`create:${name}:${source ?? ""}`);
			if (options.createError) throw options.createError;
		}),
		deleteProfile: vi.fn(async (name) => {
			calls.push(`delete:${name}`);
			if (options.deleteError) throw options.deleteError;
		}),
		readProfile: vi.fn((name) => {
			calls.push(`read:${name}`);
			return { name };
		}),
		publishSessionProfile: vi.fn((name) => {
			calls.push(`publish:${name}`);
			if (options.publishError) throw options.publishError;
		}),
		getCurrentModelKey: vi.fn(() => options.currentModelKey),
		applyProfileSelection: vi.fn(async () => {
			calls.push("apply-model");
			if (options.applyError) throw options.applyError;
			return Object.hasOwn(options, "selection") ? options.selection : selection;
		}),
		reportNotice: vi.fn((notice) => {
			calls.push(`notice:${notice.kind}`);
			notices.push(notice);
		}),
		reload: vi.fn(async () => {
			calls.push("reload");
			if (options.reloadError) throw options.reloadError;
		}),
	};
	return {
		adapter,
		calls,
		notices,
		lifecycle: createProfileTransitionLifecycle(adapter),
	};
}

describe("ProfileTransitionLifecycle", () => {
	it("switches, publishes, applies, reports, and reloads in order", async () => {
		const harness = createHarness();
		const request = switchProfile("focused");
		const outcome = await harness.lifecycle.transition(request);

		expect(harness.calls).toEqual([
			"switch:focused",
			"publish:focused",
			"read:focused",
			"apply-model",
			"notice:profile-model-applied",
			"notice:profile-switched",
			"reload",
		]);
		expect(outcome).toEqual({
			kind: "completed",
			request,
			activeProfile: "focused",
			modelApplication: { kind: "applied", selection },
		});
	});

	it("creates from the requested source before activation", async () => {
		const harness = createHarness();
		const request = createAndActivateProfile("copy", "focused");
		await harness.lifecycle.transition(request);
		expect(harness.calls.slice(0, 3)).toEqual([
			"create:copy:focused",
			"publish:copy",
			"read:copy",
		]);
		expect(harness.notices.at(-1)).toEqual({ kind: "profile-added", name: "copy" });
	});

	it("validates active deletion and fallback before publishing or deleting", async () => {
		const harness = createHarness();
		const request = deleteActiveProfile("focused");
		const outcome = await harness.lifecycle.transition(request);
		expect(harness.calls).toEqual([
			"read:focused",
			"read:default",
			"publish:default",
			"delete:focused",
			"read:default",
			"apply-model",
			"notice:profile-model-applied",
			"notice:active-profile-deleted",
			"reload",
		]);
		expect(outcome.activeProfile).toBe("default");
		expect(harness.notices.at(-1)).toEqual({
			kind: "active-profile-deleted",
			name: "focused",
			replacement: "default",
		});
		expect(harness.adapter.deleteProfile).toHaveBeenCalledWith("focused", { replaceMarker: true });
	});

	it("does not report a model change when the model identity is unchanged", async () => {
		const harness = createHarness({ currentModelKey: "ollama/model" });
		await harness.lifecycle.transition(switchProfile("focused"));
		expect(harness.notices).toEqual([{ kind: "profile-switched", name: "focused" }]);
	});

	it("treats a missing model selection as unchanged", async () => {
		const harness = createHarness({ selection: undefined });
		const outcome = await harness.lifecycle.transition(switchProfile("focused"));
		expect(outcome.modelApplication).toEqual({ kind: "unchanged" });
		expect(harness.notices).toEqual([{ kind: "profile-switched", name: "focused" }]);
	});

	it("reports model application failure but still completes and reloads", async () => {
		const failure = new Error("authentication failed");
		const harness = createHarness({ applyError: failure });
		const outcome = await harness.lifecycle.transition(switchProfile("focused"));
		expect(outcome.modelApplication).toEqual({ kind: "failed", cause: failure });
		expect(harness.calls.slice(-3)).toEqual([
			"notice:profile-model-apply-failed",
			"notice:profile-switched",
			"reload",
		]);
	});

	it.each([
		["store", { switchError: new Error("store failed") }],
		["Session entry", { publishError: new Error("entry failed") }],
	] as const)("stops after a %s failure", async (_label, options) => {
		const harness = createHarness(options);
		await expect(harness.lifecycle.transition(switchProfile("focused"))).rejects.toThrow();
		expect(harness.adapter.applyProfileSelection).not.toHaveBeenCalled();
		expect(harness.adapter.reload).not.toHaveBeenCalled();
	});

	it("does not reload when active deletion fails after fallback publication", async () => {
		const failure = new Error("unlink failed");
		const harness = createHarness({ deleteError: failure });
		await expect(harness.lifecycle.transition(deleteActiveProfile("focused"))).rejects.toBe(failure);
		expect(harness.calls).toEqual([
			"read:focused",
			"read:default",
			"publish:default",
			"delete:focused",
		]);
	});

	it("propagates reload failure after notices and committed mutation", async () => {
		const failure = new Error("reload failed");
		const harness = createHarness({ reloadError: failure });
		await expect(harness.lifecycle.transition(switchProfile("focused"))).rejects.toBe(failure);
		expect(harness.notices.at(-1)).toEqual({ kind: "profile-switched", name: "focused" });
	});
});
