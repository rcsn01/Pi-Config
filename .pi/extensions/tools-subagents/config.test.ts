import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import {
	appendChildModelArgument,
	appendChildThinkingArgument,
	applySubagentConfigurationChanges,
	createSubagentConfigStore,
	parseModelConfiguration,
	resolveSubagentAssignment,
	splitModelThinkingSetting,
} from "./config.ts";
import { agent } from "./test-harness.ts";

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
	});
});

describe("subagent configuration changes", () => {
	it("applies ordered model and thinking changes while preserving unknown fields", () => {
		const input = {
			custom: true,
			defaultModel: "main",
			agentModels: { explorer: "anthropic/old", worker: "openai/old" },
			defaultThinkingLevel: "low",
			agentThinkingLevels: { worker: "high" },
		};
		const result = applySubagentConfigurationChanges(input, [
			{ kind: "set-model", target: { kind: "all" }, model: "google/gemini-2.5-pro" },
			{ kind: "set-model", target: { kind: "agent", name: "worker" }, model: "openai/gpt-5.4" },
			{ kind: "set-thinking", target: { kind: "all" }, thinkingLevel: "medium" },
			{ kind: "set-thinking", target: { kind: "agent", name: "worker" }, thinkingLevel: "xhigh" },
		]);
		expect(result).toEqual({
			custom: true,
			defaultModel: "google/gemini-2.5-pro",
			agentModels: { worker: "openai/gpt-5.4" },
			defaultThinkingLevel: "medium",
			agentThinkingLevels: { worker: "xhigh" },
		});
		expect(input).toEqual({
			custom: true,
			defaultModel: "main",
			agentModels: { explorer: "anthropic/old", worker: "openai/old" },
			defaultThinkingLevel: "low",
			agentThinkingLevels: { worker: "high" },
		});
	});

	it("removes only named overrides for inheritance", () => {
		expect(applySubagentConfigurationChanges({
			agentModels: { explorer: "anthropic/model", worker: "openai/model" },
			agentThinkingLevels: { explorer: "low", worker: "high" },
		}, [
			{ kind: "inherit-model", agentName: "worker" },
			{ kind: "inherit-thinking", agentName: "worker" },
		])).toEqual({
			agentModels: { explorer: "anthropic/model" },
			agentThinkingLevels: { explorer: "low" },
		});
	});

	it("restores global Pi-default thinking and clears overrides", () => {
		expect(applySubagentConfigurationChanges({
			defaultModel: "main",
			defaultThinkingLevel: "high",
			agentThinkingLevels: { worker: "low" },
		}, [{ kind: "default-thinking" }])).toEqual({
			defaultModel: "main",
			agentThinkingLevels: {},
		});
	});

	it("rejects empty names and malformed values", () => {
		expect(() => applySubagentConfigurationChanges({}, [
			{ kind: "inherit-model", agentName: " " },
		])).toThrow(/agent name cannot be empty/);
		expect(() => applySubagentConfigurationChanges({}, [
			{ kind: "set-model", target: { kind: "all" }, model: "invalid" },
		])).toThrow(/provider\/model/);
		expect(() => applySubagentConfigurationChanges({}, [
			{ kind: "set-thinking", target: { kind: "agent", name: "worker" }, thinkingLevel: "ultra" as any },
		])).toThrow(/must be one of/);
	});

	it("keeps parser and context validation behavior", () => {
		expect(() => parseModelConfiguration({ defaultModel: "" })).toThrow(/cannot be empty/);
		expect(() => parseModelConfiguration({ agentModels: [] })).toThrow(/agentModels must be a JSON object/);
		expect(() => parseModelConfiguration({ agentThinkingLevels: [] })).toThrow(/agentThinkingLevels must be a JSON object/);
		expect(() => parseModelConfiguration({ defaultContextWindow: 0 })).toThrow(/positive integer/);
		expect(() => parseModelConfiguration({ agentContextWindows: { worker: "200k" } })).toThrow(/positive integer/);
		expect(() => parseModelConfiguration([])).toThrow(/must contain a JSON object/);
		expect(parseModelConfiguration({ defaultContextWindow: 200000 }).defaultContextWindow).toBe(200000);
	});
});

describe("subagent config store", () => {
	it("loads missing and existing namespaces and validates Settings", () => {
		const { settingsPath } = configHarness();
		expect(createSubagentConfigStore({ settingsPath }).load()).toEqual({
			agentModels: {}, agentThinkingLevels: {}, agentContextWindows: {}, maxConcurrency: undefined,
		});
		expect(createSubagentConfigStore({ settingsPath: configHarness('{"subagents":{"defaultModel":"main"}}').settingsPath }).load())
			.toMatchObject({ defaultModel: "main" });
		expect(() => createSubagentConfigStore({ settingsPath: configHarness('{"subagents":[]}').settingsPath }).load())
			.toThrow(/must be a JSON object/);
		expect(() => createSubagentConfigStore({ settingsPath: configHarness("[]").settingsPath }).load())
			.toThrow(/root value must be a JSON object/);
		expect(() => createSubagentConfigStore({ settingsPath: configHarness("{").settingsPath }).load())
			.toThrow(/Cannot read/);
		expect(() => createSubagentConfigStore({ settingsPath: configHarness('{"subagents":{"maxConcurrency":0}}').settingsPath }).load())
			.toThrow(/positive integer/);
	});

	it("applies a semantic batch atomically and preserves unknown settings", async () => {
		const { settingsPath } = configHarness(
			'{"compaction":{"threshold":0.1},"subagents":{"maxConcurrency":3,"custom":true,"defaultModel":"main"}}',
		);
		const store = createSubagentConfigStore({ settingsPath });
		await store.applyChanges([
			{ kind: "set-model", target: { kind: "agent", name: "worker" }, model: "openai/test" },
			{ kind: "set-thinking", target: { kind: "agent", name: "worker" }, thinkingLevel: "high" },
		]);
		expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({
			compaction: { threshold: 0.1 },
			subagents: {
				maxConcurrency: 3,
				custom: true,
				defaultModel: "main",
				agentModels: { worker: "openai/test" },
				agentThinkingLevels: { worker: "high" },
			},
		});
	});

	it("bases queued changes on the latest namespace", async () => {
		const { settingsPath } = configHarness("{}");
		const first = createSubagentConfigStore({ settingsPath });
		const second = createSubagentConfigStore({ settingsPath });
		await Promise.all([
			first.applyChanges([{ kind: "set-model", target: { kind: "agent", name: "worker" }, model: "openai/test" }]),
			second.applyChanges([{ kind: "set-thinking", target: { kind: "agent", name: "worker" }, thinkingLevel: "high" }]),
		]);
		expect(JSON.parse(readFileSync(settingsPath, "utf8")).subagents).toEqual({
			agentModels: { worker: "openai/test" },
			agentThinkingLevels: { worker: "high" },
		});
	});

	it("uses the legacy namespace as the first-write base", async () => {
		const { settingsPath, legacyPath } = configHarness(undefined,
			'{"maxConcurrency":4,"defaultModel":"main","custom":true}');
		const store = createSubagentConfigStore({ settingsPath, legacyConfigPath: legacyPath });
		expect(store.load()).toMatchObject({ defaultModel: "main", maxConcurrency: 4 });
		await store.applyChanges([
			{ kind: "set-thinking", target: { kind: "agent", name: "worker" }, thinkingLevel: "low" },
		]);
		expect(JSON.parse(readFileSync(settingsPath, "utf8")).subagents).toEqual({
			maxConcurrency: 4,
			defaultModel: "main",
			custom: true,
			agentThinkingLevels: { worker: "low" },
		});
	});

	it("resolves current and hypothetical assignments without writing", () => {
		const { settingsPath } = configHarness('{"subagents":{"defaultModel":"main","agentModels":{"worker":"openai/old"}}}');
		const store = createSubagentConfigStore({ settingsPath });
		store.rememberMainModel({ provider: "anthropic", id: "first" });
		const snapshot = store.load();
		expect(store.resolveAssignment(agent(), { snapshot }).launch.model).toBe("openai/old");
		expect(store.resolveAssignment(agent(), {
			snapshot,
			changes: [{ kind: "inherit-model", agentName: "worker" }],
		}).launch.model).toBe("anthropic/first");
		expect(JSON.parse(readFileSync(settingsPath, "utf8")).subagents.agentModels).toEqual({ worker: "openai/old" });
		store.rememberMainModel({ provider: "anthropic", id: "second" });
		expect(store.resolveMainModel()).toBe("anthropic/second");
	});

	it("projects launch fields and tracks the Main model", () => {
		const { settingsPath } = configHarness('{"subagents":{"defaultModel":"main","defaultThinkingLevel":"low"}}');
		const store = createSubagentConfigStore({ settingsPath });
		store.rememberMainModel({ provider: "openai", id: "first" });
		const firstLaunch = store.resolveLaunch(agent({ model: "" }));
		expect(firstLaunch).toEqual({ model: "openai/first", thinkingLevel: "low" });
		expect(firstLaunch).not.toHaveProperty("modelSetting");
		store.rememberMainModel({ provider: "anthropic", id: "second" });
		expect(store.resolveLaunch(agent({ model: "" }))).toEqual({ model: "anthropic/second", thinkingLevel: "low" });
	});

	it("repoints persistence and migration to the active Profile", async () => {
		const root = mkdtempSync(join(tmpdir(), "subagent-config-"));
		roots.push(root);
		const settingsPath = join(root, "settings.json");
		const profilePath = join(root, "profiles", "focused.json");
		const legacyPath = join(root, "config.json");
		mkdirSync(join(root, "profiles"));
		writeFileSync(settingsPath, '{"subagents":{"defaultModel":"main"}}');
		writeFileSync(profilePath, '{"uiModelSelector":{"profiles":{}}}');
		writeFileSync(legacyPath, '{"maxConcurrency":4,"defaultModel":"main"}');
		const store = createSubagentConfigStore({ settingsPath, legacyConfigPath: legacyPath });
		store.setSettingsPath(profilePath);
		expect(store.configPath).toBe(profilePath);
		expect(await store.migrateLegacy()).toBe(true);
		expect(JSON.parse(readFileSync(profilePath, "utf8"))).toEqual({
			uiModelSelector: { profiles: {} },
			subagents: { maxConcurrency: 4, defaultModel: "main" },
		});
		expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({ subagents: { defaultModel: "main" } });
		expect(existsSync(legacyPath)).toBe(false);
	});

	it("does not replace a namespace added while migration waits", async () => {
		const { settingsPath, legacyPath } = configHarness("{}", '{"defaultModel":"openai/legacy"}');
		let release!: () => void;
		const gate = new Promise<void>((resolve) => { release = resolve; });
		let queued!: () => void;
		const entered = new Promise<void>((resolve) => { queued = resolve; });
		const blocker = withFileMutationQueue(settingsPath, async () => {
			queued();
			await gate;
		});
		await entered;
		const store = createSubagentConfigStore({ settingsPath, legacyConfigPath: legacyPath });
		const migration = store.migrateLegacy();
		writeFileSync(settingsPath, '{"subagents":{"defaultModel":"openai/current"}}');
		release();
		await blocker;
		expect(await migration).toBe(false);
		expect(JSON.parse(readFileSync(settingsPath, "utf8")).subagents.defaultModel).toBe("openai/current");
		expect(existsSync(legacyPath)).toBe(true);
	});

	it("leaves the legacy file when the Settings write fails", async () => {
		const root = mkdtempSync(join(tmpdir(), "subagent-config-"));
		roots.push(root);
		const blockedParent = join(root, "not-a-directory");
		const settingsPath = join(blockedParent, "settings.json");
		const legacyPath = join(root, "config.json");
		writeFileSync(blockedParent, "blocked");
		writeFileSync(legacyPath, '{"defaultModel":"main"}');
		const store = createSubagentConfigStore({ settingsPath, legacyConfigPath: legacyPath });

		await expect(store.migrateLegacy()).rejects.toThrow();
		expect(existsSync(legacyPath)).toBe(true);
	});

	it("keeps invalid legacy data for fallback validation", async () => {
		const malformed = configHarness(undefined, "{");
		expect(await createSubagentConfigStore({
			settingsPath: malformed.settingsPath, legacyConfigPath: malformed.legacyPath,
		}).migrateLegacy()).toBe(false);
		expect(existsSync(malformed.legacyPath)).toBe(true);

		const invalid = configHarness(undefined, '{"defaultModel":"invalid"}');
		const invalidStore = createSubagentConfigStore({
			settingsPath: invalid.settingsPath, legacyConfigPath: invalid.legacyPath,
		});
		expect(await invalidStore.migrateLegacy()).toBe(false);
		expect(() => invalidStore.load()).toThrow(/provider\/model/);
		expect(existsSync(invalid.legacyPath)).toBe(true);
	});

	it("migrates valid assignments before load rejects malformed concurrency", async () => {
		const { settingsPath, legacyPath } = configHarness(undefined, '{"defaultModel":"main","maxConcurrency":0}');
		const store = createSubagentConfigStore({ settingsPath, legacyConfigPath: legacyPath });
		expect(await store.migrateLegacy()).toBe(true);
		expect(() => store.load()).toThrow(/maxConcurrency/);
		expect(existsSync(legacyPath)).toBe(false);
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
