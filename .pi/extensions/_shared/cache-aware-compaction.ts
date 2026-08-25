import { createHash } from "node:crypto";
import type { AssistantMessage, Context, Message, Model, SimpleStreamOptions, Tool } from "@earendil-works/pi-ai";
import {
	buildSessionContext,
	convertToLlm,
	estimateTokens,
	sessionEntryToContextMessages,
	type CompactionResult,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";

const MIN_SUMMARY_TOKENS = 256;

const SUMMARY_INSTRUCTIONS = `The conversation above must be compacted. Produce a structured context checkpoint that another assistant can use to continue the work.

Summarize the history that Pi will discard. Pi will retain the trailing provider messages identified below verbatim, so include only the context needed to understand and continue from that retained suffix. Do not continue the conversation and do not call tools.

Use this exact format:

## Goal
[The user's goals]

## Constraints & Preferences
- [Requirements and preferences, or "(none)"]

## Progress
### Done
- [x] [Completed work]

### In Progress
- [ ] [Current work]

### Blocked
- [Blockers, or "(none)"]

## Key Decisions
- **[Decision]**: [Rationale]

## Next Steps
1. [What should happen next]

## Critical Context
- [Exact paths, symbols, errors, and facts needed to continue, or "(none)"]`;

interface FingerprintSnapshot {
	modelHash: string;
	systemPromptHash: string;
	toolsHash: string;
	thinkingLevelHash: string;
	sessionIdHash: string;
	messageHashes: string[];
	messageCount: number;
}

export interface CacheAwareCompactionState {
	pending?: Readonly<FingerprintSnapshot>;
	committed?: Readonly<FingerprintSnapshot>;
	inFlight: boolean;
}

export interface CacheAwareCompactionController {
	compact(
		event: SessionBeforeCompactEvent,
		ctx: ExtensionContext,
	): Promise<{ compaction: CompactionResult } | undefined>;
	getState(): CacheAwareCompactionState;
	clear(): void;
}

function stableSerialize(value: unknown, seen = new WeakSet<object>()): string {
	if (value === undefined) return '"$undefined"';
	if (typeof value === "bigint") return JSON.stringify(`${value}n`);
	if (typeof value === "number" && !Number.isFinite(value)) return JSON.stringify(String(value));
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (seen.has(value)) return '"$circular"';
	seen.add(value);
	if (Array.isArray(value)) {
		const result = `[${value.map((item) => stableSerialize(item, seen)).join(",")}]`;
		seen.delete(value);
		return result;
	}
	const record = value as Record<string, unknown>;
	const result = `{${Object.keys(record)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key], seen)}`)
		.join(",")}}`;
	seen.delete(value);
	return result;
}

function hash(value: unknown): string {
	return createHash("sha256").update(stableSerialize(value)).digest("hex");
}

function activeTools(pi: ExtensionAPI): Tool[] {
	const byName = new Map(pi.getAllTools().map((tool) => [tool.name, tool]));
	return pi.getActiveTools().flatMap((name) => {
		const tool = byName.get(name);
		return tool
			? [{ name: tool.name, description: tool.description, parameters: tool.parameters }]
			: [];
	});
}

function fingerprint(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	messages: readonly Message[],
): FingerprintSnapshot | undefined {
	if (!ctx.model) return undefined;
	const tools = activeTools(pi);
	return {
		modelHash: hash(ctx.model),
		systemPromptHash: hash(ctx.getSystemPrompt()),
		toolsHash: hash(tools),
		thinkingLevelHash: hash(ctx.thinkingLevel ?? pi.getThinkingLevel()),
		sessionIdHash: hash(ctx.sessionManager.getSessionId()),
		messageHashes: messages.map(hash),
		messageCount: messages.length,
	};
}

function snapshotsMatch(current: FingerprintSnapshot, committed: FingerprintSnapshot): boolean {
	if (
		current.modelHash !== committed.modelHash ||
		current.systemPromptHash !== committed.systemPromptHash ||
		current.toolsHash !== committed.toolsHash ||
		current.thinkingLevelHash !== committed.thinkingLevelHash ||
		current.sessionIdHash !== committed.sessionIdHash ||
		current.messageHashes.length < committed.messageHashes.length
	) {
		return false;
	}
	return committed.messageHashes.every((messageHash, index) => current.messageHashes[index] === messageHash);
}

function containsImage(messages: readonly Message[]): boolean {
	return messages.some((message) =>
		"content" in message &&
		Array.isArray(message.content) &&
		message.content.some((block) => block.type === "image"),
	);
}

function retainedProviderMessageCount(event: SessionBeforeCompactEvent): number | undefined {
	const firstKeptIndex = event.branchEntries.findIndex(
		(entry) => entry.id === event.preparation.firstKeptEntryId,
	);
	if (firstKeptIndex < 0) return undefined;
	const retainedMessages = event.branchEntries
		.slice(firstKeptIndex)
		.flatMap((entry) => sessionEntryToContextMessages(entry));
	return convertToLlm(retainedMessages).length;
}

function instructionText(event: SessionBeforeCompactEvent, retainedCount: number): string {
	let text = `${SUMMARY_INSTRUCTIONS}\n\nPi will retain ${retainedCount} trailing provider message${retainedCount === 1 ? "" : "s"} verbatim.`;
	if (event.customInstructions?.trim()) {
		text += `\n\nAdditional focus from the user:\n${event.customInstructions.trim()}`;
	}
	return text;
}

function estimateProviderInputTokens(context: Context): number {
	let tokens = Math.ceil((context.systemPrompt?.length ?? 0) / 4);
	for (const message of context.messages) tokens += estimateTokens(message as never);
	if (context.tools) tokens += Math.ceil(stableSerialize(context.tools).length / 4);
	return tokens;
}

function summaryTokenLimit(
	event: SessionBeforeCompactEvent,
	model: Model<any>,
	context: Context,
): number | undefined {
	const estimatedInput = Math.max(event.preparation.tokensBefore, estimateProviderInputTokens(context));
	const headroom = model.contextWindow - estimatedInput;
	const reserveLimit = Math.floor(event.preparation.settings.reserveTokens * 0.8);
	const modelLimit = model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY;
	const maxTokens = Math.floor(Math.min(headroom, reserveLimit, modelLimit));
	return maxTokens >= MIN_SUMMARY_TOKENS ? maxTokens : undefined;
}

function fileMetadata(event: SessionBeforeCompactEvent): {
	readFiles: string[];
	modifiedFiles: string[];
	sections: string;
} {
	const modified = new Set([
		...event.preparation.fileOps.written,
		...event.preparation.fileOps.edited,
	]);
	const readFiles = [...event.preparation.fileOps.read]
		.filter((path) => !modified.has(path))
		.sort();
	const modifiedFiles = [...modified].sort();
	const sections: string[] = [];
	if (readFiles.length > 0) sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
	if (modifiedFiles.length > 0) {
		sections.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`);
	}
	return {
		readFiles,
		modifiedFiles,
		sections: sections.length > 0 ? `\n\n${sections.join("\n\n")}` : "",
	};
}

function summaryText(response: AssistantMessage): string | undefined {
	if (response.stopReason !== "stop") return undefined;
	if (response.content.some((block) => block.type === "toolCall")) return undefined;
	const text = response.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("\n")
		.trim();
	return text || undefined;
}

export function createCacheAwareCompaction(pi: ExtensionAPI): CacheAwareCompactionController {
	let pending: FingerprintSnapshot | undefined;
	let committed: FingerprintSnapshot | undefined;
	let inFlight = false;
	let warned = false;

	const clear = (): void => {
		pending = undefined;
		committed = undefined;
		inFlight = false;
		warned = false;
	};

	const warnFallback = (ctx: ExtensionContext, signal: AbortSignal): void => {
		if (signal.aborted || warned) return;
		warned = true;
		ctx.ui.notify("Cache-aware summary unavailable. Using Pi's native compaction.", "warning");
	};

	pi.on("context", (event, ctx) => {
		pending = fingerprint(pi, ctx, convertToLlm(event.messages));
	});
	pi.on("before_provider_request", () => {
		if (!pending || inFlight) return;
		committed = pending;
		pending = undefined;
	});
	pi.on("session_start", clear);
	pi.on("session_shutdown", clear);

	return {
		async compact(event, ctx) {
			if (inFlight) return undefined;
			inFlight = true;
			try {
				const model = ctx.model;
				const provider = model ? ctx.modelRegistry.getProvider(model.provider) : undefined;
				const sessionContext = buildSessionContext(event.branchEntries);
				const messages = convertToLlm(sessionContext.messages);
				const current = fingerprint(pi, ctx, messages);
				const retainedCount = retainedProviderMessageCount(event);
				if (
					!model ||
					!provider ||
					!committed ||
					!current ||
					!snapshotsMatch(current, committed) ||
					containsImage(messages) ||
					retainedCount === undefined
				) {
					warnFallback(ctx, event.signal);
					return undefined;
				}

				const instruction = instructionText(event, retainedCount);
				const tools = activeTools(pi);
				const context: Context = {
					systemPrompt: ctx.getSystemPrompt(),
					messages: [
						...messages,
						{
							role: "user",
							content: [{ type: "text", text: instruction }],
							timestamp: Date.now(),
						},
					],
					tools,
				};
				const maxTokens = summaryTokenLimit(event, model, context);
				if (maxTokens === undefined) {
					warnFallback(ctx, event.signal);
					return undefined;
				}

				const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
				if (!auth.ok) {
					warnFallback(ctx, event.signal);
					return undefined;
				}
				const effectiveModel = auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model;
				const options: SimpleStreamOptions = {
					maxTokens,
					signal: event.signal,
					apiKey: auth.apiKey,
					headers: auth.headers,
					env: auth.env,
					sessionId: ctx.sessionManager.getSessionId(),
				};
				const thinkingLevel = ctx.thinkingLevel ?? pi.getThinkingLevel();
				if (model.reasoning && thinkingLevel !== "off") options.reasoning = thinkingLevel;

				const response = await provider.streamSimple(effectiveModel, context, options).result();
				const summary = summaryText(response);
				if (!summary) {
					if (response.stopReason !== "aborted") warnFallback(ctx, event.signal);
					return undefined;
				}
				const files = fileMetadata(event);
				return {
					compaction: {
						summary: summary + files.sections,
						firstKeptEntryId: event.preparation.firstKeptEntryId,
						tokensBefore: event.preparation.tokensBefore,
						usage: response.usage,
						details: { readFiles: files.readFiles, modifiedFiles: files.modifiedFiles },
					},
				};
			} catch (error) {
				if (!(error instanceof Error && error.name === "AbortError")) {
					warnFallback(ctx, event.signal);
				}
				return undefined;
			} finally {
				pending = undefined;
				committed = undefined;
				inFlight = false;
			}
		},
		getState() {
			return {
				pending: pending ? { ...pending, messageHashes: [...pending.messageHashes] } : undefined,
				committed: committed ? { ...committed, messageHashes: [...committed.messageHashes] } : undefined,
				inFlight,
			};
		},
		clear,
	};
}
