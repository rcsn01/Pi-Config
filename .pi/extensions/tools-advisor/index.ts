import type { Api, Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type {
	ExtensionAPI,
	ExtensionContext,
	ToolInfo,
} from "@earendil-works/pi-coding-agent";
import {
	convertToLlm,
	getMarkdownTheme,
	sessionEntryToContextMessages,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import {
	PROJECT_SETTINGS_PATH,
	readSettingsDocument,
	writeSettingsDocument,
} from "../tools-subagents/settings-store.ts";
import { Input, Markdown, SelectList, Text, truncateToWidth } from "@earendil-works/pi-tui";
import {
	ADVISOR_PROMPT_GUIDELINES,
	ADVISOR_TOOL_DESCRIPTION,
} from "./prompt.ts";
import {
	createAdvisorRunner,
	type AdvisorRunner,
	type AdvisorSettings,
	type AdvisorToolDetails,
} from "./runner.ts";

export { deriveAdvisorSessionId } from "./runner.ts";
export type { AdvisorSettings, AdvisorToolDetails, AdvisorToolResult } from "./runner.ts";

export const DEFAULT_MAX_USES = 3;
export const DEFAULT_MAX_TOKENS = 2048;

export { PROJECT_SETTINGS_PATH } from "../tools-subagents/settings-store.ts";

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

function positiveInteger(value: unknown, fallback: number, label: string): number {
	if (value === undefined) return fallback;
	if (!Number.isInteger(value) || (value as number) <= 0) throw new Error(`advisor.${label} must be a positive integer.`);
	return value as number;
}

export function parseAdvisorSettings(document: unknown): AdvisorSettings {
	if (!isRecord(document)) throw new Error("Settings document must be a JSON object.");
	const raw = document.advisor;
	if (raw === undefined) {
		return { maxUses: DEFAULT_MAX_USES, maxTokens: DEFAULT_MAX_TOKENS, allowCrossProvider: false };
	}
	if (!isRecord(raw)) throw new Error("advisor must be a JSON object.");
	return {
		provider: requiredOptionalString(raw.provider, "provider"),
		modelId: requiredOptionalString(raw.modelId, "modelId"),
		maxUses: positiveInteger(raw.maxUses, DEFAULT_MAX_USES, "maxUses"),
		maxTokens: positiveInteger(raw.maxTokens, DEFAULT_MAX_TOKENS, "maxTokens"),
		allowCrossProvider: raw.allowCrossProvider === undefined
			? false
			: typeof raw.allowCrossProvider === "boolean"
				? raw.allowCrossProvider
				: (() => { throw new Error("advisor.allowCrossProvider must be a boolean."); })(),
	};
}

export function loadAdvisorSettings(path = PROJECT_SETTINGS_PATH): AdvisorSettings {
	return parseAdvisorSettings(readSettingsDocument(path));
}

function serializedAdvisorSettings(settings: AdvisorSettings): Record<string, unknown> {
	return {
		...(settings.provider ? { provider: settings.provider } : {}),
		...(settings.modelId ? { modelId: settings.modelId } : {}),
		maxUses: settings.maxUses,
		maxTokens: settings.maxTokens,
		allowCrossProvider: settings.allowCrossProvider,
	};
}

async function updateAdvisorSettings(
	path: string,
	mutate: (settings: AdvisorSettings) => AdvisorSettings,
): Promise<AdvisorSettings> {
	return withFileMutationQueue(path, async () => {
		const document = readSettingsDocument(path);
		const next = mutate(parseAdvisorSettings(document));
		writeSettingsDocument(path, { ...document, advisor: serializedAdvisorSettings(next) });
		return next;
	});
}

/** Disable without first validating the advisor namespace, so the kill switch works on malformed advisor settings. */
async function disableAdvisorSettings(path: string): Promise<AdvisorSettings> {
	return withFileMutationQueue(path, async () => {
		const document = readSettingsDocument(path);
		const raw = isRecord(document.advisor) ? document.advisor : {};
		const next: AdvisorSettings = {
			maxUses: Number.isInteger(raw.maxUses) && (raw.maxUses as number) > 0 ? raw.maxUses as number : DEFAULT_MAX_USES,
			maxTokens: Number.isInteger(raw.maxTokens) && (raw.maxTokens as number) > 0 ? raw.maxTokens as number : DEFAULT_MAX_TOKENS,
			allowCrossProvider: false,
		};
		writeSettingsDocument(path, { ...document, advisor: serializedAdvisorSettings(next) });
		return next;
	});
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

async function selectAdvisorModel(ctx: ExtensionContext, models: readonly Model<Api>[]): Promise<Model<Api> | undefined> {
	if (ctx.mode !== "tui") {
		const selected = await ctx.ui.select("Select advisor model", models.map(modelKey));
		return models.find((model) => modelKey(model) === selected);
	}
	return ctx.ui.custom<Model<Api> | undefined>((tui, theme, keybindings, done) => {
		const search = new Input();
		let displayed = [...models];
		let list: SelectList;
		const rebuild = () => {
			const query = search.getValue().trim().toLowerCase();
			displayed = models.filter((model) => modelKey(model).toLowerCase().includes(query) || model.name.toLowerCase().includes(query));
			list = new SelectList(
				displayed.map((model) => ({
					value: modelKey(model),
					label: modelKey(model),
					description: `${model.name} · ${model.contextWindow.toLocaleString()} context · ${model.input.includes("image") ? "text+image" : "text only"}`,
				})),
				Math.min(Math.max(displayed.length, 1), 12),
				{
					selectedPrefix: (text) => theme.fg("accent", text),
					selectedText: (text) => theme.fg("accent", text),
					description: (text) => theme.fg("muted", text),
					scrollInfo: (text) => theme.fg("dim", text),
					noMatch: (text) => theme.fg("warning", text),
				},
			);
			list.onSelect = (item) => done(displayed.find((model) => modelKey(model) === item.value));
			list.onCancel = () => done(undefined);
		};
		rebuild();
		return {
			get focused() { return search.focused; },
			set focused(value: boolean) { search.focused = value; },
			render(width: number) {
			const border = theme.fg("accent", "─".repeat(Math.max(0, width)));
			return [border, truncateToWidth(theme.fg("accent", theme.bold("Select Advisor Model")), width), ...search.render(width), "", ...list.render(width), "", truncateToWidth(theme.fg("dim", "Type to filter · Enter select · Esc cancel"), width), border];
		},
		invalidate() { search.invalidate(); list.invalidate(); },
		handleInput(data: string) {
			if (keybindings.matches(data, "tui.select.up") || keybindings.matches(data, "tui.select.down") || keybindings.matches(data, "tui.select.confirm") || keybindings.matches(data, "tui.select.cancel")) {
				list.handleInput(data);
			} else {
				const before = search.getValue();
				search.handleInput(data);
				if (before !== search.getValue()) rebuild();
			}
			tui.requestRender();
		},
	};
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

export function createAdvisorExtension(dependencies: AdvisorExtensionDependencies = {}) {
	return function advisorExtensionFactory(pi: ExtensionAPI): void {
		const settingsPath = dependencies.settingsPath ?? PROJECT_SETTINGS_PATH;
		const runner = dependencies.runner ?? createAdvisorRunner();
		let settings: AdvisorSettings = parseAdvisorSettings({});

		const notify = (ctx: ExtensionContext, message: string, type: "info" | "warning" | "error" = "info") => {
			if (ctx.hasUI) ctx.ui.notify(message, type);
		};

		const loadForSession = (ctx: ExtensionContext): void => {
			try {
				settings = loadAdvisorSettings(settingsPath);
			} catch (error) {
				settings = parseAdvisorSettings({});
				notify(ctx, `Advisor is disabled because its settings are invalid: ${errorText(error)}`, "error");
			}
			runner.reconstruct(ctx);
			const active = pi.getActiveTools();
			if (settings.provider && settings.modelId) {
				if (!active.includes("advisor")) pi.setActiveTools([...active, "advisor"]);
			} else if (active.includes("advisor")) {
				pi.setActiveTools(active.filter((name) => name !== "advisor"));
			}
		};

		const warnAboutModel = (model: Model<Api>, ctx: ExtensionContext) => {
			if (ctx.model && model.contextWindow < ctx.model.contextWindow) {
				notify(ctx, `Advisor ${modelKey(model)} has a smaller context window than the executor (${model.contextWindow.toLocaleString()} vs ${ctx.model.contextWindow.toLocaleString()}).`, "warning");
			}
			if (hasImagesInContext(ctx) && !model.input.includes("image")) {
				notify(ctx, `Advisor ${modelKey(model)} cannot accept images present in the current context.`, "warning");
			}
		};

		const configureModel = async (model: Model<Api>, ctx: ExtensionContext): Promise<void> => {
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
					provider: model.provider,
					modelId: model.id,
					allowCrossProvider,
				}));
				const active = pi.getActiveTools();
				if (!active.includes("advisor")) pi.setActiveTools([...active, "advisor"]);
				warnAboutModel(model, ctx);
				notify(ctx, `Advisor set to ${modelKey(model)}.`, "info");
			} catch (error) {
				notify(ctx, `Could not save advisor settings: ${errorText(error)}`, "error");
			}
		};

		pi.registerTool({
			name: "advisor",
			label: "Advisor",
			description: ADVISOR_TOOL_DESCRIPTION,
			promptSnippet: "Consult a stronger read-only model at important decision points",
			promptGuidelines: ADVISOR_PROMPT_GUIDELINES,
			executionMode: "sequential",
			parameters: Type.Object({
				question: Type.Optional(Type.String({ description: "Optional focus question for the advisor" })),
			}),
			async execute(toolCallId, params, signal, _onUpdate, ctx) {
				try {
					settings = loadAdvisorSettings(settingsPath);
				} catch (error) {
					return {
						content: [{ type: "text", text: `advisor_settings_error: ${errorText(error)}` }],
						details: { model: "(invalid settings)", consumesBudget: false, truncated: false },
					};
				}
				return runner.execute({
					ctx,
					settings,
					callId: toolCallId,
					question: params.question,
					activeToolNames: pi.getActiveTools(),
					allTools: pi.getAllTools() as ToolInfo[],
					signal,
					onStatus: (active, modelName) => {
						if (ctx.hasUI) ctx.ui.setStatus("advisor", active ? `Advising · ${modelName}` : undefined);
					},
				});
			},
			renderCall(args, theme) {
				const focus = args.question ? ` ${theme.fg("muted", args.question)}` : "";
				return new Text(theme.fg("toolTitle", theme.bold("advisor")) + focus, 0, 0);
			},
			renderResult(result, options, theme) {
				const text = result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
				const details = result.details as AdvisorToolDetails;
				if (options.isPartial) return new Text(theme.fg("warning", "Advising…"), 0, 0);
				if (options.expanded) return new Markdown(text, 0, 0, getMarkdownTheme());
				if (details.truncated || text.startsWith("advisor_")) {
					return new Text(theme.fg("warning", text), 0, 0);
				}
				return new Text(theme.fg("success", "✓ Advice available (expand to view)"), 0, 0);
			},
		});

		pi.registerCommand("advisor", {
			description: "Select or disable the read-only advisor model",
			getArgumentCompletions: (prefix: string) => {
				const values = ["off", ...pi.getAllTools().filter(() => false).map(() => "")];
				const matches = values.filter((value) => value.startsWith(prefix));
				return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
			},
			handler: async (args, ctx) => {
				const reference = args.trim();
				if (reference.toLowerCase() === "off") {
					try {
						settings = await disableAdvisorSettings(settingsPath);
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
				let selected: Model<Api> | undefined;
				if (!reference) {
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
					selected = await selectAdvisorModel(ctx, models);
				} else {
					const parsed = parseModelReference(reference);
					if (!parsed) {
						notify(ctx, "Usage: /advisor, /advisor <provider>/<model>, or /advisor off", "error");
						return;
					}
					selected = ctx.modelRegistry.find(parsed.provider, parsed.modelId);
					if (!selected || !ctx.modelRegistry.hasConfiguredAuth(selected)) {
						notify(ctx, `Advisor model ${reference} is unavailable or unauthenticated.`, "error");
						return;
					}
				}
				if (selected) await configureModel(selected, ctx);
			},
		});

		pi.on("session_start", async (_event, ctx) => loadForSession(ctx));
		pi.on("session_tree", async (_event, ctx) => runner.reconstruct(ctx));
		pi.on("session_shutdown", async (_event, ctx) => {
			if (ctx.hasUI) ctx.ui.setStatus("advisor", undefined);
		});
	};
}

export default createAdvisorExtension();
