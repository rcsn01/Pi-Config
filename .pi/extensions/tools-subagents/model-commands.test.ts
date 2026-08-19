import { describe, expect, it, vi } from "vitest";
import { createSubagentsCommand } from "./model-commands.ts";
import { agent, memoryConfigStore, memoryRegistry } from "./test-harness.ts";

function context(options: { mode?: "tui" | "print"; available?: any[]; custom?: any } = {}) {
	return {
		mode: options.mode ?? "print",
		model: { provider: "anthropic", id: "main" },
		scopedModels: [],
		modelRegistry: {
			refresh: vi.fn(),
			getAvailable: vi.fn(() => options.available ?? []),
			find: vi.fn(),
		},
		ui: {
			notify: vi.fn(),
			custom: vi.fn(options.custom ?? (async () => undefined)),
		},
	} as any;
}

describe("subagents model command", () => {
	it("preserves completions and non-TUI status output", async () => {
		const config = memoryConfigStore({ maxConcurrency: 2, defaultModel: "main", defaultThinkingLevel: "minimal" });
		const command = createSubagentsCommand({ registry: memoryRegistry([agent()]), config });
		expect(command.getArgumentCompletions("model w")).toEqual([
			{ value: "model worker main", label: "model worker main" },
		]);
		expect(command.getArgumentCompletions("missing")).toBeNull();
		const ctx = context();
		await command.handler("", ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Subagents status:"), "info");
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Max concurrency: 2"), "info");
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("model: main → anthropic/main"), "info");
	});

	it("shows Pi defaults without leaking undefined values", async () => {
		const config = memoryConfigStore({
			defaultModel: "default",
			defaultThinkingLevel: "default",
			defaultContextWindow: "default",
			agentThinkingLevels: { worker: "default" },
			agentContextWindows: { worker: "default" },
		});
		const command = createSubagentsCommand({ registry: memoryRegistry([agent()]), config });
		const ctx = context();

		await command.handler("models", ctx);

		const message = ctx.ui.notify.mock.calls.at(-1)?.[0] as string;
		expect(message).toContain("Global thinking: Pi default");
		expect(message).toContain("Global context: Pi default");
		expect(message).not.toContain("undefined");
	});

	it("reports model assignments and applies model/thinking mutations", async () => {
		const config = memoryConfigStore({
			custom: true,
			defaultModel: "main",
			agentModels: { worker: "openai/old" },
			agentThinkingLevels: { worker: "low" },
		});
		const command = createSubagentsCommand({ registry: memoryRegistry(), config });
		const ctx = context();
		await command.handler("models", ctx);
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Individual model overrides:"), "info");

		await command.handler("model all main", ctx);
		expect(config.document).toMatchObject({ custom: true, defaultModel: "main", agentModels: {} });
		await command.handler("model worker inherit", ctx);
		expect(config.document).toMatchObject({ agentModels: {} });
		await command.handler("thinking all high", ctx);
		expect(config.document).toMatchObject({ defaultThinkingLevel: "high", agentThinkingLevels: {} });
		await command.handler("thinking worker inherit", ctx);
		expect(config.document).toMatchObject({ agentThinkingLevels: {} });
		expect(config.updates).toHaveLength(4);
	});

	it("does not mutate configuration for unknown agents or unavailable models", async () => {
		const config = memoryConfigStore({ defaultModel: "main" });
		const command = createSubagentsCommand({ registry: memoryRegistry(), config });
		const ctx = context();
		await command.handler("model missing main", ctx);
		await command.handler("model worker openai/unavailable", ctx);
		expect(config.updates).toHaveLength(0);
		expect(ctx.modelRegistry.refresh).toHaveBeenCalledWith({ allowNetwork: false });
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Unknown subagent: missing"), "error");
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Unavailable or unauthenticated model"), "error");
	});

	it("preserves usage errors, non-TUI rejection, and interactive cancellation", async () => {
		const config = memoryConfigStore({ defaultModel: "main" });
		const command = createSubagentsCommand({ registry: memoryRegistry(), config });
		const printCtx = context();
		await command.handler("bad input", printCtx);
		await command.handler("model", printCtx);
		expect(printCtx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Usage:"), "error");
		expect(printCtx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("requires TUI mode"), "error");

		const tuiCtx = context({ mode: "tui" });
		await command.handler("", tuiCtx);
		expect(tuiCtx.ui.custom).toHaveBeenCalledOnce();
		expect(config.updates).toHaveLength(0);
	});
});
