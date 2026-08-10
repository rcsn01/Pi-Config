import { describe, expect, it } from "vitest";
import {
	appendChildModelArgument,
	appendChildThinkingArgument,
	canonicalMainModel,
	clearAllThinkingAssignments,
	parseModelConfiguration,
	removeAgentModelAssignment,
	removeAgentThinkingAssignment,
	resolveLaunchConfiguration,
	resolveModelAssignment,
	selectModelSetting,
	setAgentModelAssignment,
	setAgentThinkingAssignment,
	setAllModelAssignments,
	setAllThinkingAssignments,
	splitModelThinkingSetting,
} from "./model-config.ts";

const mainModel = { provider: "anthropic", id: "claude-sonnet-4-6" };

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
		})).toEqual({ model: "openai/gpt-5.4", thinkingLevel: "off" });
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
		expect(() => parseModelConfiguration([])).toThrow(/must contain a JSON object/);
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
