import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "../_shared/subagent-service.ts";

export const MAIN_MODEL_SETTING = "main";
export const LEGACY_MAIN_MODEL_SETTING = "default";
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type SubagentThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface ModelConfiguration {
	defaultModel?: string;
	agentModels: Record<string, string>;
	defaultThinkingLevel?: SubagentThinkingLevel;
	agentThinkingLevels: Record<string, SubagentThinkingLevel>;
}

export interface ResolveModelOptions {
	agentName: string;
	config?: unknown;
	explicitModel?: string;
	frontmatterModel?: string;
	mainModel: string | { provider: unknown; id: unknown } | undefined;
}

export interface ResolveLaunchOptions extends ResolveModelOptions {
	explicitThinkingLevel?: unknown;
}

export interface ResolvedLaunchConfiguration {
	model: string;
	thinkingLevel?: SubagentThinkingLevel;
}

export interface ExtensionConfig extends ModelConfiguration {
	maxConcurrency?: number;
}

export interface SubagentConfigStore {
	readonly configPath: string;
	readDocument(): Record<string, unknown>;
	load(): ExtensionConfig;
	update(update: (document: Record<string, unknown>) => Record<string, unknown>): Promise<Record<string, unknown>>;
	rememberMainModel(model: { provider: unknown; id: unknown } | undefined): void;
	getMainModel(): string | undefined;
	resolveLaunch(agent: AgentConfig, explicitModel?: string, explicitThinkingLevel?: SubagentThinkingLevel): ResolvedLaunchConfiguration;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireDocument(value: unknown): Record<string, unknown> {
	if (!isRecord(value)) throw new Error("Subagent config must contain a JSON object.");
	return value;
}

function modelLabel(label: string): string {
	return label ? `Subagent ${label}` : "Subagent model";
}

/** Validate and canonicalize a configured model setting. */
export function normalizeModelSetting(value: unknown, label = "model setting"): string {
	if (typeof value !== "string") {
		throw new Error(`${modelLabel(label)} must be a string containing "main" or "provider/model".`);
	}

	const setting = value.trim();
	if (!setting) {
		throw new Error(`${modelLabel(label)} cannot be empty; use "main" or "provider/model".`);
	}
	if (setting.toLowerCase() === MAIN_MODEL_SETTING || setting.toLowerCase() === LEGACY_MAIN_MODEL_SETTING) {
		return MAIN_MODEL_SETTING;
	}
	const segments = setting.split("/");
	if (/\s/.test(setting) || segments.length < 2 || segments.some((segment) => !segment)) {
		throw new Error(`${modelLabel(label)} must be "main" or a canonical "provider/model" identifier.`);
	}
	return setting;
}

/** Validate and canonicalize a configured thinking level. */
export function normalizeThinkingLevel(value: unknown, label = "thinking level"): SubagentThinkingLevel {
	if (typeof value !== "string") {
		throw new Error(`Subagent ${label} must be one of: ${THINKING_LEVELS.join(", ")}.`);
	}
	const normalized = value.trim().toLowerCase();
	if (!THINKING_LEVELS.includes(normalized as SubagentThinkingLevel)) {
		throw new Error(`Subagent ${label} must be one of: ${THINKING_LEVELS.join(", ")}.`);
	}
	return normalized as SubagentThinkingLevel;
}

/** Split Pi's optional provider/model:thinking shorthand into independent settings. */
export function splitModelThinkingSetting(value: unknown): { model: string; thinkingLevel?: SubagentThinkingLevel } {
	const setting = normalizeModelSetting(value);
	const match = setting.match(/^(.*):(off|minimal|low|medium|high|xhigh|max)$/i);
	if (!match) return { model: setting };
	return {
		model: normalizeModelSetting(match[1], "model without thinking suffix"),
		thinkingLevel: normalizeThinkingLevel(match[2], "model thinking suffix"),
	};
}

/** Parse only the model-related portion of config.json while rejecting malformed settings. */
export function parseModelConfiguration(value: unknown): ModelConfiguration {
	const document = requireDocument(value);
	const parsed: ModelConfiguration = { agentModels: {}, agentThinkingLevels: {} };

	if (Object.hasOwn(document, "defaultModel")) {
		parsed.defaultModel = normalizeModelSetting(document.defaultModel, "config defaultModel");
	}

	if (Object.hasOwn(document, "agentModels")) {
		if (!isRecord(document.agentModels)) {
			throw new Error("Subagent config agentModels must be a JSON object mapping agent names to models.");
		}
		for (const [agentName, setting] of Object.entries(document.agentModels)) {
			if (!agentName.trim()) throw new Error("Subagent config agentModels cannot contain an empty agent name.");
			parsed.agentModels[agentName] = normalizeModelSetting(setting, `config agentModels.${agentName}`);
		}
	}

	if (Object.hasOwn(document, "defaultThinkingLevel")) {
		parsed.defaultThinkingLevel = normalizeThinkingLevel(document.defaultThinkingLevel, "config defaultThinkingLevel");
	}

	if (Object.hasOwn(document, "agentThinkingLevels")) {
		if (!isRecord(document.agentThinkingLevels)) {
			throw new Error("Subagent config agentThinkingLevels must be a JSON object mapping agent names to thinking levels.");
		}
		for (const [agentName, level] of Object.entries(document.agentThinkingLevels)) {
			if (!agentName.trim()) throw new Error("Subagent config agentThinkingLevels cannot contain an empty agent name.");
			parsed.agentThinkingLevels[agentName] = normalizeThinkingLevel(level, `config agentThinkingLevels.${agentName}`);
		}
	}

	return parsed;
}

/** Construct the current main model's canonical provider/model identity. */
export function canonicalMainModel(model: string | { provider: unknown; id: unknown } | undefined): string {
	if (typeof model === "string") {
		const canonical = normalizeModelSetting(model, "main session model");
		if (canonical === MAIN_MODEL_SETTING) {
			throw new Error("The main session model must resolve to a concrete provider/model identifier.");
		}
		return canonical;
	}
	if (!model || typeof model.provider !== "string" || typeof model.id !== "string") {
		throw new Error("Cannot resolve subagent model \"main\": the main session has no active model.");
	}
	return normalizeModelSetting(`${model.provider}/${model.id}`, "main session model");
}

/** Select a setting according to invocation > agent > global > frontmatter > main precedence. */
export function selectModelSetting(options: Omit<ResolveModelOptions, "mainModel">): string {
	const config = parseModelConfiguration(options.config ?? {});
	if (options.explicitModel !== undefined) {
		return normalizeModelSetting(options.explicitModel, "invocation model override");
	}
	if (Object.hasOwn(config.agentModels, options.agentName)) {
		return config.agentModels[options.agentName]!;
	}
	if (config.defaultModel !== undefined) return config.defaultModel;
	if (options.frontmatterModel?.trim()) {
		return normalizeModelSetting(options.frontmatterModel, `agent ${options.agentName} frontmatter model`);
	}
	return MAIN_MODEL_SETTING;
}

/** Resolve the selected setting to the concrete model passed to a child Pi process. */
export function resolveModelAssignment(options: ResolveModelOptions): string {
	const setting = selectModelSetting(options);
	return setting === MAIN_MODEL_SETTING ? canonicalMainModel(options.mainModel) : setting;
}

/** Select the optional thinking override according to agent > global > Pi default precedence. */
export function selectThinkingLevelSetting(
	options: Pick<ResolveLaunchOptions, "agentName" | "config" | "explicitThinkingLevel">,
): SubagentThinkingLevel | undefined {
	if (options.explicitThinkingLevel !== undefined) {
		return normalizeThinkingLevel(options.explicitThinkingLevel, "invocation thinking level override");
	}
	const config = parseModelConfiguration(options.config ?? {});
	if (Object.hasOwn(config.agentThinkingLevels, options.agentName)) {
		return config.agentThinkingLevels[options.agentName];
	}
	return config.defaultThinkingLevel;
}

/** Resolve model identity and thinking independently for child Pi CLI arguments. */
export function resolveLaunchConfiguration(options: ResolveLaunchOptions): ResolvedLaunchConfiguration {
	const resolved = splitModelThinkingSetting(resolveModelAssignment(options));
	const config = parseModelConfiguration(options.config ?? {});
	const explicitModelThinking = options.explicitModel === undefined
		? undefined
		: splitModelThinkingSetting(options.explicitModel).thinkingLevel;
	const agentThinking = Object.hasOwn(config.agentThinkingLevels, options.agentName)
		? config.agentThinkingLevels[options.agentName]
		: undefined;
	return {
		model: resolved.model,
		thinkingLevel: options.explicitThinkingLevel !== undefined
			? normalizeThinkingLevel(options.explicitThinkingLevel, "invocation thinking level override")
			: explicitModelThinking ?? agentThinking ?? resolved.thinkingLevel ?? config.defaultThinkingLevel,
	};
}

/** Set the global assignment and clear overrides so the change truly applies to every agent. */
export function setAllModelAssignments(document: unknown, model: unknown): Record<string, unknown> {
	const config = requireDocument(document);
	parseModelConfiguration(config);
	return {
		...config,
		defaultModel: normalizeModelSetting(model, "default model"),
		agentModels: {},
	};
}

/** Set one agent override while preserving global, other agent, and unknown settings. */
export function setAgentModelAssignment(document: unknown, agentName: string, model: unknown): Record<string, unknown> {
	const config = requireDocument(document);
	const parsed = parseModelConfiguration(config);
	if (!agentName.trim()) throw new Error("Subagent agent name cannot be empty.");
	return {
		...config,
		agentModels: {
			...parsed.agentModels,
			[agentName]: normalizeModelSetting(model, `model for ${agentName}`),
		},
	};
}

/** Remove one override so that agent inherits the global/frontmatter assignment. */
export function removeAgentModelAssignment(document: unknown, agentName: string): Record<string, unknown> {
	const config = requireDocument(document);
	const parsed = parseModelConfiguration(config);
	if (!agentName.trim()) throw new Error("Subagent agent name cannot be empty.");
	const agentModels = { ...parsed.agentModels };
	delete agentModels[agentName];
	return { ...config, agentModels };
}

/** Set one thinking level for every agent and clear individual thinking overrides. */
export function setAllThinkingAssignments(document: unknown, level: unknown): Record<string, unknown> {
	const config = requireDocument(document);
	parseModelConfiguration(config);
	return {
		...config,
		defaultThinkingLevel: normalizeThinkingLevel(level, "default thinking level"),
		agentThinkingLevels: {},
	};
}

/** Restore Pi's own default thinking behavior for every agent. */
export function clearAllThinkingAssignments(document: unknown): Record<string, unknown> {
	const config = requireDocument(document);
	parseModelConfiguration(config);
	const next: Record<string, unknown> = { ...config, agentThinkingLevels: {} };
	delete next.defaultThinkingLevel;
	return next;
}

/** Set one agent's thinking override while preserving every other setting. */
export function setAgentThinkingAssignment(document: unknown, agentName: string, level: unknown): Record<string, unknown> {
	const config = requireDocument(document);
	const parsed = parseModelConfiguration(config);
	if (!agentName.trim()) throw new Error("Subagent agent name cannot be empty.");
	return {
		...config,
		agentThinkingLevels: {
			...parsed.agentThinkingLevels,
			[agentName]: normalizeThinkingLevel(level, `thinking level for ${agentName}`),
		},
	};
}

/** Remove one thinking override so the agent inherits the global/Pi default. */
export function removeAgentThinkingAssignment(document: unknown, agentName: string): Record<string, unknown> {
	const config = requireDocument(document);
	const parsed = parseModelConfiguration(config);
	if (!agentName.trim()) throw new Error("Subagent agent name cannot be empty.");
	const agentThinkingLevels = { ...parsed.agentThinkingLevels };
	delete agentThinkingLevels[agentName];
	return { ...config, agentThinkingLevels };
}

/** Add the CLI option that actually selects the child model. */
export function appendChildModelArgument(args: readonly string[], resolvedModel: string): string[] {
	const model = normalizeModelSetting(resolvedModel, "resolved child model");
	if (model === MAIN_MODEL_SETTING) {
		throw new Error("A child model must be resolved to provider/model before building Pi arguments.");
	}
	return [...args, "--model", model];
}

/** Add an explicit child thinking level while leaving Pi defaults untouched when unset. */
export function appendChildThinkingArgument(
	args: readonly string[],
	thinkingLevel: SubagentThinkingLevel | undefined,
): string[] {
	return thinkingLevel === undefined
		? [...args]
		: [...args, "--thinking", normalizeThinkingLevel(thinkingLevel, "resolved child thinking level")];
}

export function createSubagentConfigStore(configPath: string): SubagentConfigStore {
	let activeMainModel: string | undefined;

	function readDocument(): Record<string, unknown> {
		if (!fs.existsSync(configPath)) return {};
		try {
			const value = JSON.parse(fs.readFileSync(configPath, "utf-8")) as unknown;
			if (typeof value !== "object" || value === null || Array.isArray(value)) {
				throw new Error("the root value must be a JSON object");
			}
			return value as Record<string, unknown>;
		} catch (error) {
			throw new Error(`Cannot read subagent config ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	function load(): ExtensionConfig {
		const document = readDocument();
		const modelConfig = parseModelConfiguration(document);
		const maxConcurrency = document.maxConcurrency;
		if (maxConcurrency !== undefined && (!Number.isInteger(maxConcurrency) || (maxConcurrency as number) < 1)) {
			throw new Error("Subagent config maxConcurrency must be a positive integer.");
		}
		return { ...modelConfig, maxConcurrency: maxConcurrency as number | undefined };
	}

	async function update(
		mutate: (document: Record<string, unknown>) => Record<string, unknown>,
	): Promise<Record<string, unknown>> {
		return withFileMutationQueue(configPath, async () => {
			const next = mutate(readDocument());
			parseModelConfiguration(next);
			const temporaryPath = `${configPath}.${process.pid}.${Date.now()}.tmp`;
			try {
				await fs.promises.writeFile(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
				await fs.promises.rename(temporaryPath, configPath);
			} finally {
				await fs.promises.rm(temporaryPath, { force: true }).catch(() => undefined);
			}
			return next;
		});
	}

	return {
		configPath,
		readDocument,
		load,
		update,
		rememberMainModel(model) {
			activeMainModel = model ? canonicalMainModel(model) : undefined;
		},
		getMainModel: () => activeMainModel,
		resolveLaunch(agent, explicitModel, explicitThinkingLevel) {
			return resolveLaunchConfiguration({
				agentName: agent.name,
				config: readDocument(),
				explicitModel,
				explicitThinkingLevel,
				frontmatterModel: agent.model,
				mainModel: activeMainModel,
			});
		},
	};
}

const EXT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const subagentConfig = createSubagentConfigStore(path.join(EXT_DIR, "config.json"));
