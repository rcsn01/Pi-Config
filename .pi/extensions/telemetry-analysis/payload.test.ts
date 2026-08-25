import { describe, expect, it } from "vitest";
import { analyzePayload, normalizeUsage, reconcileCacheSections, serializeJson, supportsPrefixCacheEstimate } from "./payload.ts";

describe("analysis payload views", () => {
	it("labels OpenAI Completions payloads", () => {
		const analysis = analyzePayload("openai-completions", {
			model: "test",
			messages: [{ role: "developer", content: "rules" }, { role: "user", content: "hi" }],
			tools: [{ type: "function", function: { name: "read", description: "Read", parameters: { type: "object" } } }],
			temperature: 0,
		});
		expect(analysis).toMatchObject({ apiLabel: "OpenAI Completions", prefixCache: true });
		expect(analysis.sections.map((row) => [row.kind, row.pointer])).toEqual([
			["tool", "/tools/0"], ["instruction", "/messages/0"], ["conversation", "/messages/1"],
			["option", "/model"], ["option", "/temperature"],
		]);
	});

	it("labels OpenAI Responses payloads and aliases", () => {
		const payload = {
			model: "gpt-test",
			instructions: "system",
			tools: [{ type: "function", name: "read", description: "Read", parameters: { type: "object" } }],
			input: [{ role: "user", content: "hello" }, { type: "reasoning", encrypted_content: "state" }],
			reasoning: { effort: "high" },
		};
		for (const api of ["openai-responses", "openai-codex-responses", "azure-openai-responses"]) {
			const analysis = analyzePayload(api, payload);
			expect(analysis.apiLabel).toBe("OpenAI Responses");
			expect(analysis.sections.map((row) => [row.kind, row.pointer])).toEqual(expect.arrayContaining([
				["instruction", "/instructions"], ["tool", "/tools/0"], ["conversation", "/input/0"],
				["reasoning", "/input/1"], ["option", "/reasoning"],
			]));
		}
	});

	it("labels Anthropic Messages in prefix order", () => {
		const analysis = analyzePayload("anthropic-messages", {
			model: "claude-test",
			tools: [{ name: "read", description: "Read", input_schema: { type: "object" } }],
			system: [{ type: "text", text: "rules" }],
			messages: [{ role: "user", content: "hi" }],
			max_tokens: 100,
		});
		expect(analysis).toMatchObject({ apiLabel: "Anthropic Messages", prefixCache: true });
		expect(analysis.sections.map((row) => [row.kind, row.pointer])).toEqual([
			["tool", "/tools/0"], ["instruction", "/system"], ["conversation", "/messages/0"],
			["option", "/model"], ["option", "/max_tokens"],
		]);
	});

	it("uses one complete generic section for unknown APIs", () => {
		const payload = { systemInstruction: "rules", contents: [{ role: "user", parts: ["hi"] }] };
		const analysis = analyzePayload("custom-api", payload);
		expect(analysis).toMatchObject({ apiLabel: "Generic payload", prefixCache: false });
		expect(analysis.sections).toEqual([
			expect.objectContaining({ label: "complete request payload", pointer: "" }),
		]);
		expect(supportsPrefixCacheEstimate("custom-api")).toBe(false);
		expect(supportsPrefixCacheEstimate("anthropic-messages")).toBe(true);
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
