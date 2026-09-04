import * as fs from "node:fs";
import { getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	findExactModel,
	listSelectableModels,
	modelKey,
} from "../_shared/model-picker.ts";
import { THINKING_DESCRIPTIONS } from "../_shared/model-thinking.ts";
import { pickSelectScreen, type SelectScreenItem } from "../_shared/select-screen.ts";
import type { AgentConfig } from "../_shared/subagent-service.ts";
import { agentRegistry, type AgentRegistry } from "./agent-registry.ts";
import {
	canonicalMainModel,
	clearAllThinkingAssignments,
	normalizeModelSetting,
	normalizeThinkingLevel,
	removeAgentModelAssignment,
	removeAgentThinkingAssignment,
	selectModelSetting,
	setAgentModelAssignment,
	setAgentThinkingAssignment,
	setAllModelAssignments,
	setAllThinkingAssignments,
	splitModelThinkingSetting,
	THINKING_LEVELS,
	getDefaultSubagentConfig,
	type ModelConfiguration,
	type SubagentConfigStore,
	type SubagentThinkingLevel,
} from "./config.ts";
import { formatContextWindow } from "./formatting.ts";
import { DEFAULT_MAX_CONCURRENCY } from "./subagent-execution.ts";
import { BUILTIN_TOOLS, CUSTOM_TOOL_EXTENSIONS, EXT_BASE } from "./child-execution.ts";

export interface ModelCommandDependencies {
	registry?: AgentRegistry;
	config?: SubagentConfigStore;
}

export function createSubagentsCommand(dependencies: ModelCommandDependencies = {}) {
	const registry = dependencies.registry ?? agentRegistry;
	const configStore = dependencies.config ?? getDefaultSubagentConfig();
	const SUBAGENT_MODEL_USAGE = [
		"Usage:",
		"  /subagents",
		"  /subagents status",
		"  /subagents models",
		"  /subagents model",
		"  /subagents model all <main|provider/model>",
		"  /subagents model <agent> <main|provider/model|inherit>",
		"  /subagents thinking all <default|off|minimal|low|medium|high|xhigh|max>",
		"  /subagents thinking <agent> <inherit|off|minimal|low|medium|high|xhigh|max>",
	].join("\n");

	function selectedModelSettingForAgent(agent: AgentConfig, config: ModelConfiguration): string {
		return selectModelSetting({
			agentName: agent.name,
			config,
			frontmatterModel: agent.model,
		});
	}

	function effectiveModelForAgent(agent: AgentConfig, config: ModelConfiguration): { setting: string; resolved: string } {
		const selected = selectedModelSettingForAgent(agent, config);
		const split = splitModelThinkingSetting(selected);
		return {
			setting: split.model,
			resolved: split.model === "main" ? canonicalMainModel(configStore.getMainModel()) : split.model,
		};
	}

	function effectiveThinkingForAgent(agent: AgentConfig, config: ModelConfiguration): SubagentThinkingLevel | undefined {
		if (Object.hasOwn(config.agentThinkingLevels, agent.name)) return config.agentThinkingLevels[agent.name];
		const selected = splitModelThinkingSetting(selectedModelSettingForAgent(agent, config));
		return selected.thinkingLevel ?? config.defaultThinkingLevel;
	}

	function effectiveContextWindowForAgent(agent: AgentConfig, config: ModelConfiguration): number | undefined {
		if (Object.hasOwn(config.agentContextWindows, agent.name)) return config.agentContextWindows[agent.name];
		return config.defaultContextWindow;
	}

	function contextDisplay(contextWindow: number | undefined): string {
		return contextWindow === undefined ? "Pi default" : formatContextWindow(contextWindow);
	}

	function modelDisplay(setting: string, resolved: string): string {
		return setting === resolved ? resolved : `${setting} → ${resolved}`;
	}

	function thinkingDisplay(level: SubagentThinkingLevel | undefined): string {
		return level ?? "Pi default";
	}

	function statusLines(availableAgents: AgentConfig[]): string[] {
		const config = configStore.load();
		const lines = [
			"Subagents status:",
			`Extensions dir: ${EXT_BASE}`,
			`Max concurrency: ${config.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY}`,
			`Main model: ${canonicalMainModel(configStore.getMainModel())}`,
			"",
			"Agents:",
		];
		for (const agent of availableAgents) {
			const missing = agent.tools
				.filter((tool) => !BUILTIN_TOOLS.has(tool) && (!CUSTOM_TOOL_EXTENSIONS[tool] || !fs.existsSync(CUSTOM_TOOL_EXTENSIONS[tool])))
				.map((tool) => `${tool}${CUSTOM_TOOL_EXTENSIONS[tool] ? ` (${CUSTOM_TOOL_EXTENSIONS[tool]})` : " (unmapped)"}`);
			const effective = effectiveModelForAgent(agent, config);
			lines.push(`- ${agent.name}: ${agent.description || "(no description)"}`);
			lines.push(`  model: ${modelDisplay(effective.setting, effective.resolved)}`);
			lines.push(`  thinking: ${thinkingDisplay(effectiveThinkingForAgent(agent, config))}`);
			lines.push(`  context: ${contextDisplay(effectiveContextWindowForAgent(agent, config))}`);
			lines.push(`  tools: ${agent.tools.join(", ") || "none"}`);
			if (missing.length) lines.push(`  missing: ${missing.join(", ")}`);
		}
		return lines;
	}

	function modelStatusLines(availableAgents: AgentConfig[]): string[] {
		const config = configStore.load();
		const modelOverrides = Object.entries(config.agentModels);
		const thinkingOverrides = Object.entries(config.agentThinkingLevels)
			.filter((entry): entry is [string, SubagentThinkingLevel] => entry[1] !== undefined);
		const contextOverrides = Object.entries(config.agentContextWindows)
			.filter((entry): entry is [string, number] => entry[1] !== undefined);
		const lines = [
			"Subagent model and thinking configuration:",
			`Main model: ${canonicalMainModel(configStore.getMainModel())}`,
			`Global model: ${config.defaultModel ?? "(unset; frontmatter/main fallback)"}`,
			`Global thinking: ${thinkingDisplay(config.defaultThinkingLevel)}`,
			`Global context: ${contextDisplay(config.defaultContextWindow)}`,
			"Individual model overrides:",
			...(modelOverrides.length > 0
				? modelOverrides.sort(([left], [right]) => left.localeCompare(right)).map(([name, model]) => `- ${name}: ${model}`)
				: ["- (none)"]),
			"Individual thinking overrides:",
			...(thinkingOverrides.length > 0
				? thinkingOverrides.sort(([left], [right]) => left.localeCompare(right)).map(([name, level]) => `- ${name}: ${level}`)
				: ["- (none)"]),
			"Individual context overrides:",
			...(contextOverrides.length > 0
				? contextOverrides.sort(([left], [right]) => left.localeCompare(right)).map(([name, contextWindow]) => `- ${name}: ${formatContextWindow(contextWindow)}`)
				: ["- (none)"]),
			"",
			"Effective assignments:",
		];
		for (const agent of availableAgents) {
			const effective = effectiveModelForAgent(agent, config);
			lines.push(`- ${agent.name}: ${modelDisplay(effective.setting, effective.resolved)} · thinking ${thinkingDisplay(effectiveThinkingForAgent(agent, config))} · context ${contextDisplay(effectiveContextWindowForAgent(agent, config))}`);
		}
		return lines;
	}

	function catalogueModelReference(setting: string): string {
		return splitModelThinkingSetting(setting).model;
	}

	async function validateAvailableModel(setting: string, ctx: ExtensionContext): Promise<boolean> {
		if (setting === "main") return true;
		let models: Model<Api>[];
		try {
			models = await listSelectableModels(ctx);
		} catch (error) {
			ctx.ui.notify(`Could not refresh Pi's model catalogue: ${error instanceof Error ? error.message : String(error)}`, "error");
			return false;
		}
		// An aborted refresh yields an empty catalogue; reject quietly.
		if (ctx.signal?.aborted) return false;
		const reference = catalogueModelReference(setting);
		if (findExactModel(models, reference)) return true;
		ctx.ui.notify(
			`Unavailable or unauthenticated model: ${reference}\n\n${SUBAGENT_MODEL_USAGE}`,
			"error",
		);
		return false;
	}

	async function updateConfigDocument(
		update: (document: Record<string, unknown>) => Record<string, unknown>,
	): Promise<Record<string, unknown>> {
		return configStore.update(update);
	}

	async function applyModelCommand(
		target: string,
		rawValue: string,
		availableAgents: AgentConfig[],
		ctx: ExtensionContext,
	): Promise<void> {
		const agent = availableAgents.find((candidate) => candidate.name === target);
		if (target !== "all" && !agent) {
			ctx.ui.notify(`Unknown subagent: ${target}. Available: ${availableAgents.map((item) => item.name).join(", ") || "none"}\n\n${SUBAGENT_MODEL_USAGE}`, "error");
			return;
		}

		const value = rawValue.trim();
		if (value.toLowerCase() === "inherit") {
			if (target === "all") {
				ctx.ui.notify(`"inherit" applies only to an individual agent.\n\n${SUBAGENT_MODEL_USAGE}`, "error");
				return;
			}
			await updateConfigDocument((document) => removeAgentModelAssignment(document, target));
			ctx.ui.notify(`${target} now inherits the global/frontmatter model setting.`, "info");
			return;
		}

		let setting: string;
		try {
			setting = normalizeModelSetting(value, `model for ${target}`);
		} catch (error) {
			ctx.ui.notify(`${error instanceof Error ? error.message : String(error)}\n\n${SUBAGENT_MODEL_USAGE}`, "error");
			return;
		}
		if (!(await validateAvailableModel(setting, ctx))) return;

		if (target === "all") {
			await updateConfigDocument((document) => setAllModelAssignments(document, setting));
			ctx.ui.notify(`All subagents now use ${setting}; individual overrides were cleared.`, "info");
		} else {
			await updateConfigDocument((document) => setAgentModelAssignment(document, target, setting));
			ctx.ui.notify(`${target} now uses ${setting}.`, "info");
		}
	}

	async function applyThinkingCommand(
		target: string,
		rawValue: string,
		availableAgents: AgentConfig[],
		ctx: ExtensionContext,
	): Promise<void> {
		const agent = availableAgents.find((candidate) => candidate.name === target);
		if (target !== "all" && !agent) {
			ctx.ui.notify(`Unknown subagent: ${target}. Available: ${availableAgents.map((item) => item.name).join(", ") || "none"}\n\n${SUBAGENT_MODEL_USAGE}`, "error");
			return;
		}

		const value = rawValue.trim().toLowerCase();
		if (target === "all" && value === "default") {
			await updateConfigDocument(clearAllThinkingAssignments);
			ctx.ui.notify("All subagents now use Pi's default thinking behavior; individual thinking overrides were cleared.", "info");
			return;
		}
		if (target !== "all" && value === "inherit") {
			await updateConfigDocument((document) => removeAgentThinkingAssignment(document, target));
			ctx.ui.notify(`${target} now inherits the global/Pi default thinking level.`, "info");
			return;
		}

		let level: SubagentThinkingLevel;
		try {
			level = normalizeThinkingLevel(value, `thinking level for ${target}`);
		} catch (error) {
			ctx.ui.notify(`${error instanceof Error ? error.message : String(error)}\n\n${SUBAGENT_MODEL_USAGE}`, "error");
			return;
		}

		if (target === "all") {
			await updateConfigDocument((document) => setAllThinkingAssignments(document, level));
			ctx.ui.notify(`All subagents now use ${level} thinking; individual thinking overrides were cleared.`, "info");
		} else {
			await updateConfigDocument((document) => setAgentThinkingAssignment(document, target, level));
			ctx.ui.notify(`${target} now uses ${level} thinking.`, "info");
		}
	}

	async function applyInteractiveConfiguration(
		target: string,
		rawModel: string,
		rawThinking: string,
		availableAgents: AgentConfig[],
		ctx: ExtensionContext,
	): Promise<void> {
		const agent = availableAgents.find((candidate) => candidate.name === target);
		if (target !== "all" && !agent) throw new Error(`Unknown subagent: ${target}`);

		const modelValue = rawModel.trim();
		const inheritModel = modelValue.toLowerCase() === "inherit";
		if (target === "all" && inheritModel) throw new Error('"inherit" applies only to an individual agent model.');
		const modelSetting = inheritModel ? undefined : normalizeModelSetting(modelValue, `model for ${target}`);
		if (modelSetting && !(await validateAvailableModel(modelSetting, ctx))) return;

		const thinkingValue = rawThinking.trim().toLowerCase();
		const clearThinking = target === "all" && thinkingValue === "default";
		const inheritThinking = target !== "all" && thinkingValue === "inherit";
		if (!clearThinking && !inheritThinking) normalizeThinkingLevel(thinkingValue, `thinking level for ${target}`);

		await updateConfigDocument((document) => {
			let next = target === "all"
				? setAllModelAssignments(document, modelSetting!)
				: inheritModel
					? removeAgentModelAssignment(document, target)
					: setAgentModelAssignment(document, target, modelSetting!);

			if (clearThinking) next = clearAllThinkingAssignments(next);
			else if (inheritThinking) next = removeAgentThinkingAssignment(next, target);
			else if (target === "all") next = setAllThinkingAssignments(next, thinkingValue);
			else next = setAgentThinkingAssignment(next, target, thinkingValue);
			return next;
		});

		const modelNote = inheritModel ? "inherited model" : modelSetting;
		const thinkingNote = clearThinking ? "Pi default thinking" : inheritThinking ? "inherited thinking" : `${thinkingValue} thinking`;
		ctx.ui.notify(
			target === "all"
				? `All subagents now use ${modelNote} with ${thinkingNote}; individual overrides were cleared.`
				: `${target} now uses ${modelNote} with ${thinkingNote}.`,
			"info",
		);
	}

	async function selectSubagentTarget(
		availableAgents: AgentConfig[],
		ctx: ExtensionContext,
	): Promise<string | undefined> {
		const config = configStore.load();
		const defaultSelection = config.defaultModel
			? splitModelThinkingSetting(config.defaultModel)
			: undefined;
		const defaultModel = defaultSelection
			? modelDisplay(defaultSelection.model, defaultSelection.model === "main" ? canonicalMainModel(configStore.getMainModel()) : defaultSelection.model)
			: "(unset; per-agent fallback)";
		const defaultThinking = defaultSelection?.thinkingLevel ?? config.defaultThinkingLevel;
		const items = [
			{
				value: "all",
				label: "All subagents",
				description: `${defaultModel} · thinking ${thinkingDisplay(defaultThinking)} · clears individual overrides`,
			},
			...availableAgents.map((agent) => {
				const effective = effectiveModelForAgent(agent, config);
				return {
					value: agent.name,
					label: agent.name,
					description: `${modelDisplay(effective.setting, effective.resolved)} · thinking ${thinkingDisplay(effectiveThinkingForAgent(agent, config))}`,
				};
			}),
		];

		return pickSelectScreen(ctx, {
			title: "Configure subagents",
			subtitle: "Choose all subagents or one agent to change model and thinking",
			items,
			columns: { minPrimaryColumnWidth: 18, maxPrimaryColumnWidth: 28 },
			cancelVerb: "close",
		});
	}

	async function selectSubagentModel(
		target: string,
		availableAgents: AgentConfig[],
		models: readonly Model<Api>[],
		ctx: ExtensionContext,
	): Promise<string | undefined> {
		const config = configStore.load();
		const agent = target === "all" ? undefined : availableAgents.find((candidate) => candidate.name === target);
		if (target !== "all" && !agent) throw new Error(`Unknown subagent: ${target}`);

		const hasOverride = target !== "all" && Object.hasOwn(config.agentModels, target);
		const currentValue = target === "all"
			? config.defaultModel ?? "main"
			: hasOverride
				? config.agentModels[target]!
				: "inherit";
		const currentModelValue = currentValue === "inherit"
			? currentValue
			: splitModelThinkingSetting(currentValue).model;
		const mainModel = canonicalMainModel(configStore.getMainModel());
		const choices: SelectScreenItem[] = [];

		if (agent) {
			const inheritedAgentModels = { ...config.agentModels };
			delete inheritedAgentModels[target];
			const inherited = effectiveModelForAgent(agent, { ...config, agentModels: inheritedAgentModels });
			choices.push({
				value: "inherit",
				label: "Inherit global/frontmatter setting",
				description: `Uses ${modelDisplay(inherited.setting, inherited.resolved)}`,
				searchText: "inherit default global frontmatter",
			});
		}

		choices.push({
			value: "main",
			label: "Main session model",
			description: `${mainModel} · follows future /model changes`,
			searchText: `main default ${mainModel}`,
		});

		const configuredReference = currentModelValue === "main" || currentModelValue === "inherit"
			? undefined
			: currentModelValue;
		for (const model of models) {
			const reference = modelKey(model);
			const isCurrent = reference === configuredReference;
			choices.push({
				value: reference,
				label: reference,
				description: `${model.name} · ${formatContextWindow(model.contextWindow)} · ${model.reasoning ? "thinking" : "no thinking"}${isCurrent && currentValue !== reference ? ` · configured as ${currentValue}` : ""}`,
				searchText: `${reference} ${model.name}`,
			});
		}

		return pickSelectScreen(ctx, {
			title: `Select model for ${target === "all" ? "all subagents" : target}`,
			items: choices,
			currentValue: currentModelValue,
			showCurrentMarker: true,
			search: {},
			columns: { minPrimaryColumnWidth: 30, maxPrimaryColumnWidth: 52 },
			confirmVerb: "next",
			cancelVerb: "back",
		});
	}

	function modelSettingAfterChoice(
		target: string,
		choice: string,
		agent: AgentConfig | undefined,
		config: ModelConfiguration,
	): string {
		if (choice !== "inherit") return choice;
		if (!agent || target === "all") throw new Error('"inherit" requires an individual subagent.');
		const inheritedAgentModels = { ...config.agentModels };
		delete inheritedAgentModels[target];
		return selectModelSetting({
			agentName: agent.name,
			config: { ...config, agentModels: inheritedAgentModels },
			frontmatterModel: agent.model,
		});
	}

	function findCatalogueModel(
		setting: string,
		models: readonly Model<Api>[],
		ctx: ExtensionContext,
	): Model<Api> | undefined {
		const selected = splitModelThinkingSetting(setting).model;
		const reference = selected === "main" ? canonicalMainModel(configStore.getMainModel()) : selected;
		const listed = models.find((model) => modelKey(model) === reference);
		if (listed) return listed;
		const slash = reference.indexOf("/");
		return slash > 0
			? ctx.modelRegistry.find(reference.slice(0, slash), reference.slice(slash + 1))
			: undefined;
	}

	async function selectSubagentThinking(
		target: string,
		modelChoice: string,
		availableAgents: AgentConfig[],
		models: readonly Model<Api>[],
		ctx: ExtensionContext,
	): Promise<string | undefined> {
		const config = configStore.load();
		const agent = target === "all" ? undefined : availableAgents.find((candidate) => candidate.name === target);
		if (target !== "all" && !agent) throw new Error(`Unknown subagent: ${target}`);

		const pendingModelSetting = modelSettingAfterChoice(target, modelChoice, agent, config);
		const catalogueModel = findCatalogueModel(pendingModelSetting, models, ctx);
		const supported = catalogueModel
			? getSupportedThinkingLevels(catalogueModel).map((level) => normalizeThinkingLevel(level))
			: [...THINKING_LEVELS];

		const currentModelSetting = target === "all"
			? config.defaultModel ?? "main"
			: selectedModelSettingForAgent(agent!, config);
		const pendingModel = splitModelThinkingSetting(pendingModelSetting).model;
		const currentModel = splitModelThinkingSetting(currentModelSetting);
		const sameModel = currentModel.model === pendingModel;
		const currentValue = target === "all"
			? sameModel && currentModel.thinkingLevel
				? currentModel.thinkingLevel
				: config.defaultThinkingLevel ?? "default"
			: Object.hasOwn(config.agentThinkingLevels, target)
				? config.agentThinkingLevels[target]!
				: sameModel && currentModel.thinkingLevel
					? currentModel.thinkingLevel
					: "inherit";

		const items: Array<{ value: string; label: string; description: string }> = [];
		if (target === "all") {
			items.push({
				value: "default",
				label: "Pi default",
				description: "Do not pass a --thinking override to child Pi processes",
			});
		} else {
			const inheritedAgentThinking = { ...config.agentThinkingLevels };
			delete inheritedAgentThinking[target];
			const inheritedConfig = { ...config, agentThinkingLevels: inheritedAgentThinking };
			const inheritedModelSetting = modelSettingAfterChoice(target, modelChoice, agent, inheritedConfig);
			const inheritedSplit = splitModelThinkingSetting(inheritedModelSetting);
			const inheritedLevel = inheritedSplit.thinkingLevel ?? inheritedConfig.defaultThinkingLevel;
			items.push({
				value: "inherit",
				label: "Inherit global/Pi default",
				description: `Uses ${thinkingDisplay(inheritedLevel)}`,
			});
		}

		for (const level of supported) {
			items.push({
				value: level,
				label: level,
				description: THINKING_DESCRIPTIONS[level],
			});
		}

		const modelLabel = splitModelThinkingSetting(pendingModelSetting).model;
		return pickSelectScreen(ctx, {
			title: `Select thinking for ${target === "all" ? "all subagents" : target}`,
			subtitle: `Model: ${modelLabel}`,
			items,
			currentValue,
			showCurrentMarker: true,
			maxVisibleRows: 10,
			columns: { minPrimaryColumnWidth: 24, maxPrimaryColumnWidth: 36 },
			confirmVerb: "apply",
			cancelVerb: "back",
		});
	}

	async function runInteractiveModelCommand(availableAgents: AgentConfig[], ctx: ExtensionContext): Promise<void> {
		if (ctx.mode !== "tui") {
			ctx.ui.notify(`Interactive subagent model configuration requires TUI mode.\n\n${SUBAGENT_MODEL_USAGE}`, "error");
			return;
		}
		let models: Model<Api>[];
		try {
			models = await listSelectableModels(ctx);
		} catch (error) {
			ctx.ui.notify(`Could not refresh Pi's model catalogue: ${error instanceof Error ? error.message : String(error)}`, "error");
			return;
		}
		// An aborted refresh yields an empty catalogue; exit without notifying.
		if (ctx.signal?.aborted) return;

		while (true) {
			const target = await selectSubagentTarget(availableAgents, ctx);
			if (!target) return;

			// Back from thinking returns to model selection for the same target;
			// Back from model selection returns to target selection.
			while (true) {
				const model = await selectSubagentModel(target, availableAgents, models, ctx);
				if (model === undefined) break;
				const thinking = await selectSubagentThinking(target, model, availableAgents, models, ctx);
				if (thinking === undefined) continue;
				await applyInteractiveConfiguration(target, model, thinking, availableAgents, ctx);
				break;
			}
		}
	}


	return {
		description: "View and configure subagent models and thinking levels",
		getArgumentCompletions: (prefix: string) => {
			const agentCommands = registry.load().flatMap((agent) => [
				`model ${agent.name} main`,
				`thinking ${agent.name} inherit`,
			]);
			const values = ["status", "models", "model", "model all main", "thinking all default", "thinking all medium", ...agentCommands];
			const matches = values.filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value }));
			return matches.length > 0 ? matches : null;
		},
		handler: async (args: string, ctx: ExtensionContext) => {
			configStore.rememberMainModel(ctx.model);
			const agents = registry.load();
			const parts = args.trim().split(/\s+/).filter(Boolean);
			try {
				if (parts.length === 0) {
					if (ctx.mode === "tui") await runInteractiveModelCommand(agents, ctx);
					else ctx.ui.notify(statusLines(agents).join("\n"), "info");
					return;
				}
				if (parts.length === 1 && parts[0] === "status") {
					ctx.ui.notify(statusLines(agents).join("\n"), "info");
					return;
				}
				if (parts.length === 1 && parts[0] === "models") {
					ctx.ui.notify(modelStatusLines(agents).join("\n"), "info");
					return;
				}
				if (parts[0] === "model") {
					if (parts.length === 1) {
						await runInteractiveModelCommand(agents, ctx);
						return;
					}
					if (parts.length === 3) {
						await applyModelCommand(parts[1]!, parts[2]!, agents, ctx);
						return;
					}
				}
				if (parts[0] === "thinking" && parts.length === 3) {
					await applyThinkingCommand(parts[1]!, parts[2]!, agents, ctx);
					return;
				}
				ctx.ui.notify(SUBAGENT_MODEL_USAGE, "error");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	};
}
