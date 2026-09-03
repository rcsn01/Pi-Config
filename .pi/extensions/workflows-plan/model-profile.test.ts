import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
	createNormalDefaultsStore,
	type StoredModelSelectionSettings,
} from "./model-profile.ts";
import {
	createHarness,
	createProfileDependencies,
	deferred,
	initializeAndExtract,
	normalModel,
	planModel,
	profileFor,
} from "./test-harness.ts";

describe("Plan Mode model and thinking profiles", () => {
	it("skips model refresh and selection when only the thinking level changes", async () => {
		const stores = createProfileDependencies(profileFor(normalModel, "xhigh"));
		const harness = createHarness({
			branch: [], model: normalModel, thinkingLevel: "medium",
			availableModels: [normalModel], dependencies: stores.dependencies,
		});
		await harness.emit("session_start", { type: "session_start", reason: "startup" });
		await harness.commands.get("plan").handler("", harness.ctx);

		expect((harness.ctx as any).modelRegistry.refresh).not.toHaveBeenCalled();
		expect(harness.setModel).not.toHaveBeenCalled();
		expect(harness.setThinkingLevel).toHaveBeenCalledWith("xhigh");
	});

	it("ignores thinking feedback during stored Profile entry, then persists a user change", async () => {
		const stores = createProfileDependencies(profileFor(planModel, "high"));
		const harness = createHarness({
			branch: [], model: normalModel, thinkingLevel: "medium",
			availableModels: [normalModel, planModel], dependencies: stores.dependencies,
			emitThinkingLevelFeedback: true,
		});
		await harness.emit("session_start", { type: "session_start", reason: "startup" });
		stores.save.mockClear();

		await harness.commands.get("plan").handler("", harness.ctx);
		await harness.drainSelectionFeedback();
		expect(stores.save).toHaveBeenCalledOnce();
		expect(stores.save).toHaveBeenLastCalledWith("plan", profileFor(planModel, "high"));

		harness.setThinkingLevel("xhigh");
		await harness.drainSelectionFeedback();
		expect(stores.save).toHaveBeenCalledTimes(2);
		expect(stores.save).toHaveBeenLastCalledWith("plan", profileFor(planModel, "xhigh"));
	});

	it("ignores thinking feedback during normal Profile restoration on exit", async () => {
		const stores = createProfileDependencies(profileFor(planModel, "high"));
		const branch = [{
			type: "custom",
			customType: "plan-mode-state",
			data: {
				active: true,
				phase: "planning",
				setAt: 1,
				normalProfile: profileFor(normalModel, "medium"),
			},
		}];
		const harness = createHarness({
			branch, model: planModel, thinkingLevel: "high",
			availableModels: [normalModel, planModel], dependencies: stores.dependencies,
			emitThinkingLevelFeedback: true,
		});
		await harness.emit("session_start", { type: "session_start", reason: "resume" });
		stores.save.mockClear();

		await harness.commands.get("plan").handler("exit", harness.ctx);
		await harness.drainSelectionFeedback();

		expect(stores.save).not.toHaveBeenCalled();
	});

	it("preserves model and thinking observation order while the first save is pending", async () => {
		const pendingSave = deferred<void>();
		const stores = createProfileDependencies(profileFor(planModel, "high"));
		const harness = createHarness({
			model: planModel, thinkingLevel: "high",
			availableModels: [normalModel, planModel], dependencies: stores.dependencies,
		});
		await harness.emit("session_start", { type: "session_start", reason: "resume" });
		stores.save.mockClear();
		stores.save.mockImplementationOnce(() => pendingSave.promise);

		harness.setCurrentModel(normalModel);
		const modelChange = harness.emit("model_select", {
			type: "model_select", model: normalModel, previousModel: planModel, source: "cycle",
		});
		await vi.waitFor(() => expect(stores.save).toHaveBeenCalledOnce());
		expect(stores.save).toHaveBeenNthCalledWith(1, "plan", profileFor(normalModel, "high"));

		harness.setCurrentThinkingLevel("xhigh");
		const thinkingChange = harness.emit("thinking_level_select", {
			type: "thinking_level_select", level: "xhigh", previousLevel: "high",
		});
		await Promise.resolve();
		expect(stores.save).toHaveBeenCalledOnce();

		pendingSave.resolve();
		await Promise.all([modelChange, thinkingChange]);
		expect(stores.save).toHaveBeenCalledTimes(2);
		expect(stores.save).toHaveBeenNthCalledWith(2, "plan", profileFor(normalModel, "xhigh"));
		expect(stores.getStored()).toEqual(profileFor(normalModel, "xhigh"));
	});

	it("reuses the current model definition when only its context changes", async () => {
		const contextProfile = { ...profileFor(normalModel, "medium"), contextWindow: 500_000 };
		const stores = createProfileDependencies(contextProfile);
		const harness = createHarness({
			branch: [], model: normalModel, thinkingLevel: "medium",
			availableModels: [normalModel], dependencies: stores.dependencies,
		});
		await harness.emit("session_start", { type: "session_start", reason: "startup" });
		await harness.commands.get("plan").handler("", harness.ctx);

		expect((harness.ctx as any).modelRegistry.refresh).not.toHaveBeenCalled();
		expect(harness.setModel).toHaveBeenCalledWith(expect.objectContaining({
			provider: normalModel.provider,
			id: normalModel.id,
			contextWindow: 500_000,
		}));
	});

	it("initializes the first profile from the current session", async () => {
		const stores = createProfileDependencies();
		const harness = createHarness({
			branch: [], model: normalModel, thinkingLevel: "medium",
			availableModels: [normalModel, planModel], dependencies: stores.dependencies,
		});
		await harness.emit("session_start", { type: "session_start", reason: "startup" });
		await harness.commands.get("plan").handler("", harness.ctx);

		expect(stores.load).toHaveBeenCalledWith("plan");
		expect(stores.save).toHaveBeenCalledWith("plan", profileFor(normalModel, "medium"));
		expect(harness.setModel).not.toHaveBeenCalled();
		expect(harness.appendedEntries.at(-1)?.data).toMatchObject({
			mode: "plan",
			revision: 1,
			normalProfile: profileFor(normalModel, "medium"),
		});
	});

	it("restores the saved Plan profile on entry and the conversation profile on exit", async () => {
		const stores = createProfileDependencies(profileFor(planModel, "high"));
		const harness = createHarness({
			branch: [], model: normalModel, thinkingLevel: "medium",
			availableModels: [normalModel, planModel], dependencies: stores.dependencies,
		});
		await harness.emit("session_start", { type: "session_start", reason: "startup" });
		await harness.commands.get("plan").handler("", harness.ctx);

		expect(harness.timeline).toEqual(expect.arrayContaining([
			"setModel:github-copilot/gpt-5.6-sol",
			"setThinking:high",
		]));
		expect(stores.restore).toHaveBeenCalledWith("/test/project", profileFor(normalModel, "medium"));
		expect(harness.notify).toHaveBeenLastCalledWith(
			"📋 Plan mode active: github-copilot/gpt-5.6-sol · high · 1,050,000 ctx",
			"info",
		);

		await harness.commands.get("plan").handler("exit", harness.ctx);
		expect(harness.timeline.slice(-3)).toEqual([
			"setModel:anthropic/claude-sonnet-4.6",
			"setThinking:medium",
			"setActiveTools:read,bash,edit,write,grep,find,ls",
		]);
		expect(harness.appendedEntries.at(-1)?.data).toMatchObject({ mode: "default", revision: 2 });
		expect(harness.appendedEntries.at(-1)?.data.normalProfile).toBeUndefined();
	});

	it("applies native defaults without rewriting a sentinel Plan profile", async () => {
		const nativeModel = {
			provider: "openai-codex",
			id: "gpt-5.6-luna",
			name: "GPT 5.6 Luna",
			contextWindow: 900_000,
			reasoning: true,
		};
		const stored: StoredModelSelectionSettings = {
			provider: "default",
			modelId: "default",
			thinkingLevel: "default",
			contextWindow: "default",
		};
		const profileStore = {
			load: vi.fn(async (mode: "normal" | "plan") => {
				if (mode !== "plan") throw new Error(`Unexpected model-selection mode: ${mode}`);
				return stored;
			}),
			save: vi.fn(),
		};
		const harness = createHarness({
			branch: [],
			model: normalModel,
			thinkingLevel: "medium",
			availableModels: [normalModel, nativeModel],
			dependencies: {
				createModelSelectionPersistence: () => profileStore,
				nativeDefaults: { provider: nativeModel.provider, modelId: nativeModel.id, thinkingLevel: "max" },
				normalDefaultsStore: {
					capture: vi.fn(async (_cwd, fallback) => fallback),
					restore: vi.fn(async () => {}),
				},
				waitForNativePersistence: async () => {},
			},
		});

		await harness.emit("session_start", { type: "session_start", reason: "startup" });
		await harness.commands.get("plan").handler("", harness.ctx);

		expect(harness.setModel).toHaveBeenCalledWith(expect.objectContaining({
			provider: nativeModel.provider,
			id: nativeModel.id,
			contextWindow: nativeModel.contextWindow,
		}));
		expect(harness.setThinkingLevel).toHaveBeenCalledWith("max");
		expect(profileStore.save).not.toHaveBeenCalled();
	});

	it("restores normal before sending an implementation prompt", async () => {
		const stores = createProfileDependencies(profileFor(planModel, "high"));
		const branch = [{
			type: "custom",
			customType: "plan-mode-state",
			data: {
				active: true,
				phase: "planning",
				setAt: 1,
				normalProfile: profileFor(normalModel, "medium"),
			},
		}];
		const harness = createHarness({
			branch, model: planModel, thinkingLevel: "high",
			selection: "Implement in current session",
			availableModels: [normalModel, planModel], dependencies: stores.dependencies,
		});
		await initializeAndExtract(harness, "# Restore Then Implement");
		await harness.emit("agent_settled");

		expect(harness.setModel).toHaveBeenCalledWith(expect.objectContaining({ id: normalModel.id }));
		expect(harness.timeline.indexOf("setThinking:medium")).toBeLessThan(
			harness.timeline.indexOf("sendUserMessage"),
		);
		expect(harness.sendUserMessage).toHaveBeenCalledWith(
			expect.stringContaining("Implement this proposed plan"),
			undefined,
		);
	});

	it("records model and thinking changes only while Plan Mode is active", async () => {
		const stores = createProfileDependencies(profileFor(planModel, "high"));
		const branch = [{
			type: "custom",
			customType: "plan-mode-state",
			data: {
				active: true,
				phase: "planning",
				setAt: 1,
				normalProfile: profileFor(normalModel, "medium"),
			},
		}];
		const harness = createHarness({
			branch, model: planModel, thinkingLevel: "high",
			availableModels: [normalModel, planModel], dependencies: stores.dependencies,
		});
		await harness.emit("session_start", { type: "session_start", reason: "resume" });
		stores.save.mockClear();

		harness.setCurrentModel(normalModel);
		await harness.emit("model_select", {
			type: "model_select", model: normalModel, previousModel: planModel, source: "cycle",
		});
		expect(stores.save).toHaveBeenLastCalledWith("plan", profileFor(normalModel, "high"));

		harness.setCurrentThinkingLevel("xhigh");
		await harness.emit("thinking_level_select", {
			type: "thinking_level_select", level: "xhigh", previousLevel: "high",
		});
		expect(stores.save).toHaveBeenLastCalledWith("plan", profileFor(normalModel, "xhigh"));
		expect(stores.restore).toHaveBeenCalled();

		await harness.commands.get("plan").handler("exit", harness.ctx);
		stores.save.mockClear();
		await harness.emit("model_select", {
			type: "model_select", model: planModel, previousModel: normalModel, source: "set",
		});
		expect(stores.save).not.toHaveBeenCalled();
	});

	it("does not let restored historical models redefine the project preference", async () => {
		const stores = createProfileDependencies(profileFor(planModel, "high"));
		const branch = [{
			type: "custom",
			customType: "plan-mode-state",
			data: { active: true, phase: "planning", setAt: 1, normalProfile: profileFor(normalModel, "medium") },
		}];
		const harness = createHarness({
			branch, model: normalModel, thinkingLevel: "medium",
			availableModels: [normalModel, planModel], dependencies: stores.dependencies,
		});
		await harness.emit("session_start", { type: "session_start", reason: "resume" });
		await harness.emit("model_select", {
			type: "model_select", model: normalModel, previousModel: planModel, source: "restore",
		});
		expect(stores.save).not.toHaveBeenCalled();
		expect(stores.getStored()).toEqual(profileFor(planModel, "high"));
	});

	it("keeps Plan Mode active when normal restoration fails", async () => {
		const stores = createProfileDependencies(profileFor(planModel, "high"));
		const branch = [{
			type: "custom",
			customType: "plan-mode-state",
			data: { active: true, phase: "planning", setAt: 1, normalProfile: profileFor(normalModel, "medium") },
		}];
		const harness = createHarness({
			branch, model: planModel, thinkingLevel: "high", setModelResult: false,
			selection: "Implement in current session",
			availableModels: [normalModel, planModel], dependencies: stores.dependencies,
		});
		await initializeAndExtract(harness, "# Do Not Implement Yet");
		await harness.emit("agent_settled");

		expect(harness.sendUserMessage).not.toHaveBeenCalled();
		expect(harness.notify).toHaveBeenCalledWith(expect.stringContaining("Could not exit Plan Mode"), "error");
		expect(harness.appendedEntries.at(-1)?.data).toMatchObject({ mode: "plan" });
		const [result] = await harness.emit("before_agent_start", { systemPrompt: "BASE" });
		expect(result.systemPrompt).toContain("You are in **Plan Mode**");
		expect(result.systemPrompt).not.toContain("Plan Mode is inactive for this turn");
	});

	it("reports unavailable and malformed profiles without entering", async () => {
		const missing = createProfileDependencies(profileFor(planModel, "high"));
		const missingHarness = createHarness({
			branch: [], model: normalModel, availableModels: [normalModel], dependencies: missing.dependencies,
		});
		await missingHarness.emit("session_start", { type: "session_start", reason: "startup" });
		await missingHarness.commands.get("plan").handler("", missingHarness.ctx);
		expect(missingHarness.notify).toHaveBeenCalledWith(expect.stringContaining("is unavailable"), "error");

		const auth = createProfileDependencies(profileFor(planModel, "high"));
		const authHarness = createHarness({
			branch: [], model: normalModel, availableModels: [normalModel, planModel],
			setModelResult: false, dependencies: auth.dependencies,
		});
		await authHarness.emit("session_start", { type: "session_start", reason: "startup" });
		await authHarness.commands.get("plan").handler("", authHarness.ctx);
		expect(authHarness.notify).toHaveBeenCalledWith(
			expect.stringContaining("No configured authentication"),
			"error",
		);

		const malformedHarness = createHarness({
			branch: [], model: normalModel, availableModels: [normalModel],
			dependencies: {
				...missing.dependencies,
				createModelSelectionPersistence: () => ({
					load: vi.fn(async () => { throw new Error("malformed profile"); }),
					save: vi.fn(),
				}),
			},
		});
		await malformedHarness.emit("session_start", { type: "session_start", reason: "startup" });
		await malformedHarness.commands.get("plan").handler("", malformedHarness.ctx);
		expect(malformedHarness.notify).toHaveBeenCalledWith(expect.stringContaining("malformed profile"), "error");
	});

	it("restores the normal profile through Shift+Tab and fresh implementation", async () => {
		const branch = [{
			type: "custom",
			customType: "plan-mode-state",
			data: { active: true, phase: "planning", setAt: 1, normalProfile: profileFor(normalModel, "medium") },
		}];
		const shortcutStores = createProfileDependencies(profileFor(planModel, "high"));
		const shortcutHarness = createHarness({
			branch, model: planModel, thinkingLevel: "high",
			availableModels: [normalModel, planModel], dependencies: shortcutStores.dependencies,
		});
		await shortcutHarness.emit("session_start", { type: "session_start", reason: "reload" });
		await shortcutHarness.shortcuts.get("shift+tab").handler(shortcutHarness.ctx);
		expect(shortcutHarness.timeline.slice(-3)).toEqual([
			"setModel:anthropic/claude-sonnet-4.6",
			"setThinking:medium",
			"setActiveTools:read,bash,edit,write,grep,find,ls",
		]);

		const freshStores = createProfileDependencies(profileFor(planModel, "high"));
		const freshHarness = createHarness({
			branch, model: planModel, thinkingLevel: "high", selection: "Clear context and implement (recommended)",
			availableModels: [normalModel, planModel], dependencies: freshStores.dependencies,
		});
		await initializeAndExtract(freshHarness, "# Fresh With Normal Model");
		await freshHarness.emit("agent_settled");
		expect(freshHarness.timeline.indexOf("setThinking:medium")).toBeLessThan(
			freshHarness.timeline.indexOf("newSession"),
		);
	});

	it("reports profile persistence failures and stays in normal mode", async () => {
		const stores = createProfileDependencies();
		stores.save.mockRejectedValueOnce(new Error("profile is read-only"));
		const harness = createHarness({
			branch: [], model: normalModel, thinkingLevel: "medium",
			availableModels: [normalModel, planModel], dependencies: stores.dependencies,
		});
		await harness.emit("session_start", { type: "session_start", reason: "startup" });
		await harness.commands.get("plan").handler("", harness.ctx);
		expect(harness.notify).toHaveBeenCalledWith(expect.stringContaining("profile is read-only"), "error");
		expect(harness.appendedEntries.some((entry) => entry.data.mode === "plan")).toBe(false);
	});

	it("shows active and normal restoration profiles in /plan status", async () => {
		const stores = createProfileDependencies(profileFor(planModel, "high"));
		const harness = createHarness({
			branch: [], model: normalModel, thinkingLevel: "medium",
			availableModels: [normalModel, planModel], dependencies: stores.dependencies,
		});
		await harness.emit("session_start", { type: "session_start", reason: "startup" });
		await harness.commands.get("plan").handler("", harness.ctx);
		await harness.commands.get("plan").handler("status", harness.ctx);
		expect(harness.notify).toHaveBeenLastCalledWith(
			expect.stringContaining(
				"Plan: github-copilot/gpt-5.6-sol · high · 1,050,000 ctx. Normal on exit: anthropic/claude-sonnet-4.6 · medium · 1,000,000 ctx.",
			),
			"info",
		);
	});
});

describe("Plan Mode profile schema", () => {
	it("preserves normal defaults through Pi's native SettingsManager", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-normal-defaults-"));
		try {
			const settings = SettingsManager.create("/test/project", directory);
			settings.setDefaultModelAndProvider(planModel.provider, planModel.id);
			settings.setDefaultThinkingLevel("high");
			await settings.flush();

			const store = createNormalDefaultsStore(directory);
			expect(await store.capture("/test/project", profileFor(normalModel, "medium")))
				.toEqual({
					...profileFor(planModel, "high"),
					// Native settings have no context field; the active session fallback supplies it.
					contextWindow: normalModel.contextWindow,
				});
			await store.restore("/test/project", profileFor(normalModel, "medium"));

			const restored = SettingsManager.create("/test/project", directory).getGlobalSettings();
			expect(restored).toMatchObject({
				defaultProvider: normalModel.provider,
				defaultModel: normalModel.id,
				defaultThinkingLevel: "medium",
			});
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

});
