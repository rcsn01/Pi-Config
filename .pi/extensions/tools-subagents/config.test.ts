import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	appendChildModelArgument,
	appendChildThinkingArgument,
	canonicalMainModel,
	clearAllContextWindows,
	clearAllThinkingAssignments,
	createSubagentConfigStore,
	migrateSubagentConfigLegacy,
	parseModelConfiguration,
	removeAgentContextWindow,
	removeAgentModelAssignment,
	removeAgentThinkingAssignment,
	resolveLaunchConfiguration,
	resolveModelAssignment,
	selectContextWindowSetting,
	selectModelSetting,
	setAgentContextWindow,
	setAgentModelAssignment,
	setAgentThinkingAssignment,
	setAllContextWindows,
	setAllModelAssignments,
	setAllThinkingAssignments,
	splitModelThinkingSetting,
	validateContextWindow,
} from "./config.ts";

const mainModel = { provider: "anthropic", id: "claude-sonnet-4-6" };
const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function configHarness(
	settingsContent?: string,
	legacyContent?: string,
): { settingsPath: string; legacyPath: string } {
	const root = mkdtempSync(join(tmpdir(), "subagent-config-"));
	roots.push(root);
	const settingsPath = join(root, "settings.json");
	const legacyPath = join(root, "config.json");
	if (settingsContent !== undefined) writeFileSync(settingsPath, settingsContent);
	if (legacyContent !== undefined) writeFileSync(legacyPath, legacyContent);
	return { settingsPath, legacyPath };
}

describe("subagent model resolution", () => {
	it("resolves main to the current main provider/model", () => {
		expect(canonicalMainModel(mainModel)).toBe("anthropic/claude-sonnet-4-6");
		expect(resolveModelAssignment({ agentName: "worker", config: { defaultModel: "main" }, mainModel })).toBe(
			"anthropic/claude-sonnet-4-6",
		);
	});

	it("treats legacy default like main", () => {
		expect(resolveModelAssignment({ agentName: "worker", config: { defaultModel: "default" }, mainModel })).toBe(
			"anthropic/claude-sonnet-4-6",
		);
	});

	it("leaves a specific model unchanged", () => {
		expect(resolveModelAssignment({
			agentName: "worker",
			config: { defaultModel: "openai/gpt-5.4" },
			mainModel,
		})).toBe("openai/gpt-5.4");
	});

	it("gives individual overrides precedence over the global default", () => {
		expect(selectModelSetting({
			agentName: "worker",
			config: {
				defaultModel: "anthropic/claude-haiku-4-5",
				agentModels: { worker: "openai/gpt-5.4" },
			},
			frontmatterModel: "google/gemini-2.5-pro",
		})).toBe("openai/gpt-5.4");
	});

	it("gives the global default precedence over Markdown frontmatter", () => {
		expect(selectModelSetting({
			agentName: "explorer",
			config: { defaultModel: "anthropic/claude-haiku-4-5" },
			frontmatterModel: "google/gemini-2.5-pro",
		})).toBe("anthropic/claude-haiku-4-5");
	});

	it("gives explicit invocation overrides highest precedence", () => {
		expect(selectModelSetting({
			agentName: "worker",
			explicitModel: "openai/gpt-5.4:high",
			config: {
				defaultModel: "anthropic/claude-haiku-4-5",
				agentModels: { worker: "google/gemini-2.5-pro" },
			},
			frontmatterModel: "anthropic/claude-sonnet-4-6",
		})).toBe("openai/gpt-5.4:high");
	});

	it("falls back to the current main model when settings are missing", () => {
		expect(resolveModelAssignment({ agentName: "default", config: {}, mainModel })).toBe(
			"anthropic/claude-sonnet-4-6",
		);
	});

	it("resolves model identity and thinking as independent child settings", () => {
		expect(resolveLaunchConfiguration({
			agentName: "worker",
			config: { defaultModel: "main", defaultThinkingLevel: "high" },
			mainModel,
		})).toEqual({ model: "anthropic/claude-sonnet-4-6", thinkingLevel: "high" });
	});

	it("uses agent thinking overrides before legacy model suffixes and global thinking", () => {
		expect(resolveLaunchConfiguration({
			agentName: "worker",
			config: {
				defaultModel: "openai/gpt-5.4:high",
				defaultThinkingLevel: "minimal",
				agentThinkingLevels: { worker: "low" },
			},
			mainModel,
		})).toEqual({ model: "openai/gpt-5.4", thinkingLevel: "low" });
	});

	it("keeps model suffixes compatible and gives invocation overrides highest precedence", () => {
		expect(splitModelThinkingSetting("openai/gpt-5.4:xhigh")).toEqual({
			model: "openai/gpt-5.4",
			thinkingLevel: "xhigh",
		});
		expect(resolveLaunchConfiguration({
			agentName: "worker",
			explicitModel: "openai/gpt-5.4:max",
			explicitThinkingLevel: "off",
			config: { agentThinkingLevels: { worker: "low" } },
			mainModel,
		})).toEqual({ model: "openai/gpt-5.4", thinkingLevel: "off", contextWindow: undefined });
	});

	it("resolves context windows by explicit > agent > global precedence", () => {
		expect(selectContextWindowSetting({
			agentName: "worker",
			config: { defaultContextWindow: 200000, agentContextWindows: { worker: 131072 } },
		})).toBe(131072);
		expect(selectContextWindowSetting({
			agentName: "explorer",
			config: { defaultContextWindow: 200000, agentContextWindows: { worker: 131072 } },
		})).toBe(200000);
		expect(selectContextWindowSetting({
			agentName: "explorer",
			explicitContextWindow: 64000,
			config: { defaultContextWindow: 200000 },
		})).toBe(64000);
		expect(selectContextWindowSetting({ agentName: "explorer", config: {} })).toBeUndefined();
	});

	it("carries the resolved context window through resolveLaunchConfiguration", () => {
		expect(resolveLaunchConfiguration({
			agentName: "worker",
			config: { defaultContextWindow: 200000, agentContextWindows: { worker: 131072 } },
			mainModel,
		})).toEqual({ model: "anthropic/claude-sonnet-4-6", contextWindow: 131072 });
	});
});

describe("subagent model configuration updates", () => {
	it("setting all agents clears individual overrides and preserves unknown fields", () => {
		expect(setAllModelAssignments({
			maxConcurrency: 8,
			custom: true,
			defaultModel: "main",
			agentModels: { worker: "openai/gpt-5.4" },
			defaultThinkingLevel: "medium",
			agentThinkingLevels: { worker: "high" },
		}, "google/gemini-2.5-pro")).toEqual({
			maxConcurrency: 8,
			custom: true,
			defaultModel: "google/gemini-2.5-pro",
			agentModels: {},
			defaultThinkingLevel: "medium",
			agentThinkingLevels: { worker: "high" },
		});
	});

	it("setting one agent preserves all other assignments", () => {
		expect(setAgentModelAssignment({
			defaultModel: "main",
			agentModels: { explorer: "anthropic/claude-haiku-4-5" },
		}, "worker", "openai/gpt-5.4")).toEqual({
			defaultModel: "main",
			agentModels: {
				explorer: "anthropic/claude-haiku-4-5",
				worker: "openai/gpt-5.4",
			},
		});
	});

	it("inherit removes only the selected agent override", () => {
		expect(removeAgentModelAssignment({
			defaultModel: "main",
			agentModels: {
				explorer: "anthropic/claude-haiku-4-5",
				worker: "openai/gpt-5.4",
			},
		}, "worker")).toEqual({
			defaultModel: "main",
			agentModels: { explorer: "anthropic/claude-haiku-4-5" },
		});
	});

	it("sets, removes, and clears thinking assignments without discarding model settings", () => {
		const configured = setAllThinkingAssignments({
			defaultModel: "main",
			agentModels: { worker: "openai/gpt-5.4" },
			agentThinkingLevels: { worker: "low" },
		}, "high");
		expect(configured).toEqual({
			defaultModel: "main",
			agentModels: { worker: "openai/gpt-5.4" },
			defaultThinkingLevel: "high",
			agentThinkingLevels: {},
		});

		const withAgent = setAgentThinkingAssignment(configured, "worker", "xhigh");
		expect(withAgent).toEqual(expect.objectContaining({
			defaultThinkingLevel: "high",
			agentThinkingLevels: { worker: "xhigh" },
		}));
		expect(removeAgentThinkingAssignment(withAgent, "worker")).toEqual(expect.objectContaining({
			defaultThinkingLevel: "high",
			agentThinkingLevels: {},
		}));
		expect(clearAllThinkingAssignments(withAgent)).toEqual({
			defaultModel: "main",
			agentModels: { worker: "openai/gpt-5.4" },
			agentThinkingLevels: {},
		});
	});

	it("rejects empty, malformed, and invalid model/thinking settings", () => {
		expect(() => parseModelConfiguration({ defaultModel: "" })).toThrow(/cannot be empty/);
		expect(() => parseModelConfiguration({ defaultModel: "claude-sonnet-4-6" })).toThrow(/provider\/model/);
		expect(() => parseModelConfiguration({ defaultModel: "anthropic//claude" })).toThrow(/provider\/model/);
		expect(() => parseModelConfiguration({ agentModels: { worker: 42 } })).toThrow(/must be a string/);
		expect(() => parseModelConfiguration({ agentModels: [] })).toThrow(/agentModels must be a JSON object/);
		expect(() => parseModelConfiguration({ defaultThinkingLevel: "ultra" })).toThrow(/must be one of/);
		expect(() => parseModelConfiguration({ agentThinkingLevels: [] })).toThrow(/agentThinkingLevels must be a JSON object/);
		expect(() => parseModelConfiguration({ agentThinkingLevels: { worker: 42 } })).toThrow(/must be one of/);
		expect(() => parseModelConfiguration({ defaultContextWindow: 0 })).toThrow(/positive integer/);
		expect(() => parseModelConfiguration({ defaultContextWindow: 1.5 })).toThrow(/positive integer/);
		expect(() => parseModelConfiguration({ agentContextWindows: [] })).toThrow(/agentContextWindows must be a JSON object/);
		expect(() => parseModelConfiguration({ agentContextWindows: { worker: "200k" } })).toThrow(/positive integer/);
		expect(() => parseModelConfiguration([])).toThrow(/must contain a JSON object/);
	});

	it("validates context windows as positive integers", () => {
		expect(validateContextWindow(200000)).toBe(200000);
		expect(() => validateContextWindow(0)).toThrow(/positive integer/);
		expect(() => validateContextWindow(-1)).toThrow(/positive integer/);
		expect(() => validateContextWindow(1.5)).toThrow(/positive integer/);
		expect(() => validateContextWindow("200k")).toThrow(/positive integer/);
	});

	it("sets, removes, and clears context windows without discarding other settings", () => {
		const all = setAllContextWindows({
			defaultModel: "main",
			defaultContextWindow: 131072,
			agentContextWindows: { worker: 200000 },
		}, 262144);
		expect(all).toEqual({
			defaultModel: "main",
			defaultContextWindow: 262144,
			agentContextWindows: {},
		});

		const withAgent = setAgentContextWindow(all, "worker", 131072);
		expect(withAgent).toEqual(expect.objectContaining({ agentContextWindows: { worker: 131072 } }));
		expect(removeAgentContextWindow(withAgent, "worker")).toEqual(expect.objectContaining({
			defaultContextWindow: 262144,
			agentContextWindows: {},
		}));
		expect(clearAllContextWindows(withAgent)).toEqual({
			defaultModel: "main",
			agentContextWindows: {},
		});
		expect(() => setAgentContextWindow({}, "worker", -5)).toThrow(/positive integer/);
	});
});

describe("subagent config store", () => {
	it("loads missing settings and validates root values and concurrency", () => {
		const { settingsPath } = configHarness();
		expect(createSubagentConfigStore({ settingsPath }).load()).toEqual({
			agentModels: {}, agentThinkingLevels: {}, agentContextWindows: {}, maxConcurrency: undefined,
		});
		expect(() => createSubagentConfigStore({ settingsPath: configHarness("[]").settingsPath }).load())
			.toThrow(/root value must be a JSON object/);
		expect(() => createSubagentConfigStore({ settingsPath: configHarness("{").settingsPath }).load())
			.toThrow(/Cannot read/);
		expect(() => createSubagentConfigStore({ settingsPath: configHarness('{"subagents":{"maxConcurrency":0}}').settingsPath }).load())
			.toThrow(/positive integer/);
		expect(() => createSubagentConfigStore({ settingsPath: configHarness('{"subagents":{"maxConcurrency":1.5}}').settingsPath }).load())
			.toThrow(/positive integer/);
	});

	it("updates atomically while preserving unknown settings keys", async () => {
		const { settingsPath } = configHarness(
			'{"compaction":{"threshold":0.1},"subagents":{"maxConcurrency":3,"custom":true,"defaultModel":"main"}}',
		);
		const store = createSubagentConfigStore({ settingsPath });
		await store.update((document) => setAgentModelAssignment(document, "worker", "openai/test"));
		expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({
			compaction: { threshold: 0.1 },
			subagents: {
				maxConcurrency: 3,
				custom: true,
				defaultModel: "main",
				agentModels: { worker: "openai/test" },
			},
		});
	});

	it("honors a legacy config.json until settings.json gains a subagents key", () => {
		const { settingsPath, legacyPath } = configHarness(
			undefined,
			'{"maxConcurrency":4,"defaultModel":"main","defaultThinkingLevel":"low"}',
		);
		const store = createSubagentConfigStore({ settingsPath, legacyConfigPath: legacyPath });
		expect(store.load()).toEqual({
			defaultModel: "main",
			defaultThinkingLevel: "low",
			agentModels: {},
			agentThinkingLevels: {},
			agentContextWindows: {},
			maxConcurrency: 4,
		});
	});

	it("migrates a legacy config.json into settings.json and removes it", async () => {
		const { settingsPath, legacyPath } = configHarness(undefined, '{"maxConcurrency":4,"defaultModel":"main"}');
		expect(await migrateSubagentConfigLegacy(settingsPath, legacyPath)).toBe(true);
		expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({
			subagents: { maxConcurrency: 4, defaultModel: "main" },
		});
		expect(existsSync(legacyPath)).toBe(false);
		// No-op once settings.json already has a subagents key.
		expect(await migrateSubagentConfigLegacy(settingsPath, legacyPath)).toBe(false);
	});

	it("migrates a legacy config.json into the session's profile instead of settings.json", async () => {
		const root = mkdtempSync(join(tmpdir(), "subagent-config-"));
		roots.push(root);
		const settingsPath = join(root, "settings.json");
		const profilePath = join(root, "profiles", "focused.json");
		const legacyPath = join(root, "config.json");
		mkdirSync(join(root, "profiles"));
		writeFileSync(settingsPath, '{"compaction":{"threshold":0.1}}');
		writeFileSync(profilePath, '{"uiModelSelector":{"profiles":{}}}');
		writeFileSync(legacyPath, '{"maxConcurrency":4,"defaultModel":"main"}');

		expect(await migrateSubagentConfigLegacy(profilePath, legacyPath)).toBe(true);
		expect(JSON.parse(readFileSync(profilePath, "utf8"))).toEqual({
			uiModelSelector: { profiles: {} },
			subagents: { maxConcurrency: 4, defaultModel: "main" },
		});
		// settings.json is untouched by the profile-targeted migration.
		expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({ compaction: { threshold: 0.1 } });
		expect(existsSync(legacyPath)).toBe(false);
	});

	it("repoints the config store at the session's profile with setSettingsPath", async () => {
		const root = mkdtempSync(join(tmpdir(), "subagent-config-"));
		roots.push(root);
		const settingsPath = join(root, "settings.json");
		const profilePath = join(root, "profiles", "focused.json");
		mkdirSync(join(root, "profiles"));
		writeFileSync(settingsPath, '{"subagents":{"defaultModel":"main"}}');
		writeFileSync(profilePath, '{"uiModelSelector":{"profiles":{}}}');
		const store = createSubagentConfigStore({ settingsPath });
		expect(store.configPath).toBe(settingsPath);
		expect(store.load()).toMatchObject({ defaultModel: "main" });

		store.setSettingsPath(profilePath);
		expect(store.configPath).toBe(profilePath);
		expect(store.load()).not.toHaveProperty("defaultModel");
		await store.update((document) => setAgentModelAssignment(document, "worker", "openai/test"));
		expect(JSON.parse(readFileSync(profilePath, "utf8"))).toEqual({
			uiModelSelector: { profiles: {} },
			subagents: { agentModels: { worker: "openai/test" } },
		});
		// settings.json keeps its own subagents namespace untouched.
		expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({ subagents: { defaultModel: "main" } });
	});

	it("tracks the main model dynamically when resolving launches", () => {
		const { settingsPath } = configHarness('{"subagents":{"defaultModel":"main","defaultThinkingLevel":"low"}}');
		const store = createSubagentConfigStore({ settingsPath });
		const worker = { name: "worker", model: "", description: "", tools: [], systemPrompt: "", filePath: "" };
		store.rememberMainModel({ provider: "openai", id: "first" });
		expect(store.resolveLaunch(worker)).toEqual({ model: "openai/first", thinkingLevel: "low" });
		store.rememberMainModel({ provider: "anthropic", id: "second" });
		expect(store.resolveLaunch(worker)).toEqual({ model: "anthropic/second", thinkingLevel: "low" });
	});
});

describe("child Pi model arguments", () => {
	it("uses --model and never --models for selection", () => {
		const args = appendChildModelArgument(["--mode", "json"], "anthropic/claude-sonnet-4-6");
		expect(args).toEqual(["--mode", "json", "--model", "anthropic/claude-sonnet-4-6"]);
		expect(args).not.toContain("--models");
	});

	it("adds --thinking only for explicit subagent thinking assignments", () => {
		expect(appendChildThinkingArgument(["--model", "openai/gpt-5.4"], "high")).toEqual([
			"--model", "openai/gpt-5.4", "--thinking", "high",
		]);
		expect(appendChildThinkingArgument(["--model", "openai/gpt-5.4"], undefined)).toEqual([
			"--model", "openai/gpt-5.4",
		]);
	});
});
