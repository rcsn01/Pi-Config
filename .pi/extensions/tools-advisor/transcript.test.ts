import { describe, expect, it } from "vitest";
import { ADVISOR_SYSTEM_PROMPT } from "./prompt.ts";
import {
	projectTranscript,
	providerRejectsOversizedInput,
	type TranscriptProjectionInput,
} from "./transcript.ts";

function entry(id: string, message: any): any {
	return { type: "message", id, parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message };
}

function model(overrides: Record<string, unknown> = {}): any {
	return {
		provider: "anthropic",
		id: "advisor",
		contextWindow: 100_000,
		maxTokens: 2048,
		input: ["text", "image"],
		...overrides,
	};
}

function input(overrides: Partial<TranscriptProjectionInput> = {}): TranscriptProjectionInput {
	return {
		entries: [],
		systemPrompt: "Executor system prompt",
		activeToolNames: ["read"],
		allTools: [{
			name: "read",
			description: "Read a file",
			parameters: { type: "object", properties: { path: { type: "string" } } },
			sourceInfo: { source: "builtin", path: "<builtin:read>", scope: "temporary", origin: "top-level" },
		}],
		model: model(),
		maxTokens: 2048,
		...overrides,
	};
}

describe("advisor transcript projection", () => {
	it("includes the executor context and every effective message in order", () => {
		const projected = projectTranscript(input({
			entries: [
				entry("user", { role: "user", content: "Inspect the parser" , timestamp: 1 }),
				entry("assistant", {
					role: "assistant",
					content: [
						{ type: "text", text: "I found the parser." , textSignature: "opaque" },
						{ type: "thinking", thinking: "The parser is central.", thinkingSignature: "opaque" },
						{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "src/parser.ts" }, thoughtSignature: "opaque" },
					],
					provider: "executor-provider", model: "executor-model", api: "executor-api",
					usage: {}, stopReason: "toolUse", timestamp: 2,
				}),
				entry("tool", {
					role: "toolResult", toolCallId: "read-1", toolName: "read", isError: false,
					content: [{ type: "text", text: "export function parse() {}", textSignature: "opaque" }], timestamp: 3,
				}),
				{ type: "compaction", id: "compact", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", summary: "Earlier work summary", firstKeptEntryId: "user", tokensBefore: 100 },
				{ type: "custom_message", id: "custom", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", customType: "note", content: "A durable note", display: true },
			],
			advisorCallId: undefined,
			question: "Should I change the parser interface?",
		}));

		expect(projected.systemPrompt).toBe(ADVISOR_SYSTEM_PROMPT);
		expect(projected.messages[0]).toMatchObject({ role: "user", timestamp: 0 });
		const rendered = JSON.stringify(projected.messages);
		expect(rendered.indexOf("Executor system prompt")).toBeGreaterThanOrEqual(0);
		expect(rendered.indexOf("Inspect the parser")).toBeGreaterThan(rendered.indexOf("Executor system prompt"));
		expect(rendered).toContain("I found the parser.");
		expect(rendered).toContain("The parser is central.");
		expect(rendered).toContain("<tool_call>");
		expect(rendered).toContain("src/parser.ts");
		expect(rendered).toContain("<tool_result");
		expect(rendered).toContain("export function parse() {}");
		expect(rendered).toContain("Earlier work summary");
		expect(rendered).toContain("A durable note");
		expect(rendered).toContain("Should I change the parser interface?");
		expect(rendered).toContain("Keep your advice under 400 words.");
		expect(rendered).not.toContain("opaque");
	});

	it("removes only the current advisor call while retaining preceding prose and prior advice", () => {
		const projected = projectTranscript(input({
			entries: [
				entry("old-assistant", {
					role: "assistant", content: [{ type: "text", text: "Old advice request" }, { type: "toolCall", id: "old-advisor", name: "advisor", arguments: {} }],
					provider: "x", model: "x", api: "x", usage: {}, stopReason: "toolUse", timestamp: 1,
				}),
				entry("old-result", { role: "toolResult", toolCallId: "old-advisor", toolName: "advisor", content: [{ type: "text", text: "Previous advice" }], isError: false, timestamp: 2 }),
				entry("current-assistant", {
					role: "assistant", content: [{ type: "text", text: "Current prose before asking." }, { type: "toolCall", id: "current-advisor", name: "advisor", arguments: { question: "focus" } }],
					provider: "x", model: "x", api: "x", usage: {}, stopReason: "toolUse", timestamp: 3,
				}),
			],
			advisorCallId: "current-advisor",
		}));
		const rendered = JSON.stringify(projected.messages);
		expect(rendered).toContain("Current prose before asking.");
		expect(rendered).toContain("Previous advice");
		expect(rendered).not.toContain("current-advisor");
		expect(rendered.match(/<tool_call>/g)).toHaveLength(1);
	});

	it("rejects an advisor call batched with another unresolved tool call", () => {
		expect(() => projectTranscript(input({
			entries: [entry("assistant", {
				role: "assistant", content: [
					{ type: "text", text: "Before tools" },
					{ type: "toolCall", id: "advisor", name: "advisor", arguments: {} },
					{ type: "toolCall", id: "write", name: "write", arguments: { path: "x" } },
				], provider: "x", model: "x", api: "x", usage: {}, stopReason: "toolUse", timestamp: 1,
			})],
			advisorCallId: "advisor",
		}))).toThrow(/parallel_tool_calls/);
	});

	it("preserves supported images and marks error tool results without leaking signatures", () => {
		const projected = projectTranscript(input({
			entries: [
				entry("user-image", { role: "user", content: [{ type: "text", text: "Screenshot" }, { type: "image", data: "base64-data", mimeType: "image/png" }], timestamp: 1 }),
				entry("error-result", { role: "toolResult", toolCallId: "read-1", toolName: "read", content: [{ type: "text", text: "permission denied", textSignature: "secret" }], isError: true, timestamp: 2 }),
			],
		}));
		const messages = projected.messages.filter((message) => message.role !== "assistant");
		expect(messages.some((message) => Array.isArray(message.content) && message.content.some((block) => block.type === "image" && block.data === "base64-data"))).toBe(true);
		expect(JSON.stringify(projected.messages)).toContain("status=error");
		expect(JSON.stringify(projected.messages)).toContain("permission denied");
		expect(JSON.stringify(projected.messages)).not.toContain("secret");
	});

	it("replaces redacted thinking with a marker and strips all provider signatures", () => {
		const projected = projectTranscript(input({
			entries: [entry("assistant", {
				role: "assistant", content: [
					{ type: "thinking", thinking: "", redacted: true, thinkingSignature: "secret" },
					{ type: "text", text: "Visible", textSignature: "secret" },
				], provider: "x", model: "x", api: "x", usage: {}, stopReason: "stop", timestamp: 1,
			})],
		}));
		const rendered = JSON.stringify(projected.messages);
		expect(rendered).toContain("thinking unavailable");
		expect(rendered).toContain("Visible");
		expect(rendered).not.toContain("secret");
	});

	it("is byte-stable and never truncates the projected transcript", () => {
		const value = input({
			entries: [entry("user", { role: "user", content: "stable", timestamp: Date.now() })],
			question: "same",
		});
		const first = projectTranscript(value);
		const second = projectTranscript(value);
		expect(JSON.stringify(first)).toBe(JSON.stringify(second));
		expect(JSON.stringify(first)).toContain("stable");
	});

	it("fails visibly for unsupported images and definite or ambiguous overflow", () => {
		const imageEntry = entry("image", { role: "user", content: [{ type: "image", data: "abc", mimeType: "image/png" }], timestamp: 1 });
		expect(() => projectTranscript(input({ entries: [imageEntry], model: model({ input: ["text"] }) }))).toThrow(/unsupported_modality/);

		const huge = entry("huge", { role: "user", content: "x".repeat(20_000), timestamp: 1 });
		expect(() => projectTranscript(input({ entries: [huge], model: model({ contextWindow: 100 }) , maxTokens: 10 }))).toThrow(/context_too_large/);

		const ambiguous = entry("ambiguous", { role: "user", content: "x".repeat(300), timestamp: 1 });
		const unconstrained = projectTranscript(input({ entries: [ambiguous], model: model({ contextWindow: 1_000_000 }), maxTokens: 10 }));
		const straddleWindow = Math.floor((unconstrained.bounds.totalLowerBound + unconstrained.bounds.totalUpperBound) / 2);
		expect(() => projectTranscript(input({ entries: [ambiguous], model: model({ provider: "ollama", contextWindow: straddleWindow }), maxTokens: 10 }))).toThrow(/context_too_large/);
		expect(projectTranscript(input({ entries: [ambiguous], model: model({ provider: "anthropic", contextWindow: straddleWindow }), maxTokens: 10 })).bounds.totalUpperBound).toBeGreaterThan(straddleWindow);
	});

	it("identifies only providers with explicit overflow rejection behavior as safe for ambiguity", () => {
		expect(providerRejectsOversizedInput("anthropic")).toBe(true);
		expect(providerRejectsOversizedInput("openai-codex")).toBe(true);
		expect(providerRejectsOversizedInput("google-vertex")).toBe(true);
		expect(providerRejectsOversizedInput("ollama")).toBe(false);
		expect(providerRejectsOversizedInput("openrouter")).toBe(false);
		expect(providerRejectsOversizedInput("custom-provider")).toBe(false);
	});
});
