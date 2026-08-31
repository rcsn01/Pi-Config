import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
	mutateSettingsDocument,
	PROJECT_SETTINGS_PATH,
	readSettingsDocument,
} from "../_shared/settings-document.ts";
import { registerSessionProfileBinding } from "../_shared/session-profile-binding.ts";
import { modelKey, pickModelAndThinking } from "../_shared/model-picker.ts";
import { resolveModelContext } from "../_shared/model-selection.ts";
import { registerToolErrorHandler, renderToolMarkdown, renderToolSummary } from "../_shared/tool-result-ui.ts";
import {
	advisorFailure,
	classifyAdvisorToolResult,
	toAdvisorToolResult,
	type AdvisorToolDetails,
} from "./outcome.ts";
import { ADVISOR_TOOL_DESCRIPTION } from "./prompt.ts";
import { createAdvisorRunner, DEFAULT_MAX_TOKENS, type AdvisorRunner, type AdvisorSettings } from "./runner.ts";

export type { AdvisorSettings } from "./runner.ts";

export interface AdvisorExtensionDependencies {
	settingsPath?: string;
	runner?: AdvisorRunner;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown, label: string): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || !value.trim()) throw new Error(`advisor.${label} must be a non-empty string.`);
	return value.trim();
}

function optionalBoolean(value: unknown): boolean | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "boolean") throw new Error("advisor.enabled must be a boolean.");
	return value;
}

function optionalThinkingLevel(value: unknown): ModelThinkingLevel | undefined {
	if (value === undefined) return undefined;
	const levels: ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
	if (typeof value !== "string" || !levels.includes(value as ModelThinkingLevel)) {
		throw new Error("advisor.thinkingLevel must be one of off, minimal, low, medium, high, xhigh, or max.");
	}
	return value as ModelThinkingLevel;
}

function positiveInteger(value: unknown, fallback: number): number {
	if (value === undefined) return fallback;
	if (!Number.isInteger(value) || (value as number) <= 0) throw new Error("advisor.maxTokens must be a positive integer.");
	return value as number;
}

function legacyModel(raw: Record<string, unknown>): string | undefined {
	const provider = typeof raw.provider === "string" ? raw.provider.trim() : "";
	const modelId = typeof raw.modelId === "string" ? raw.modelId.trim() : "";
	return provider && modelId ? `${provider}/${modelId}` : undefined;
}

export function parseAdvisorSettings(document: unknown): AdvisorSettings {
	if (!isRecord(document)) throw new Error("Settings document must be a JSON object.");
	if (document.advisor === undefined) return { enabled: false, maxTokens: DEFAULT_MAX_TOKENS };
	if (!isRecord(document.advisor)) throw new Error("advisor must be a JSON object.");
	const raw = document.advisor;
	const model = optionalString(raw.model, "model") ?? legacyModel(raw);
	return {
		enabled: optionalBoolean(raw.enabled) ?? Boolean(model),
		...(model ? { model } : {}),
		...(raw.thinkingLevel === undefined ? {} : { thinkingLevel: optionalThinkingLevel(raw.thinkingLevel) }),
		maxTokens: positiveInteger(raw.maxTokens, DEFAULT_MAX_TOKENS),
	};
}

export function loadAdvisorSettings(path: string): AdvisorSettings {
	return parseAdvisorSettings(readSettingsDocument(path));
}

function serializedAdvisorSettings(settings: AdvisorSettings): Record<string, unknown> {
	return {
		enabled: settings.enabled,
		...(settings.model ? { model: settings.model } : {}),
		...(settings.thinkingLevel === undefined ? {} : { thinkingLevel: settings.thinkingLevel }),
		maxTokens: settings.maxTokens,
	};
}

async function updateAdvisorSettings(
	path: string,
	mutate: (settings: AdvisorSettings) => AdvisorSettings,
): Promise<AdvisorSettings> {
	let next!: AdvisorSettings;
	await mutateSettingsDocument(path, (document) => {
		next = mutate(parseAdvisorSettings(document));
		return { ...document, advisor: serializedAdvisorSettings(next) };
	});
	return next;
}

async function disableAdvisorSettings(path: string): Promise<AdvisorSettings> {
	let next!: AdvisorSettings;
	await mutateSettingsDocument(path, (document) => {
		const raw = isRecord(document.advisor) ? document.advisor : {};
		let current: AdvisorSettings;
		try {
			current = parseAdvisorSettings({ advisor: raw });
		} catch {
			current = {
				enabled: false,
				model: typeof raw.model === "string" ? raw.model : legacyModel(raw),
				maxTokens: Number.isInteger(raw.maxTokens) && (raw.maxTokens as number) > 0
					? raw.maxTokens as number
					: DEFAULT_MAX_TOKENS,
			};
		}
		next = { ...current, enabled: false };
		return { ...document, advisor: serializedAdvisorSettings(next) };
	});
	return next;
}

function splitModel(reference?: string): { provider?: string; modelId?: string } {
	if (!reference) return {};
	const slash = reference.indexOf("/");
	if (slash <= 0 || slash === reference.length - 1) return {};
	return { provider: reference.slice(0, slash), modelId: reference.slice(slash + 1) };
}

export function formatAdvisorStatus(settings: Pick<AdvisorSettings, "enabled" | "model">): string | undefined {
	if (!settings.enabled || !settings.model) return undefined;
	const slash = settings.model.indexOf("/");
	const shortModelName = slash > 0 ? `${settings.model[0]}/${settings.model.slice(slash + 1)}` : settings.model;
	return `advisor(${shortModelName})`;
}

export function createAdvisorExtension(dependencies: AdvisorExtensionDependencies = {}) {
	return function advisorExtensionFactory(pi: ExtensionAPI): void {
		const settingsFilePath = dependencies.settingsPath ?? PROJECT_SETTINGS_PATH;
		let settingsPath = settingsFilePath;
		let settings: AdvisorSettings = { enabled: false, maxTokens: DEFAULT_MAX_TOKENS };
		const runner = dependencies.runner ?? createAdvisorRunner();

		registerToolErrorHandler(pi, ["advisor"], (event) => classifyAdvisorToolResult(event) === "failure");

		const notify = (ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "info") => {
			if (ctx.hasUI) ctx.ui.notify(message, type);
		};
		const updateStatus = (ctx: ExtensionContext) => {
			if (ctx.hasUI) ctx.ui.setStatus("advisor", formatAdvisorStatus(settings));
		};
		const syncTool = () => {
			const active = pi.getActiveTools();
			const shouldBeActive = settings.enabled && Boolean(settings.model);
			if (shouldBeActive && !active.includes("advisor")) pi.setActiveTools([...active, "advisor"]);
			if (!shouldBeActive && active.includes("advisor")) pi.setActiveTools(active.filter((name) => name !== "advisor"));
		};
		const loadForSession = async (ctx: ExtensionContext) => {
			try {
				settings = loadAdvisorSettings(settingsPath);
			} catch (error) {
				settings = { enabled: false, maxTokens: DEFAULT_MAX_TOKENS };
				notify(ctx, `Advisor is disabled because its settings are invalid: ${errorText(error)}`, "error");
			}
			syncTool();
			updateStatus(ctx);
		};

		const profileInitialization = registerSessionProfileBinding(
			{ settingsPath: settingsFilePath },
			{
				name: "tools-advisor",
				applyPath: (binding) => { settingsPath = binding.settingsPath; },
				initialize: (_binding, _event, ctx) => loadForSession(ctx),
				dispose: (_binding, ctx) => { if (ctx.hasUI) ctx.ui.setStatus("advisor", undefined); },
			},
		);

		const configure = async (model: Model<Api>, thinkingLevel: ModelThinkingLevel, ctx: ExtensionContext) => {
			try {
				settings = await updateAdvisorSettings(settingsPath, (current) => ({
					...current,
					enabled: true,
					model: modelKey(model),
					thinkingLevel,
				}));
				syncTool();
				updateStatus(ctx);
				if (ctx.model && model.contextWindow < ctx.model.contextWindow) {
					notify(ctx, `Advisor ${modelKey(model)} has a smaller context window than the executor. Older context may be omitted.`, "warning");
				}
				notify(ctx, `Advisor set to ${modelKey(model)} with ${thinkingLevel} thinking.`, "info");
			} catch (error) {
				notify(ctx, `Could not save advisor settings: ${errorText(error)}`, "error");
			}
		};

		pi.registerTool({
			name: "advisor",
			label: "Advisor",
			description: ADVISOR_TOOL_DESCRIPTION,
			promptSnippet: "Consult a stronger read-only model at an important decision point",
			executionMode: "sequential",
			parameters: Type.Object({
				question: Type.Optional(Type.String({ description: "Optional focus for the advisor." })),
			}),
			async execute(toolCallId, params, signal, _onUpdate, ctx) {
				try {
					settings = loadAdvisorSettings(settingsPath);
				} catch (error) {
					return toAdvisorToolResult(advisorFailure(errorText(error), "(invalid settings)"));
				}
				updateStatus(ctx);
				return toAdvisorToolResult(await runner.execute({
					ctx,
					settings,
					callId: toolCallId,
					question: params.question,
					activeToolNames: pi.getActiveTools(),
					allTools: pi.getAllTools(),
					signal,
				}));
			},
			renderCall(args, theme) {
				const focus = args.question ? ` ${theme.fg("muted", args.question)}` : "";
				return new Text(theme.fg("toolTitle", theme.bold("advisor")) + focus, 0, 0);
			},
			renderResult(result, options, theme, context) {
				const text = result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
				const disposition = classifyAdvisorToolResult({ content: result.content, details: result.details as AdvisorToolDetails, isError: context.isError });
				if (options.isPartial) return renderToolSummary(theme, "running", "Advising…");
				if (options.expanded) return renderToolMarkdown(text, theme);
				if (disposition === "warning") return renderToolSummary(theme, "warning", "Advice may be incomplete", true);
				if (disposition === "failure") return renderToolSummary(theme, "error", text || "Advisor consultation failed.");
				return renderToolSummary(theme, "success", "Advice available", true);
			},
		});

		pi.registerCommand("advisor", {
			description: "Select or disable the read-only advisor model",
			getArgumentCompletions: (prefix: string) => ["on", "off"]
				.filter((value) => value.startsWith(prefix))
				.map((value) => ({ value, label: value })),
			handler: async (args, ctx) => {
				const command = args.trim().toLowerCase();
				if (command === "off") {
					try {
						settings = await disableAdvisorSettings(settingsPath);
						syncTool();
						updateStatus(ctx);
						notify(ctx, "Advisor disabled.");
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
				if (command === "on" && settings.model) {
					settings = await updateAdvisorSettings(settingsPath, (current) => ({ ...current, enabled: true }));
					syncTool();
					updateStatus(ctx);
					notify(ctx, `Advisor enabled with ${settings.model}.`);
					return;
				}
				if (command && command !== "on") {
					notify(ctx, "Unknown /advisor argument. Accepted forms are /advisor, /advisor on, and /advisor off.", "error");
					return;
				}
				if (ctx.mode !== "tui") {
					notify(ctx, "The advisor picker requires TUI mode.", "error");
					return;
				}
				const previous = splitModel(settings.model);
				let selection;
				try {
					selection = await pickModelAndThinking(ctx, {
						previous: { ...previous, thinkingLevel: settings.thinkingLevel },
						currentModel: previous.provider && previous.modelId
							? resolveOptionalModel(ctx, previous.provider, previous.modelId)
							: undefined,
						modelTitle: "Select advisor model",
					});
				} catch (error) {
					notify(ctx, errorText(error), "error");
					return;
				}
				if (selection) await configure(selection.model, selection.thinkingLevel, ctx);
			},
		});

		pi.on("session_start", async (event, ctx) => { await profileInitialization.start(event, ctx); });
		pi.on("session_shutdown", async (event, ctx) => {
			try { await profileInitialization.stop(event, ctx); }
			finally { profileInitialization.unregister(); }
		});
	};
}

function resolveOptionalModel(ctx: ExtensionContext, provider: string, modelId: string): Model<Api> | undefined {
	const model = ctx.modelRegistry.find(provider, modelId);
	return model ? resolveModelContext(model) : undefined;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export default createAdvisorExtension();
