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
	getDefaultSubagentConfig,
	normalizeModelSetting,
	normalizeThinkingLevel,
	splitModelThinkingSetting,
	THINKING_LEVELS,
	type SubagentAssignmentEdit,
	type SubagentAssignmentTarget,
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

	function assignmentTarget(target: string): SubagentAssignmentTarget {
		return target === "all" ? { kind: "all" } : { kind: "agent", name: target };
	}

	function targetName(target: SubagentAssignmentTarget): string {
		return target.kind === "all" ? "all" : target.name;
	}

	function modelEdit(target: SubagentAssignmentTarget, value: string): SubagentAssignmentEdit {
		const setting = value.trim();
		return setting.toLowerCase() === "inherit"
			? { target, model: { kind: "inherit" } }
			: { target, model: { kind: "set", setting: normalizeModelSetting(setting, `model for ${targetName(target)}`) } };
	}

	function thinkingEdit(target: SubagentAssignmentTarget, value: string): SubagentAssignmentEdit {
		const level = value.trim().toLowerCase();
		if (level === "default") return { target, thinking: { kind: "default" } };
		if (level === "inherit") return { target, thinking: { kind: "inherit" } };
		return { target, thinking: { kind: "set", level: normalizeThinkingLevel(level, `thinking level for ${targetName(target)}`) } };
	}

	function combinedEdit(
		target: SubagentAssignmentTarget,
		modelValue: string,
		thinkingValue: string,
	): SubagentAssignmentEdit {
		return { ...modelEdit(target, modelValue), thinking: thinkingEdit(target, thinkingValue).thinking };
	}

	function requireKnownTarget(target: string, availableAgents: AgentConfig[], ctx: ExtensionContext): boolean {
		if (target === "all" || availableAgents.some((candidate) => candidate.name === target)) return true;
		ctx.ui.notify(
			`Unknown subagent: ${target}. Available: ${availableAgents.map((item) => item.name).join(", ") || "none"}\n\n${SUBAGENT_MODEL_USAGE}`,
			"error",
		);
		return false;
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
			`Main model: ${configStore.resolveMainModel()}`,
			"",
			"Agents:",
		];
		for (const agent of availableAgents) {
			const missing = agent.tools
				.filter((tool) => !BUILTIN_TOOLS.has(tool) && (!CUSTOM_TOOL_EXTENSIONS[tool] || !fs.existsSync(CUSTOM_TOOL_EXTENSIONS[tool])))
				.map((tool) => `${tool}${CUSTOM_TOOL_EXTENSIONS[tool] ? ` (${CUSTOM_TOOL_EXTENSIONS[tool]})` : " (unmapped)"}`);
			const assignment = configStore.resolveAssignment(agent, { snapshot: config });
			lines.push(`- ${agent.name}: ${agent.description || "(no description)"}`);
			lines.push(`  model: ${modelDisplay(assignment.modelSetting, assignment.launch.model)}`);
			lines.push(`  thinking: ${thinkingDisplay(assignment.launch.thinkingLevel)}`);
			lines.push(`  context: ${contextDisplay(assignment.launch.contextWindow)}`);
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
			`Main model: ${configStore.resolveMainModel()}`,
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
			const assignment = configStore.resolveAssignment(agent, { snapshot: config });
			lines.push(`- ${agent.name}: ${modelDisplay(assignment.modelSetting, assignment.launch.model)} · thinking ${thinkingDisplay(assignment.launch.thinkingLevel)} · context ${contextDisplay(assignment.launch.contextWindow)}`);
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

	async function applyModelCommand(
		target: string,
		rawValue: string,
		availableAgents: AgentConfig[],
		ctx: ExtensionContext,
	): Promise<void> {
		if (!requireKnownTarget(target, availableAgents, ctx)) return;

		let edit: SubagentAssignmentEdit;
		try {
			edit = modelEdit(assignmentTarget(target), rawValue);
			const pending = edit.model!;
			if (pending.kind === "set" && !(await validateAvailableModel(pending.setting, ctx))) return;
			await configStore.applyAssignmentEdit(edit);
		} catch (error) {
			ctx.ui.notify(`${error instanceof Error ? error.message : String(error)}\n\n${SUBAGENT_MODEL_USAGE}`, "error");
			return;
		}

		const model = edit.model!;
		if (model.kind === "inherit") {
			ctx.ui.notify(`${target} now inherits the global/frontmatter model setting.`, "info");
		} else if (target === "all") {
			ctx.ui.notify(`All subagents now use ${model.setting}; individual overrides were cleared.`, "info");
		} else {
			ctx.ui.notify(`${target} now uses ${model.setting}.`, "info");
		}
	}

	async function applyThinkingCommand(
		target: string,
		rawValue: string,
		availableAgents: AgentConfig[],
		ctx: ExtensionContext,
	): Promise<void> {
		if (!requireKnownTarget(target, availableAgents, ctx)) return;

		let edit: SubagentAssignmentEdit;
		try {
			edit = thinkingEdit(assignmentTarget(target), rawValue);
			await configStore.applyAssignmentEdit(edit);
		} catch (error) {
			ctx.ui.notify(`${error instanceof Error ? error.message : String(error)}\n\n${SUBAGENT_MODEL_USAGE}`, "error");
			return;
		}

		const thinking = edit.thinking!;
		if (thinking.kind === "default") {
			ctx.ui.notify("All subagents now use Pi's default thinking behavior; individual thinking overrides were cleared.", "info");
		} else if (thinking.kind === "inherit") {
			ctx.ui.notify(`${target} now inherits the global/Pi default thinking level.`, "info");
		} else if (target === "all") {
			ctx.ui.notify(`All subagents now use ${thinking.level} thinking; individual thinking overrides were cleared.`, "info");
		} else {
			ctx.ui.notify(`${target} now uses ${thinking.level} thinking.`, "info");
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

		const edit = combinedEdit(assignmentTarget(target), rawModel, rawThinking);
		const model = edit.model!;
		if (model.kind === "set" && !(await validateAvailableModel(model.setting, ctx))) return;

		await configStore.applyAssignmentEdit(edit);

		const thinking = edit.thinking!;
		const modelNote = model.kind === "inherit" ? "inherited model" : model.setting;
		const thinkingNote = thinking.kind === "default"
			? "Pi default thinking"
			: thinking.kind === "inherit" ? "inherited thinking" : `${thinking.level} thinking`;
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
			? modelDisplay(defaultSelection.model, defaultSelection.model === "main" ? configStore.resolveMainModel() : defaultSelection.model)
			: "(unset; per-agent fallback)";
		const defaultThinking = defaultSelection?.thinkingLevel ?? config.defaultThinkingLevel;
		const items = [
			{
				value: "all",
				label: "All subagents",
				description: `${defaultModel} · thinking ${thinkingDisplay(defaultThinking)} · clears individual overrides`,
			},
			...availableAgents.map((agent) => {
				const assignment = configStore.resolveAssignment(agent, { snapshot: config });
				return {
					value: agent.name,
					label: agent.name,
					description: `${modelDisplay(assignment.modelSetting, assignment.launch.model)} · thinking ${thinkingDisplay(assignment.launch.thinkingLevel)}`,
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
		const mainModel = configStore.resolveMainModel();
		const choices: SelectScreenItem[] = [];

		if (agent) {
			const inherited = configStore.resolveAssignment(agent, {
				snapshot: config,
				edit: modelEdit({ kind: "agent", name: target }, "inherit"),
			});
			choices.push({
				value: "inherit",
				label: "Inherit global/frontmatter setting",
				description: `Uses ${modelDisplay(inherited.modelSetting, inherited.launch.model)}`,
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

	function findCatalogueModel(
		setting: string,
		models: readonly Model<Api>[],
		ctx: ExtensionContext,
	): Model<Api> | undefined {
		const selected = splitModelThinkingSetting(setting).model;
		const reference = selected === "main" ? configStore.resolveMainModel() : selected;
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

		const pendingModelEdit = modelEdit(assignmentTarget(target), modelChoice);
		const pendingAssignment = agent
			? configStore.resolveAssignment(agent, { snapshot: config, edit: pendingModelEdit })
			: undefined;
		const pendingModelSetting = pendingAssignment?.modelSetting ?? modelChoice;
		const catalogueModel = findCatalogueModel(pendingModelSetting, models, ctx);
		const supported = catalogueModel
			? getSupportedThinkingLevels(catalogueModel).map((level) => normalizeThinkingLevel(level))
			: [...THINKING_LEVELS];

		const currentRawModel = target === "all"
			? config.defaultModel ?? "main"
			: Object.hasOwn(config.agentModels, target)
				? config.agentModels[target]!
				: undefined;
		const currentAssignment = agent ? configStore.resolveAssignment(agent, { snapshot: config }) : undefined;
		const currentModel = currentAssignment?.modelSetting ?? splitModelThinkingSetting(currentRawModel!).model;
		const currentModelSuffix = currentRawModel === undefined
			? undefined
			: splitModelThinkingSetting(currentRawModel).thinkingLevel;
		const sameModel = currentModel === pendingModelSetting;
		const currentValue = target === "all"
			? sameModel && currentModelSuffix
				? currentModelSuffix
				: config.defaultThinkingLevel ?? "default"
			: Object.hasOwn(config.agentThinkingLevels, target)
				? currentAssignment!.launch.thinkingLevel!
				: sameModel && currentModelSuffix
					? currentAssignment!.launch.thinkingLevel!
					: "inherit";

		const items: Array<{ value: string; label: string; description: string }> = [];
		if (target === "all") {
			items.push({
				value: "default",
				label: "Pi default",
				description: "Do not pass a --thinking override to child Pi processes",
			});
		} else {
			const inherited = configStore.resolveAssignment(agent!, {
				snapshot: config,
				edit: { ...pendingModelEdit, thinking: { kind: "inherit" } },
			});
			items.push({
				value: "inherit",
				label: "Inherit global/Pi default",
				description: `Uses ${thinkingDisplay(inherited.launch.thinkingLevel)}`,
			});
		}

		for (const level of supported) {
			items.push({
				value: level,
				label: level,
				description: THINKING_DESCRIPTIONS[level],
			});
		}

		return pickSelectScreen(ctx, {
			title: `Select thinking for ${target === "all" ? "all subagents" : target}`,
			subtitle: `Model: ${pendingModelSetting}`,
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
