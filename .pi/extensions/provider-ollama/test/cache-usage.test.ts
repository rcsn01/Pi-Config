import type { Context, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { createOllamaFetch, normalizeOllamaUsage, streamOllama } from "../ollama-stream.ts";

describe("normalizeOllamaUsage", () => {
	it("maps Ollama prompt metrics to OpenAI usage fields", () => {
		expect(
			normalizeOllamaUsage({
				prompt_eval_count: 100,
				prompt_eval_cached_count: 64,
				eval_count: 10,
			}),
		).toEqual({
			prompt_eval_count: 100,
			prompt_eval_cached_count: 64,
			eval_count: 10,
			prompt_tokens: 100,
			completion_tokens: 10,
			prompt_tokens_details: { cached_tokens: 64 },
		});
	});

	it("maps zero cache hits without dropping the field", () => {
		expect(normalizeOllamaUsage({ prompt_eval_count: 100, prompt_eval_cached_count: 0 })).toMatchObject({
			prompt_tokens: 100,
			prompt_tokens_details: { cached_tokens: 0 },
		});
	});

	it("preserves an existing OpenAI cache count", () => {
		expect(
			normalizeOllamaUsage({
				prompt_tokens: 100,
				prompt_eval_cached_count: 64,
				prompt_tokens_details: { cached_tokens: 32 },
			}),
		).toMatchObject({
			prompt_tokens_details: { cached_tokens: 32 },
		});
	});
});

describe("createOllamaFetch", () => {
	it("rewrites native cache metrics in the final SSE usage chunk", async () => {
		const source = [
			`data: ${JSON.stringify({
				id: "chatcmpl_test",
				choices: [],
				usage: { prompt_eval_count: 100, prompt_eval_cached_count: 64, eval_count: 10 },
			})}\n\n`,
			"data: [DONE]\n\n",
		].join("");
		const fetch = createOllamaFetch(async () =>
			new Response(source, { headers: { "content-type": "text/event-stream" } }),
		);

		const response = await fetch("https://ollama.test/v1/chat/completions");
		const lines = (await response.text()).split("\n");
		const rewritten = lines.find((line) => line.startsWith("data: {") && line.includes("cached_tokens"));
		expect(rewritten).toBeDefined();
		expect(JSON.parse(rewritten!.slice("data: ".length)).usage).toMatchObject({
			prompt_tokens: 100,
			completion_tokens: 10,
			prompt_tokens_details: { cached_tokens: 64 },
		});
	});

	it("passes non-SSE responses through unchanged", async () => {
		const source = JSON.stringify({ prompt_eval_cached_count: 64 });
		const fetch = createOllamaFetch(async () =>
			new Response(source, { headers: { "content-type": "application/json" } }),
		);

		const response = await fetch("https://ollama.test/v1/chat/completions");
		expect(await response.text()).toBe(source);
	});
});

describe("streamOllama", () => {
	it("delivers Ollama cache hits in the assistant usage", async () => {
		const source = [
			`data: ${JSON.stringify({
				id: "chatcmpl_test",
				model: "test-model",
				choices: [{ index: 0, delta: { role: "assistant", content: "hello" }, finish_reason: null }],
			})}\n\n`,
			`data: ${JSON.stringify({
				id: "chatcmpl_test",
				model: "test-model",
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			})}\n\n`,
			`data: ${JSON.stringify({
				id: "chatcmpl_test",
				model: "test-model",
				choices: [],
				usage: { prompt_eval_count: 100, prompt_eval_cached_count: 64, eval_count: 10 },
			})}\n\n`,
			"data: [DONE]\n\n",
		].join("");
		const model: Model<"openai-completions"> = {
			id: "test-model",
			name: "Test model",
			api: "openai-completions",
			provider: "ollama-cloud",
			baseUrl: "https://ollama.test/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 1000,
		};
		const context: Context = {
			messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
		};

		const stream = streamOllama(model, context, {
			apiKey: "test-key",
			fetch: async () => new Response(source, { headers: { "content-type": "text/event-stream" } }),
		});
		const assistant = await stream.result();

		expect(assistant.usage.cacheRead).toBe(64);
		expect(assistant.usage.input).toBe(36);
		expect(assistant.usage.output).toBe(10);
	});
});
