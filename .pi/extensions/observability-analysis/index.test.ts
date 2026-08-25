import { describe, expect, it, vi } from "vitest";
import { createAnalysisExtension } from "./index.ts";

function harness() {
	const commands = new Map<string, any>();
	const handlers = new Map<string, any>();
	const pi: any = {
		registerCommand: vi.fn((name: string, command: any) => commands.set(name, command)),
		on: vi.fn((name: string, handler: any) => handlers.set(name, handler)),
	};
	const ctx: any = {
		model: { provider: "openai", api: "openai-responses", id: "gpt-test" },
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
		await h.commands.get("analysis").handler("bad", h.ctx);
		expect(runtime.start).not.toHaveBeenCalled();
		expect(h.ctx.ui.notify).toHaveBeenCalledWith("Usage: /analysis", "warning");
		await h.commands.get("analysis").handler("", h.ctx);
		await h.commands.get("analysis").handler("", h.ctx);
		expect(runtime.start).toHaveBeenCalledTimes(2);
		expect(h.ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("#token=secret"), "info");
	});

	it("observes lifecycle events without replacing payloads or messages", async () => {
		const runtime: any = { start: vi.fn(), observe: vi.fn(), close: vi.fn(async () => {}) };
		const h = harness();
		createAnalysisExtension({ createRuntime: () => runtime })(h.pi);
		expect(h.handlers.get("before_provider_request")({ payload: { secret: true } }, h.ctx)).toBeUndefined();
		expect(h.handlers.get("message_end")({ message: { role: "assistant", content: [] } }, h.ctx)).toBeUndefined();
		h.handlers.get("agent_start")({}, h.ctx);
		h.handlers.get("turn_start")({ turnIndex: 3, timestamp: 99 }, h.ctx);
		h.handlers.get("after_provider_response")({ status: 201 }, h.ctx);
		expect(runtime.observe).toHaveBeenCalledWith(expect.objectContaining({ type: "request", payload: { secret: true } }));
		expect(runtime.observe).toHaveBeenCalledWith({ type: "assistant", message: { role: "assistant", content: [] } });
		await h.handlers.get("session_shutdown")({}, h.ctx);
		expect(runtime.close).toHaveBeenCalledOnce();
	});
});
