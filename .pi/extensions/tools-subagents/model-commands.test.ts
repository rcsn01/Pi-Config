import { describe, expect, it, vi } from "vitest";
import { createSubagentsCommand } from "./model-commands.ts";
import { agent, memoryConfigStore, memoryRegistry } from "./test-harness.ts";

const gpt = {
	provider: "openai",
	id: "gpt-5.2",
	name: "GPT 5.2",
	api: "openai-completions",
	baseUrl: "https://example.invalid",
	reasoning: true,
	input: ["text"],
	contextWindow: 400_000,
	maxTokens: 4096,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

const qwen = {
	provider: "ollama",
	id: "qwen3.8:27b",
	name: "Qwen 3.8",
	api: "openai-completions",
	baseUrl: "https://example.invalid",
	reasoning: true,
	input: ["text"],
	contextWindow: 512_000,
	maxTokens: 4096,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

interface ContextOptions {
	mode?: "tui" | "print";
	available?: any[];
	authenticated?: string[];
	custom?: any;
	refreshError?: Error;
	refreshErrors?: Map<string, Error>;
	signal?: AbortSignal;
}

function context(options: ContextOptions = {}) {
	const models = options.available ?? [];
	const authenticated = new Set(options.authenticated ?? models.map((model) => `${model.provider}/${model.id}`));
	return {
		mode: options.mode ?? "print",
		model: { provider: "anthropic", id: "main" },
		signal: options.signal,
		scopedModels: [],
		modelRegistry: {
			refresh: vi.fn(async () => {
				if (options.refreshError) throw options.refreshError;
				return { aborted: false, errors: options.refreshErrors ?? new Map() };
			}),
			getAvailable: vi.fn(() => models),
			find: vi.fn((provider: string, id: string) =>
				models.find((model) => model.provider === provider && model.id === id)),
			hasConfiguredAuth: vi.fn((model: any) => authenticated.has(`${model.provider}/${model.id}`)),
		},
		ui: {
			notify: vi.fn(),
			custom: vi.fn(options.custom ?? (async () => undefined)),
		},
	} as any;
}

/** Capture the rendered lines of every select screen while driving scripted selections. */
function screenCustom(selections: Array<string | undefined>) {
	const queue = [...selections];
	const screens: string[] = [];
	const custom = vi.fn(async (builder: any) => {
		const component = builder(
			{ requestRender: vi.fn() },
			{ fg: (_color: string, text: string) => text, bold: (text: string) => text },
			{ getKeys: () => [] as any[], matches: () => false },
			(_value: any) => {},
		);
		screens.push(component.render(400).join("\n"));
		return queue.shift();
	});
	return { custom, screens };
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

	it("applies the three-step shared TUI selector flow", async () => {
		const config = memoryConfigStore({ defaultModel: "main", defaultThinkingLevel: "minimal" });
		const command = createSubagentsCommand({ registry: memoryRegistry([agent()]), config });
		const { custom, screens } = screenCustom(["all", "openai/gpt-5.2", "high", undefined]);
		const ctx = context({ mode: "tui", available: [gpt], custom });
		await command.handler("", ctx);
		expect(ctx.ui.custom).toHaveBeenCalledTimes(4);
		expect(screens[1]).toContain("Main session model");
		expect(screens[1]).toContain("openai/gpt-5.2");
		expect(config.document).toMatchObject({ defaultModel: "openai/gpt-5.2", defaultThinkingLevel: "high" });
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("All subagents now use openai/gpt-5.2 with high thinking"),
			"info",
		);
	});

	it("returns from thinking cancellation to model selection", async () => {
		const config = memoryConfigStore({ defaultModel: "main", defaultThinkingLevel: "minimal" });
		const command = createSubagentsCommand({ registry: memoryRegistry([agent()]), config });
		const { custom } = screenCustom(["all", "main", undefined, "main", "high", undefined]);
		const ctx = context({ mode: "tui", custom });
		await command.handler("", ctx);
		expect(ctx.ui.custom).toHaveBeenCalledTimes(6);
		expect(config.document).toMatchObject({ defaultModel: "main", defaultThinkingLevel: "high" });
	});

	it("offers only authenticated models in the interactive picker", async () => {
		const config = memoryConfigStore({ defaultModel: "main" });
		const command = createSubagentsCommand({ registry: memoryRegistry([agent()]), config });
		const { custom, screens } = screenCustom(["worker", undefined, undefined]);
		const ctx = context({
			mode: "tui",
			available: [gpt, qwen],
			authenticated: ["openai/gpt-5.2"],
			custom,
		});

		await command.handler("", ctx);

		// Both models come back from the registry; only the authenticated one is offered.
		expect(ctx.modelRegistry.getAvailable()).toHaveLength(2);
		const modelScreen = screens[1]!;
		expect(modelScreen).toContain("openai/gpt-5.2");
		expect(modelScreen).not.toContain("ollama/qwen3.8:27b");
		expect(config.updates).toHaveLength(0);
	});

	it("rejects direct assignment of an unauthenticated model before persistence", async () => {
		const config = memoryConfigStore({ defaultModel: "main" });
		const command = createSubagentsCommand({ registry: memoryRegistry(), config });
		const ctx = context({
			available: [gpt, qwen],
			authenticated: ["openai/gpt-5.2"],
		});

		await command.handler("model all ollama/qwen3.8:27b", ctx);

		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("Unavailable or unauthenticated model: ollama/qwen3.8:27b"),
			"error",
		);
		expect(config.updates).toHaveLength(0);
	});

	it("notifies and returns when the catalogue refresh fails", async () => {
		const config = memoryConfigStore({ defaultModel: "main" });
		const command = createSubagentsCommand({ registry: memoryRegistry([agent()]), config });

		const thrown = context({
			mode: "tui",
			available: [gpt],
			refreshError: new Error("registry offline"),
			custom: vi.fn(async () => "all"),
		});
		await command.handler("", thrown);
		expect(thrown.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("Could not refresh Pi's model catalogue: registry offline"),
			"error",
		);
		expect(thrown.ui.custom).not.toHaveBeenCalled();

		const providerErrors = context({
			mode: "tui",
			available: [gpt],
			refreshErrors: new Map([["openai", new Error("auth rejected")]]),
			custom: vi.fn(async () => "all"),
		});
		await command.handler("", providerErrors);
		expect(providerErrors.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("Could not refresh Pi's model catalogue: openai: auth rejected"),
			"error",
		);
		expect(providerErrors.ui.custom).not.toHaveBeenCalled();

		const direct = context({
			available: [gpt],
			refreshError: new Error("registry offline"),
		});
		await command.handler("model all openai/gpt-5.2", direct);
		expect(direct.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("Could not refresh Pi's model catalogue: registry offline"),
			"error",
		);
		expect(config.updates).toHaveLength(0);
	});

	it("exits quietly when the refresh is aborted", async () => {
		const config = memoryConfigStore({ defaultModel: "main" });
		const command = createSubagentsCommand({ registry: memoryRegistry([agent()]), config });
		const controller = new AbortController();
		controller.abort();
		const signal = controller.signal;

		const interactive = context({
			mode: "tui",
			available: [gpt],
			signal,
			custom: vi.fn(async () => "all"),
		});
		await command.handler("", interactive);
		expect(interactive.ui.notify).not.toHaveBeenCalled();
		expect(interactive.ui.custom).not.toHaveBeenCalled();

		const direct = context({ available: [gpt], signal });
		await command.handler("model all openai/gpt-5.2", direct);
		expect(direct.ui.notify).not.toHaveBeenCalled();
		expect(config.updates).toHaveLength(0);
	});

	it("does not mutate configuration for unknown agents or unavailable models", async () => {
		const config = memoryConfigStore({ defaultModel: "main" });
		const command = createSubagentsCommand({ registry: memoryRegistry(), config });
		const ctx = context();
		await command.handler("model missing main", ctx);
		await command.handler("model worker openai/unavailable", ctx);
		expect(config.updates).toHaveLength(0);
		expect(ctx.modelRegistry.refresh).toHaveBeenCalledWith(
			expect.objectContaining({ allowNetwork: false }),
		);
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