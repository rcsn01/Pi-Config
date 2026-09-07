import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import {
	appendChildModelArgument,
	appendChildThinkingArgument,
	createSubagentConfigStore,
	normalizeModelSetting,
	parseModelConfiguration,
	resolveSubagentAssignment,
	resolveSubagentAssignmentSelection,
	splitModelThinkingSetting,
	type SubagentAssignmentEdit,
	type SubagentThinkingLevel,
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

describe("stored colon-suffix pass-through", () => {
	// A non-level colon suffix is not an attempted thinking level: the shared
	// suffix vocabulary only extracts valid level words, so these settings pass
	// through unchanged rather than being rejected at parse time.
	it("keeps an invalid suffix level in the model id", () => {
		expect(normalizeModelSetting("openai/model:turbo")).toBe("openai/model:turbo");
		expect(splitModelThinkingSetting("openai/model:turbo")).toEqual({ model: "openai/model:turbo" });
	});

	it("keeps a legitimately colon-suffixed model id intact", () => {
		expect(normalizeModelSetting("openrouter/deepseek-r1:free")).toBe("openrouter/deepseek-r1:free");
		expect(splitModelThinkingSetting("openrouter/deepseek-r1:free")).toEqual({
			model: "openrouter/deepseek-r1:free",
		});
	});
});

describe("subagent assignment selection", () => {
	const cases = [
		{
			name: "an unset global model reports the default choice with an effective main assignment",
			options: { target: { kind: "all" }, mainModel },
			expected: {
				model: { kind: "default" },
				thinking: { kind: "default" },
				assignment: {
					modelSetting: "main",
					launch: { model: "anthropic/claude-sonnet-4-6", thinkingLevel: undefined, contextWindow: undefined },
					},
			},
		},
		{
			name: "an explicit global main setting stays distinct from the unset default",
			options: { target: { kind: "all" }, config: { defaultModel: "main" }, mainModel },
			expected: {
				model: { kind: "set", setting: "main" },
				thinking: { kind: "default" },
				assignment: {
					modelSetting: "main",
					launch: { model: "anthropic/claude-sonnet-4-6", thinkingLevel: undefined, contextWindow: undefined },
					},
			},
		},
		{
			name: "a global model suffix is direct metadata and beats global thinking",
			options: { target: { kind: "all" }, config: { defaultModel: "openai/gpt:high", defaultThinkingLevel: "minimal" }, mainModel },
			expected: {
				model: { kind: "set", setting: "openai/gpt:high" },
				modelSuffixThinkingLevel: "high",
				thinking: { kind: "set", level: "minimal" },
				assignment: {
					modelSetting: "openai/gpt",
					launch: { model: "openai/gpt", thinkingLevel: "high", contextWindow: undefined },
					},
			},
		},
		{
			name: "an agent without a direct model inherits even when a global model exists",
			options: { target: { kind: "agent", name: "worker" }, agent: agent({ model: "google/frontmatter" }), config: { defaultModel: "anthropic/global" }, mainModel },
			expected: {
				model: { kind: "inherit" },
				thinking: { kind: "inherit" },
				assignment: {
					modelSetting: "anthropic/global",
					launch: { model: "anthropic/global", thinkingLevel: undefined, contextWindow: undefined },
					},
			},
		},
		{
			name: "an inheriting agent reports no direct suffix even when fallbacks carry one",
			options: {
				target: { kind: "agent", name: "worker" },
				agent: agent({ model: "google/frontmatter:max" }),
				config: { defaultModel: "openai/global:high", defaultThinkingLevel: "minimal" },
				mainModel,
			},
			expected: {
				model: { kind: "inherit" },
				thinking: { kind: "inherit" },
				assignment: {
					modelSetting: "openai/global",
					launch: { model: "openai/global", thinkingLevel: "high", contextWindow: undefined },
					},
			},
		},
		{
			name: "a direct agent model keeps its suffix as direct metadata",
			options: { target: { kind: "agent", name: "worker" }, agent: agent(), config: { agentModels: { worker: "openai/gpt:xhigh" } }, mainModel },
			expected: {
				model: { kind: "set", setting: "openai/gpt:xhigh" },
				modelSuffixThinkingLevel: "xhigh",
				thinking: { kind: "inherit" },
				assignment: {
					modelSetting: "openai/gpt",
					launch: { model: "openai/gpt", thinkingLevel: "xhigh", contextWindow: undefined },
					},
			},
		},
		{
			name: "a direct agent thinking level beats its direct model suffix",
			options: {
				target: { kind: "agent", name: "worker" },
				agent: agent(),
				config: { agentModels: { worker: "openai/gpt:xhigh" }, agentThinkingLevels: { worker: "low" } },
				mainModel,
			},
			expected: {
				model: { kind: "set", setting: "openai/gpt:xhigh" },
				modelSuffixThinkingLevel: "xhigh",
				thinking: { kind: "set", level: "low" },
				assignment: {
					modelSetting: "openai/gpt",
					launch: { model: "openai/gpt", thinkingLevel: "low", contextWindow: undefined },
					},
			},
		},
		{
			name: "an inheriting agent still inherits a global thinking level",
			options: { target: { kind: "agent", name: "worker" }, agent: agent(), config: { defaultThinkingLevel: "medium" }, mainModel },
			expected: {
				model: { kind: "inherit" },
				thinking: { kind: "inherit" },
				assignment: {
					modelSetting: "openai/test-model",
					launch: { model: "openai/test-model", thinkingLevel: "medium", contextWindow: undefined },
					},
			},
		},
		{
			name: "a global direct thinking level is reported as set",
			options: { target: { kind: "all" }, config: { defaultThinkingLevel: "high" }, mainModel },
			expected: {
				model: { kind: "default" },
				thinking: { kind: "set", level: "high" },
				assignment: {
					modelSetting: "main",
					launch: { model: "anthropic/claude-sonnet-4-6", thinkingLevel: "high", contextWindow: undefined },
					},
			},
		},
	] as const;

	for (const testCase of cases) {
		it(testCase.name, () => {
			expect(resolveSubagentAssignmentSelection(testCase.options)).toEqual(testCase.expected);
		});
	}

	it("returns the complete semantic result for a mixed global and individual state", () => {
		expect(resolveSubagentAssignmentSelection({
				target: { kind: "agent", name: "worker" },
				agent: agent(),
				config: {
					defaultModel: "openai/global:high",
					agentThinkingLevels: { worker: "low" },
				},
				mainModel,
			})).toEqual({
				model: { kind: "inherit" },
				thinking: { kind: "set", level: "low" },
				assignment: {
					modelSetting: "openai/global",
					launch: {
						model: "openai/global",
						thinkingLevel: "low",
						contextWindow: undefined,
					},
				},
			});
	});

	it("resolves a concrete direct model without a Main model and keeps the main fallback error", () => {
		expect(resolveSubagentAssignmentSelection({
			target: { kind: "agent", name: "worker" },
			agent: agent(),
			config: { agentModels: { worker: "openai/gpt" } },
			mainModel: undefined,
		}).assignment.launch.model).toBe("openai/gpt");
		expect(() => resolveSubagentAssignmentSelection({
				target: { kind: "agent", name: "worker" },
				agent: agent({ model: "" }),
				config: {},
				mainModel: undefined,
			})).toThrow('Cannot resolve subagent model "main": the main session has no active model.');
	});

	it("propagates malformed selection settings unchanged", () => {
		expect(() => resolveSubagentAssignmentSelection({
			target: { kind: "all" }, config: { defaultModel: "" }, mainModel,
		})).toThrow(/cannot be empty/);
		expect(() => resolveSubagentAssignmentSelection({
			target: { kind: "agent", name: "worker" }, agent: agent(),
			config: { agentThinkingLevels: { worker: "ultra" } }, mainModel,
		})).toThrow(/must be one of/);
		expect(() => resolveSubagentAssignmentSelection({
			target: { kind: "agent", name: "worker" }, agent: agent(),
			config: { agentContextWindows: { worker: 0 } }, mainModel,
		})).toThrow(/positive integer/);
	});
});

describe("subagent assignment edits", () => {
	function editHarness(content?: string): {
		settingsPath: string;
		store: ReturnType<typeof createSubagentConfigStore>;
		subagents: () => Record<string, unknown>;
	} {
		const { settingsPath } = configHarness(content);
		return {
			settingsPath,
			store: createSubagentConfigStore({ settingsPath }),
			subagents: () => (JSON.parse(readFileSync(settingsPath, "utf8")) as { subagents: Record<string, unknown> }).subagents,
		};
	}

	async function expectEditRejected(
		content: string,
		edit: SubagentAssignmentEdit,
		pattern: RegExp,
	): Promise<void> {
		const { settingsPath, store } = editHarness(content);
		await expect(store.applyAssignmentEdit(edit)).rejects.toThrow(pattern);
		expect(readFileSync(settingsPath, "utf8")).toBe(content);
	}

	it("sets both globals and clears both individual maps with one combined edit", async () => {
		const { store, subagents } = editHarness(
			'{"subagents":{"custom":true,"agentModels":{"worker":"openai/old"},"agentThinkingLevels":{"worker":"low"}}}',
		);
		await store.applyAssignmentEdit({
			target: { kind: "all" },
			model: { kind: "set", setting: "openai/new" },
			thinking: { kind: "set", level: "high" },
		});
		expect(subagents()).toEqual({
			custom: true,
			defaultModel: "openai/new",
			agentModels: {},
			defaultThinkingLevel: "high",
			agentThinkingLevels: {},
		});
	});

	it("sets both individual overrides with one combined edit", async () => {
		const { store, subagents } = editHarness('{"subagents":{"defaultModel":"openai/global"}}');
		await store.applyAssignmentEdit({
			target: { kind: "agent", name: "worker" },
			model: { kind: "set", setting: "openai/new" },
			thinking: { kind: "set", level: "high" },
		});
		expect(subagents()).toEqual({
			defaultModel: "openai/global",
			agentModels: { worker: "openai/new" },
			agentThinkingLevels: { worker: "high" },
		});
	});

	it("removes only the named override for individual inheritance", async () => {
		const { store, subagents } = editHarness(
			'{"subagents":{"agentModels":{"explorer":"anthropic/old","worker":"openai/old"},"agentThinkingLevels":{"explorer":"low","worker":"high"}}}',
		);
		await store.applyAssignmentEdit({ target: { kind: "agent", name: "worker" }, model: { kind: "inherit" } });
		expect(subagents()).toEqual({
			agentModels: { explorer: "anthropic/old" },
			agentThinkingLevels: { explorer: "low", worker: "high" },
		});
		await store.applyAssignmentEdit({ target: { kind: "agent", name: "worker" }, thinking: { kind: "inherit" } });
		expect(subagents()).toEqual({
			agentModels: { explorer: "anthropic/old" },
			agentThinkingLevels: { explorer: "low" },
		});
	});

	it("restores global Pi-default thinking and clears individual overrides", async () => {
		const { store, subagents } = editHarness(
			'{"subagents":{"defaultModel":"main","defaultThinkingLevel":"high","agentThinkingLevels":{"worker":"low"},"defaultContextWindow":200000}}',
		);
		await store.applyAssignmentEdit({ target: { kind: "all" }, thinking: { kind: "default" } });
		expect(subagents()).toEqual({
			defaultModel: "main",
			agentThinkingLevels: {},
			defaultContextWindow: 200000,
		});
	});

	it("preserves unrelated settings and namespace keys through every edit", async () => {
		const { settingsPath, store } = editHarness(
			'{"unrelated":1,"subagents":{"custom":true,"maxConcurrency":2,"defaultModel":"main","agentModels":{"worker":"openai/old"},"agentThinkingLevels":{"worker":"low"},"defaultContextWindow":200000,"agentContextWindows":{"worker":131072}}}',
		);
		await store.applyAssignmentEdit({ target: { kind: "all" }, model: { kind: "set", setting: "openai/new" } });
		await store.applyAssignmentEdit({ target: { kind: "agent", name: "worker" }, thinking: { kind: "set", level: "low" } });
		await store.applyAssignmentEdit({ target: { kind: "agent", name: "worker" }, model: { kind: "inherit" } });
		await store.applyAssignmentEdit({ target: { kind: "all" }, thinking: { kind: "default" } });
		expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({
			unrelated: 1,
			subagents: {
				custom: true,
				maxConcurrency: 2,
				defaultModel: "openai/new",
				agentModels: {},
				agentThinkingLevels: {},
				defaultContextWindow: 200000,
				agentContextWindows: { worker: 131072 },
			},
		});
	});

	it("leaves the preview snapshot unchanged", async () => {
		const { store } = editHarness('{"subagents":{"agentModels":{"worker":"openai/old"}}}');
		const snapshot = store.load();
		const before = structuredClone(snapshot);
		store.resolveAssignment(agent(), {
			snapshot,
			edit: {
				target: { kind: "all" },
				model: { kind: "set", setting: "openai/new" },
				thinking: { kind: "set", level: "high" },
			},
		});
		expect(snapshot).toEqual(before);
	});

	it("resolves the same effective assignment through preview and commit", async () => {
		const { store } = editHarness('{"subagents":{"agentModels":{"worker":"openai/old"}}}');
		store.rememberMainModel(mainModel);
		const edit: SubagentAssignmentEdit = { target: { kind: "agent", name: "worker" }, model: { kind: "inherit" } };
		const previewed = store.resolveAssignment(agent(), { snapshot: store.load(), edit });
		await store.applyAssignmentEdit(edit);
		expect(store.resolveAssignment(agent(), { snapshot: store.load() })).toEqual(previewed);
	});

	it("writes nothing when one field of a combined edit is invalid", async () => {
		await expectEditRejected(
			'{"subagents":{"agentModels":{"worker":"openai/old"}}}',
			{
				target: { kind: "agent", name: "worker" },
				model: { kind: "set", setting: "openai/new" },
				thinking: { kind: "set", level: "ultra" as SubagentThinkingLevel },
			},
			/must be one of/,
		);
	});

	it("rejects an edit with neither a model nor a thinking change", async () => {
		await expectEditRejected(
			'{"subagents":{"defaultModel":"main"}}',
			{ target: { kind: "all" } },
			/Subagent assignment edit must include a model or thinking change/,
		);
	});

	it("rejects global model inheritance without writing", async () => {
		await expectEditRejected(
			'{"subagents":{"agentModels":{"worker":"openai/old"}}}',
			{ target: { kind: "all" }, model: { kind: "inherit" } },
			/"inherit" applies only to an individual agent/,
		);
	});

	it("rejects global thinking inheritance without writing", async () => {
		await expectEditRejected(
			'{"subagents":{}}',
			{ target: { kind: "all" }, thinking: { kind: "inherit" } },
			/Subagent thinking level for all must be one of/,
		);
	});

	it("rejects individual Pi-default thinking without writing", async () => {
		await expectEditRejected(
			'{"subagents":{}}',
			{ target: { kind: "agent", name: "worker" }, thinking: { kind: "default" } },
			/Subagent thinking level for worker must be one of/,
		);
	});

	it("rejects empty agent names without writing", async () => {
		await expectEditRejected(
			'{"subagents":{}}',
			{ target: { kind: "agent", name: "  " }, model: { kind: "set", setting: "openai/new" } },
			/agent name cannot be empty/,
		);
		await expectEditRejected(
			'{"subagents":{}}',
			{ target: { kind: "agent", name: "" }, thinking: { kind: "inherit" } },
			/agent name cannot be empty/,
		);
	});

	it("retains current diagnostics for invalid model and thinking values", async () => {
		await expectEditRejected(
			'{"subagents":{}}',
			{ target: { kind: "all" }, model: { kind: "set", setting: "invalid" } },
			/default model must be "main" or a canonical "provider\/model" identifier/,
		);
		await expectEditRejected(
			'{"subagents":{}}',
			{ target: { kind: "agent", name: "worker" }, model: { kind: "set", setting: "" } },
			/cannot be empty/,
		);
		await expectEditRejected(
			'{"subagents":{}}',
			{ target: { kind: "agent", name: "worker" }, thinking: { kind: "set", level: "ultra" as SubagentThinkingLevel } },
			/Subagent thinking level for worker must be one of/,
		);
		await expectEditRejected(
			'{"subagents":{}}',
			{ target: { kind: "all" }, thinking: { kind: "set", level: "ultra" as SubagentThinkingLevel } },
			/Subagent default thinking level must be one of/,
		);
	});

	it("rejects unknown edit kinds without writing", async () => {
		await expectEditRejected(
			'{"subagents":{}}',
			{ target: { kind: "all" }, model: { kind: "bogus" } as never },
			/Unknown subagent model edit kind/,
		);
		await expectEditRejected(
			'{"subagents":{}}',
			{ target: { kind: "all" }, thinking: { kind: "bogus" } as never },
			/Unknown subagent thinking edit kind/,
		);
	});

	it("rejects unknown assignment targets without writing", async () => {
		await expectEditRejected(
			'{"subagents":{}}',
			{ target: { kind: "bogus" } as never, model: { kind: "inherit" } },
			/Unknown subagent assignment target/,
		);
	});

	it("applies model before thinking so a configured suffix keeps precedence", async () => {
		const { store } = editHarness("{}");
		store.rememberMainModel(mainModel);
		await store.applyAssignmentEdit({
			target: { kind: "all" },
			model: { kind: "set", setting: "openai/global:high" },
			thinking: { kind: "set", level: "low" },
		});
		expect(store.resolveAssignment(agent(), { snapshot: store.load() })).toEqual({
			modelSetting: "openai/global",
			launch: { model: "openai/global", thinkingLevel: "high", contextWindow: undefined },
		});
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

	it("commits a combined edit as one atomic Settings update and preserves unknown settings", async () => {
		const { settingsPath } = configHarness(
			'{"compaction":{"threshold":0.1},"subagents":{"maxConcurrency":3,"custom":true,"defaultModel":"main"}}',
		);
		const store = createSubagentConfigStore({ settingsPath });
		await store.applyAssignmentEdit({
			target: { kind: "agent", name: "worker" },
			model: { kind: "set", setting: "openai/test" },
			thinking: { kind: "set", level: "high" },
		});
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
			first.applyAssignmentEdit({ target: { kind: "agent", name: "worker" }, model: { kind: "set", setting: "openai/test" } }),
			second.applyAssignmentEdit({ target: { kind: "agent", name: "worker" }, thinking: { kind: "set", level: "high" } }),
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
		await store.applyAssignmentEdit({ target: { kind: "agent", name: "worker" }, thinking: { kind: "set", level: "low" } });
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
			edit: { target: { kind: "agent", name: "worker" }, model: { kind: "inherit" } },
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

	it("delegates selections to the pure resolver without writing", async () => {
		const content = '{"subagents":{"defaultModel":"main","agentModels":{"worker":"openai/old"}}}';
		const { settingsPath } = configHarness(content);
		const store = createSubagentConfigStore({ settingsPath });
		store.rememberMainModel(mainModel);
		const snapshot = store.load();
		const before = structuredClone(snapshot);

		const current = store.resolveAssignmentSelection({ target: { kind: "agent", name: "worker" }, agent: agent(), snapshot });
		expect(current).toEqual(resolveSubagentAssignmentSelection({
			target: { kind: "agent", name: "worker" },
			agent: agent(),
			config: snapshot,
			mainModel,
		}));
		const pending = store.resolveAssignmentSelection({
			target: { kind: "agent", name: "worker" },
			agent: agent(),
			snapshot,
			edit: { target: { kind: "agent", name: "worker" }, model: { kind: "inherit" } },
		});

		expect(pending.model).toEqual({ kind: "inherit" });
		expect(pending.assignment.launch.model).toBe("anthropic/claude-sonnet-4-6");
		expect(snapshot).toEqual(before);
		expect(readFileSync(settingsPath, "utf8")).toBe(content);

		await store.applyAssignmentEdit({ target: { kind: "agent", name: "worker" }, model: { kind: "inherit" } });
		expect(store.resolveAssignmentSelection({ target: { kind: "agent", name: "worker" }, agent: agent() })).toEqual(pending);
		store.rememberMainModel({ provider: "anthropic", id: "second" });
		expect(store.resolveAssignmentSelection({ target: { kind: "all" } }).assignment.launch.model).toBe("anthropic/second");
		expect(Object.keys(store.resolveLaunch(agent())).sort()).toEqual(["contextWindow", "model", "thinkingLevel"]);
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
