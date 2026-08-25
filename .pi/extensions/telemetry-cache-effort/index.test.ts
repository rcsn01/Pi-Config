import { describe, expect, it, vi } from "vitest";
import { createCacheEffortExtension } from "./index.ts";

const config: any = {
	provider: "openai-codex",
	modelId: "gpt-test",
	modelName: "GPT Test",
	api: "openai-codex-responses",
	effortA: "medium",
	effortB: "max",
	runSize: "quick",
};

function harness(confirm = false) {
	const commands = new Map<string, any>();
	const pi: any = {
		registerCommand: vi.fn((name: string, command: any) => commands.set(name, command)),
		registerEntryRenderer: vi.fn(),
		appendEntry: vi.fn(),
		registerTool: vi.fn(),
		on: vi.fn(),
	};
	const ctx: any = {
		mode: "tui",
		hasUI: true,
		ui: {
			notify: vi.fn(),
			confirm: vi.fn(async () => confirm),
			setStatus: vi.fn(),
		},
		waitForIdle: vi.fn(),
	};
	return { pi, commands, ctx };
}

describe("cache effort extension activation boundary", () => {
	it("registers only a command and passive entry renderer at startup", () => {
		const h = harness();
		createCacheEffortExtension()(h.pi);
		expect(h.pi.registerCommand).toHaveBeenCalledOnce();
		expect(h.pi.registerEntryRenderer).toHaveBeenCalledOnce();
		expect(h.pi.registerTool).not.toHaveBeenCalled();
		expect(h.pi.on).not.toHaveBeenCalled();
		expect(h.pi.appendEntry).not.toHaveBeenCalled();
	});

	it("does not start a run until the user confirms the displayed call count", async () => {
		const h = harness(false);
		const run = vi.fn();
		createCacheEffortExtension({ selectConfig: async () => config, run })(h.pi);
		await h.commands.get("cache-effort-test").handler("", h.ctx);
		expect(h.ctx.ui.confirm).toHaveBeenCalledWith(
			"Run prompt-cache effort test?",
			expect.stringContaining("8 sequential provider calls"),
		);
		expect(run).not.toHaveBeenCalled();
		expect(h.pi.appendEntry).not.toHaveBeenCalled();
	});

	it("rejects arguments and non-TUI invocation before selection", async () => {
		const h = harness();
		const choose = vi.fn(async () => config);
		createCacheEffortExtension({ selectConfig: choose })(h.pi);
		await h.commands.get("cache-effort-test").handler("unexpected", h.ctx);
		expect(choose).not.toHaveBeenCalled();
		expect(h.ctx.ui.notify).toHaveBeenCalledWith("Usage: /cache-effort-test", "warning");
	});
});
