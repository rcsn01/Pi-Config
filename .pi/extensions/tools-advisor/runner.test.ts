import { describe, expect, it, vi } from "vitest";
import { InMemoryCredentialStore, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import type { Usage } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { deriveSubagentSessionId } from "../tools-subagents/cache-affinity.ts";
import {
	createAdvisorRunner,
	deriveAdvisorSessionId,
	type AdvisorRunInput,
	type AdvisorSettings,
} from "./runner.ts";

const usage: Usage = {
	input: 20,
	output: 10,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 30,
	cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 },
};

const advisorModel: any = {
	provider: "anthropic",
	id: "strong",
	name: "Strong",
	api: "anthropic-messages",
	baseUrl: "https://example.invalid",
	reasoning: true,
	input: ["text"],
	contextWindow: 100_000,
	maxTokens: 4096,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

function assistantResponse(overrides: Record<string, unknown> = {}): any {
	return {
		role: "assistant",
		content: [{ type: "text", text: "Use the narrow change and verify it." }],
		api: advisorModel.api,
		provider: advisorModel.provider,
		model: advisorModel.id,
		usage,
		stopReason: "stop",
		timestamp: 0,
		...overrides,
	};
}

function currentEntries(): any[] {
	return [
		{ type: "message", id: "user", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "Fix the parser", timestamp: 0 } },
		{ type: "message", id: "assistant", parentId: "user", timestamp: "2026-01-01T00:00:00.000Z", message: {
			role: "assistant",
			content: [
				{ type: "text", text: "I inspected the parser." },
				{ type: "toolCall", id: "advisor-call", name: "advisor", arguments: { question: "focus" } },
			],
			api: "faux", provider: "executor", model: "cheap", usage, stopReason: "toolUse", timestamp: 0,
		} },
	];
}

function context(overrides: Record<string, unknown> = {}): any {
	const entries = currentEntries();
	return {
		cwd: "/workspace",
		model: { provider: "executor", id: "cheap" },
		signal: undefined,
		getSystemPrompt: () => "Executor instructions",
		sessionManager: {
			buildContextEntries: () => entries,
			getBranch: () => entries,
			getSessionId: () => "main-session",
		},
		modelRegistry: {
			find: vi.fn(() => advisorModel),
			hasConfiguredAuth: vi.fn(() => true),
			complete: vi.fn(async () => assistantResponse()),
		},
		...overrides,
	};
}

function runInput(ctx: any, overrides: Partial<AdvisorRunInput> = {}): AdvisorRunInput {
	return {
		ctx,
		settings: {
			provider: "anthropic",
			modelId: "strong",
			strict: false,
			nudgeTurn: 3,
			maxUses: 3,
			maxUsesPerSession: 20,
			maxTokens: 2048,
			allowCrossProvider: true,
		},
		callId: "advisor-call",
		question: "Should I change the parser interface?",
		activeToolNames: ["advisor", "read"],
		allTools: [{
			name: "advisor",
			label: "Advisor",
			description: "Advisor",
			parameters: { type: "object", properties: {} },
			sourceInfo: { source: "extension", path: "advisor", scope: "project", origin: "top-level" },
		} as any],
		...overrides,
	};
}

describe("advisor cache affinity", () => {
	it("is stable per main session and advisor model but isolated from executor/subagent IDs", () => {
		const first = deriveAdvisorSessionId("main", "anthropic/strong");
		expect(first).toMatch(/^advisor-[a-f0-9]{32}$/);
		expect(deriveAdvisorSessionId("main", "anthropic/strong")).toBe(first);
		expect(deriveAdvisorSessionId("main", "openai/strong")).not.toBe(first);
		expect(deriveAdvisorSessionId("other", "anthropic/strong")).not.toBe(first);
		expect(first).not.toBe("main");
		expect(first).not.toBe(deriveSubagentSessionId("main", "anthropic/strong"));
		expect(() => deriveAdvisorSessionId("", "anthropic/strong")).toThrow(/Main session ID/);
		expect(() => deriveAdvisorSessionId("main", "")).toThrow(/Resolved advisor model/);
	});
});

describe("advisor runner", () => {
	it("makes one tool-free call with the complete projection, focus question, cap, and stable cache identity", async () => {
		const ctx = context();
		const runner = createAdvisorRunner();
		const result = await runner.execute(runInput(ctx));
		const complete = ctx.modelRegistry.complete;

		expect(complete).toHaveBeenCalledOnce();
		expect(complete.mock.calls[0][0]).toBe(advisorModel);
		expect(complete.mock.calls[0][1]).toMatchObject({
			systemPrompt: expect.stringContaining("read-only engineering advisor"),
			tools: [],
		});
		expect(JSON.stringify(complete.mock.calls[0][1].messages)).toContain("Should I change the parser interface?");
		expect(complete.mock.calls[0][2]).toMatchObject({
			maxTokens: 2048,
			cacheRetention: "short",
			sessionId: deriveAdvisorSessionId("main-session", "anthropic/strong"),
		});
		expect(result).toMatchObject({
			content: [{ type: "text", text: "Use the narrow change and verify it." }],
			details: { model: "anthropic/strong", consumesBudget: true, truncated: false },
			usage,
		});
	});

	it("returns visible fail-soft results for empty, truncated, aborted, and provider-error responses", async () => {
		for (const response of [
			assistantResponse({ content: [], stopReason: "stop" }),
			assistantResponse({ content: [{ type: "text", text: "partial" }], stopReason: "length" }),
			assistantResponse({ content: [], stopReason: "aborted", errorMessage: "This operation was aborted" }),
			assistantResponse({ content: [], stopReason: "error", errorMessage: "provider failed" }),
		]) {
			const ctx = context();
			ctx.modelRegistry.complete.mockResolvedValue(response);
			const result = await createAdvisorRunner().execute(runInput(ctx));
			expect(result.content[0]?.type).toBe("text");
			expect(result.details.consumesBudget).toBe(true);
			if (response.stopReason === "length") expect(result.details.truncated).toBe(true);
			expect(result.content[0].text).toMatch(/^advisor_/);
		}
	});

	it("does not call the provider after the per-turn cap is exhausted", async () => {
		const entries = [...currentEntries()];
		const ctx = context({ sessionManager: { buildContextEntries: () => entries, getBranch: () => entries, getSessionId: () => "main-session" } });
		const runner = createAdvisorRunner();
		const settings: AdvisorSettings = { provider: "anthropic", modelId: "strong", strict: false, nudgeTurn: 3, maxUses: 1, maxUsesPerSession: 20, maxTokens: 2048, allowCrossProvider: true };
		await runner.execute(runInput(ctx, { settings }));
		entries.push({
			type: "message", id: "advisor-result", parentId: "assistant", timestamp: "2026-01-01T00:00:00.000Z",
			message: {
				role: "toolResult", toolCallId: "advisor-call", toolName: "advisor", isError: false,
				content: [{ type: "text", text: "Use the narrow change and verify it." }],
				details: { model: "anthropic/strong", consumesBudget: true, truncated: false }, timestamp: 0,
			},
		});
		const second = await runner.execute(runInput(ctx, { settings }));
		expect(ctx.modelRegistry.complete).toHaveBeenCalledOnce();
		expect(second.content[0].text).toMatch(/^advisor_turn_budget_exhausted/);
		expect(second.details.consumesBudget).toBe(false);
	});

	it("resets the per-turn budget on a new user message", async () => {
		const entries = [...currentEntries()];
		const ctx = context({ sessionManager: { buildContextEntries: () => entries, getBranch: () => entries, getSessionId: () => "main-session" } });
		const runner = createAdvisorRunner();
		const settings: AdvisorSettings = { provider: "anthropic", modelId: "strong", strict: false, nudgeTurn: 3, maxUses: 1, maxUsesPerSession: 20, maxTokens: 2048, allowCrossProvider: true };
		await runner.execute(runInput(ctx, { settings }));
		entries.push({
			type: "message", id: "advisor-result", parentId: "assistant", timestamp: "2026-01-01T00:00:00.000Z",
			message: {
				role: "toolResult", toolCallId: "advisor-call", toolName: "advisor", isError: false,
				content: [{ type: "text", text: "Advice" }],
				details: { model: "anthropic/strong", consumesBudget: true, truncated: false }, timestamp: 0,
			},
		});
		const second = await runner.execute(runInput(ctx, { settings }));
		expect(second.content[0].text).toMatch(/^advisor_turn_budget_exhausted/);
		entries.push({ type: "message", id: "next-user", parentId: "advisor-result", timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "Next turn", timestamp: 0 } });
		const third = await runner.execute(runInput(ctx, { settings }));
		expect(ctx.modelRegistry.complete).toHaveBeenCalledTimes(2);
		expect(third.details.consumesBudget).toBe(true);
	});

	it("enforces the session ceiling even when the per-turn budget resets", async () => {
		const entries = [...currentEntries()];
		const ctx = context({ sessionManager: { buildContextEntries: () => entries, getBranch: () => entries, getSessionId: () => "main-session" } });
		const runner = createAdvisorRunner();
		const settings: AdvisorSettings = { provider: "anthropic", modelId: "strong", strict: false, nudgeTurn: 3, maxUses: 3, maxUsesPerSession: 1, maxTokens: 2048, allowCrossProvider: true };
		await runner.execute(runInput(ctx, { settings }));
		entries.push({
			type: "message", id: "advisor-result", parentId: "assistant", timestamp: "2026-01-01T00:00:00.000Z",
			message: {
				role: "toolResult", toolCallId: "advisor-call", toolName: "advisor", isError: false,
				content: [{ type: "text", text: "Advice" }],
				details: { model: "anthropic/strong", consumesBudget: true, truncated: false }, timestamp: 0,
			},
		});
		entries.push({ type: "message", id: "next-user", parentId: "advisor-result", timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "Next turn", timestamp: 0 } });
		const second = await runner.execute(runInput(ctx, { settings }));
		expect(ctx.modelRegistry.complete).toHaveBeenCalledOnce();
		expect(second.content[0].text).toMatch(/^advisor_budget_exhausted/);
		expect(second.details.consumesBudget).toBe(false);
	});

	it("reuses the advisor cache identity and exposes faux-provider cache-read usage on a compatible second consultation", async () => {
		const faux = fauxProvider({ provider: "anthropic", models: [{ id: "strong", contextWindow: 100_000 }], tokensPerSecond: 100_000 });
		faux.setResponses([fauxAssistantMessage("first advice"), fauxAssistantMessage("second advice")]);
		const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
		runtime.registerNativeProvider(faux.provider);
		const model = faux.getModel("strong")!;
		const ctx = context({
			model: { provider: "anthropic", id: "executor" },
			modelRegistry: {
				find: vi.fn(() => model),
				hasConfiguredAuth: vi.fn(() => true),
				complete: runtime.complete.bind(runtime),
			},
		});
		const runner = createAdvisorRunner();
		const first = await runner.execute(runInput(ctx, { settings: { provider: "anthropic", modelId: "strong", strict: false, nudgeTurn: 3, maxUses: 3, maxUsesPerSession: 20, maxTokens: 2048, allowCrossProvider: true } }));
		const second = await runner.execute(runInput(ctx, { settings: { provider: "anthropic", modelId: "strong", strict: false, nudgeTurn: 3, maxUses: 3, maxUsesPerSession: 20, maxTokens: 2048, allowCrossProvider: true } }));
		expect(first.usage?.cacheWrite).toBeGreaterThan(0);
		expect(second.usage?.cacheRead).toBeGreaterThan(0);
		expect(first.details.model).toBe(second.details.model);
	});

	it("rejects missing model/auth, denied cross-provider transfer, and explicit zero-usage overflow without consuming", async () => {
		const missingModel = context();
		missingModel.modelRegistry.find.mockReturnValue(undefined);
		let result = await createAdvisorRunner().execute(runInput(missingModel));
		expect(result.content[0].text).toMatch(/^advisor_model_unavailable/);
		expect(result.details.consumesBudget).toBe(false);

		const missingAuth = context();
		missingAuth.modelRegistry.hasConfiguredAuth.mockReturnValue(false);
		result = await createAdvisorRunner().execute(runInput(missingAuth));
		expect(result.content[0].text).toMatch(/^advisor_auth_unavailable/);
		expect(result.details.consumesBudget).toBe(false);

		const denied = context();
		result = await createAdvisorRunner().execute(runInput(denied, {
			settings: { provider: "anthropic", modelId: "strong", strict: false, nudgeTurn: 3, maxUses: 3, maxUsesPerSession: 20, maxTokens: 2048, allowCrossProvider: false },
		}));
		expect(result.content[0].text).toMatch(/^advisor_cross_provider_denied/);
		expect(result.details.consumesBudget).toBe(false);

		const overflow = context();
		overflow.modelRegistry.complete.mockResolvedValue(assistantResponse({
			content: [], stopReason: "error", errorMessage: "context_length_exceeded",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		}));
		const overflowRunner = createAdvisorRunner();
		result = await overflowRunner.execute(runInput(overflow));
		expect(result.content[0].text).toMatch(/^advisor_context_too_large/);
		expect(result.details.consumesBudget).toBe(false);

		const promptTooLong = context();
		promptTooLong.modelRegistry.complete.mockResolvedValue(assistantResponse({
			content: [], stopReason: "error", errorMessage: "prompt_too_long",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		}));
		result = await createAdvisorRunner().execute(runInput(promptTooLong));
		expect(result.content[0].text).toMatch(/^advisor_context_too_large/);
		expect(result.details.consumesBudget).toBe(false);
	});
});
