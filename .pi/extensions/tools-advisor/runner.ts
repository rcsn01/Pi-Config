import { createHash } from "node:crypto";
import {
	clampThinkingLevel,
	isContextOverflow,
	type Api,
	type AssistantMessage,
	type Context,
	type Model,
	type ModelThinkingLevel,
	type ProviderHeaders,
	type SimpleStreamOptions,
	type Usage,
} from "@earendil-works/pi-ai";
import type { ExtensionContext, SessionEntry, ToolInfo } from "@earendil-works/pi-coding-agent";
import { resolveModelContext } from "../_shared/model-selection.ts";
import {
	type AdvisorContextBudget,
	projectTranscript,
	TranscriptProjectionError,
	type TranscriptProjectionInput,
} from "./transcript.ts";

const CACHE_AFFINITY_VERSION = "advisor-v1";
export const DEFAULT_MAX_USES = 3;
export const DEFAULT_MAX_USES_PER_SESSION = 20;
export const DEFAULT_NUDGE_TURN = 3;
export const ADVISOR_NUDGE_CUSTOM_TYPE = "advisor-nudge";
const DEFAULT_MAX_TOKENS = 2048;

export interface AdvisorSettings {
	provider?: string;
	modelId?: string;
	/** Omit for legacy settings; false is the persisted /advisor off state. */
	enabled?: boolean;
	strict: boolean;
	nudgeTurn: number;
	/** 0 disables the limit. */
	maxUses: number;
	/** 0 disables the limit. */
	maxUsesPerSession: number;
	maxTokens: number;
	/** Omit to use DEFAULT_CONTEXT_BUDGET. */
	contextBudget?: AdvisorContextBudget;
	/** Semantic reasoning level selected in the advisor picker. */
	thinkingLevel?: ModelThinkingLevel;
	/** Context window selected in the advisor picker. */
	contextWindow?: number;
}

export interface AdvisorToolDetails {
	model: string;
	consumesBudget: boolean;
	truncated: boolean;
}

export interface AdvisorToolResult {
	content: [{ type: "text"; text: string }];
	details: AdvisorToolDetails;
	usage?: Usage;
}

export interface AdvisorRunInput {
	ctx: ExtensionContext;
	settings: AdvisorSettings;
	callId: string;
	question?: string;
	activeToolNames: readonly string[];
	allTools: readonly ToolInfo[];
	signal?: AbortSignal;
	onStatus?: (active: boolean, model: string) => void;
}

export interface AdvisorRunner {
	execute(input: AdvisorRunInput): Promise<AdvisorToolResult>;
}

export function deriveAdvisorSessionId(mainSessionId: string, resolvedModel: string): string {
	if (!mainSessionId) throw new Error("Main session ID is required for advisor cache affinity.");
	if (!resolvedModel) throw new Error("Resolved advisor model is required for advisor cache affinity.");
	const digest = createHash("sha256")
		.update(CACHE_AFFINITY_VERSION)
		.update("\0")
		.update(mainSessionId)
		.update("\0")
		.update(resolvedModel)
		.digest("hex")
		.slice(0, 32);
	return `advisor-${digest}`;
}

export function createAdvisorRunner(): AdvisorRunner {
	// Reservations for calls that have started but not yet completed. Completed
	// calls are counted from the session branch instead, so correctness never
	// depends on event delivery.
	let inFlight = 0;

	async function execute(input: AdvisorRunInput): Promise<AdvisorToolResult> {
		const modelName = configuredModelName(input.settings);
		const localFailure = (code: string, message: string): AdvisorToolResult => failure(
			code,
			message,
			modelName,
			false,
			false,
		);

		if (input.settings.enabled === false || !input.settings.provider || !input.settings.modelId) {
			return localFailure("advisor_off", "Advisor is disabled. Select a model with /advisor first.");
		}

		const branch = input.ctx.sessionManager.getBranch();
		const turnUses = countTurnUses(branch);
		const sessionUses = countSessionUses(branch);
		const maxUses = validNonNegativeInteger(input.settings.maxUses, DEFAULT_MAX_USES);
		const maxUsesPerSession = validNonNegativeInteger(input.settings.maxUsesPerSession, DEFAULT_MAX_USES_PER_SESSION);
		// Session ceiling first: when both are hit, the terminal message must win.
		if (maxUsesPerSession > 0 && sessionUses + inFlight >= maxUsesPerSession) {
			return localFailure(
				"advisor_budget_exhausted",
				`The advisor consultation budget is exhausted (${maxUsesPerSession} uses per session). Continue without another consultation.`,
			);
		}
		if (maxUses > 0 && turnUses + inFlight >= maxUses) {
			return localFailure(
				"advisor_turn_budget_exhausted",
				`The advisor consultation budget for this turn is exhausted (${maxUses} uses per turn). Continue without another consultation; the budget resets on the next user message.`,
			);
		}
		let model: Model<Api>;
		let auth: Awaited<ReturnType<ExtensionContext["modelRegistry"]["getApiKeyAndHeaders"]>> | undefined;
		try {
			const catalogueModel = input.ctx.modelRegistry.find(input.settings.provider, input.settings.modelId);
			if (!catalogueModel) {
				return localFailure("advisor_model_unavailable", `Configured advisor model ${modelName} is unavailable.`);
			}
			const scopedModels = input.ctx.scopedModels ?? [];
			if (
				scopedModels.length > 0 &&
				!scopedModels.some((entry) =>
					entry.model.provider === catalogueModel.provider && entry.model.id === catalogueModel.id)
			) {
				return localFailure("advisor_model_unavailable", `Configured advisor model ${modelName} is outside this session's model scope.`);
			}
			if (!input.ctx.modelRegistry.hasConfiguredAuth(catalogueModel)) {
				return localFailure("advisor_auth_unavailable", `No authentication is configured for advisor model ${modelName}.`);
			}
			model = resolveModelContext(catalogueModel);
		} catch (error) {
			return localFailure("advisor_preflight_error", error instanceof Error ? error.message : String(error));
		}
		const configuredContextWindow = input.settings.contextWindow;
		if (
			configuredContextWindow !== undefined &&
			(!Number.isInteger(configuredContextWindow) || configuredContextWindow <= 0 || configuredContextWindow > model.contextWindow)
		) {
			return localFailure(
				"advisor_context_window_invalid",
				`The saved advisor context window (${String(configuredContextWindow)}) exceeds the catalogue maximum of ${model.contextWindow}. Reopen /advisor and choose a valid context window.`,
			);
		}
		if (configuredContextWindow !== undefined && configuredContextWindow !== model.contextWindow) {
			model = { ...model, contextWindow: configuredContextWindow };
		}
		const thinkingLevel = clampThinkingLevel(model, input.settings.thinkingLevel ?? "medium");

		const registry = input.ctx.modelRegistry;
		if (typeof registry.getApiKeyAndHeaders !== "function" || typeof registry.getProvider !== "function") {
			return localFailure("advisor_provider_unavailable", "The model registry does not expose a native simple-completion provider.");
		}
		let nativeProvider;
		try {
			auth = await registry.getApiKeyAndHeaders(model);
			if (!auth?.ok) {
				return localFailure("advisor_auth_unavailable", auth?.error ?? `No authentication is configured for advisor model ${modelName}.`);
			}
			nativeProvider = registry.getProvider(model.provider);
			if (!nativeProvider) {
				return localFailure("advisor_provider_unavailable", `The native provider for ${modelName} is unavailable.`);
			}
		} catch (error) {
			return localFailure("advisor_preflight_error", error instanceof Error ? error.message : String(error));
		}

		let projection: ReturnType<typeof projectTranscript>;
		try {
			const transcriptInput: TranscriptProjectionInput = {
				entries: input.ctx.sessionManager.buildContextEntries(),
				systemPrompt: input.ctx.getSystemPrompt(),
				activeToolNames: input.activeToolNames,
				allTools: input.allTools,
				model,
				maxTokens: validPositiveInteger(input.settings.maxTokens, DEFAULT_MAX_TOKENS),
				advisorCallId: input.callId,
				question: input.question,
				budget: input.settings.contextBudget,
			};
			projection = projectTranscript(transcriptInput);
		} catch (error) {
			if (error instanceof TranscriptProjectionError) {
				return localFailure(`advisor_${error.code}`, error.message.replace(`${error.code}: `, ""));
			}
			return localFailure("advisor_context_error", error instanceof Error ? error.message : String(error));
		}

		// Reserve synchronously before the first await. The tool is sequential in Pi,
		// and this reservation also protects direct callers that start two executions.
		inFlight++;
		const signal = input.signal ?? input.ctx.signal;
		const resolvedModel = `${model.provider}/${model.id}`;
		const setStatus = (active: boolean) => {
			try {
				input.onStatus?.(active, resolvedModel);
			} catch {
				// UI status is best-effort and must never change the tool outcome.
			}
		};
		setStatus(true);
		try {
			const context: Context = {
				systemPrompt: projection.systemPrompt,
				messages: projection.messages,
				tools: [],
			};
			const sessionId = deriveAdvisorSessionId(input.ctx.sessionManager.getSessionId(), resolvedModel);
			const requestModel = auth?.ok && auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model;
			const headers = mergeProviderHeaders(model.headers, auth?.ok ? auth.headers : undefined);
			const simpleOptions: SimpleStreamOptions = {
				signal,
				maxTokens: projection.effectiveMaxTokens,
				cacheRetention: "short",
				sessionId,
				...(auth?.ok && auth.apiKey === undefined ? {} : auth?.ok ? { apiKey: auth.apiKey } : {}),
				...(headers && Object.keys(headers).length > 0 ? { headers } : {}),
				...(auth?.ok && auth.env === undefined ? {} : auth?.ok ? { env: auth.env } : {}),
				...(thinkingLevel === "off" ? {} : { reasoning: thinkingLevel }),
			};
			const response = await nativeProvider!.streamSimple(requestModel, context, simpleOptions).result();
			return resultFromResponse(response, resolvedModel, () => {
				inFlight--;
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (isAbortError(error) || signal?.aborted) {
				inFlight--;
				return failure("advisor_aborted", message || "The advisor consultation was aborted.", resolvedModel, true, false);
			}
			if (isExplicitOverflow(message) && !hasNonzeroUsage((error as { usage?: Usage }).usage)) {
				inFlight--;
				return failure(
					"advisor_context_too_large",
					`The advisor provider rejected the complete request as too large: ${message}`,
					resolvedModel,
					false,
					false,
				);
			}
			inFlight--;
			return failure("advisor_provider_error", message || "The advisor provider failed.", resolvedModel, true, false);
		} finally {
			setStatus(false);
		}
	}

	return {
		execute,
	};
}

/** Return the effective branch entries after the most recent real user message. */
export function entriesSinceLastUser(branch: readonly SessionEntry[]): readonly SessionEntry[] {
	let start = 0;
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry.type === "message" && entry.message.role === "user") {
			start = index + 1;
			break;
		}
	}
	return branch.slice(start);
}

/** Counts advisor tool results that consumed budget, optionally only after the last user message. */
export function countAdvisorUses(branch: readonly SessionEntry[], afterLastUser: boolean): number {
	const entries = afterLastUser ? entriesSinceLastUser(branch) : branch;
	return entries.reduce((count, entry) => {
		if (entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.toolName !== "advisor") {
			return count;
		}
		const details = entry.message.details as Partial<AdvisorToolDetails> | undefined;
		return details?.consumesBudget === true ? count + 1 : count;
	}, 0);
}

/** Counts assistant responses in the current user turn. The optional current message
 * covers the turn_end event before Pi persists that response to the branch. */
export function countAssistantTurns(branch: readonly SessionEntry[], currentAssistant?: AssistantMessage): number {
	const entries = entriesSinceLastUser(branch);
	const count = entries.reduce(
		(total, entry) => total + (entry.type === "message" && entry.message.role === "assistant" ? 1 : 0),
		0,
	);
	if (
		currentAssistant &&
		!entries.some((entry) => entry.type === "message" && entry.message === currentAssistant)
	) {
		return count + 1;
	}
	return count;
}

/** Counts custom messages of a given type, optionally only after the last user message. */
export function countCustomMessages(
	branch: readonly SessionEntry[],
	customType: string,
	afterLastUser = true,
): number {
	const entries = afterLastUser ? entriesSinceLastUser(branch) : branch;
	return entries.reduce(
		(count, entry) => count + (entry.type === "custom_message" && entry.customType === customType ? 1 : 0),
		0,
	);
}

function countTurnUses(branch: readonly SessionEntry[]): number {
	return countAdvisorUses(branch, true);
}

function countSessionUses(branch: readonly SessionEntry[]): number {
	return countAdvisorUses(branch, false);
}

function resultFromResponse(
	response: AssistantMessage,
	model: string,
	releaseBudget: () => void,
): AdvisorToolResult {
	const text = response.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("\n")
		.trim();
	const overflow = isContextOverflow(response, undefined) || isExplicitOverflow(response.errorMessage ?? "");
	const partialAdvice = text ? `\n\nPartial advice:\n\n${text}` : "";
	if (response.stopReason === "error") {
		if (overflow && !hasNonzeroUsage(response.usage)) {
			releaseBudget();
			return failure(
				"advisor_context_too_large",
				`The advisor provider rejected the complete request as too large: ${response.errorMessage ?? "context limit exceeded"}${partialAdvice}`,
				model,
				false,
				false,
				response.usage,
			);
		}
		releaseBudget();
		return failure("advisor_provider_error", `${response.errorMessage ?? "The advisor provider returned an error."}${partialAdvice}`, model, true, false, response.usage);
	}
	if (response.stopReason === "aborted") {
		releaseBudget();
		return failure("advisor_aborted", `${response.errorMessage ?? "The advisor consultation was aborted."}${partialAdvice}`, model, true, false, response.usage);
	}
	if (response.stopReason === "length") {
		releaseBudget();
		return failure(
			"advisor_truncated",
			text ? `The advisor response was truncated and may be incomplete.\n\n${text}` : "The advisor response was truncated before producing visible advice.",
			model,
			true,
			true,
			response.usage,
		);
	}
	if (!text) {
		releaseBudget();
		return failure("advisor_empty", "The advisor returned no visible advice. Its response may have used the output budget for reasoning.", model, true, false, response.usage);
	}
	releaseBudget();
	return {
		content: [{ type: "text", text }],
		details: { model, consumesBudget: true, truncated: false },
		usage: response.usage,
	};
}

function failure(
	code: string,
	message: string,
	model: string,
	consumesBudget: boolean,
	truncated: boolean,
	usage?: Usage,
): AdvisorToolResult {
	return {
		content: [{ type: "text", text: `${code}: ${message}` }],
		details: { model, consumesBudget, truncated },
		...(usage ? { usage } : {}),
	};
}

function configuredModelName(settings: AdvisorSettings): string {
	return settings.provider && settings.modelId ? `${settings.provider}/${settings.modelId}` : "(unconfigured)";
}

function validNonNegativeInteger(value: number | undefined, fallback: number): number {
	return Number.isInteger(value) && value! >= 0 ? value! : fallback;
}

function validPositiveInteger(value: number | undefined, fallback: number): number {
	return Number.isInteger(value) && value! > 0 ? value! : fallback;
}

function mergeProviderHeaders(
	base: ProviderHeaders | undefined,
	override: ProviderHeaders | undefined,
): ProviderHeaders | undefined {
	if (!base && !override) return undefined;
	const merged: ProviderHeaders = { ...(base ?? {}) };
	for (const [name, value] of Object.entries(override ?? {})) {
		const lowerName = name.toLowerCase();
		for (const existingName of Object.keys(merged)) {
			if (existingName.toLowerCase() === lowerName) delete merged[existingName];
		}
		merged[name] = value;
	}
	return merged;
}

function hasNonzeroUsage(usage: unknown): boolean {
	if (!usage || typeof usage !== "object") return false;
	const value = usage as Partial<Usage>;
	return [value.input, value.output, value.cacheRead, value.cacheWrite, value.totalTokens]
		.some((number) => typeof number === "number" && number > 0);
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && (error.name === "AbortError" || /aborted|abort/i.test(error.message));
}

function isExplicitOverflow(message: string): boolean {
	return /context[_ ]length[_ ]exceeded|prompt(?:[_ ]is)?[_ ]too[_ ]long|exceeds (?:the )?(?:model'?s )?maximum context length|exceeds the context window|too many tokens|token limit exceeded|request_too_large|exceeds the available context size|range of input length should be/i.test(message);
}
