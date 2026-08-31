import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import advisorExtension, {
	createAdvisorExtension,
	formatAdvisorStatus,
	loadAdvisorSettings,
	parseAdvisorSettings,
} from "./index.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const model: any = {
	provider: "anthropic", id: "strong", name: "Strong", api: "anthropic-messages",
	baseUrl: "https://example.invalid", reasoning: true, input: ["text"], contextWindow: 100_000,
	maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

function settingsFile(value: unknown): string {
	const root = mkdtempSync(join(tmpdir(), "advisor-index-"));
	roots.push(root);
	const path = join(root, "settings.json");
	writeFileSync(path, JSON.stringify(value));
	return path;
}

function makePi(options: {
	settingsPath: string;
	activeTools?: string[];
	model?: any;
	availableModel?: any;
	branchEntries?: any[];
	customResults?: Array<string | undefined>;
}): any {
	const handlers = new Map<string, any>();
	const commands = new Map<string, any>();
	const tools = new Map<string, any>();
	let activeTools = [...(options.activeTools ?? ["read"])] as string[];
	const allTools: any[] = [{ name: "read", description: "Read files", parameters: {}, sourceInfo: {} }];
	const customResults = [...(options.customResults ?? [])];
	const pi: any = {
		on: vi.fn((event: string, handler: any) => handlers.set(event, handler)),
		registerCommand: vi.fn((name: string, command: any) => commands.set(name, command)),
		registerTool: vi.fn((tool: any) => { tools.set(tool.name, tool); allTools.push(tool); }),
		getActiveTools: vi.fn(() => [...activeTools]),
		setActiveTools: vi.fn((names: string[]) => { activeTools = [...names]; }),
		getAllTools: vi.fn(() => [...allTools]),
	};
	const entries = options.branchEntries ?? [];
	const ctx: any = {
		cwd: "/workspace",
		mode: "tui",
		hasUI: true,
		model: options.model ?? { provider: "anthropic", id: "executor", contextWindow: 100_000 },
		scopedModels: [],
		signal: undefined,
		ui: {
			notify: vi.fn(),
			select: vi.fn(async (_title: string, choices: string[]) => choices[0]),
			custom: vi.fn(async () => customResults.shift()),
			setStatus: vi.fn(),
		},
		sessionManager: { getBranch: () => entries, buildContextEntries: () => entries },
		getSystemPrompt: () => "Executor prompt",
		modelRegistry: {
			refresh: vi.fn(async () => ({ aborted: false, errors: new Map() })),
			getAvailable: vi.fn(() => [options.availableModel ?? model]),
			find: vi.fn(() => options.availableModel ?? model),
			hasConfiguredAuth: vi.fn(() => true),
			getRegisteredNativeProvider: vi.fn(),
			getRegisteredProviderConfig: vi.fn(),
		},
	};
	return { pi, handlers, commands, tools, ctx, getActiveTools: () => activeTools };
}

describe("advisor settings", () => {
	it("has a small default configuration", () => {
		expect(parseAdvisorSettings({})).toEqual({ enabled: false, maxTokens: 2048 });
		expect(parseAdvisorSettings({ advisor: { model: "anthropic/strong" } })).toEqual({
			enabled: true, model: "anthropic/strong", maxTokens: 2048,
		});
	});

	it("reads the old provider/modelId shape but ignores removed tuning fields", () => {
		expect(parseAdvisorSettings({ advisor: {
			provider: "anthropic", modelId: "strong", strict: true, maxUses: 10, contextWindow: 50_000,
		} })).toEqual({ enabled: true, model: "anthropic/strong", maxTokens: 2048 });
	});

	it("rejects malformed retained fields", () => {
		expect(() => parseAdvisorSettings({ advisor: [] })).toThrow(/JSON object/);
		expect(() => parseAdvisorSettings({ advisor: { model: "" } })).toThrow(/model/);
		expect(() => parseAdvisorSettings({ advisor: { enabled: "yes" } })).toThrow(/enabled/);
		expect(() => parseAdvisorSettings({ advisor: { thinkingLevel: "turbo" } })).toThrow(/thinkingLevel/);
		expect(() => parseAdvisorSettings({ advisor: { maxTokens: 0 } })).toThrow(/maxTokens/);
	});
});

describe("advisor extension", () => {
	it("registers and activates the tool only when enabled with a model", async () => {
		const configuredPath = settingsFile({ advisor: { enabled: true, model: "anthropic/strong" } });
		const configured = makePi({ settingsPath: configuredPath });
		createAdvisorExtension({ settingsPath: configuredPath })(configured.pi);
		expect(advisorExtension).toEqual(expect.any(Function));
		expect(configured.tools.get("advisor")).toMatchObject({ name: "advisor", executionMode: "sequential" });
		await configured.handlers.get("session_start")({ reason: "startup" }, configured.ctx);
		expect(configured.getActiveTools()).toContain("advisor");
		expect(configured.ctx.ui.setStatus).toHaveBeenCalledWith("advisor", "advisor(a/strong)");

		const disabledPath = settingsFile({ advisor: { enabled: false, model: "anthropic/strong" } });
		const disabled = makePi({ settingsPath: disabledPath, activeTools: ["read", "advisor"] });
		createAdvisorExtension({ settingsPath: disabledPath })(disabled.pi);
		await disabled.handlers.get("session_start")({ reason: "startup" }, disabled.ctx);
		expect(disabled.getActiveTools()).not.toContain("advisor");
	});

	it("uses the session profile settings", async () => {
		const root = mkdtempSync(join(tmpdir(), "advisor-profile-"));
		roots.push(root);
		const settingsPath = join(root, "settings.json");
		mkdirSync(join(root, "profiles"));
		writeFileSync(settingsPath, JSON.stringify({ configProfiles: { active: "focused" } }));
		writeFileSync(join(root, "profiles", "focused.json"), JSON.stringify({ advisor: { model: "anthropic/strong", enabled: true } }));
		const harness = makePi({ settingsPath });
		createAdvisorExtension({ settingsPath })(harness.pi);
		await harness.handlers.get("session_start")({ reason: "startup" }, harness.ctx);
		expect(harness.getActiveTools()).toContain("advisor");
	});

	it("picks only model and thinking, then writes the compact settings shape", async () => {
		const path = settingsFile({ other: { keep: true }, advisor: { strict: true, contextBudget: {}, maxUses: 3 } });
		const harness = makePi({ settingsPath: path, customResults: ["anthropic/strong"] });
		createAdvisorExtension({ settingsPath: path })(harness.pi);
		await harness.commands.get("advisor").handler("", harness.ctx);
		const saved = JSON.parse(readFileSync(path, "utf8"));
		expect(saved.other).toEqual({ keep: true });
		expect(saved.advisor).toEqual({ enabled: true, model: "anthropic/strong", thinkingLevel: "medium", maxTokens: 2048 });
		expect(harness.ctx.ui.custom).toHaveBeenCalledOnce();
		expect(harness.ctx.ui.select).toHaveBeenCalledOnce();
	});

	it("turns an existing selection on and off without opening the picker", async () => {
		const path = settingsFile({ advisor: { enabled: false, model: "anthropic/strong", thinkingLevel: "high", maxTokens: 1000 } });
		const harness = makePi({ settingsPath: path, activeTools: ["read"] });
		createAdvisorExtension({ settingsPath: path })(harness.pi);
		await harness.commands.get("advisor").handler("on", harness.ctx);
		expect(loadAdvisorSettings(path)).toEqual({ enabled: true, model: "anthropic/strong", thinkingLevel: "high", maxTokens: 1000 });
		expect(harness.getActiveTools()).toContain("advisor");
		expect(harness.ctx.ui.custom).not.toHaveBeenCalled();

		await harness.commands.get("advisor").handler("off", harness.ctx);
		expect(loadAdvisorSettings(path).enabled).toBe(false);
		expect(harness.getActiveTools()).not.toContain("advisor");
	});

	it("keeps the off command usable when old settings are malformed", async () => {
		const path = settingsFile({ other: { keep: true }, advisor: { provider: "anthropic", modelId: "strong", thinkingLevel: "turbo" } });
		const harness = makePi({ settingsPath: path, activeTools: ["advisor"] });
		createAdvisorExtension({ settingsPath: path })(harness.pi);
		await harness.commands.get("advisor").handler("off", harness.ctx);
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
			other: { keep: true },
			advisor: { enabled: false, model: "anthropic/strong", maxTokens: 2048 },
		});
		expect(harness.getActiveTools()).not.toContain("advisor");
	});

	it("supports only the simplified command forms", async () => {
		const path = settingsFile({});
		const harness = makePi({ settingsPath: path });
		createAdvisorExtension({ settingsPath: path })(harness.pi);
		expect(harness.commands.get("advisor").getArgumentCompletions("")).toEqual([
			{ value: "on", label: "on" }, { value: "off", label: "off" },
		]);
		await harness.commands.get("advisor").handler("strict", harness.ctx);
		expect(harness.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Accepted forms"), "error");
		expect(harness.handlers.has("turn_end")).toBe(false);
	});

	it("renders simple success, warning, and failure results", async () => {
		const path = settingsFile({ advisor: { model: "anthropic/strong" } });
		for (const result of [
			{ ok: true, text: "Advice", model: "anthropic/strong", truncated: false },
			{ ok: true, text: "Partial", model: "anthropic/strong", truncated: true },
			{ ok: false, message: "Unavailable", model: "anthropic/strong" },
		]) {
			const harness = makePi({ settingsPath: path });
			createAdvisorExtension({ settingsPath: path, runner: { execute: vi.fn(async () => result as any) } })(harness.pi);
			const tool = harness.tools.get("advisor");
			const toolResult = await tool.execute("call", {}, undefined, undefined, harness.ctx);
			expect(Boolean(toolResult.isError)).toBe(!result.ok);
			const rendered = tool.renderResult(toolResult, { expanded: false, isPartial: false }, { fg: (_color: string, text: string) => text } as any, { isError: Boolean(toolResult.isError) } as any);
			expect(rendered.render(80).join("\n")).toContain(result.ok ? (result.truncated ? "Advice may be incomplete" : "Advice available") : "Unavailable");
		}
	});
});

describe("advisor runtime integration", () => {
	it("makes a no-tools request with current-turn evidence", async () => {
		const root = mkdtempSync(join(tmpdir(), "advisor-runtime-"));
		roots.push(root);
		const path = join(root, "settings.json");
		writeFileSync(path, JSON.stringify({ advisor: { enabled: true, model: "contract/advisor", maxTokens: 256 } }));
		const faux = fauxProvider({
			provider: "contract",
			models: [{ id: "executor", contextWindow: 100_000 }, { id: "advisor", contextWindow: 100_000 }],
			tokensPerSecond: 100_000,
		});
		let captured: any;
		faux.setResponses([
			fauxAssistantMessage([fauxText("Prose before consultation."), fauxToolCall("advisor", { question: "review" }, { id: "advisor-call" })], { stopReason: "toolUse" }),
			(context) => { captured = context; return fauxAssistantMessage("Advice from isolated session"); },
			fauxAssistantMessage("Executor continued."),
		]);
		const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
		runtime.registerNativeProvider(faux.provider);
		const settings = SettingsManager.inMemory({ compaction: { enabled: false } });
		const loader = new DefaultResourceLoader({
			cwd: root, agentDir: root, settingsManager: settings,
			systemPromptOverride: () => "Executor system prompt",
			extensionFactories: [createAdvisorExtension({ settingsPath: path })],
		});
		await loader.reload();
		const { session } = await createAgentSession({
			cwd: root, agentDir: root, modelRuntime: runtime, model: faux.getModel("executor"),
			resourceLoader: loader, sessionManager: SessionManager.inMemory(root), settingsManager: settings,
			tools: ["advisor"],
		});
		try {
			await session.bindExtensions({});
			await session.prompt("Start the task");
			const serialized = JSON.stringify(captured?.messages ?? []);
			expect(serialized).toContain("Executor system prompt");
			expect(serialized).toContain("Prose before consultation.");
			expect(serialized).not.toContain("advisor-call");
			expect(captured?.tools).toEqual([]);
		} finally {
			session.dispose();
		}
	});
});
