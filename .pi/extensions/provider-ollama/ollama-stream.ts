import { streamSimple as streamOpenAICompletions } from "@earendil-works/pi-ai/api/openai-completions";
import type { Api, AssistantMessageEventStream, Context, FetchFunction, JsonValue, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";

function object(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}

function count(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/**
 * Convert Ollama's native prompt metrics when they are embedded in an
 * OpenAI-compatible usage object.
 */
export function normalizeOllamaUsage(value: unknown): Record<string, JsonValue> | undefined {
	const usage = object(value);
	if (!usage) return undefined;

	const promptEvalCount = count(usage.prompt_eval_count);
	const promptEvalCachedCount = count(usage.prompt_eval_cached_count);
	const evalCount = count(usage.eval_count);
	if (promptEvalCount === undefined && promptEvalCachedCount === undefined && evalCount === undefined) {
		return undefined;
	}

	const normalized: Record<string, JsonValue> = { ...usage } as Record<string, JsonValue>;
	if (usage.prompt_tokens === undefined && promptEvalCount !== undefined) {
		normalized.prompt_tokens = promptEvalCount;
	}
	if (usage.completion_tokens === undefined && evalCount !== undefined) {
		normalized.completion_tokens = evalCount;
	}

	const details = object(usage.prompt_tokens_details);
	const existingCachedTokens = count(details?.cached_tokens);
	if (promptEvalCachedCount !== undefined && existingCachedTokens === undefined) {
		normalized.prompt_tokens_details = {
			...(details as Record<string, JsonValue> | undefined),
			cached_tokens: promptEvalCachedCount,
		};
	}

	return normalized;
}

function rewriteSseLine(line: string): string {
	const ending = line.endsWith("\r\n") ? "\r\n" : line.endsWith("\n") ? "\n" : "";
	const content = ending ? line.slice(0, -ending.length) : line;
	if (!content.startsWith("data:")) return line;

	const payload = content.slice("data:".length).trimStart();
	if (!payload || payload === "[DONE]") return line;

	let parsed: unknown;
	try {
		parsed = JSON.parse(payload);
	} catch {
		return line;
	}
	const chunk = object(parsed);
	const usage = normalizeOllamaUsage(chunk?.usage);
	if (!chunk || !usage) return line;

	return `data: ${JSON.stringify({ ...chunk, usage })}${ending}`;
}

function rewriteOllamaSse(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
	const decoder = new TextDecoder();
	const encoder = new TextEncoder();
	let buffered = "";

	return body.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				buffered += decoder.decode(chunk, { stream: true });
				let newline: number;
				while ((newline = buffered.indexOf("\n")) >= 0) {
					const line = buffered.slice(0, newline + 1);
					buffered = buffered.slice(newline + 1);
					controller.enqueue(encoder.encode(rewriteSseLine(line)));
				}
			},
			flush(controller) {
				buffered += decoder.decode();
				if (buffered) controller.enqueue(encoder.encode(rewriteSseLine(buffered)));
			},
		}),
	);
}

/** Wrap a provider fetch so Ollama usage metrics reach pi-ai's normalizer. */
export function createOllamaFetch(fetch: FetchFunction = globalThis.fetch): FetchFunction {
	return async (input, init) => {
		const response = await fetch(input, init);
		const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
		if (!response.body || !contentType.includes("text/event-stream")) return response;

		const headers = new Headers(response.headers);
		headers.delete("content-length");
		return new Response(rewriteOllamaSse(response.body), {
			status: response.status,
			statusText: response.statusText,
			headers,
		});
	};
}

/** Delegate all OpenAI-compatible behavior while normalizing Ollama's usage metrics. */
export function streamOllama(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	if (model.api !== "openai-completions") {
		throw new Error(`Ollama provider requires openai-completions, got ${model.api}`);
	}
	return streamOpenAICompletions(model as Model<"openai-completions">, context, {
		...options,
		fetch: createOllamaFetch(options?.fetch),
	});
}
