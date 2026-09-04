import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { MODEL_THINKING_LEVELS } from "../_shared/model-thinking.ts";
import { DEFAULT_SENTINEL } from "../_shared/pi-defaults.ts";
import type { AgentConfig } from "../_shared/subagent-service.ts";
import { isRecord, mutateSettingsDocument, PROJECT_SETTINGS_PATH, readSettingsDocument } from "../_shared/settings-document.ts";

export const MAIN_MODEL_SETTING = "main";
export const LEGACY_MAIN_MODEL_SETTING = "default";
export const THINKING_LEVELS = MODEL_THINKING_LEVELS;

const SUBAGENTS_SETTINGS_KEY = "subagents";

const THINKING_SUFFIX_PATTERN = new RegExp(`^(.*):(${THINKING_LEVELS.join("|")})$`, "i");

export type SubagentThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface ModelConfiguration {
	defaultModel?: string;
	agentModels: Record<string, string>;
	defaultThinkingLevel?: SubagentThinkingLevel;
	agentThinkingLevels: Record<string, SubagentThinkingLevel | undefined>;
	defaultContextWindow?: number;
	agentContextWindows: Record<string, number | undefined>;
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
	explicitContextWindow?: unknown;
}

export interface ResolvedLaunchConfiguration {
	model: string;
	thinkingLevel?: SubagentThinkingLevel;
	contextWindow?: number;
}

export interface ResolvedSubagentAssignment {
	/** Canonical selected setting before `main` becomes a concrete model. */
	modelSetting: string;
	/** Resolved launch fields; contextWindow remains descriptive metadata. */
	launch: ResolvedLaunchConfiguration;
}

export interface ExtensionConfig extends ModelConfiguration {
	maxConcurrency?: number;
}

export type SubagentAssignmentTarget = { kind: "all" } | { kind: "agent"; name: string };

export type SubagentConfigurationChange =
	| { kind: "set-model"; target: SubagentAssignmentTarget; model: string }
	| { kind: "inherit-model"; agentName: string }
	| { kind: "set-thinking"; target: SubagentAssignmentTarget; thinkingLevel: SubagentThinkingLevel }
	| { kind: "default-thinking" }
	| { kind: "inherit-thinking"; agentName: string };

export interface ResolveStoredAssignmentOptions {
	snapshot?: ExtensionConfig;
	changes?: readonly SubagentConfigurationChange[];
	explicitModel?: string;
	explicitThinkingLevel?: SubagentThinkingLevel;
}

export interface SubagentConfigStore {
	readonly configPath: string;
	load(): ExtensionConfig;
	applyChanges(changes: readonly SubagentConfigurationChange[]): Promise<void>;
	rememberMainModel(model: { provider: unknown; id: unknown } | undefined): void;
	resolveMainModel(): string;
	resolveAssignment(agent: AgentConfig, options?: ResolveStoredAssignmentOptions): ResolvedSubagentAssignment;
	resolveLaunch(agent: AgentConfig, explicitModel?: string, explicitThinkingLevel?: SubagentThinkingLevel): ResolvedLaunchConfiguration;
	setSettingsPath(path: string): void;
	migrateLegacy(): Promise<boolean>;
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

/** Validate a configured context window (positive integer tokens). */
function validateContextWindow(value: unknown, label = "context window"): number {
	if (!Number.isInteger(value) || (value as number) <= 0) {
		throw new Error(`Subagent ${label} must be a positive integer.`);
	}
	return value as number;
}

function parseConfiguredThinkingLevel(value: unknown, label: string): SubagentThinkingLevel | undefined {
	if (value === DEFAULT_SENTINEL) return undefined;
	return normalizeThinkingLevel(value, label);
}

function parseConfiguredContextWindow(value: unknown, label: string): number | undefined {
	if (value === DEFAULT_SENTINEL) return undefined;
	return validateContextWindow(value, label);
}

/** Split Pi's optional provider/model:thinking shorthand into independent settings. */
export function splitModelThinkingSetting(value: unknown): { model: string; thinkingLevel?: SubagentThinkingLevel } {
	const setting = normalizeModelSetting(value);
	const match = setting.match(THINKING_SUFFIX_PATTERN);
	if (!match) return { model: setting };
	return {
		model: normalizeModelSetting(match[1], "model without thinking suffix"),
		thinkingLevel: normalizeThinkingLevel(match[2], "model thinking suffix"),
	};
}

/** Parse only the model-related portion of config.json while rejecting malformed settings. */
export function parseModelConfiguration(value: unknown): ModelConfiguration {
	const document = requireDocument(value);
	const parsed: ModelConfiguration = { agentModels: {}, agentThinkingLevels: {}, agentContextWindows: {} };

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
		const level = parseConfiguredThinkingLevel(document.defaultThinkingLevel, "config defaultThinkingLevel");
		if (level !== undefined) parsed.defaultThinkingLevel = level;
	}

	if (Object.hasOwn(document, "agentThinkingLevels")) {
		if (!isRecord(document.agentThinkingLevels)) {
			throw new Error("Subagent config agentThinkingLevels must be a JSON object mapping agent names to thinking levels.");
		}
		for (const [agentName, level] of Object.entries(document.agentThinkingLevels)) {
			if (!agentName.trim()) throw new Error("Subagent config agentThinkingLevels cannot contain an empty agent name.");
			const parsedLevel = parseConfiguredThinkingLevel(level, `config agentThinkingLevels.${agentName}`);
			if (parsedLevel !== undefined) parsed.agentThinkingLevels[agentName] = parsedLevel;
		}
	}

	if (Object.hasOwn(document, "defaultContextWindow")) {
		const contextWindow = parseConfiguredContextWindow(document.defaultContextWindow, "config defaultContextWindow");
		if (contextWindow !== undefined) parsed.defaultContextWindow = contextWindow;
	}

	if (Object.hasOwn(document, "agentContextWindows")) {
		if (!isRecord(document.agentContextWindows)) {
			throw new Error("Subagent config agentContextWindows must be a JSON object mapping agent names to context windows.");
		}
		for (const [agentName, contextWindow] of Object.entries(document.agentContextWindows)) {
			if (!agentName.trim()) throw new Error("Subagent config agentContextWindows cannot contain an empty agent name.");
			const parsedContextWindow = parseConfiguredContextWindow(contextWindow, `config agentContextWindows.${agentName}`);
			if (parsedContextWindow !== undefined) parsed.agentContextWindows[agentName] = parsedContextWindow;
		}
	}

	return parsed;
}

/** Construct the current main model's canonical provider/model identity. */
function canonicalMainModel(model: string | { provider: unknown; id: unknown } | undefined): string {
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

/** Resolve the effective assignment used by displays and child launch preparation. */
export function resolveSubagentAssignment(options: ResolveLaunchOptions): ResolvedSubagentAssignment {
	const config = parseModelConfiguration(options.config ?? {});
	let selectedModel: string;
	if (options.explicitModel !== undefined) {
		selectedModel = normalizeModelSetting(options.explicitModel, "invocation model override");
	} else if (Object.hasOwn(config.agentModels, options.agentName)) {
		selectedModel = config.agentModels[options.agentName]!;
	} else if (config.defaultModel !== undefined) {
		selectedModel = config.defaultModel;
	} else if (options.frontmatterModel?.trim()) {
		selectedModel = normalizeModelSetting(options.frontmatterModel, `agent ${options.agentName} frontmatter model`);
	} else {
		selectedModel = MAIN_MODEL_SETTING;
	}

	const selected = splitModelThinkingSetting(selectedModel);
	const agentThinking = Object.hasOwn(config.agentThinkingLevels, options.agentName)
		? config.agentThinkingLevels[options.agentName]
		: undefined;
	const thinkingLevel = options.explicitThinkingLevel !== undefined
		? normalizeThinkingLevel(options.explicitThinkingLevel, "invocation thinking level override")
		: options.explicitModel !== undefined && selected.thinkingLevel !== undefined
			? selected.thinkingLevel
			: agentThinking ?? selected.thinkingLevel ?? config.defaultThinkingLevel;
	const contextWindow = options.explicitContextWindow !== undefined
		? validateContextWindow(options.explicitContextWindow, "invocation context window override")
		: Object.hasOwn(config.agentContextWindows, options.agentName)
			? config.agentContextWindows[options.agentName]
			: config.defaultContextWindow;

	return {
		modelSetting: selected.model,
		launch: {
			model: selected.model === MAIN_MODEL_SETTING ? canonicalMainModel(options.mainModel) : selected.model,
			thinkingLevel,
			contextWindow,
		},
	};
}

/** Apply an ordered batch of semantic assignment changes without mutating the input. */
export function applySubagentConfigurationChanges(
	document: unknown,
	changes: readonly SubagentConfigurationChange[],
): Record<string, unknown> {
	let next: Record<string, unknown> = { ...requireDocument(document) };
	const parsed = parseModelConfiguration(next);
	let agentModels = { ...parsed.agentModels };
	let agentThinkingLevels = { ...parsed.agentThinkingLevels };
	const requireAgent = (name: string): string => {
		if (!name.trim()) throw new Error("Subagent agent name cannot be empty.");
		return name;
	};

	for (const change of changes) {
		switch (change.kind) {
			case "set-model":
				if (change.target.kind === "all") {
					agentModels = {};
					next = {
						...next,
						defaultModel: normalizeModelSetting(change.model, "default model"),
						agentModels,
					};
				} else {
					const name = requireAgent(change.target.name);
					agentModels = {
						...agentModels,
						[name]: normalizeModelSetting(change.model, `model for ${name}`),
					};
					next = { ...next, agentModels };
				}
				break;
			case "inherit-model": {
				const name = requireAgent(change.agentName);
				agentModels = { ...agentModels };
				delete agentModels[name];
				next = { ...next, agentModels };
				break;
			}
			case "set-thinking":
				if (change.target.kind === "all") {
					agentThinkingLevels = {};
					next = {
						...next,
						defaultThinkingLevel: normalizeThinkingLevel(change.thinkingLevel, "default thinking level"),
						agentThinkingLevels,
					};
				} else {
					const name = requireAgent(change.target.name);
					agentThinkingLevels = {
						...agentThinkingLevels,
						[name]: normalizeThinkingLevel(change.thinkingLevel, `thinking level for ${name}`),
					};
					next = { ...next, agentThinkingLevels };
				}
				break;
			case "default-thinking":
				agentThinkingLevels = {};
				next = { ...next, agentThinkingLevels };
				delete next.defaultThinkingLevel;
				break;
			case "inherit-thinking": {
				const name = requireAgent(change.agentName);
				agentThinkingLevels = { ...agentThinkingLevels };
				delete agentThinkingLevels[name];
				next = { ...next, agentThinkingLevels };
				break;
			}
		}
	}

	parseModelConfiguration(next);
	return next;
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

export interface SubagentConfigStoreOptions {
	settingsPath?: string;
	/** Optional path to a legacy config.json whose model settings are honored until settings.json gains a subagents key. */
	legacyConfigPath?: string;
}

export function createSubagentConfigStore(options: SubagentConfigStoreOptions = {}): SubagentConfigStore {
	let settingsPath = options.settingsPath ?? PROJECT_SETTINGS_PATH;
	const legacyPath = options.legacyConfigPath;
	let activeMainModel: string | undefined;
	const readLegacyDocument = (): Record<string, unknown> | undefined => {
		if (!legacyPath || !fs.existsSync(legacyPath)) return undefined;
		try {
			const value: unknown = JSON.parse(fs.readFileSync(legacyPath, "utf-8"));
			return isRecord(value) ? value : undefined;
		} catch { return undefined; }
	};
	const namespaceFrom = (document: Record<string, unknown>): Record<string, unknown> | undefined => {
		if (!Object.hasOwn(document, SUBAGENTS_SETTINGS_KEY)) return undefined;
		const namespace = document[SUBAGENTS_SETTINGS_KEY];
		if (!isRecord(namespace)) throw new Error(`Subagent settings "${SUBAGENTS_SETTINGS_KEY}" must be a JSON object.`);
		return namespace;
	};
	const readSettingsNamespace = (): Record<string, unknown> =>
		namespaceFrom(readSettingsDocument(settingsPath)) ?? readLegacyDocument() ?? {};
	const load = (): ExtensionConfig => {
		const document = readSettingsNamespace();
		const modelConfig = parseModelConfiguration(document);
		const maxConcurrency = document.maxConcurrency;
		if (maxConcurrency !== undefined && (!Number.isInteger(maxConcurrency) || (maxConcurrency as number) < 1))
			throw new Error("Subagent config maxConcurrency must be a positive integer.");
		return { ...modelConfig, maxConcurrency: maxConcurrency as number | undefined };
	};
	const resolveAssignment = (agent: AgentConfig, options: ResolveStoredAssignmentOptions = {}): ResolvedSubagentAssignment => {
		let config: unknown = options.snapshot ?? readSettingsNamespace();
		if (options.changes) config = applySubagentConfigurationChanges(config, options.changes);
		return resolveSubagentAssignment({ agentName: agent.name, config, explicitModel: options.explicitModel,
			explicitThinkingLevel: options.explicitThinkingLevel, frontmatterModel: agent.model, mainModel: activeMainModel });
	};
	return {
		get configPath() { return settingsPath; },
		load,
		async applyChanges(changes) {
			await mutateSettingsDocument(settingsPath, (document) => {
				const base = namespaceFrom(document) ?? readLegacyDocument() ?? {};
				const namespace = applySubagentConfigurationChanges(structuredClone(base), changes);
				parseModelConfiguration(namespace);
				return { ...document, [SUBAGENTS_SETTINGS_KEY]: namespace };
			});
		},
		rememberMainModel(model) { activeMainModel = model ? canonicalMainModel(model) : undefined; },
		resolveMainModel() { return canonicalMainModel(activeMainModel); },
		resolveAssignment,
		resolveLaunch(agent, explicitModel, explicitThinkingLevel) {
			return resolveAssignment(agent, { explicitModel, explicitThinkingLevel }).launch;
		},
		setSettingsPath(path) { settingsPath = path; },
		async migrateLegacy() {
			if (Object.hasOwn(readSettingsDocument(settingsPath), SUBAGENTS_SETTINGS_KEY)) return false;
			const legacy = readLegacyDocument();
			if (!legacy) return false;
			try { parseModelConfiguration(legacy); } catch { return false; }
			let copied = false;
			await mutateSettingsDocument(settingsPath, (document) => {
				if (Object.hasOwn(document, SUBAGENTS_SETTINGS_KEY)) return document;
				copied = true;
				return { ...document, [SUBAGENTS_SETTINGS_KEY]: legacy };
			});
			if (copied && legacyPath) await fs.promises.rm(legacyPath, { force: true }).catch(() => undefined);
			return copied;
		},
	};
}

const EXT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const LEGACY_CONFIG_PATH = path.join(EXT_DIR, "config.json");

let defaultSubagentConfig: SubagentConfigStore | undefined;

/** Lazily preserve the standalone helper default without binding Settings at module load. */
export function getDefaultSubagentConfig(): SubagentConfigStore {
	return defaultSubagentConfig ??= createSubagentConfigStore({
		settingsPath: PROJECT_SETTINGS_PATH,
		legacyConfigPath: LEGACY_CONFIG_PATH,
	});
}
