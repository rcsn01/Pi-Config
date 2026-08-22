import { dirname, join } from "node:path";
import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { clampThinkingLevel } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type {
	ExtensionAPI,
	ExtensionContext,
	ToolInfo,
} from "@earendil-works/pi-coding-agent";
import {
	convertToLlm,
	sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import {
	mutateSettingsDocument,
	PROJECT_SETTINGS_PATH,
	readSettingsDocument,
} from "../_shared/settings-document.ts";
import { createSessionProfileResolver } from "../_shared/active-profile.ts";
import {
	formatTokenCount,
	modelKey,
	pickModelConfiguration,
	type ModelPickerSelection,
} from "../_shared/model-picker.ts";
import { pickSelectScreen } from "../_shared/select-screen.ts";
import { resolveModelContext } from "../_shared/model-selection.ts";
import { Text } from "@earendil-works/pi-tui";
import { registerToolErrorHandler, renderToolMarkdown, renderToolSummary } from "../_shared/tool-result-ui.ts";
import {
	ADVISOR_NUDGE_MESSAGE,
	ADVISOR_TOOL_DESCRIPTION,
	transformAdvisorPrompt,
} from "./prompt.ts";
import {
	ADVISOR_NUDGE_CUSTOM_TYPE,
	countAdvisorUses,
	countAssistantTurns,
	countCustomMessages,
	createAdvisorRunner,
	DEFAULT_MAX_USES,
	DEFAULT_MAX_USES_PER_SESSION,
	DEFAULT_NUDGE_TURN,
	type AdvisorRunner,
	type AdvisorSettings,
	type AdvisorToolDetails,
} from "./runner.ts";
import { DEFAULT_CONTEXT_BUDGET, type AdvisorContextBudget } from "./transcript.ts";

export {
	deriveAdvisorSessionId,
	DEFAULT_MAX_USES,
	DEFAULT_MAX_USES_PER_SESSION,
	DEFAULT_NUDGE_TURN,
} from "./runner.ts";
export type { AdvisorSettings, AdvisorToolDetails, AdvisorToolResult } from "./runner.ts";

export const DEFAULT_MAX_TOKENS = 2048;

export { PROJECT_SETTINGS_PATH } from "../_shared/settings-document.ts";

export interface AdvisorExtensionDependencies {
	settingsPath?: string;
	runner?: AdvisorRunner;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredOptionalString(value: unknown, label: string): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || !value.trim()) throw new Error(`advisor.${label} must be a non-empty string when configured.`);
	return value.trim();
}

function preservedOptionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "boolean") throw new Error(`advisor.${label} must be a boolean.`);
	return value;
}

function positiveInteger(value: unknown, fallback: number, label: string): number {
	if (value === undefined) return fallback;
	if (!Number.isInteger(value) || (value as number) <= 0) throw new Error(`advisor.${label} must be a positive integer.`);
	return value as number;
}

function nonNegativeInteger(value: unknown, fallback: number, label: string): number {
	if (value === undefined) return fallback;
	if (!Number.isInteger(value) || (value as number) < 0) throw new Error(`advisor.${label} must be a non-negative integer.`);
	return value as number;
}

function optionalThinkingLevel(value: unknown): ModelThinkingLevel | undefined {
	if (value === undefined) return undefined;
	const levels: ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
	if (typeof value !== "string" || !levels.includes(value as ModelThinkingLevel)) {
		throw new Error("advisor.thinkingLevel must be one of off, minimal, low, medium, high, xhigh, or max.");
	}
	return value as ModelThinkingLevel;
}

function optionalContextWindow(value: unknown): number | undefined {
	if (value === undefined) return undefined;
	if (!Number.isInteger(value) || (value as number) <= 0) {
		throw new Error("advisor.contextWindow must be a positive integer.");
	}
	return value as number;
}

function safeThinkingLevel(value: unknown): ModelThinkingLevel | undefined {
	try {
		return optionalThinkingLevel(value);
	} catch {
		return undefined;
	}
}

function safeContextWindow(value: unknown): number | undefined {
	try {
		return optionalContextWindow(value);
	} catch {
		return undefined;
	}
}

const THINKING_MODES = ["all", "recent", "none"] as const;
type AdvisorMode = "on" | "strict" | "off";

export function parseContextBudget(raw: unknown): AdvisorContextBudget {
	if (raw === undefined) return DEFAULT_CONTEXT_BUDGET;
	if (!isRecord(raw)) throw new Error("advisor.contextBudget must be a JSON object.");
	const thinking = raw.thinking === undefined ? DEFAULT_CONTEXT_BUDGET.thinking : raw.thinking;
	if (!THINKING_MODES.includes(thinking as (typeof THINKING_MODES)[number])) {
		throw new Error(`advisor.contextBudget.thinking must be one of ${THINKING_MODES.join(", ")}.`);
	}
	if (raw.toolSchemas !== undefined && typeof raw.toolSchemas !== "boolean") {
		throw new Error("advisor.contextBudget.toolSchemas must be a boolean.");
	}
	return {
		thinking: thinking as AdvisorContextBudget["thinking"],
		recentMessages: nonNegativeInteger(
			raw.recentMessages,
			DEFAULT_CONTEXT_BUDGET.recentMessages,
			"contextBudget.recentMessages",
		),
		toolResultMaxChars: nonNegativeInteger(
			raw.toolResultMaxChars,
			DEFAULT_CONTEXT_BUDGET.toolResultMaxChars,
			"contextBudget.toolResultMaxChars",
		),
		toolCallMaxChars: nonNegativeInteger(
			raw.toolCallMaxChars,
			DEFAULT_CONTEXT_BUDGET.toolCallMaxChars,
			"contextBudget.toolCallMaxChars",
		),
		toolSchemas: raw.toolSchemas === undefined ? DEFAULT_CONTEXT_BUDGET.toolSchemas : raw.toolSchemas,
	};
}

export function parseAdvisorSettings(document: unknown): AdvisorSettings {
	if (!isRecord(document)) throw new Error("Settings document must be a JSON object.");
	const raw = document.advisor;
	if (raw === undefined) {
		return {
			strict: false,
			nudgeTurn: DEFAULT_NUDGE_TURN,
			maxUses: DEFAULT_MAX_USES,
			maxUsesPerSession: DEFAULT_MAX_USES_PER_SESSION,
			maxTokens: DEFAULT_MAX_TOKENS,
			contextBudget: DEFAULT_CONTEXT_BUDGET,
		};
	}
	if (!isRecord(raw)) throw new Error("advisor must be a JSON object.");
	const enabled = optionalBoolean(raw.enabled, "enabled");
	const thinkingLevel = optionalThinkingLevel(raw.thinkingLevel);
	const contextWindow = optionalContextWindow(raw.contextWindow);
	return {
		provider: requiredOptionalString(raw.provider, "provider"),
		modelId: requiredOptionalString(raw.modelId, "modelId"),
		...(enabled === undefined ? {} : { enabled }),
		...(thinkingLevel === undefined ? {} : { thinkingLevel }),
		...(contextWindow === undefined ? {} : { contextWindow }),
		strict: raw.strict === undefined
			? false
			: typeof raw.strict === "boolean"
				? raw.strict
				: (() => { throw new Error("advisor.strict must be a boolean."); })(),
		nudgeTurn: positiveInteger(raw.nudgeTurn, DEFAULT_NUDGE_TURN, "nudgeTurn"),
		// Per user turn; resets on each new user message. 0 disables the limit.
		maxUses: nonNegativeInteger(raw.maxUses, DEFAULT_MAX_USES, "maxUses"),
		maxUsesPerSession: nonNegativeInteger(raw.maxUsesPerSession, DEFAULT_MAX_USES_PER_SESSION, "maxUsesPerSession"),
		maxTokens: positiveInteger(raw.maxTokens, DEFAULT_MAX_TOKENS, "maxTokens"),
		contextBudget: parseContextBudget(raw.contextBudget),
	};
}

export function loadAdvisorSettings(path = PROJECT_SETTINGS_PATH): AdvisorSettings {
	return parseAdvisorSettings(readSettingsDocument(path));
}

function serializedAdvisorSettings(settings: AdvisorSettings): Record<string, unknown> {
	return {
		...(settings.provider ? { provider: settings.provider } : {}),
		...(settings.modelId ? { modelId: settings.modelId } : {}),
		...(settings.enabled === undefined ? {} : { enabled: settings.enabled }),
		...(settings.thinkingLevel === undefined ? {} : { thinkingLevel: settings.thinkingLevel }),
		...(settings.contextWindow === undefined ? {} : { contextWindow: settings.contextWindow }),
		strict: settings.strict,
		nudgeTurn: settings.nudgeTurn,
		maxUses: settings.maxUses,
		maxUsesPerSession: settings.maxUsesPerSession,
		maxTokens: settings.maxTokens,
		contextBudget: settings.contextBudget ?? DEFAULT_CONTEXT_BUDGET,
	};
}

async function updateAdvisorSettings(
	path: string,
	mutate: (settings: AdvisorSettings) => AdvisorSettings,
): Promise<AdvisorSettings> {
	let next: AdvisorSettings;
	await mutateSettingsDocument(path, (document) => {
		next = mutate(parseAdvisorSettings(document));
		return { ...document, advisor: serializedAdvisorSettings(next) };
	});
	return next!;
}

/** Fill fields introduced after the original advisor settings format. */
export async function migrateAdvisorSettings(
	path: string,
	ctx: ExtensionContext,
): Promise<AdvisorSettings> {
	const current = loadAdvisorSettings(path);
	if (!current.provider || !current.modelId ||
		(current.thinkingLevel !== undefined && current.contextWindow !== undefined)) {
		return current;
	}

	const refresh = await ctx.modelRegistry.refresh({ allowNetwork: false, providers: [current.provider], signal: ctx.signal });
	if (refresh.aborted || refresh.errors.has(current.provider)) return current;
	const catalogue = ctx.modelRegistry.find(current.provider, current.modelId);
	if (!catalogue) return current;
	const model = resolveModelContext(catalogue);
	const thinkingLevel = current.thinkingLevel ?? clampThinkingLevel(model, "medium");
	const contextWindow = current.contextWindow ?? model.contextWindow;
	return updateAdvisorSettings(path, (settings) => ({
		...settings,
		thinkingLevel,
		contextWindow,
	}));
}

/** Disable without first validating the advisor namespace, so the kill switch works on malformed advisor settings. */
async function disableAdvisorSettings(path: string): Promise<AdvisorSettings> {
	let next: AdvisorSettings;
	await mutateSettingsDocument(path, (document) => {
		const raw = isRecord(document.advisor) ? document.advisor : {};
		const thinkingLevel = safeThinkingLevel(raw.thinkingLevel);
		const contextWindow = safeContextWindow(raw.contextWindow);
		let contextBudget = DEFAULT_CONTEXT_BUDGET;
		try {
			contextBudget = parseContextBudget(raw.contextBudget);
		} catch {
			// The kill switch must still work on a malformed contextBudget.
		}
		next = {
			provider: preservedOptionalString(raw.provider),
			modelId: preservedOptionalString(raw.modelId),
			...(thinkingLevel === undefined ? {} : { thinkingLevel }),
			...(contextWindow === undefined ? {} : { contextWindow }),
			enabled: false,
			strict: false,
			nudgeTurn: Number.isInteger(raw.nudgeTurn) && (raw.nudgeTurn as number) > 0
				? raw.nudgeTurn as number
				: DEFAULT_NUDGE_TURN,
			maxUses: Number.isInteger(raw.maxUses) && (raw.maxUses as number) >= 0 ? raw.maxUses as number : DEFAULT_MAX_USES,
			maxUsesPerSession: Number.isInteger(raw.maxUsesPerSession) && (raw.maxUsesPerSession as number) >= 0
				? raw.maxUsesPerSession as number
				: DEFAULT_MAX_USES_PER_SESSION,
			maxTokens: Number.isInteger(raw.maxTokens) && (raw.maxTokens as number) > 0 ? raw.maxTokens as number : DEFAULT_MAX_TOKENS,
			contextBudget,
		};
		return { ...document, advisor: serializedAdvisorSettings(next) };
	});
	return next!;
}


const ADVISOR_MODE_OPTIONS = [
	{ value: "on", label: "on", description: "Advisor available; the model decides when to consult." },
	{ value: "strict", label: "strict", description: "Advisor available and nudged if unused after the configured turn." },
	{ value: "off", label: "off", description: "Disable advisor consultations." },
] as const;

async function selectAdvisorMode(
	ctx: ExtensionContext,
	currentValue: AdvisorMode,
): Promise<AdvisorMode | undefined> {
	if (ctx.mode !== "tui") {
		const selected = await ctx.ui.select("Select advisor mode", ADVISOR_MODE_OPTIONS.map((option) => option.label));
		return ADVISOR_MODE_OPTIONS.find((option) => option.value === selected)?.value;
	}
	return pickSelectScreen(ctx, {
		title: "Select advisor mode",
		items: ADVISOR_MODE_OPTIONS.map((option) => ({ ...option })),
		currentValue,
		showCurrentMarker: true,
	});
}

function hasImagesInContext(ctx: ExtensionContext): boolean {
	const messages = ctx.sessionManager.buildContextEntries().flatMap(sessionEntryToContextMessages);
	return convertToLlm(messages).some((message) => {
		if (message.role === "assistant") return false;
		return Array.isArray(message.content) && message.content.some((block) => block.type === "image");
	});
}

function isModelReferenceArgument(reference: string): boolean {
	const slash = reference.indexOf("/");
	if (slash <= 0 || slash === reference.length - 1) return false;
	return Boolean(reference.slice(0, slash).trim() && reference.slice(slash + 1).trim());
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function formatAdvisorStatus(active: boolean, strict: boolean, modelName: string): string | undefined {
	if (!active) return undefined;
	const slash = modelName.indexOf("/");
	const shortModelName = slash > 0 ? `${modelName[0]}/${modelName.slice(slash + 1)}` : modelName;
	return `${strict ? "advisor.s" : "advisor"}(${shortModelName})`;
}

export function formatConfiguredAdvisorStatus(
	settings: Pick<AdvisorSettings, "enabled" | "provider" | "modelId" | "strict">,
): string | undefined {
	if (settings.enabled === false || !settings.provider || !settings.modelId) return undefined;
	return formatAdvisorStatus(true, settings.strict, `${settings.provider}/${settings.modelId}`);
}

export function createAdvisorExtension(dependencies: AdvisorExtensionDependencies = {}) {
	return function advisorExtensionFactory(pi: ExtensionAPI): void {
		const settingsFilePath = dependencies.settingsPath ?? PROJECT_SETTINGS_PATH;
		const profilesDirectory = join(dirname(settingsFilePath), "profiles");
		const resolver = createSessionProfileResolver({
			settingsPath: settingsFilePath,
			profilesDirectory,
		});
		// The document read/written by loadForSession and the /advisor commands;
		// repointed at the session's profile file on session start.
		let settingsPath = settingsFilePath;
		const runner = dependencies.runner ?? createAdvisorRunner();
		let settings: AdvisorSettings = parseAdvisorSettings({});

		registerToolErrorHandler(pi, ["advisor"], (event) =>
			event.content.some((content) => content.type === "text" && content.text?.startsWith("advisor_") &&
				!(event.details && typeof event.details === "object" && "truncated" in event.details && event.details.truncated === true)),
		);

		const notify = (ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "info") => {
			if (ctx.hasUI) ctx.ui.notify(message, type);
		};

		const updateStatus = (ctx: ExtensionContext): void => {
			if (ctx.hasUI) ctx.ui.setStatus("advisor", formatConfiguredAdvisorStatus(settings));
		};

		const loadForSession = async (ctx: ExtensionContext): Promise<void> => {
			let loaded = true;
			try {
				settings = loadAdvisorSettings(settingsPath);
			} catch (error) {
				loaded = false;
				settings = parseAdvisorSettings({});
				notify(ctx, `Advisor is disabled because its settings are invalid: ${errorText(error)}`, "error");
			}
			if (loaded) {
				try {
					settings = await migrateAdvisorSettings(settingsPath, ctx);
				} catch (error) {
					notify(ctx, `Could not migrate advisor settings: ${errorText(error)}`, "warning");
				}
			}
			const active = pi.getActiveTools();
			if (settings.enabled !== false && settings.provider && settings.modelId) {
				if (!active.includes("advisor")) pi.setActiveTools([...active, "advisor"]);
			} else if (active.includes("advisor")) {
				pi.setActiveTools(active.filter((name) => name !== "advisor"));
			}
			updateStatus(ctx);
		};

		const warnAboutModel = (model: Model<Api>, ctx: ExtensionContext) => {
			if (ctx.model && model.contextWindow < ctx.model.contextWindow) {
				notify(ctx, `Advisor ${modelKey(model)} has a smaller context window than the executor (${model.contextWindow.toLocaleString()} vs ${ctx.model.contextWindow.toLocaleString()}).`, "warning");
			}
			if (hasImagesInContext(ctx) && !model.input.includes("image")) {
				notify(ctx, `Advisor ${modelKey(model)} cannot accept images present in the current context.`, "warning");
			}
		};

		const configureModel = async (
			model: Model<Api>,
			thinkingLevel: ModelThinkingLevel,
			contextWindow: number,
			ctx: ExtensionContext,
			strict?: boolean,
		): Promise<void> => {
			if (!ctx.modelRegistry.hasConfiguredAuth(model)) {
				notify(ctx, `Advisor model ${modelKey(model)} is unavailable or unauthenticated.`, "error");
				return;
			}
			try {
				settings = await updateAdvisorSettings(settingsPath, (current) => ({
					...current,
					enabled: true,
					provider: model.provider,
					modelId: model.id,
					thinkingLevel,
					contextWindow,
					strict: strict ?? current.strict,
				}));
				const active = pi.getActiveTools();
				if (!active.includes("advisor")) pi.setActiveTools([...active, "advisor"]);
				updateStatus(ctx);
				warnAboutModel(model, ctx);
				notify(ctx, `Advisor set to ${modelKey(model)} · thinking ${thinkingLevel} · context ${formatTokenCount(contextWindow)}.`, "info");
			} catch (error) {
				notify(ctx, `Could not save advisor settings: ${errorText(error)}`, "error");
			}
		};

		const hasCompleteSelection = (value: AdvisorSettings): boolean =>
			Boolean(value.provider && value.modelId && value.thinkingLevel !== undefined && value.contextWindow !== undefined);

		const setStrictMode = async (strict: boolean, ctx: ExtensionContext): Promise<void> => {
			try {
				settings = await updateAdvisorSettings(settingsPath, (current) => ({ ...current, enabled: true, strict }));
				const active = pi.getActiveTools();
				if (!active.includes("advisor")) pi.setActiveTools([...active, "advisor"]);
				updateStatus(ctx);
				const detail = settings.provider && settings.modelId && settings.thinkingLevel && settings.contextWindow
					? ` · ${settings.provider}/${settings.modelId} · thinking ${settings.thinkingLevel} · context ${formatTokenCount(settings.contextWindow)}`
					: "";
				notify(ctx, `Advisor strict mode ${strict ? "enabled" : "disabled"}.${detail}`, "info");
			} catch (error) {
				notify(ctx, `Could not save advisor settings: ${errorText(error)}`, "error");
			}
		};

		pi.on("before_agent_start", async (event) => {
			if (
				settings.enabled === false ||
				!settings.provider ||
				!settings.modelId ||
				!pi.getActiveTools().includes("advisor")
			) return;
			return { systemPrompt: transformAdvisorPrompt(event.systemPrompt) };
		});

		pi.registerTool({
			name: "advisor",
			label: "Advisor",
			description: ADVISOR_TOOL_DESCRIPTION,
			promptSnippet: "Consult a stronger read-only model at important decision points",
			executionMode: "sequential",
			parameters: Type.Object({
				question: Type.Optional(Type.String({
					description: "Optional focus for the advisor. The full conversation is forwarded either way — do not restate context here.",
				})),
			}),
			async execute(toolCallId, params, signal, _onUpdate, ctx) {
				try {
					settings = loadAdvisorSettings(settingsPath);
				} catch (error) {
					updateStatus(ctx);
					return {
						content: [{ type: "text", text: `advisor_settings_error: ${errorText(error)}` }],
						details: { model: "(invalid settings)", consumesBudget: false, truncated: false },
						isError: true,
					};
				}
				updateStatus(ctx);
				const result = await runner.execute({
					ctx,
					settings,
					callId: toolCallId,
					question: params.question,
					activeToolNames: pi.getActiveTools(),
					allTools: pi.getAllTools() as ToolInfo[],
					signal,
					onStatus: () => updateStatus(ctx),
				});
				const text = result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
			const details = result.details as AdvisorToolDetails | undefined;
			const isFailure = text.startsWith("advisor_") && !details?.truncated;
			return isFailure ? { ...result, isError: true } : result;
			},
			renderCall(args, theme) {
				const focus = args.question ? ` ${theme.fg("muted", args.question)}` : "";
				return new Text(theme.fg("toolTitle", theme.bold("advisor")) + focus, 0, 0);
			},
			renderResult(result, options, theme, context) {
				const text = result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
				const details = result.details as AdvisorToolDetails | undefined;
				if (options.isPartial) return renderToolSummary(theme, "running", "Advising…");
				if (details?.truncated) {
					if (options.expanded) return renderToolMarkdown(text.replace(/^advisor_truncated:\s*/, ""), theme);
					return renderToolSummary(theme, "warning", "Advice may be incomplete", true);
				}
				if (context.isError || text.startsWith("advisor_")) {
					if (options.expanded) return renderToolMarkdown(text, theme);
					return renderToolSummary(theme, "error", text || "Advisor consultation failed.");
				}
				if (options.expanded) return renderToolMarkdown(text, theme);
				return renderToolSummary(theme, "success", "Advice available", true);
			},
		});

		pi.registerCommand("advisor", {
			description: "Select the read-only advisor model or mode",
			getArgumentCompletions: (prefix: string) => {
				const values = ["on", "strict", "off"];
				const matches = values.filter((value) => value.startsWith(prefix));
				return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
			},
			handler: async (args, ctx) => {
				const reference = args.trim();
				const normalized = reference.toLowerCase();
				if (normalized === "off") {
					try {
						settings = await disableAdvisorSettings(settingsPath);
						updateStatus(ctx);
						notify(ctx, "Advisor disabled for future consultations.", "info");
					} catch (error) {
						notify(ctx, `Could not disable advisor: ${errorText(error)}`, "error");
					}
					return;
				}
				try {
					settings = loadAdvisorSettings(settingsPath);
				} catch (error) {
					notify(ctx, `Advisor settings are invalid: ${errorText(error)}`, "error");
					return;
				}

				let desiredStrict: boolean | undefined;
				let needsPicker = false;
				if (!reference) {
					if (ctx.mode !== "tui") {
						notify(ctx, "The full /advisor picker requires TUI mode.", "error");
						return;
					}
					const currentMode: AdvisorMode = settings.enabled === false ? "off" : settings.strict ? "strict" : "on";
					const mode = await selectAdvisorMode(ctx, currentMode);
					if (!mode) return;
					if (mode === "off") {
						try {
							settings = await disableAdvisorSettings(settingsPath);
							updateStatus(ctx);
							notify(ctx, "Advisor disabled for future consultations.", "info");
						} catch (error) {
							notify(ctx, `Could not disable advisor: ${errorText(error)}`, "error");
						}
						return;
					}
					desiredStrict = mode === "strict";
					needsPicker = true;
				} else if (normalized === "on" || normalized === "strict") {
					desiredStrict = normalized === "strict";
					if (hasCompleteSelection(settings)) {
						await setStrictMode(desiredStrict, ctx);
						return;
					}
					needsPicker = true;
				} else {
					const message = isModelReferenceArgument(reference)
						? "Direct advisor model arguments are not supported. Use /advisor to open the full picker."
						: "Unknown /advisor argument. Accepted forms are /advisor, /advisor on, /advisor strict, and /advisor off.";
					notify(ctx, message, "error");
					return;
				}

				if (!needsPicker) return;
				if (ctx.mode !== "tui") {
					notify(ctx, "The full /advisor picker requires TUI mode.", "error");
					return;
				}
				const configuredModel = settings.provider && settings.modelId
					? ctx.modelRegistry.find(settings.provider, settings.modelId)
					: undefined;
				let selection: ModelPickerSelection | undefined;
				try {
					selection = await pickModelConfiguration(ctx, {
						previous: {
							provider: settings.provider,
							modelId: settings.modelId,
							thinkingLevel: settings.thinkingLevel,
							contextWindow: settings.contextWindow,
						},
						currentModel: configuredModel ? resolveModelContext(configuredModel) : undefined,
					});
				} catch (error) {
					notify(ctx, errorText(error), "error");
					return;
				}
				if (!selection) return;
				await configureModel(selection.model, selection.thinkingLevel, selection.contextWindow, ctx, desiredStrict);
			},
		});

		pi.on("turn_end", (event, ctx) => {
			if (settings.enabled === false || !settings.strict || !settings.provider || !settings.modelId) return;
			const branch = ctx.sessionManager.getBranch();
			const currentAssistant = event.message.role === "assistant" ? event.message : undefined;
			if (countAssistantTurns(branch, currentAssistant) < settings.nudgeTurn) return;
			if (settings.maxUsesPerSession > 0 && countAdvisorUses(branch, false) >= settings.maxUsesPerSession) return;
			const turnUses = countAdvisorUses(branch, true);
			if (turnUses > 0) return;
			if (settings.maxUses > 0 && turnUses >= settings.maxUses) return;
			if (countCustomMessages(branch, ADVISOR_NUDGE_CUSTOM_TYPE) > 0) return;
			pi.sendMessage(
				{
					customType: ADVISOR_NUDGE_CUSTOM_TYPE,
					content: ADVISOR_NUDGE_MESSAGE,
					display: false,
				},
				{ deliverAs: "steer", triggerTurn: false },
			);
		});

		pi.on("session_start", async (event, ctx) => {
			// Point the advisor at the session's profile file; no profile means
			// settings.json.
			settingsPath = resolver.resolve(ctx.sessionManager.getBranch(), event.reason);
			await loadForSession(ctx);
		});
		pi.on("session_shutdown", async (_event, ctx) => {
			if (ctx.hasUI) ctx.ui.setStatus("advisor", undefined);
		});
	};
}

export default createAdvisorExtension();
