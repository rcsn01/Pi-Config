import { describe, expect, it, vi } from "vitest";
import { createTelemetryUsageExtension } from "./index.ts";

function harness() {
	const commands = new Map<string, any>();
	const handlers = new Map<string, any>();
	const pi: any = {
		registerCommand: vi.fn((name: string, command: any) => commands.set(name, command)),
		on: vi.fn((name: string, handler: any) => handlers.set(name, handler)),
	};
	const ctx: any = { ui: { notify: vi.fn() } };
	return { pi, commands, handlers, ctx };
}

function fakeRuntime(url = "http://localhost:1/#token=secret") {
	return {
		start: vi.fn(async () => ({ url })),
		close: vi.fn(async () => {}),
	};
}

describe("telemetry usage extension adapter", () => {
	it("registers /global-usage without starting resources during extension load", async () => {
		const runtime = fakeRuntime();
		const h = harness();
		createTelemetryUsageExtension({ createRuntime: () => runtime })(h.pi);
		const command = h.commands.get("global-usage");
		expect(command.description).toBe("Start the local global usage dashboard");
		expect(runtime.start).not.toHaveBeenCalled();

		await command.handler("unexpected", h.ctx);
		expect(runtime.start).not.toHaveBeenCalled();
		expect(h.ctx.ui.notify).toHaveBeenLastCalledWith("Usage: /global-usage", "warning");

		await command.handler("", h.ctx);
		await command.handler("", h.ctx);
		expect(runtime.start).toHaveBeenCalledTimes(2);
		expect(h.ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("#token=secret"), "info");
		expect(h.ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("Treat this URL as a secret"), "info");
	});

	it("reports startup failures", async () => {
		const runtime = fakeRuntime();
		runtime.start.mockRejectedValueOnce(new Error("listen failed"));
		const h = harness();
		createTelemetryUsageExtension({ createRuntime: () => runtime })(h.pi);
		await h.commands.get("global-usage").handler("", h.ctx);
		expect(h.ctx.ui.notify).toHaveBeenCalledWith(
			"Could not start global usage dashboard: listen failed",
			"error",
		);
	});

	it("keeps an injected runtime across replacement shutdowns and closes it on quit", async () => {
		const runtime = fakeRuntime();
		const h = harness();
		createTelemetryUsageExtension({ createRuntime: () => runtime })(h.pi);
		await h.handlers.get("session_shutdown")({ reason: "reload" });
		await h.handlers.get("session_shutdown")({ reason: "new" });
		expect(runtime.close).not.toHaveBeenCalled();
		await h.handlers.get("session_shutdown")({ reason: "quit" });
		expect(runtime.close).toHaveBeenCalledOnce();
	});
});
