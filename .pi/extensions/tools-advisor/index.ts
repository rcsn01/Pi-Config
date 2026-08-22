import { dirname, join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
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
import { pickSelectScreen, type SelectScreenItem } from "../_shared/select-screen.ts";
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
			allowCrossProvider: false,
			contextBudget: DEFAULT_CONTEXT_BUDGET,
		};
	}
	if (!isRecord(raw)) throw new Error("advisor must be a JSON object.");
	const enabled = optionalBoolean(raw.enabled, "enabled");
	return {
		provider: requiredOptionalString(raw.provider, "provider"),
		modelId: requiredOptionalString(raw.modelId, "modelId"),
		...(enabled === undefined ? {} : { enabled }),
		strict: raw.strict === undefined
			? false
			: typeof raw.strict === "boolean"
				? raw.strict
				: (() => { throw new Error("advisor.strict must be a boolean."); })(),
		nudgeTurn: positiveInteger(raw.nudgeTurn, DEFAULT_NUDGE_TURN, "nudgeTurn"),
		// Per user turn; resets on each new user message.
		maxUses: positiveInteger(raw.maxUses, DEFAULT_MAX_USES, "maxUses"),
		maxUsesPerSession: positiveInteger(raw.maxUsesPerSession, DEFAULT_MAX_USES_PER_SESSION, "maxUsesPerSession"),
		maxTokens: positiveInteger(raw.maxTokens, DEFAULT_MAX_TOKENS, "maxTokens"),
		allowCrossProvider: raw.allowCrossProvider === undefined
			? false
			: typeof raw.allowCrossProvider === "boolean"
				? raw.allowCrossProvider
				: (() => { throw new Error("advisor.allowCrossProvider must be a boolean."); })(),
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
		strict: settings.strict,
		nudgeTurn: settings.nudgeTurn,
		maxUses: settings.maxUses,
		maxUsesPerSession: settings.maxUsesPerSession,
		maxTokens: settings.maxTokens,
		allowCrossProvider: settings.allowCrossProvider,
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

/** Disable without first validating the advisor namespace, so the kill switch works on malformed advisor settings. */
async function disableAdvisorSettings(path: string): Promise<AdvisorSettings> {
	let next: AdvisorSettings;
	await mutateSettingsDocument(path, (document) => {
		const raw = isRecord(document.advisor) ? document.advisor : {};
		let contextBudget = DEFAULT_CONTEXT_BUDGET;
		try {
			contextBudget = parseContextBudget(raw.contextBudget);
		} catch {
			// The kill switch must still work on a malformed contextBudget.
		}
		next = {
			provider: preservedOptionalString(raw.provider),
			modelId: preservedOptionalString(raw.modelId),
			enabled: false,
			strict: false,
			nudgeTurn: Number.isInteger(raw.nudgeTurn) && (raw.nudgeTurn as number) > 0
				? raw.nudgeTurn as number
				: DEFAULT_NUDGE_TURN,
			maxUses: Number.isInteger(raw.maxUses) && (raw.maxUses as number) > 0 ? raw.maxUses as number : DEFAULT_MAX_USES,
			maxUsesPerSession: Number.isInteger(raw.maxUsesPerSession) && (raw.maxUsesPerSession as number) > 0
				? raw.maxUsesPerSession as number
				: DEFAULT_MAX_USES_PER_SESSION,
			maxTokens: Number.isInteger(raw.maxTokens) && (raw.maxTokens as number) > 0 ? raw.maxTokens as number : DEFAULT_MAX_TOKENS,
			allowCrossProvider: false,
			contextBudget,
		};
		return { ...document, advisor: serializedAdvisorSettings(next) };
	});
	return next!;
}

function modelKey(model: Pick<Model<Api>, "provider" | "id">): string {
	return `${model.provider}/${model.id}`;
}

function availableAdvisorModels(ctx: ExtensionContext): Model<Api>[] {
	const source = ctx.scopedModels.length > 0
		? ctx.scopedModels.map((entry) => ctx.modelRegistry.find(entry.model.provider, entry.model.id) ?? entry.model)
		: ctx.modelRegistry.getAvailable();
	const unique = new Map<string, Model<Api>>();
	for (const model of source) {
		if (ctx.modelRegistry.hasConfiguredAuth(model)) unique.set(modelKey(model), model);
	}
	return [...unique.values()].sort((left, right) => modelKey(left).localeCompare(modelKey(right)));
}

async function selectAdvisorModel(
	ctx: ExtensionContext,
	models: readonly Model<Api>[],
	currentValue?: string,
): Promise<Model<Api> | undefined> {
	if (ctx.mode !== "tui") {
		const selected = await ctx.ui.select("Select advisor model", models.map(modelKey));
		return models.find((model) => modelKey(model) === selected);
	}
	const items: SelectScreenItem[] = models.map((model) => ({
		value: modelKey(model),
		label: modelKey(model),
		description: `${model.name} · ${model.contextWindow.toLocaleString()} context · ${model.input.includes("image") ? "text+image" : "text only"}`,
		searchText: model.name,
	}));
	const selected = await pickSelectScreen(ctx, {
		title: "Select advisor model",
		items,
		currentValue,
		showCurrentMarker: Boolean(currentValue),
		search: {
			filter: (choices, query) => {
				const normalized = query.trim().toLowerCase();
				return choices.filter((choice) =>
					choice.value.toLowerCase().includes(normalized) ||
					choice.searchText?.toLowerCase().includes(normalized));
			},
		},
	});
	return models.find((model) => modelKey(model) === selected);
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

function parseModelReference(reference: string): { provider: string; modelId: string } | undefined {
	const slash = reference.indexOf("/");
	if (slash <= 0 || slash === reference.length - 1) return undefined;
	return { provider: reference.slice(0, slash), modelId: reference.slice(slash + 1) };
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

		const loadForSession = (ctx: ExtensionContext): void => {
			try {
				settings = loadAdvisorSettings(settingsPath);
			} catch (error) {
				settings = parseAdvisorSettings({});
				notify(ctx, `Advisor is disabled because its settings are invalid: ${errorText(error)}`, "error");
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

		const configureModel = async (model: Model<Api>, ctx: ExtensionContext, strict?: boolean): Promise<void> => {
			if (!ctx.modelRegistry.hasConfiguredAuth(model)) {
				notify(ctx, `Advisor model ${modelKey(model)} is unavailable or unauthenticated.`, "error");
				return;
			}
			const crossProvider = !!ctx.model && ctx.model.provider !== model.provider;
			let allowCrossProvider = false;
			if (crossProvider) {
				if (settings.allowCrossProvider) {
					allowCrossProvider = true;
				} else {
					if (!ctx.hasUI) {
						notify(ctx, "Advisor selection denied: cross-provider transfer requires explicit confirmation in the UI.", "error");
						return;
					}
					const approved = await ctx.ui.confirm(
						"Cross-provider advisor",
						`Send the executor system prompt, conversation, code, and tool output to ${modelKey(model)}?`,
					);
					if (!approved) {
						notify(ctx, "Advisor selection cancelled; no context was transferred.", "info");
						return;
					}
					allowCrossProvider = true;
				}
			}
			try {
				settings = await updateAdvisorSettings(settingsPath, (current) => ({
					...current,
					enabled: true,
					provider: model.provider,
					modelId: model.id,
					strict: strict ?? current.strict,
					allowCrossProvider,
				}));
				const active = pi.getActiveTools();
				if (!active.includes("advisor")) pi.setActiveTools([...active, "advisor"]);
				updateStatus(ctx);
				warnAboutModel(model, ctx);
				notify(ctx, `Advisor set to ${modelKey(model)}.`, "info");
			} catch (error) {
				notify(ctx, `Could not save advisor settings: ${errorText(error)}`, "error");
			}
		};

		const setStrictMode = async (strict: boolean, ctx: ExtensionContext): Promise<void> => {
			try {
				settings = await updateAdvisorSettings(settingsPath, (current) => ({ ...current, enabled: true, strict }));
				const active = pi.getActiveTools();
				if (!active.includes("advisor")) pi.setActiveTools([...active, "advisor"]);
				updateStatus(ctx);
				notify(ctx, `Advisor strict mode ${strict ? "enabled" : "disabled"}.`, "info");
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
				let pickModel = false;
				if (!reference) {
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
					pickModel = true;
				} else if (normalized === "on" || normalized === "strict") {
					desiredStrict = normalized === "strict";
					if (settings.provider && settings.modelId) {
						await setStrictMode(desiredStrict, ctx);
						return;
					}
					pickModel = true;
				}

				let selected: Model<Api> | undefined;
				if (pickModel) {
					try {
						const refresh = await ctx.modelRegistry.refresh({ allowNetwork: false });
						if (refresh.aborted || refresh.errors.size > 0) throw new Error("Could not refresh the authenticated model catalogue.");
					} catch (error) {
						notify(ctx, errorText(error), "error");
						return;
					}
					const models = availableAdvisorModels(ctx);
					if (models.length === 0) {
						notify(ctx, "No authenticated advisor models are available.", "error");
						return;
					}
					const currentModel = settings.provider && settings.modelId
						? `${settings.provider}/${settings.modelId}`
						: undefined;
					selected = await selectAdvisorModel(ctx, models, currentModel);
				} else {
					const parsed = parseModelReference(reference);
					if (!parsed) {
						notify(ctx, "Usage: /advisor, /advisor on, /advisor strict, /advisor <provider>/<model>, or /advisor off", "error");
						return;
					}
					selected = ctx.modelRegistry.find(parsed.provider, parsed.modelId);
					if (!selected || !ctx.modelRegistry.hasConfiguredAuth(selected)) {
						notify(ctx, `Advisor model ${reference} is unavailable or unauthenticated.`, "error");
						return;
					}
				}
				if (selected) await configureModel(selected, ctx, desiredStrict);
			},
		});

		pi.on("turn_end", (event, ctx) => {
			if (settings.enabled === false || !settings.strict || !settings.provider || !settings.modelId) return;
			const branch = ctx.sessionManager.getBranch();
			const currentAssistant = event.message.role === "assistant" ? event.message : undefined;
			if (countAssistantTurns(branch, currentAssistant) < settings.nudgeTurn) return;
			if (countAdvisorUses(branch, false) >= settings.maxUsesPerSession) return;
			const turnUses = countAdvisorUses(branch, true);
			if (turnUses > 0) return;
			if (turnUses >= settings.maxUses) return;
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
			loadForSession(ctx);
		});
		pi.on("session_shutdown", async (_event, ctx) => {
			if (ctx.hasUI) ctx.ui.setStatus("advisor", undefined);
		});
	};
}

export default createAdvisorExtension();
