import { getSupportedThinkingLevels, type Api, type Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	findExactModel,
	listSelectableModels,
	modelKey,
} from "../_shared/model-picker.ts";
import { THINKING_DESCRIPTIONS } from "../_shared/model-thinking.ts";
import { resolveModelReference } from "../_shared/model-reference.ts";
import { pickSelectScreen, type SelectScreenItem } from "../_shared/select-screen.ts";
import type { AgentConfig } from "../_shared/subagent-service.ts";
import { agentRegistry, type AgentRegistry } from "./agent-registry.ts";
import {
	getDefaultSubagentConfig,
	normalizeModelSetting,
	normalizeThinkingLevel,
	splitModelThinkingSetting,
	THINKING_LEVELS,
	type ExtensionConfig,
	type ResolvedSubagentAssignmentSelection,
	type SubagentAssignmentEdit,
	type SubagentAssignmentTarget,
	type SubagentConfigStore,
	type SubagentThinkingLevel,
} from "./config.ts";
import { formatContextWindow } from "./formatting.ts";
import {
	createSubagentChildExecution,
	type SubagentChildExecution,
	type SubagentChildToolDiagnostic,
} from "./child-execution.ts";
import { DEFAULT_MAX_CONCURRENCY } from "./subagent-execution.ts";

export interface ModelCommandDependencies {
	registry?: AgentRegistry;
	config?: SubagentConfigStore;
	childExecution?: Pick<SubagentChildExecution, "inspectTools">;
}

function formatChildToolDiagnostic(diagnostic: SubagentChildToolDiagnostic): string {
	switch (diagnostic.kind) {
		case "unmapped-tool":
			return `${diagnostic.tool} (unmapped)`;
		case "missing-tool-extension":
			return `${diagnostic.tool} (${diagnostic.path})`;
		case "missing-runtime-extension":
			return `${diagnostic.extension} (${diagnostic.path})`;
	}
}

export function createSubagentsCommand(dependencies: ModelCommandDependencies = {}) {
	const registry = dependencies.registry ?? agentRegistry;
	const configStore = dependencies.config ?? getDefaultSubagentConfig();
	const childExecution = dependencies.childExecution ?? createSubagentChildExecution();
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

	/** Wire one command target to the assignment module's selection seam. */
	function targetSelection(
		target: string,
		availableAgents: AgentConfig[],
		options: { snapshot: ExtensionConfig; edit?: SubagentAssignmentEdit },
	): ResolvedSubagentAssignmentSelection {
		const agent = target === "all" ? undefined : availableAgents.find((candidate) => candidate.name === target);
		if (target !== "all" && !agent) throw new Error(`Unknown subagent: ${target}`);
		return agent
			? configStore.resolveAssignmentSelection({ target: { kind: "agent", name: target }, agent, ...options })
			: configStore.resolveAssignmentSelection({ target: { kind: "all" }, ...options });
	}

	function statusLines(availableAgents: AgentConfig[]): string[] {
		const config = configStore.load();
		const lines = [
			"Subagents status:",
			`Max concurrency: ${config.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY}`,
			`Main model: ${configStore.resolveMainModel()}`,
			"",
			"Agents:",
		];
		for (const agent of availableAgents) {
			const missing = childExecution.inspectTools(agent.tools).map(formatChildToolDiagnostic);
			const { assignment } = targetSelection(agent.name, availableAgents, { snapshot: config });
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
			const { assignment } = targetSelection(agent.name, availableAgents, { snapshot: config });
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
		const global = targetSelection("all", availableAgents, { snapshot: config });
		const globalModel = global.model.kind === "default"
			? "(unset; per-agent fallback)"
			: modelDisplay(global.assignment.modelSetting, global.assignment.launch.model);
		const globalThinking = global.modelSuffixThinkingLevel
			?? (global.thinking.kind === "set" ? global.thinking.level : undefined);
		const items = [
			{
				value: "all",
				label: "All subagents",
				description: `${globalModel} · thinking ${thinkingDisplay(globalThinking)} · clears individual overrides`,
			},
			...availableAgents.map((agent) => {
				const { assignment } = targetSelection(agent.name, availableAgents, { snapshot: config });
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

		const current = targetSelection(target, availableAgents, { snapshot: config });
		const currentModelValue = current.model.kind === "set"
			? current.assignment.modelSetting
			: current.model.kind === "inherit" ? "inherit" : "main";
		const rawSetting = current.model.kind === "set" ? current.model.setting : undefined;
		const mainModel = configStore.resolveMainModel();
		const choices: SelectScreenItem[] = [];

		if (agent) {
			const inherited = targetSelection(target, availableAgents, {
				snapshot: config,
				edit: modelEdit({ kind: "agent", name: target }, "inherit"),
			});
			choices.push({
				value: "inherit",
				label: "Inherit global/frontmatter setting",
				description: `Uses ${modelDisplay(inherited.assignment.modelSetting, inherited.assignment.launch.model)}`,
				searchText: "inherit default global frontmatter",
			});
		}

		choices.push({
			value: "main",
			label: "Main session model",
			description: `${mainModel} · follows future /model changes`,
			searchText: `main default ${mainModel}`,
		});

		for (const model of models) {
			const reference = modelKey(model);
			const isCurrent = reference === currentModelValue;
			choices.push({
				value: reference,
				label: reference,
				description: `${model.name} · ${formatContextWindow(model.contextWindow)} · ${model.reasoning ? "thinking" : "no thinking"}${isCurrent && rawSetting !== undefined && rawSetting !== reference ? ` · configured as ${rawSetting}` : ""}`,
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

	async function findCatalogueModel(
		reference: string,
		models: readonly Model<Api>[],
		ctx: ExtensionContext,
	): Promise<Model<Api> | undefined> {
		const target = reference === "main" ? configStore.resolveMainModel() : reference;
		const listed = models.find((model) => modelKey(model) === target);
		if (listed) return listed;
		// The child Pi process enforces model scope and auth at launch; the picker
		// only needs a catalogue match here, so scope is deliberately ignored.
		return resolveModelReference(ctx, target, { optional: true, scope: "ignore" });
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
		const currentSelection = targetSelection(target, availableAgents, { snapshot: config });
		const pendingSelection = targetSelection(target, availableAgents, { snapshot: config, edit: pendingModelEdit });
		const pendingModelSetting = pendingSelection.assignment.modelSetting;
		const catalogueModel = await findCatalogueModel(pendingModelSetting, models, ctx);
		const supported = catalogueModel
			? getSupportedThinkingLevels(catalogueModel).map((level) => normalizeThinkingLevel(level))
			: [...THINKING_LEVELS];

		const sameModel = currentSelection.assignment.modelSetting === pendingModelSetting;
		const currentValue = target === "all"
			? sameModel && currentSelection.modelSuffixThinkingLevel
				? currentSelection.modelSuffixThinkingLevel
				: currentSelection.thinking.kind === "set" ? currentSelection.thinking.level : "default"
			: currentSelection.thinking.kind === "set"
				? currentSelection.thinking.level
				: sameModel && currentSelection.modelSuffixThinkingLevel
					? currentSelection.assignment.launch.thinkingLevel!
					: "inherit";

		const items: Array<{ value: string; label: string; description: string }> = [];
		if (target === "all") {
			items.push({
				value: "default",
				label: "Pi default",
				description: "Do not pass a --thinking override to child Pi processes",
			});
		} else {
			const inherited = targetSelection(target, availableAgents, {
				snapshot: config,
				edit: { ...pendingModelEdit, thinking: { kind: "inherit" } },
			});
			items.push({
				value: "inherit",
				label: "Inherit global/Pi default",
				description: `Uses ${thinkingDisplay(inherited.assignment.launch.thinkingLevel)}`,
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
