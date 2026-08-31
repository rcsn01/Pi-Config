import {
	clampThinkingLevel,
	isContextOverflow,
	type Api,
	type AssistantMessage,
	type Context,
	type Message,
	type Model,
	type ModelThinkingLevel,
	type ProviderHeaders,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { type ExtensionContext, type ToolInfo } from "@earendil-works/pi-coding-agent";
import { resolveModelContext } from "../_shared/model-selection.ts";
import { advisorFailure, advisorSuccess, type AdvisorResult } from "./outcome.ts";
import { ADVISOR_SYSTEM_PROMPT } from "./prompt.ts";
import { projectAdvisorContext } from "./transcript.ts";

export const DEFAULT_MAX_TOKENS = 2048;

export interface AdvisorSettings {
	enabled: boolean;
	model?: string;
	thinkingLevel?: ModelThinkingLevel;
	maxTokens: number;
}

export interface AdvisorRunInput {
	ctx: ExtensionContext;
	settings: AdvisorSettings;
	callId: string;
	question?: string;
	activeToolNames: readonly string[];
	allTools: readonly ToolInfo[];
	signal?: AbortSignal;
}

export interface AdvisorRunner {
	execute(input: AdvisorRunInput): Promise<AdvisorResult>;
}

interface CompletionInput {
	ctx: ExtensionContext;
	model: Model<Api>;
	thinkingLevel: ModelThinkingLevel;
	maxTokens: number;
	messages: Message[];
	signal?: AbortSignal;
}

type CompleteAdvisor = (input: CompletionInput) => Promise<AssistantMessage>;

export function createAdvisorRunner(dependencies: { complete?: CompleteAdvisor } = {}): AdvisorRunner {
	const complete = dependencies.complete ?? completeWithRegistry;

	return {
		async execute(input): Promise<AdvisorResult> {
			const modelName = input.settings.model ?? "(unconfigured)";
			if (!input.settings.enabled || !input.settings.model) {
				return advisorFailure("Advisor is disabled. Select a model with /advisor first.", modelName);
			}
			const model = resolveConfiguredModel(input.ctx, input.settings.model);
			if (!model) return advisorFailure(`Configured advisor model ${modelName} is unavailable.`, modelName);
			if (!input.ctx.modelRegistry.hasConfiguredAuth(model)) {
				return advisorFailure(`No authentication is configured for advisor model ${modelName}.`, modelName);
			}
			const normalized = resolveModelContext(model);
			const maxTokens = Math.min(input.settings.maxTokens, normalized.maxTokens);
			let projection;
			try {
				projection = projectAdvisorContext({
					entries: input.ctx.sessionManager.buildContextEntries(),
					systemPrompt: input.ctx.getSystemPrompt(),
					activeToolNames: input.activeToolNames,
					allTools: input.allTools,
					model: normalized,
					maxTokens,
					advisorCallId: input.callId,
					question: input.question,
				});
			} catch (error) {
				return advisorFailure(error instanceof Error ? error.message : String(error), modelName);
			}

			try {
				const response = await complete({
					ctx: input.ctx,
					model: normalized,
					thinkingLevel: clampThinkingLevel(normalized, input.settings.thinkingLevel ?? "medium"),
					maxTokens,
					messages: projection.messages,
					signal: input.signal ?? input.ctx.signal,
				});
				return resultFromResponse(response, modelName);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				if (isAbortError(error) || input.signal?.aborted || input.ctx.signal?.aborted) {
					return advisorFailure(message || "The advisor consultation was aborted.", modelName);
				}
				return advisorFailure(message || "The advisor consultation failed.", modelName);
			}
		},
	};
}

function resolveConfiguredModel(ctx: ExtensionContext, reference: string): Model<Api> | undefined {
	const slash = reference.indexOf("/");
	if (slash <= 0 || slash === reference.length - 1) return undefined;
	const provider = reference.slice(0, slash);
	const id = reference.slice(slash + 1);
	const model = ctx.modelRegistry.find(provider, id);
	if (!model) return undefined;
	if (ctx.scopedModels.length > 0 && !ctx.scopedModels.some(
		(entry) => entry.model.provider === provider && entry.model.id === id,
	)) return undefined;
	return model;
}

async function completeWithRegistry(input: CompletionInput): Promise<AssistantMessage> {
	const auth = await input.ctx.modelRegistry.getApiKeyAndHeaders(input.model);
	if (!auth.ok) throw new Error(auth.error);
	const provider = input.ctx.modelRegistry.getProvider(input.model.provider);
	if (!provider) throw new Error(`The provider for ${input.model.provider} is unavailable.`);

	const requestModel = auth.baseUrl ? { ...input.model, baseUrl: auth.baseUrl } : input.model;
	const headers = mergeProviderHeaders(input.model.headers, auth.headers);
	const context: Context = {
		systemPrompt: ADVISOR_SYSTEM_PROMPT,
		messages: input.messages,
		tools: [],
	};
	const options: SimpleStreamOptions = {
		signal: input.signal,
		maxTokens: input.maxTokens,
		cacheRetention: "short",
		...(auth.apiKey === undefined ? {} : { apiKey: auth.apiKey }),
		...(headers && Object.keys(headers).length > 0 ? { headers } : {}),
		...(auth.env === undefined ? {} : { env: auth.env }),
		...(input.thinkingLevel === "off" ? {} : { reasoning: input.thinkingLevel }),
	};
	return provider.streamSimple(requestModel, context, options).result();
}

function mergeProviderHeaders(
	base: ProviderHeaders | undefined,
	override: ProviderHeaders | undefined,
): ProviderHeaders | undefined {
	if (!base && !override) return undefined;
	const merged: ProviderHeaders = { ...(base ?? {}) };
	for (const [name, value] of Object.entries(override ?? {})) {
		for (const existingName of Object.keys(merged)) {
			if (existingName.toLowerCase() === name.toLowerCase()) delete merged[existingName];
		}
		merged[name] = value;
	}
	return merged;
}

function resultFromResponse(response: AssistantMessage, model: string): AdvisorResult {
	const text = response.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("\n")
		.trim();
	if (response.stopReason === "length") {
		return text
			? advisorSuccess(`The advisor response was truncated and may be incomplete.\n\n${text}`, model, response.usage, true)
			: advisorFailure("The advisor response was truncated before producing visible advice.", model, response.usage);
	}
	if (response.stopReason === "aborted") {
		return advisorFailure(response.errorMessage || "The advisor consultation was aborted.", model, response.usage);
	}
	if (response.stopReason === "error") {
		const prefix = isContextOverflow(response, undefined) ? "The advisor context was too large" : "The advisor provider failed";
		return advisorFailure(`${prefix}: ${response.errorMessage || "unknown error"}`, model, response.usage);
	}
	if (!text) return advisorFailure("The advisor returned no visible advice.", model, response.usage);
	return advisorSuccess(text, model, response.usage);
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && (error.name === "AbortError" || /aborted|abort/i.test(error.message));
}
