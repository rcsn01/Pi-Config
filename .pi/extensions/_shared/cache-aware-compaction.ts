import type { AssistantMessage, Context, Model, SimpleStreamOptions, Tool } from "@earendil-works/pi-ai";
import {
	buildSessionContext,
	convertToLlm,
	sessionEntryToContextMessages,
	type CompactionResult,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionBeforeCompactEvent,
} from "@earendil-works/pi-coding-agent";
import {
	getToolOutputRetention,
	type RetentionMessage,
} from "./tool-output-retention.ts";

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

export interface CacheAwareCompactionController {
	compact(
		event: SessionBeforeCompactEvent,
		ctx: ExtensionContext,
	): Promise<{ compaction?: CompactionResult; cancel?: true } | undefined>;
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

function safeProjectHistory(messages: RetentionMessage[]): RetentionMessage[] {
	const retention = getToolOutputRetention();
	if (!retention) return messages;
	try {
		return retention.projectHistory(messages).messages;
	} catch {
		return messages;
	}
}

function instructionText(event: SessionBeforeCompactEvent, retainedCount: number): string {
	let text = `${SUMMARY_INSTRUCTIONS}\n\nPi will retain ${retainedCount} trailing provider message${retainedCount === 1 ? "" : "s"} verbatim.`;
	if (event.customInstructions?.trim()) {
		text += `\n\nAdditional focus from the user:\n${event.customInstructions.trim()}`;
	}
	return text;
}

function summaryTokenLimit(event: SessionBeforeCompactEvent, model: Model<any>): number {
	const reserveLimit = Math.floor(event.preparation.settings.reserveTokens * 0.8);
	const requested = Math.max(MIN_SUMMARY_TOKENS, reserveLimit);
	return model.maxTokens > 0 ? Math.min(requested, model.maxTokens) : requested;
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

function notifyNativeFallback(ctx: ExtensionContext, signal: AbortSignal, reason: string): void {
	if (signal.aborted) return;
	ctx.ui.notify(`Custom compaction unavailable (${reason}). Using Pi's native compaction.`, "warning");
}

export function createCacheAwareCompaction(pi: ExtensionAPI): CacheAwareCompactionController {
	return {
		async compact(event, ctx) {
			if (event.signal.aborted) return { cancel: true };
			const model = ctx.model;
			if (!model) {
				notifyNativeFallback(ctx, event.signal, "no active model");
				return undefined;
			}
			const provider = ctx.modelRegistry.getProvider(model.provider);
			if (!provider) {
				notifyNativeFallback(ctx, event.signal, "provider unavailable");
				return undefined;
			}

			try {
				const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
				if (event.signal.aborted) return { cancel: true };
				if (!auth.ok) {
					notifyNativeFallback(ctx, event.signal, "authentication unavailable");
					return undefined;
				}

				const retainedCount = retainedProviderMessageCount(event);
				if (retainedCount === undefined) {
					notifyNativeFallback(ctx, event.signal, "invalid retained-message boundary");
					return undefined;
				}
				const canonicalMessages = buildSessionContext(event.branchEntries).messages;
				const messages = convertToLlm(safeProjectHistory(canonicalMessages));
				const context: Context = {
					systemPrompt: ctx.getSystemPrompt(),
					messages: [
						...messages,
						{
							role: "user",
							content: [{
								type: "text",
								text: instructionText(event, retainedCount),
							}],
							timestamp: Date.now(),
						},
					],
					tools: activeTools(pi),
				};
				const effectiveModel = auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model;
				const options: SimpleStreamOptions = {
					maxTokens: summaryTokenLimit(event, model),
					signal: event.signal,
					apiKey: auth.apiKey,
					headers: auth.headers,
					env: auth.env,
					sessionId: ctx.sessionManager.getSessionId(),
				};
				const thinkingLevel = ctx.thinkingLevel ?? pi.getThinkingLevel();
				if (model.reasoning && thinkingLevel !== "off") options.reasoning = thinkingLevel;

				const response = await provider.streamSimple(effectiveModel, context, options).result();
				if (event.signal.aborted) return { cancel: true };
				const summary = summaryText(response);
				if (!summary) {
					if (response.stopReason === "aborted" || event.signal.aborted) return { cancel: true };
					notifyNativeFallback(ctx, event.signal, `summarizer stopped with ${response.stopReason}`);
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
				if (event.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
					return { cancel: true };
				}
				const reason = error instanceof Error ? error.message : String(error);
				notifyNativeFallback(ctx, event.signal, reason);
				return undefined;
			}
		},
	};
}
