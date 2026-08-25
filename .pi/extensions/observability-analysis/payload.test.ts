import { describe, expect, it } from "vitest";
import { labelPayload, normalizeUsage, reconcileCacheSections, serializeJson } from "./payload.ts";

describe("analysis payload views", () => {
	it("labels Responses and chat payloads with JSON pointers", () => {
		const responses = labelPayload({
			model: "gpt-test",
			instructions: "system",
			tools: [{ type: "function", name: "read", description: "Read", parameters: { type: "object" } }],
			input: [{ role: "user", content: "hello" }, { type: "reasoning", encrypted_content: "state" }],
			reasoning: { effort: "high" },
		});
		expect(responses.map((row) => [row.kind, row.pointer])).toEqual(expect.arrayContaining([
			["instruction", "/instructions"], ["tool", "/tools/0"], ["conversation", "/input/0"],
			["reasoning", "/input/1"], ["option", "/reasoning"],
		]));
		const chat = labelPayload({ messages: [{ role: "developer", content: "rules" }, { role: "user", content: "hi" }], prompt: "fallback" });
		expect(chat.map((row) => row.pointer)).toEqual(["/messages/0", "/messages/1", "/prompt"]);
	});

	it("reconciles visible estimates and consumes the cache hit from the prefix", () => {
		const rows = reconcileCacheSections([
			{ kind: "instruction", label: "a", pointer: "/a", estimatedTokens: 1 },
			{ kind: "tool", label: "b", pointer: "/b", estimatedTokens: 2 },
			{ kind: "conversation", label: "c", pointer: "/c", estimatedTokens: 1 },
		], 11, 5);
		expect(rows.reduce((sum, row) => sum + row.allocatedTokens!, 0)).toBe(11);
		expect(rows.reduce((sum, row) => sum + row.cachedTokens!, 0)).toBe(5);
		expect(rows[0]!.cachedTokens).toBe(rows[0]!.allocatedTokens);
	});

	it("keeps exact usage fields and reasoning as a subset without adding it to output", () => {
		const usage = normalizeUsage({ input: 10, cacheRead: 20, cacheWrite: 3, output: 8, reasoning: 5, totalTokens: 41, cost: { input: 1, cacheRead: 2, cacheWrite: 3, output: 4, total: 10 } });
		expect(usage).toMatchObject({ input: 10, cacheRead: 20, cacheWrite: 3, output: 8, reasoning: 5, totalTokens: 41 });
		expect(usage!.cost.total).toBe(10);
	});

	it("serializes without truncation or redaction and diagnoses unsupported JSON", () => {
		const secret = "sk-synthetic-" + "x".repeat(1000);
		expect(serializeJson({ secret }).json).toContain(secret);
		expect(serializeJson({ value: 1n }).diagnostic).toContain("serialization failed");
	});
});
