import { describe, expect, it } from "vitest";
import { AdvisorProjectionError, projectAdvisorContext, type AdvisorProjectionInput } from "./transcript.ts";

function entry(id: string, message: any): any {
	return { type: "message", id, parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message };
}

function input(overrides: Partial<AdvisorProjectionInput> = {}): AdvisorProjectionInput {
	return {
		entries: [],
		systemPrompt: "Executor system prompt",
		activeToolNames: ["read"],
		allTools: [{
			name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } } },
			sourceInfo: { source: "builtin", path: "<builtin:read>", scope: "temporary", origin: "top-level" },
		} as any],
		model: { provider: "anthropic", id: "advisor", contextWindow: 100_000, input: ["text", "image"] },
		maxTokens: 2048,
		...overrides,
	};
}

describe("advisor context projection", () => {
	it("quotes executor context and preserves conversation evidence without schemas or reasoning", () => {
		const result = projectAdvisorContext(input({
			entries: [
				entry("user", { role: "user", content: "Inspect the parser", timestamp: 1 }),
				entry("assistant", {
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "secret reasoning", thinkingSignature: "secret" },
						{ type: "text", text: "I found it.", textSignature: "secret" },
						{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "src/parser.ts" } },
					],
					provider: "x", model: "x", api: "x", usage: {}, stopReason: "toolUse", timestamp: 2,
				}),
				entry("result", { role: "toolResult", toolCallId: "read-1", toolName: "read", isError: false, content: [{ type: "text", text: "source" }], timestamp: 3 }),
			],
		}));
		const text = JSON.stringify(result.messages);
		expect(text).toContain("Executor system prompt");
		expect(text).toContain("Read a file");
		expect(text).not.toContain("properties");
		expect(text).toContain("Inspect the parser");
		expect(text).toContain("I found it.");
		expect(text).toContain("src/parser.ts");
		expect(text).toContain("source");
		expect(text).toContain("reasoning omitted");
		expect(text).not.toContain("secret reasoning");
		expect(text).not.toContain("thinkingSignature");
	});

	it("removes the active advisor call and retains preceding prose", () => {
		const result = projectAdvisorContext(input({
			entries: [entry("assistant", {
				role: "assistant",
				content: [
					{ type: "text", text: "Current finding" },
					{ type: "toolCall", id: "advisor-call", name: "advisor", arguments: {} },
				],
				provider: "x", model: "x", api: "x", usage: {}, stopReason: "toolUse", timestamp: 1,
			})],
			advisorCallId: "advisor-call",
		}));
		const text = JSON.stringify(result.messages);
		expect(text).toContain("Current finding");
		expect(text).not.toContain("advisor-call");
	});

	it("rejects unresolved sibling calls", () => {
		expect(() => projectAdvisorContext(input({
			entries: [entry("assistant", {
				role: "assistant",
				content: [
					{ type: "toolCall", id: "advisor-call", name: "advisor", arguments: {} },
					{ type: "toolCall", id: "write-call", name: "write", arguments: {} },
				],
				provider: "x", model: "x", api: "x", usage: {}, stopReason: "toolUse", timestamp: 1,
			})],
			advisorCallId: "advisor-call",
		}))).toThrow(AdvisorProjectionError);
	});

	it("keeps newest context within a fixed model-derived limit", () => {
		const result = projectAdvisorContext(input({
			entries: [
				entry("old", { role: "user", content: `OLD-${"x".repeat(20_000)}`, timestamp: 1 }),
				entry("new", { role: "user", content: "NEW-EVIDENCE", timestamp: 2 }),
			],
			model: { provider: "tiny", id: "tiny", contextWindow: 3000, input: ["text"] },
			maxTokens: 1000,
		}));
		const text = JSON.stringify(result.messages);
		expect(result.truncated).toBe(true);
		expect(text).toContain("NEW-EVIDENCE");
		expect(text.length).toBeLessThan(7000);
	});

	it("includes the focus question inside the projection bound and caps long questions", () => {
		const result = projectAdvisorContext(input({ question: `FOCUS-${"q".repeat(20_000)}` }));
		const focus = result.messages.at(-1);
		expect(focus?.role).toBe("user");
		const text = JSON.stringify(focus);
		expect(text).toContain("FOCUS-");
		expect(text.length).toBeLessThan(4_500);
		expect(text).not.toContain("q".repeat(4_001));
	});

	it("preserves supported images and rejects unsupported ones", () => {
		const image = entry("image", { role: "user", content: [{ type: "image", data: "abc", mimeType: "image/png" }], timestamp: 1 });
		expect(JSON.stringify(projectAdvisorContext(input({ entries: [image] })).messages)).toContain("abc");
		expect(() => projectAdvisorContext(input({
			entries: [image],
			model: { provider: "text", id: "only", contextWindow: 100_000, input: ["text"] },
		}))).toThrow(/does not accept images/);
	});
});
