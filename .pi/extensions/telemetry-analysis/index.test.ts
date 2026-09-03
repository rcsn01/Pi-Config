import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getObservabilityService, resetObservabilityServiceForTests } from "../_shared/observability.ts";
import { createAnalysisExtension } from "./index.ts";
import { getPersistentAnalysisRuntime, persistentAnalysisRuntime } from "./runtime.ts";

beforeEach(() => resetObservabilityServiceForTests());

afterEach(async () => persistentAnalysisRuntime.resetForTests());

function fakeRuntime(url = "http://localhost:1/#token=secret") {
	let active = false;
	return {
		start: vi.fn(async () => {
			active = true;
			return { url };
		}),
		observe: vi.fn(),
		close: vi.fn(async () => {
			active = false;
		}),
		isActive: vi.fn(() => active),
		setNotify: vi.fn(),
	};
}

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
		const runtime = fakeRuntime();
		const h = harness();
		const openUrl = vi.fn();
		createAnalysisExtension({ createRuntime: () => runtime, openUrl })(h.pi);
		expect(runtime.start).not.toHaveBeenCalled();
		expect(runtime.observe).not.toHaveBeenCalled();
		expect(h.commands.get("analysis").description).not.toContain("OpenAI");
		await h.commands.get("analysis").handler("bad", h.ctx);
		expect(runtime.start).not.toHaveBeenCalled();
		expect(openUrl).not.toHaveBeenCalled();
		expect(h.ctx.ui.notify).toHaveBeenCalledWith("Usage: /analysis", "warning");
		await h.commands.get("analysis").handler("", h.ctx);
		await h.commands.get("analysis").handler("", h.ctx);
		expect(runtime.start).toHaveBeenCalledTimes(2);
		expect(openUrl).toHaveBeenCalledTimes(2);
		expect(openUrl).toHaveBeenLastCalledWith("http://localhost:1/#token=secret");
		expect(h.ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("#token=secret"), "info");
		expect(h.ctx.ui.notify.mock.calls.flat().join(" ")).not.toContain("OpenAI request analysis");
	});

	it("routes an observation to the runtime after analysis starts", async () => {
		const runtime = fakeRuntime("http://localhost/#token=test");
		const h = harness();
		createAnalysisExtension({ createRuntime: () => runtime, openUrl: vi.fn() })(h.pi);
		await h.commands.get("analysis").handler("", h.ctx);

		h.handlers.get("before_provider_request")({ payload: { secret: true } }, h.ctx);

		expect(runtime.observe).toHaveBeenCalledWith(expect.objectContaining({
			type: "request",
			payload: { secret: true },
			source: expect.objectContaining({ channel: "main" }),
		}));
	});

	it("rebinds the persistent runtime across reload and session replacement", async () => {
		const runtime = getPersistentAnalysisRuntime();
		const first = harness();
		createAnalysisExtension({ openUrl: vi.fn() })(first.pi);
		await first.commands.get("analysis").handler("", first.ctx);
		expect(runtime.isActive()).toBe(true);

		await first.handlers.get("session_shutdown")({ reason: "reload" }, first.ctx);
		const reloaded = harness();
		createAnalysisExtension({ openUrl: vi.fn() })(reloaded.pi);
		await reloaded.handlers.get("session_start")({ reason: "reload" }, reloaded.ctx);
		expect(getPersistentAnalysisRuntime()).toBe(runtime);
		expect(getObservabilityService().isActive()).toBe(true);

		await reloaded.handlers.get("session_shutdown")({ reason: "new" }, reloaded.ctx);
		const cleared = harness();
		createAnalysisExtension({ openUrl: vi.fn() })(cleared.pi);
		await cleared.handlers.get("session_start")({ reason: "new" }, cleared.ctx);
		expect(runtime.isActive()).toBe(true);
		expect(getObservabilityService().isActive()).toBe(true);

		await cleared.handlers.get("session_shutdown")({ reason: "quit" }, cleared.ctx);
		expect(runtime.isActive()).toBe(false);
	});

	it("keeps the active runtime across reload and session replacement, then closes on quit", async () => {
		const runtime = fakeRuntime();
		const observability = getObservabilityService();
		const first = harness();
		createAnalysisExtension({ createRuntime: () => runtime, openUrl: vi.fn() })(first.pi);
		await first.commands.get("analysis").handler("", first.ctx);
		expect(observability.isActive()).toBe(true);

		await first.handlers.get("session_shutdown")({ reason: "reload" }, first.ctx);
		expect(runtime.close).not.toHaveBeenCalled();
		expect(observability.isActive()).toBe(false);

		const reloaded = harness();
		createAnalysisExtension({ createRuntime: () => runtime, openUrl: vi.fn() })(reloaded.pi);
		await reloaded.handlers.get("session_start")({ reason: "reload" }, reloaded.ctx);
		expect(observability.isActive()).toBe(true);

		await reloaded.handlers.get("session_shutdown")({ reason: "new" }, reloaded.ctx);
		expect(runtime.close).not.toHaveBeenCalled();
		expect(observability.isActive()).toBe(false);

		const cleared = harness();
		createAnalysisExtension({ createRuntime: () => runtime, openUrl: vi.fn() })(cleared.pi);
		await cleared.handlers.get("session_start")({ reason: "new" }, cleared.ctx);
		expect(observability.isActive()).toBe(true);

		await cleared.handlers.get("session_shutdown")({ reason: "quit" }, cleared.ctx);
		expect(runtime.close).toHaveBeenCalledOnce();
		expect(observability.isActive()).toBe(false);
	});
});
