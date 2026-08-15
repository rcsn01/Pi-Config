import * as fs from "node:fs";
import { getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Input, SelectList, truncateToWidth } from "@earendil-works/pi-tui";
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
	subagentConfig,
	type ModelConfiguration,
	type SubagentConfigStore,
	type SubagentThinkingLevel,
} from "./config.ts";
import { formatContextWindow } from "./formatting.ts";
import { DEFAULT_MAX_CONCURRENCY } from "./parallel-runner.ts";
import { BUILTIN_TOOLS, CUSTOM_TOOL_EXTENSIONS, EXT_BASE } from "./subagent-runner.ts";

export interface ModelCommandDependencies {
	registry?: AgentRegistry;
	config?: SubagentConfigStore;
}

export function createSubagentsCommand(dependencies: ModelCommandDependencies = {}) {
	const registry = dependencies.registry ?? agentRegistry;
	const configStore = dependencies.config ?? subagentConfig;
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
			lines.push(`  tools: ${agent.tools.join(", ") || "none"}`);
			if (missing.length) lines.push(`  missing: ${missing.join(", ")}`);
		}
		return lines;
	}

	function modelStatusLines(availableAgents: AgentConfig[]): string[] {
		const config = configStore.load();
		const modelOverrides = Object.entries(config.agentModels);
		const thinkingOverrides = Object.entries(config.agentThinkingLevels);
		const lines = [
			"Subagent model and thinking configuration:",
			`Main model: ${canonicalMainModel(configStore.getMainModel())}`,
			`Global model: ${config.defaultModel ?? "(unset; frontmatter/main fallback)"}`,
			`Global thinking: ${thinkingDisplay(config.defaultThinkingLevel)}`,
			"Individual model overrides:",
			...(modelOverrides.length > 0
				? modelOverrides.sort(([left], [right]) => left.localeCompare(right)).map(([name, model]) => `- ${name}: ${model}`)
				: ["- (none)"]),
			"Individual thinking overrides:",
			...(thinkingOverrides.length > 0
				? thinkingOverrides.sort(([left], [right]) => left.localeCompare(right)).map(([name, level]) => `- ${name}: ${level}`)
				: ["- (none)"]),
			"",
			"Effective assignments:",
		];
		for (const agent of availableAgents) {
			const effective = effectiveModelForAgent(agent, config);
			lines.push(`- ${agent.name}: ${modelDisplay(effective.setting, effective.resolved)} · thinking ${thinkingDisplay(effectiveThinkingForAgent(agent, config))}`);
		}
		return lines;
	}

	function catalogueModelReference(setting: string): string {
		return splitModelThinkingSetting(setting).model;
	}

	async function validateAvailableModel(setting: string, ctx: ExtensionContext): Promise<boolean> {
		if (setting === "main") return true;
		try {
			await ctx.modelRegistry.refresh({ allowNetwork: false });
		} catch (error) {
			ctx.ui.notify(`Could not refresh Pi's model catalogue: ${error instanceof Error ? error.message : String(error)}`, "error");
			return false;
		}
		const reference = catalogueModelReference(setting);
		const available = ctx.modelRegistry.getAvailable();
		if (available.some((model) => `${model.provider}/${model.id}` === reference)) return true;
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

	function modelKey(model: Pick<Model<Api>, "provider" | "id">): string {
		return `${model.provider}/${model.id}`;
	}

	function availableModelCatalogue(ctx: ExtensionContext): Model<Api>[] {
		const models = ctx.scopedModels.length > 0
			? ctx.scopedModels.map((entry) =>
				ctx.modelRegistry.find(entry.model.provider, entry.model.id) ?? entry.model)
			: ctx.modelRegistry.getAvailable();
		const unique = new Map<string, Model<Api>>();
		for (const model of models) unique.set(modelKey(model), model);
		return [...unique.values()].sort((left, right) => modelKey(left).localeCompare(modelKey(right)));
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

		return ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
			const list = new SelectList(items, Math.min(Math.max(items.length, 1), 12), {
				selectedPrefix: (text) => theme.fg("accent", text),
				selectedText: (text) => theme.fg("accent", text),
				description: (text) => theme.fg("muted", text),
				scrollInfo: (text) => theme.fg("dim", text),
				noMatch: (text) => theme.fg("warning", text),
			}, { minPrimaryColumnWidth: 18, maxPrimaryColumnWidth: 28 });
			list.onSelect = (item) => done(item.value);
			list.onCancel = () => done(undefined);

			return {
				render(width: number) {
					const border = theme.fg("accent", "─".repeat(Math.max(0, width)));
					return [
						border,
						truncateToWidth(theme.fg("accent", theme.bold("Subagent Configuration")), width),
						truncateToWidth(theme.fg("dim", "Choose all subagents or one agent to change model and thinking"), width),
						"",
						...list.render(width),
						"",
						truncateToWidth(theme.fg("dim", "↑↓ navigate · Enter select · Esc close"), width),
						border,
					];
				},
				invalidate() {
					list.invalidate();
				},
				handleInput(data: string) {
					list.handleInput(data);
					tui.requestRender();
				},
			};
		});
	}

	interface ModelPickerChoice {
		value: string;
		label: string;
		description: string;
		searchText: string;
	}

	function filterModelChoices(choices: readonly ModelPickerChoice[], query: string): ModelPickerChoice[] {
		const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
		if (terms.length === 0) return [...choices];
		return choices.filter((choice) => {
			const searchable = `${choice.label} ${choice.description} ${choice.searchText}`.toLowerCase();
			return terms.every((term) => searchable.includes(term));
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
		const choices: ModelPickerChoice[] = [];

		if (agent) {
			const inheritedAgentModels = { ...config.agentModels };
			delete inheritedAgentModels[target];
			const inherited = effectiveModelForAgent(agent, { ...config, agentModels: inheritedAgentModels });
			choices.push({
				value: "inherit",
				label: `${currentValue === "inherit" ? "●" : "○"} Inherit global/frontmatter setting`,
				description: `Uses ${modelDisplay(inherited.setting, inherited.resolved)}`,
				searchText: "inherit default global frontmatter",
			});
		}

		choices.push({
			value: "main",
			label: `${currentModelValue === "main" ? "●" : "○"} Main session model`,
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
				label: `${isCurrent ? "●" : "○"} ${reference}`,
				description: `${model.name} · ${formatContextWindow(model.contextWindow)} · ${model.reasoning ? "thinking" : "no thinking"}${isCurrent && currentValue !== reference ? ` · configured as ${currentValue}` : ""}`,
				searchText: `${reference} ${model.name}`,
			});
		}

		return ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) => {
			const search = new Input();
			let list: SelectList;

			const rebuildList = () => {
				const filtered = filterModelChoices(choices, search.getValue());
				list = new SelectList(
					filtered.map((choice) => ({
						value: choice.value,
						label: choice.label,
						description: choice.description,
					})),
					Math.min(Math.max(filtered.length, 1), 12),
					{
						selectedPrefix: (text) => theme.fg("accent", text),
						selectedText: (text) => theme.fg("accent", text),
						description: (text) => theme.fg("muted", text),
						scrollInfo: (text) => theme.fg("dim", text),
						noMatch: (text) => theme.fg("warning", text),
					},
					{ minPrimaryColumnWidth: 30, maxPrimaryColumnWidth: 52 },
				);
				list.onSelect = (item) => done(item.value);
				list.onCancel = () => done(undefined);
				if (!search.getValue()) {
					const currentIndex = filtered.findIndex((choice) => choice.value === currentModelValue);
					if (currentIndex >= 0) list.setSelectedIndex(currentIndex);
				}
			};

			rebuildList();

			return {
				get focused() {
					return search.focused;
				},
				set focused(value: boolean) {
					search.focused = value;
				},
				render(width: number) {
					const border = theme.fg("accent", "─".repeat(Math.max(0, width)));
					return [
						border,
						truncateToWidth(theme.fg("accent", theme.bold(`Model for ${target === "all" ? "all subagents" : target}`)), width),
						...search.render(width),
						"",
						...list.render(width),
						"",
						truncateToWidth(theme.fg("dim", "Type to filter · ↑↓ navigate · Enter next · Esc back"), width),
						border,
					];
				},
				invalidate() {
					search.invalidate();
					list.invalidate();
				},
				handleInput(data: string) {
					if (
						keybindings.matches(data, "tui.select.up") ||
						keybindings.matches(data, "tui.select.down") ||
						keybindings.matches(data, "tui.select.confirm") ||
						keybindings.matches(data, "tui.select.cancel")
					) {
						list.handleInput(data);
					} else {
						const before = search.getValue();
						search.handleInput(data);
						if (search.getValue() !== before) rebuildList();
					}
					tui.requestRender();
				},
			};
		});
	}

	const THINKING_DESCRIPTIONS: Record<SubagentThinkingLevel, string> = {
		off: "No extended thinking",
		minimal: "Fastest reasoning",
		low: "Light reasoning",
		medium: "Balanced reasoning",
		high: "Deep reasoning",
		xhigh: "Extra-high reasoning",
		max: "Maximum reasoning",
	};

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
				label: `${currentValue === "default" ? "●" : "○"} Pi default`,
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
				label: `${currentValue === "inherit" ? "●" : "○"} Inherit global/Pi default`,
				description: `Uses ${thinkingDisplay(inheritedLevel)}`,
			});
		}

		for (const level of supported) {
			items.push({
				value: level,
				label: `${currentValue === level ? "●" : "○"} ${level}`,
				description: THINKING_DESCRIPTIONS[level],
			});
		}

		return ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
			const list = new SelectList(items, Math.min(Math.max(items.length, 1), 10), {
				selectedPrefix: (text) => theme.fg("accent", text),
				selectedText: (text) => theme.fg("accent", text),
				description: (text) => theme.fg("muted", text),
				scrollInfo: (text) => theme.fg("dim", text),
				noMatch: (text) => theme.fg("warning", text),
			}, { minPrimaryColumnWidth: 24, maxPrimaryColumnWidth: 36 });
			list.onSelect = (item) => done(item.value);
			list.onCancel = () => done(undefined);
			const currentIndex = items.findIndex((item) => item.value === currentValue);
			if (currentIndex >= 0) list.setSelectedIndex(currentIndex);

			return {
				render(width: number) {
					const border = theme.fg("accent", "─".repeat(Math.max(0, width)));
					const modelLabel = splitModelThinkingSetting(pendingModelSetting).model;
					return [
						border,
						truncateToWidth(theme.fg("accent", theme.bold(`Thinking for ${target === "all" ? "all subagents" : target}`)), width),
						truncateToWidth(theme.fg("dim", `Model: ${modelLabel}`), width),
						"",
						...list.render(width),
						"",
						truncateToWidth(theme.fg("dim", "↑↓ navigate · Enter apply · Esc back"), width),
						border,
					];
				},
				invalidate() {
					list.invalidate();
				},
				handleInput(data: string) {
					list.handleInput(data);
					tui.requestRender();
				},
			};
		});
	}

	async function runInteractiveModelCommand(availableAgents: AgentConfig[], ctx: ExtensionContext): Promise<void> {
		if (ctx.mode !== "tui") {
			ctx.ui.notify(`Interactive subagent model configuration requires TUI mode.\n\n${SUBAGENT_MODEL_USAGE}`, "error");
			return;
		}
		try {
			await ctx.modelRegistry.refresh({ allowNetwork: false });
		} catch (error) {
			ctx.ui.notify(`Could not refresh Pi's model catalogue: ${error instanceof Error ? error.message : String(error)}`, "error");
			return;
		}
		const models = availableModelCatalogue(ctx);

		while (true) {
			const target = await selectSubagentTarget(availableAgents, ctx);
			if (!target) return;
			const model = await selectSubagentModel(target, availableAgents, models, ctx);
			if (model === undefined) continue;
			const thinking = await selectSubagentThinking(target, model, availableAgents, models, ctx);
			if (thinking === undefined) continue;
			await applyInteractiveConfiguration(target, model, thinking, availableAgents, ctx);
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
