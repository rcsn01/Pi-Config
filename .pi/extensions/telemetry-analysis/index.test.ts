import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetObservabilityServiceForTests } from "../_shared/observability.ts";
import { createAnalysisExtension } from "./index.ts";

beforeEach(() => resetObservabilityServiceForTests());

function harness() {
	const commands = new Map<string, any>();
	const handlers = new Map<string, any>();
	const pi: any = {
		registerCommand: vi.fn((name: string, command: any) => commands.set(name, command)),
		on: vi.fn((name: string, handler: any) => handlers.set(name, handler)),
	};
	const ctx: any = {
		model: { provider: "openrouter", api: "openai-completions", id: "test-model" },
		ui: { notify: vi.fn() },
	};
	return { pi, commands, handlers, ctx };
}

describe("analysis extension adapter", () => {
	it("loads without starting capture, starts idempotently, and rejects arguments", async () => {
		const runtime: any = { start: vi.fn(async () => ({ url: "http://localhost:1/#token=secret" })), observe: vi.fn(), close: vi.fn() };
		const h = harness();
		createAnalysisExtension({ createRuntime: () => runtime })(h.pi);
		expect(runtime.start).not.toHaveBeenCalled();
		expect(runtime.observe).not.toHaveBeenCalled();
		expect(h.commands.get("analysis").description).not.toContain("OpenAI");
		await h.commands.get("analysis").handler("bad", h.ctx);
		expect(runtime.start).not.toHaveBeenCalled();
		expect(h.ctx.ui.notify).toHaveBeenCalledWith("Usage: /analysis", "warning");
		await h.commands.get("analysis").handler("", h.ctx);
		await h.commands.get("analysis").handler("", h.ctx);
		expect(runtime.start).toHaveBeenCalledTimes(2);
		expect(h.ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("#token=secret"), "info");
		expect(h.ctx.ui.notify.mock.calls.flat().join(" ")).not.toContain("OpenAI request analysis");
	});

	it("captures compaction preparation and attaches the saved summary and usage", async () => {
		const runtime: any = { start: vi.fn(async () => ({ url: "http://localhost/#token=test" })), observe: vi.fn(), close: vi.fn(async () => {}) };
		const h = harness();
		createAnalysisExtension({ createRuntime: () => runtime })(h.pi);
		await h.commands.get("analysis").handler("", h.ctx);
		const preparation = {
			firstKeptEntryId: "kept", messagesToSummarize: [{ role: "user", content: "old" }],
			turnPrefixMessages: [{ role: "assistant", content: "prefix" }], isSplitTurn: true, tokensBefore: 123,
			previousSummary: "previous", fileOps: { readFiles: ["a.ts"], modifiedFiles: [] }, settings: { keepRecentTokens: 20 },
		};
		h.handlers.get("session_before_compact")({ preparation, customInstructions: "focus", reason: "manual", willRetry: false }, h.ctx);
		const request = runtime.observe.mock.calls.map(([event]: any[]) => event).find((event: any) => event.type === "request");
		expect(request).toMatchObject({ source: { channel: "compaction", displayLabel: "Compaction" }, api: "pi-compaction", fidelity: "pi-preparation" });
		expect(request.payload).toMatchObject({ instructions: "focus", previousSummary: "previous", messagesToSummarize: preparation.messagesToSummarize, turnPrefixMessages: preparation.turnPrefixMessages });
		const usage = { input: 2, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
		h.handlers.get("session_compact")({ compactionEntry: { summary: "saved summary", usage, tokensBefore: 123, firstKeptEntryId: "kept" }, reason: "manual", willRetry: false, fromExtension: false }, h.ctx);
		const completion = runtime.observe.mock.calls.map(([event]: any[]) => event).find((event: any) => event.type === "assistant");
		expect(completion.source.invocationId).toBe(request.source.invocationId);
		expect(completion.message).toMatchObject({ summary: "saved summary", usage });
	});

	it("observes lifecycle events without replacing payloads or messages", async () => {
		const runtime: any = { start: vi.fn(async () => ({ url: "http://localhost/#token=test" })), observe: vi.fn(), close: vi.fn(async () => {}) };
		const h = harness();
		createAnalysisExtension({ createRuntime: () => runtime })(h.pi);
		await h.commands.get("analysis").handler("", h.ctx);
		expect(h.handlers.get("before_provider_request")({ payload: { secret: true } }, h.ctx)).toBeUndefined();
		expect(h.handlers.get("message_end")({ message: { role: "assistant", content: [] } }, h.ctx)).toBeUndefined();
		h.handlers.get("agent_start")({}, h.ctx);
		h.handlers.get("turn_start")({ turnIndex: 3, timestamp: 99 }, h.ctx);
		h.handlers.get("after_provider_response")({ status: 201 }, h.ctx);
		expect(runtime.observe).toHaveBeenCalledWith(expect.objectContaining({ type: "request", payload: { secret: true } }));
		expect(runtime.observe).toHaveBeenCalledWith(expect.objectContaining({ type: "assistant", message: { role: "assistant", content: [] }, source: expect.objectContaining({ channel: "main" }) }));
		await h.handlers.get("session_shutdown")({}, h.ctx);
		expect(runtime.close).toHaveBeenCalledOnce();
	});
});
