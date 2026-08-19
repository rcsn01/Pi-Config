import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
	applySessionProfile,
	createNormalDefaultsStore,
	createPlanModeProfileStore,
	validateModeModelProfile,
	validateStoredModeModelProfile,
} from "./model-profile.ts";
import {
	createHarness,
	createProfileDependencies,
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

		expect(stores.save).toHaveBeenCalledWith(profileFor(normalModel, "medium"));
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
		const stored = validateStoredModeModelProfile({
			provider: "default",
			modelId: "default",
			thinkingLevel: "default",
			contextWindow: "default",
		});
		const profileStore = {
			load: vi.fn(async () => stored),
			save: vi.fn(),
			setPath: vi.fn(),
		};
		const harness = createHarness({
			branch: [],
			model: normalModel,
			thinkingLevel: "medium",
			availableModels: [normalModel, nativeModel],
			dependencies: {
				profileStore,
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
		expect(stores.save).toHaveBeenLastCalledWith(profileFor(normalModel, "high"));

		harness.setCurrentThinkingLevel("xhigh");
		await harness.emit("thinking_level_select", {
			type: "thinking_level_select", level: "xhigh", previousLevel: "high",
		});
		expect(stores.save).toHaveBeenLastCalledWith(profileFor(normalModel, "xhigh"));
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
				profileStore: {
					load: vi.fn(async () => { throw new Error("malformed profile"); }),
					save: vi.fn(),
					setPath: vi.fn(),
				},
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

	it("round-trips the Plan profile through the project settings file without replacing other settings", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-plan-profile-"));
		const path = join(directory, "settings.json");
		const initialSettings = {
			compaction: { enabled: true, threshold: 0.1 },
			uiModelSelector: {
				label: "preserved",
				profiles: { normal: profileFor(normalModel, "medium") },
			},
		};
		writeFileSync(path, `${JSON.stringify(initialSettings, null, 2)}\n`, "utf-8");
		try {
			const store = createPlanModeProfileStore(path);
			expect(await store.load()).toBeUndefined();
			await store.save(profileFor(planModel, "high"));
			expect(await store.load()).toEqual(profileFor(planModel, "high"));
			expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({
				...initialSettings,
				uiModelSelector: {
					...initialSettings.uiModelSelector,
					profiles: {
						...initialSettings.uiModelSelector.profiles,
						plan: profileFor(planModel, "high"),
					},
				},
			});
			expect(readdirSync(directory)).toEqual(["settings.json"]);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("repoints the store at the session's profile with setPath", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-plan-profile-"));
		const settingsPath = join(directory, "settings.json");
		const profilePath = join(directory, "profiles", "focused.json");
		mkdirSync(join(directory, "profiles"));
		writeFileSync(settingsPath, JSON.stringify({
			uiModelSelector: { profiles: { plan: profileFor(planModel, "low") } },
		}), "utf-8");
		writeFileSync(profilePath, JSON.stringify({ uiModelSelector: { profiles: {} } }), "utf-8");
		try {
			const store = createPlanModeProfileStore(settingsPath);
			expect(await store.load()).toEqual(profileFor(planModel, "low"));

			store.setPath(profilePath);
			expect(await store.load()).toBeUndefined();
			await store.save(profileFor(planModel, "high"));
			expect(await store.load()).toEqual(profileFor(planModel, "high"));
			// The original settings.json document is untouched.
			expect(JSON.parse(readFileSync(settingsPath, "utf-8"))).toEqual({
				uiModelSelector: { profiles: { plan: profileFor(planModel, "low") } },
			});
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("accepts current profiles and legacy session profiles without context", () => {
		expect(validateModeModelProfile(profileFor(planModel, "xhigh")))
			.toEqual(profileFor(planModel, "xhigh"));
		expect(validateModeModelProfile({
			provider: planModel.provider,
			modelId: planModel.id,
			thinkingLevel: "high",
		})).toEqual({ provider: planModel.provider, modelId: planModel.id, thinkingLevel: "high" });
	});

	it("accepts stored default sentinels without treating them as concrete session profiles", () => {
		const stored = validateStoredModeModelProfile({
			provider: "default",
			modelId: "default",
			thinkingLevel: "default",
			contextWindow: "default",
		});
		expect(stored).toEqual({
			provider: "default",
			modelId: "default",
			thinkingLevel: "default",
			contextWindow: "default",
		});
		expect(() => validateModeModelProfile(stored)).toThrow(/concrete model settings/);
	});

	it("rejects malformed thinking levels and contexts", () => {
		expect(() => validateModeModelProfile({
			...profileFor(planModel, "high"), thinkingLevel: "turbo",
		})).toThrow("thinkingLevel is not supported");
		expect(() => validateModeModelProfile({
			...profileFor(planModel, "high"), contextWindow: 0,
		})).toThrow("contextWindow must be a positive integer");
	});
});
