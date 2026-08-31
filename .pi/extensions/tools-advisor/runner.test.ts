import { describe, expect, it, vi } from "vitest";
import type { Usage } from "@earendil-works/pi-ai";
import { createAdvisorRunner, type AdvisorRunInput } from "./runner.ts";

const usage: Usage = {
	input: 20, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 30,
	cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 },
};

const advisorModel: any = {
	provider: "anthropic", id: "strong", name: "Strong", api: "anthropic-messages",
	baseUrl: "https://example.invalid", reasoning: true, input: ["text"], contextWindow: 100_000,
	maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

function response(overrides: Record<string, unknown> = {}): any {
	return {
		role: "assistant",
		content: [{ type: "text", text: "Use the narrow change." }],
		api: advisorModel.api,
		provider: advisorModel.provider,
		model: advisorModel.id,
		usage,
		stopReason: "stop",
		timestamp: 0,
		...overrides,
	};
}

function entries(): any[] {
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
	const branch = entries();
	return {
		cwd: "/workspace",
		model: { provider: "executor", id: "cheap" },
		scopedModels: [],
		signal: undefined,
		getSystemPrompt: () => "Executor instructions",
		sessionManager: { buildContextEntries: () => branch },
		modelRegistry: {
			find: vi.fn(() => advisorModel),
			hasConfiguredAuth: vi.fn(() => true),
			getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: "secret" })),
			getProvider: vi.fn(),
		},
		...overrides,
	};
}

function runInput(ctx: any, overrides: Partial<AdvisorRunInput> = {}): AdvisorRunInput {
	return {
		ctx,
		settings: { enabled: true, model: "anthropic/strong", thinkingLevel: "high", maxTokens: 2048 },
		callId: "advisor-call",
		question: "Should I change the parser interface?",
		activeToolNames: ["advisor", "read"],
		allTools: [{ name: "read", description: "Read files", parameters: {}, sourceInfo: {} } as any],
		...overrides,
	};
}

describe("advisor runner", () => {
	it("passes a bounded transcript and model choices through one completion seam", async () => {
		const complete = vi.fn(async (_input: any) => response());
		const result = await createAdvisorRunner({ complete }).execute(runInput(context()));
		expect(complete).toHaveBeenCalledOnce();
		expect(complete.mock.calls[0][0]).toMatchObject({
			model: { provider: "anthropic", id: "strong" },
			thinkingLevel: "high",
			maxTokens: 2048,
		});
		const projected = JSON.stringify(complete.mock.calls[0][0].messages);
		expect(projected).toContain("Executor instructions");
		expect(projected).toContain("I inspected the parser.");
		expect(projected).not.toContain("advisor-call");
		expect(projected).toContain("Should I change the parser interface?");
		expect(result).toEqual({
			ok: true,
			text: "Use the narrow change.",
			model: "anthropic/strong",
			truncated: false,
			usage,
		});
	});

	it("does not run when disabled, unavailable, unauthenticated, or outside scope", async () => {
		const complete = vi.fn(async (_input: any) => response());
		const runner = createAdvisorRunner({ complete });
		let ctx = context();
		expect(await runner.execute(runInput(ctx, { settings: { enabled: false, model: "anthropic/strong", maxTokens: 2048 } })))
			.toMatchObject({ ok: false, message: expect.stringContaining("disabled") });
		ctx = context();
		ctx.modelRegistry.find.mockReturnValue(undefined);
		expect(await runner.execute(runInput(ctx))).toMatchObject({ ok: false, message: expect.stringContaining("unavailable") });
		ctx = context();
		ctx.modelRegistry.hasConfiguredAuth.mockReturnValue(false);
		expect(await runner.execute(runInput(ctx))).toMatchObject({ ok: false, message: expect.stringContaining("authentication") });
		ctx = context({ scopedModels: [{ model: { provider: "anthropic", id: "other" } }] });
		expect(await runner.execute(runInput(ctx))).toMatchObject({ ok: false, message: expect.stringContaining("unavailable") });
		expect(complete).not.toHaveBeenCalled();
	});

	it("normalizes successful, truncated, empty, aborted, and failed responses", async () => {
		const cases = [
			[response(), { ok: true, truncated: false }],
			[response({ stopReason: "length", content: [{ type: "text", text: "partial" }] }), { ok: true, truncated: true, text: expect.stringContaining("partial") }],
			[response({ content: [] }), { ok: false, message: expect.stringContaining("no visible advice") }],
			[response({ stopReason: "aborted", content: [], errorMessage: "cancelled" }), { ok: false, message: "cancelled" }],
			[response({ stopReason: "error", content: [], errorMessage: "provider failed" }), { ok: false, message: expect.stringContaining("provider failed") }],
		] as const;
		for (const [assistant, expected] of cases) {
			const runner = createAdvisorRunner({ complete: async () => assistant });
			expect(await runner.execute(runInput(context()))).toMatchObject(expected);
		}
	});

	it("reports projection and completion failures as simple failures", async () => {
		const malformed = context({ sessionManager: { buildContextEntries: () => [] } });
		const complete = vi.fn(async (_input: any) => response());
		expect(await createAdvisorRunner({ complete }).execute(runInput(malformed)))
			.toMatchObject({ ok: false, message: expect.stringContaining("not uniquely present") });
		expect(complete).not.toHaveBeenCalled();

		const failing = createAdvisorRunner({ complete: async () => { throw new Error("network down"); } });
		expect(await failing.execute(runInput(context()))).toMatchObject({ ok: false, message: "network down" });
	});

	it("uses the active registry's provider and resolved request authentication", async () => {
		const stream = { result: vi.fn(async () => response()) };
		const streamSimple = vi.fn((_model: any, _context: any, _options: any) => stream);
		const ctx = context();
		ctx.modelRegistry.getApiKeyAndHeaders.mockResolvedValue({
			ok: true,
			apiKey: "live-token",
			baseUrl: "https://live.example",
			headers: { authorization: "Bearer live", "X-Trace": "resolved" },
			env: { REGION: "test" },
		});
		ctx.modelRegistry.getProvider.mockReturnValue({ streamSimple });
		ctx.modelRegistry.find.mockReturnValue({
			...advisorModel,
			headers: { Authorization: "stale", "X-Model": "kept" },
		});

		const result = await createAdvisorRunner().execute(runInput(ctx));

		expect(result).toMatchObject({ ok: true });
		expect(streamSimple).toHaveBeenCalledOnce();
		const [requestModel, requestContext, options] = streamSimple.mock.calls[0];
		expect(requestModel.baseUrl).toBe("https://live.example");
		expect(requestContext.tools).toEqual([]);
		expect(requestContext.systemPrompt).toEqual(expect.any(String));
		expect(options).toMatchObject({
			apiKey: "live-token",
			headers: { authorization: "Bearer live", "X-Trace": "resolved", "X-Model": "kept" },
			env: { REGION: "test" },
			reasoning: "high",
			maxTokens: 2048,
		});
		expect(options.headers).not.toHaveProperty("Authorization");
	});

	it("clamps thinking and output to model capabilities", async () => {
		const limited = {
			...advisorModel,
			maxTokens: 512,
			thinkingLevelMap: { off: "none", minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: null },
		};
		const ctx = context();
		ctx.modelRegistry.find.mockReturnValue(limited);
		const complete = vi.fn(async (_input: any) => response());
		await createAdvisorRunner({ complete }).execute(runInput(ctx, {
			settings: { enabled: true, model: "anthropic/strong", thinkingLevel: "medium", maxTokens: 2048 },
		}));
		expect(complete.mock.calls[0][0]).toMatchObject({ thinkingLevel: "high", maxTokens: 512 });
	});
});
