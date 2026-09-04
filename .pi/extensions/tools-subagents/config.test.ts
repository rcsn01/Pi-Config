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
	resolveSubagentAssignment,
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
	const cases = [
		{
			name: "missing configuration falls back to main",
			options: { agentName: "worker", config: {}, mainModel },
			expected: { modelSetting: "main", launch: { model: "anthropic/claude-sonnet-4-6", thinkingLevel: undefined, contextWindow: undefined } },
		},
		{
			name: "legacy default normalizes to main",
			options: { agentName: "worker", config: { defaultModel: "default" }, mainModel },
			expected: { modelSetting: "main", launch: { model: "anthropic/claude-sonnet-4-6", thinkingLevel: undefined, contextWindow: undefined } },
		},
		{
			name: "a concrete model remains selected and resolved",
			options: { agentName: "worker", config: { defaultModel: "openai/gpt-5.4" }, mainModel },
			expected: { modelSetting: "openai/gpt-5.4", launch: { model: "openai/gpt-5.4", thinkingLevel: undefined, contextWindow: undefined } },
		},
		{
			name: "per-agent model beats global and frontmatter",
			options: { agentName: "worker", config: { defaultModel: "anthropic/global", agentModels: { worker: "openai/agent" } }, frontmatterModel: "google/frontmatter", mainModel },
			expected: { modelSetting: "openai/agent", launch: { model: "openai/agent", thinkingLevel: undefined, contextWindow: undefined } },
		},
		{
			name: "global model beats frontmatter",
			options: { agentName: "worker", config: { defaultModel: "anthropic/global" }, frontmatterModel: "google/frontmatter", mainModel },
			expected: { modelSetting: "anthropic/global", launch: { model: "anthropic/global", thinkingLevel: undefined, contextWindow: undefined } },
		},
		{
			name: "frontmatter beats main without central model settings",
			options: { agentName: "worker", config: {}, frontmatterModel: "google/frontmatter", mainModel },
			expected: { modelSetting: "google/frontmatter", launch: { model: "google/frontmatter", thinkingLevel: undefined, contextWindow: undefined } },
		},
		{
			name: "explicit model beats every configured source",
			options: { agentName: "worker", explicitModel: "openai/explicit", config: { defaultModel: "anthropic/global", agentModels: { worker: "openai/agent" } }, frontmatterModel: "google/frontmatter", mainModel },
			expected: { modelSetting: "openai/explicit", launch: { model: "openai/explicit", thinkingLevel: undefined, contextWindow: undefined } },
		},
		{
			name: "main retains its setting while resolving the current model",
			options: { agentName: "worker", config: { defaultModel: "main" }, mainModel },
			expected: { modelSetting: "main", launch: { model: "anthropic/claude-sonnet-4-6", thinkingLevel: undefined, contextWindow: undefined } },
		},
		{
			name: "explicit thinking beats an explicit-model suffix",
			options: { agentName: "worker", explicitModel: "openai/explicit:high", explicitThinkingLevel: "off", config: { agentThinkingLevels: { worker: "low" } }, mainModel },
			expected: { modelSetting: "openai/explicit", launch: { model: "openai/explicit", thinkingLevel: "off", contextWindow: undefined } },
		},
		{
			name: "explicit-model suffix beats per-agent thinking",
			options: { agentName: "worker", explicitModel: "openai/explicit:high", config: { agentThinkingLevels: { worker: "low" } }, mainModel },
			expected: { modelSetting: "openai/explicit", launch: { model: "openai/explicit", thinkingLevel: "high", contextWindow: undefined } },
		},
		{
			name: "per-agent thinking beats a configured-model suffix",
			options: { agentName: "worker", config: { defaultModel: "openai/global:high", agentThinkingLevels: { worker: "low" } }, mainModel },
			expected: { modelSetting: "openai/global", launch: { model: "openai/global", thinkingLevel: "low", contextWindow: undefined } },
		},
		{
			name: "per-agent model suffix beats global thinking",
			options: { agentName: "worker", config: { agentModels: { worker: "openai/agent:xhigh" }, defaultThinkingLevel: "minimal" }, mainModel },
			expected: { modelSetting: "openai/agent", launch: { model: "openai/agent", thinkingLevel: "xhigh", contextWindow: undefined } },
		},
		{
			name: "global model suffix beats global thinking",
			options: { agentName: "worker", config: { defaultModel: "openai/global:high", defaultThinkingLevel: "minimal" }, mainModel },
			expected: { modelSetting: "openai/global", launch: { model: "openai/global", thinkingLevel: "high", contextWindow: undefined } },
		},
		{
			name: "frontmatter model suffix beats global thinking",
			options: { agentName: "worker", config: { defaultThinkingLevel: "minimal" }, frontmatterModel: "google/frontmatter:max", mainModel },
			expected: { modelSetting: "google/frontmatter", launch: { model: "google/frontmatter", thinkingLevel: "max", contextWindow: undefined } },
		},
		{
			name: "global thinking beats the Pi default",
			options: { agentName: "worker", config: { defaultThinkingLevel: "medium" }, mainModel },
			expected: { modelSetting: "main", launch: { model: "anthropic/claude-sonnet-4-6", thinkingLevel: "medium", contextWindow: undefined } },
		},
		{
			name: "explicit context beats per-agent context",
			options: { agentName: "worker", explicitContextWindow: 64000, config: { defaultContextWindow: 200000, agentContextWindows: { worker: 131072 } }, mainModel },
			expected: { modelSetting: "main", launch: { model: "anthropic/claude-sonnet-4-6", thinkingLevel: undefined, contextWindow: 64000 } },
		},
		{
			name: "per-agent context beats global context",
			options: { agentName: "worker", config: { defaultContextWindow: 200000, agentContextWindows: { worker: 131072 } }, mainModel },
			expected: { modelSetting: "main", launch: { model: "anthropic/claude-sonnet-4-6", thinkingLevel: undefined, contextWindow: 131072 } },
		},
		{
			name: "missing context remains undefined",
			options: { agentName: "worker", config: {}, mainModel },
			expected: { modelSetting: "main", launch: { model: "anthropic/claude-sonnet-4-6", thinkingLevel: undefined, contextWindow: undefined } },
		},
		{
			name: "legacy default thinking and context use Pi defaults",
			options: { agentName: "worker", config: { defaultThinkingLevel: "default", agentThinkingLevels: { worker: "default" }, defaultContextWindow: "default", agentContextWindows: { worker: "default" } }, mainModel },
			expected: { modelSetting: "main", launch: { model: "anthropic/claude-sonnet-4-6", thinkingLevel: undefined, contextWindow: undefined } },
		},
	] as const;

	for (const testCase of cases) {
		it(testCase.name, () => {
			expect(resolveSubagentAssignment(testCase.options)).toEqual(testCase.expected);
		});
	}

	it("parses legacy default values without retaining sentinel assignments", () => {
		expect(parseModelConfiguration({
			defaultModel: "default",
			defaultThinkingLevel: "default",
			agentThinkingLevels: { worker: "default" },
			defaultContextWindow: "default",
			agentContextWindows: { worker: "default" },
		})).toEqual({
			defaultModel: "main",
			agentModels: {},
			agentThinkingLevels: {},
			agentContextWindows: {},
		});
	});

	it("propagates malformed setting errors unchanged", () => {
		expect(() => resolveSubagentAssignment({
			agentName: "worker",
			config: { defaultContextWindow: 0 },
			mainModel,
		})).toThrow("Subagent config defaultContextWindow must be a positive integer.");
	});

	it("preserves the missing Main model error", () => {
		expect(() => resolveSubagentAssignment({
			agentName: "worker",
			config: {},
			mainModel: undefined,
		})).toThrow('Cannot resolve subagent model "main": the main session has no active model.');
	});

	it("splits legacy model thinking shorthand", () => {
		expect(splitModelThinkingSetting("openai/gpt-5.4:xhigh")).toEqual({
			model: "openai/gpt-5.4",
			thinkingLevel: "xhigh",
		});
		expect(canonicalMainModel(mainModel)).toBe("anthropic/claude-sonnet-4-6");
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
		const firstLaunch = store.resolveLaunch(worker);
		expect(firstLaunch).toEqual({ model: "openai/first", thinkingLevel: "low" });
		expect(firstLaunch).not.toHaveProperty("modelSetting");
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
