import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxToolCall,
	InMemoryCredentialStore,
} from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import advisorExtension, {
	createAdvisorExtension,
	loadAdvisorSettings,
	parseAdvisorSettings,
} from "./index.ts";
import { createAdvisorRunner } from "./runner.ts";
import { DEFAULT_CONTEXT_BUDGET } from "./transcript.ts";

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
	confirm?: boolean;
	availableModel?: any;
	branchEntries?: any[];
}): any {
	const handlers = new Map<string, any>();
	const commands = new Map<string, any>();
	const tools = new Map<string, any>();
	let activeTools = [...(options.activeTools ?? ["read"])] as string[];
	const allTools: any[] = [{
		name: "read", label: "Read", description: "Read files", parameters: { type: "object" },
		sourceInfo: { source: "builtin", path: "<builtin:read>", scope: "temporary", origin: "top-level" },
	}];
	const pi: any = {
		on: vi.fn((event: string, handler: any) => handlers.set(event, handler)),
		registerCommand: vi.fn((name: string, command: any) => commands.set(name, command)),
		registerTool: vi.fn((tool: any) => { tools.set(tool.name, tool); allTools.push(tool); }),
		getActiveTools: vi.fn(() => [...activeTools]),
		setActiveTools: vi.fn((names: string[]) => { activeTools = [...names]; }),
		getAllTools: vi.fn(() => [...allTools]),
	};
	const entries: any[] = options.branchEntries ?? [];
	const ctx: any = {
		cwd: "/workspace",
		mode: "tui",
		hasUI: true,
		model: options.model ?? { provider: "anthropic", id: "executor" },
		scopedModels: [],
		signal: undefined,
		ui: {
			notify: vi.fn(),
			confirm: vi.fn(async () => options.confirm ?? true),
			select: vi.fn(),
			custom: vi.fn(),
			setStatus: vi.fn(),
		},
		sessionManager: {
			getBranch: () => entries,
			buildContextEntries: () => entries,
			getSessionId: () => "main-session",
		},
		getSystemPrompt: () => "Executor prompt",
		modelRegistry: {
			refresh: vi.fn(async () => ({ aborted: false, errors: new Map() })),
			getAvailable: vi.fn(() => [options.availableModel ?? model]),
			find: vi.fn(() => options.availableModel ?? model),
			hasConfiguredAuth: vi.fn(() => true),
			complete: vi.fn(async () => fauxAssistantMessage("Advice")),
		},
	};
	return { pi, handlers, commands, tools, ctx, getActiveTools: () => activeTools };
}

describe("advisor settings", () => {
	it("defaults missing advisor settings to disabled with the v1 budget", () => {
		expect(parseAdvisorSettings({ compaction: {} })).toEqual({
			strict: false, nudgeTurn: 3, maxUses: 3, maxUsesPerSession: 20, maxTokens: 2048, allowCrossProvider: false, contextBudget: DEFAULT_CONTEXT_BUDGET,
		});
		expect(parseAdvisorSettings({ advisor: { provider: "anthropic", modelId: "strong" } })).toEqual({
			provider: "anthropic", modelId: "strong", strict: false, nudgeTurn: 3, maxUses: 3, maxUsesPerSession: 20, maxTokens: 2048, allowCrossProvider: false,
			contextBudget: DEFAULT_CONTEXT_BUDGET,
		});
	});

	it("merges a partial context budget over the defaults", () => {
		expect(parseAdvisorSettings({ advisor: { contextBudget: { thinking: "none", recentMessages: 0 } } }).contextBudget)
			.toEqual({ ...DEFAULT_CONTEXT_BUDGET, thinking: "none", recentMessages: 0 });
	});

	it("fails closed for malformed advisor values", () => {
		expect(() => parseAdvisorSettings({ advisor: [] })).toThrow(/advisor must be a JSON object/);
		expect(() => parseAdvisorSettings({ advisor: { maxUses: 0 } })).toThrow(/maxUses/);
		expect(() => parseAdvisorSettings({ advisor: { maxUsesPerSession: 0 } })).toThrow(/maxUsesPerSession/);
		expect(() => parseAdvisorSettings({ advisor: { maxTokens: -1 } })).toThrow(/maxTokens/);
		expect(() => parseAdvisorSettings({ advisor: { strict: "yes" } })).toThrow(/strict/);
		expect(() => parseAdvisorSettings({ advisor: { nudgeTurn: 0 } })).toThrow(/nudgeTurn/);
		expect(() => parseAdvisorSettings({ advisor: { nudgeTurn: -1 } })).toThrow(/nudgeTurn/);
		expect(() => parseAdvisorSettings({ advisor: { allowCrossProvider: "yes" } })).toThrow(/allowCrossProvider/);
		expect(() => parseAdvisorSettings({ advisor: { contextBudget: [] } })).toThrow(/contextBudget must be a JSON object/);
		expect(() => parseAdvisorSettings({ advisor: { contextBudget: { thinking: "some" } } })).toThrow(/thinking/);
		expect(() => parseAdvisorSettings({ advisor: { contextBudget: { recentMessages: -1 } } })).toThrow(/recentMessages/);
		expect(() => parseAdvisorSettings({ advisor: { contextBudget: { toolSchemas: "yes" } } })).toThrow(/toolSchemas/);
	});
});

describe("advisor extension", () => {
	it("registers the opt-in advisor tool and activates it only for configured sessions", async () => {
		const configuredPath = settingsFile({ advisor: { provider: "anthropic", modelId: "strong" } });
		const configured = makePi({ settingsPath: configuredPath });
		createAdvisorExtension({ settingsPath: configuredPath })(configured.pi);
		expect(advisorExtension).toEqual(expect.any(Function));
		expect(configured.tools.get("advisor")).toMatchObject({
		name: "advisor", label: "Advisor", executionMode: "sequential",
		promptSnippet: expect.any(String), promptGuidelines: expect.arrayContaining([expect.stringContaining("advisor")]),
		parameters: expect.any(Object),
		});
		expect(configured.tools.get("advisor").description).toContain("forwarded automatically");
		await configured.handlers.get("session_start")({ reason: "startup" }, configured.ctx);
		expect(configured.getActiveTools()).toContain("advisor");

		const disabledPath = settingsFile({ compaction: { enabled: true } });
		const disabled = makePi({ settingsPath: disabledPath, activeTools: ["read", "advisor"] });
		createAdvisorExtension({ settingsPath: disabledPath })(disabled.pi);
		await disabled.handlers.get("session_start")({ reason: "startup" }, disabled.ctx);
		expect(disabled.getActiveTools()).not.toContain("advisor");
	});

	it("reads advisor settings from the session's profile file at session start", async () => {
		const root = mkdtempSync(join(tmpdir(), "advisor-profile-"));
		roots.push(root);
		const settingsPath = join(root, "settings.json");
		const profilesDirectory = join(root, "profiles");
		mkdirSync(profilesDirectory);
		writeFileSync(settingsPath, JSON.stringify({ configProfiles: { active: "focused" } }));
		writeFileSync(join(profilesDirectory, "focused.json"), JSON.stringify({
			advisor: { provider: "anthropic", modelId: "strong" },
		}));
		const harness = makePi({ settingsPath });
		createAdvisorExtension({ settingsPath })(harness.pi);
		await harness.handlers.get("session_start")({ reason: "startup" }, harness.ctx);
		expect(harness.getActiveTools()).toContain("advisor");
	});

	it("ignores settings.json advisor values when the session has a profile", async () => {
		const root = mkdtempSync(join(tmpdir(), "advisor-profile-"));
		roots.push(root);
		const settingsPath = join(root, "settings.json");
		const profilesDirectory = join(root, "profiles");
		mkdirSync(profilesDirectory);
		writeFileSync(settingsPath, JSON.stringify({
			configProfiles: { active: "focused" },
			advisor: { provider: "anthropic", modelId: "strong" },
		}));
		writeFileSync(join(profilesDirectory, "focused.json"), JSON.stringify({ compaction: { enabled: true } }));
		const harness = makePi({ settingsPath, activeTools: ["read", "advisor"] });
		createAdvisorExtension({ settingsPath })(harness.pi);
		await harness.handlers.get("session_start")({ reason: "startup" }, harness.ctx);
		expect(harness.getActiveTools()).not.toContain("advisor");
	});

	it("keeps the session's profile on reload even when the marker changed", async () => {
		const root = mkdtempSync(join(tmpdir(), "advisor-profile-"));
		roots.push(root);
		const settingsPath = join(root, "settings.json");
		const profilesDirectory = join(root, "profiles");
		mkdirSync(profilesDirectory);
		// Another session switched the marker to "focused" (no advisor), but this
		// session's remembered entry still names "default" (with advisor).
		writeFileSync(settingsPath, JSON.stringify({ configProfiles: { active: "focused" } }));
		writeFileSync(join(profilesDirectory, "focused.json"), JSON.stringify({ compaction: { enabled: true } }));
		writeFileSync(join(profilesDirectory, "default.json"), JSON.stringify({
			advisor: { provider: "anthropic", modelId: "strong" },
		}));
		const harness = makePi({
			settingsPath,
			branchEntries: [{ type: "custom", customType: "configProfiles", data: { active: "default" } }],
		});
		createAdvisorExtension({ settingsPath })(harness.pi);
		await harness.handlers.get("session_start")({ reason: "reload" }, harness.ctx);
		expect(harness.getActiveTools()).toContain("advisor");
	});

	it("supports direct selection, requires cross-provider consent, and writes atomically without losing settings", async () => {
		const path = settingsFile({ compaction: { threshold: 0.1 }, other: { keep: true }, advisor: { maxUses: 2, maxTokens: 1000, strict: true } });
		const harness = makePi({ settingsPath: path, model: { provider: "openai", id: "executor" }, confirm: true });
		createAdvisorExtension({ settingsPath: path })(harness.pi);
		await harness.commands.get("advisor").handler("anthropic/strong", harness.ctx);
		const saved = JSON.parse(readFileSync(path, "utf8"));
		expect(saved).toMatchObject({
			compaction: { threshold: 0.1 }, other: { keep: true },
			advisor: { provider: "anthropic", modelId: "strong", maxUses: 2, maxTokens: 1000, strict: true, allowCrossProvider: true },
		});
		expect(harness.ctx.ui.confirm).toHaveBeenCalledOnce();
		expect(harness.getActiveTools()).toContain("advisor");

		await harness.commands.get("advisor").handler("off", harness.ctx);
		const afterOff = JSON.parse(readFileSync(path, "utf8"));
		expect(afterOff).toMatchObject({ compaction: { threshold: 0.1 }, other: { keep: true } });
		expect(afterOff.advisor).not.toHaveProperty("provider");
		expect(afterOff.advisor).not.toHaveProperty("modelId");
		expect(afterOff.advisor).toMatchObject({ maxUses: 2, maxTokens: 1000, strict: false, allowCrossProvider: false });
		expect(harness.getActiveTools()).toContain("advisor");

		const malformedPath = settingsFile({ other: { keep: true }, advisor: [] });
		const malformed = makePi({ settingsPath: malformedPath, activeTools: ["advisor"] });
		createAdvisorExtension({ settingsPath: malformedPath })(malformed.pi);
		await malformed.commands.get("advisor").handler("off", malformed.ctx);
		expect(loadAdvisorSettings(malformedPath).provider).toBeUndefined();
		expect(JSON.parse(readFileSync(malformedPath, "utf8"))).toMatchObject({ other: { keep: true }, advisor: { strict: false, allowCrossProvider: false } });

		const malformedStrictPath = settingsFile({ other: { keep: true }, advisor: { strict: "yes", contextBudget: [] } });
		const malformedStrict = makePi({ settingsPath: malformedStrictPath, activeTools: ["advisor"] });
		createAdvisorExtension({ settingsPath: malformedStrictPath })(malformedStrict.pi);
		await malformedStrict.commands.get("advisor").handler("off", malformedStrict.ctx);
		expect(JSON.parse(readFileSync(malformedStrictPath, "utf8"))).toMatchObject({ advisor: { strict: false, allowCrossProvider: false } });
	});

	it("shows the three advisor modes before the model picker on a bare command", async () => {
		const path = settingsFile({});
		const harness = makePi({ settingsPath: path });
		harness.ctx.mode = "print";
		harness.ctx.ui.select.mockResolvedValueOnce("on").mockResolvedValueOnce(undefined);
		createAdvisorExtension({ settingsPath: path })(harness.pi);
		expect(harness.commands.get("advisor").getArgumentCompletions("")).toEqual([
			{ value: "on", label: "on" },
			{ value: "strict", label: "strict" },
			{ value: "off", label: "off" },
		]);
		await harness.commands.get("advisor").handler("", harness.ctx);
		expect(harness.ctx.ui.select).toHaveBeenNthCalledWith(1, "Select advisor mode", ["on", "strict", "off"]);
		expect(harness.ctx.ui.select).toHaveBeenNthCalledWith(2, "Select advisor model", ["anthropic/strong"]);
	});

	it("flips strict mode without reopening the model picker when explicitly requested", async () => {
		const path = settingsFile({ advisor: { provider: "anthropic", modelId: "strong" } });
		const harness = makePi({ settingsPath: path });
		createAdvisorExtension({ settingsPath: path })(harness.pi);
		await harness.commands.get("advisor").handler("strict", harness.ctx);
		expect(loadAdvisorSettings(path).strict).toBe(true);
		expect(harness.ctx.ui.select).not.toHaveBeenCalled();
		await harness.commands.get("advisor").handler("on", harness.ctx);
		expect(loadAdvisorSettings(path).strict).toBe(false);
	});

	it("includes strict mode in the active advisor status", async () => {
		const path = settingsFile({ advisor: { provider: "anthropic", modelId: "strong", strict: true } });
		const runner: any = {
			execute: vi.fn(async (input: any) => {
				input.onStatus?.(true, "anthropic/strong");
				input.onStatus?.(false, "anthropic/strong");
				return {
					content: [{ type: "text", text: "Advice" }],
					details: { model: "anthropic/strong", consumesBudget: true, truncated: false },
				};
			}),
		};
		const harness = makePi({ settingsPath: path });
		createAdvisorExtension({ settingsPath: path, runner })(harness.pi);
		await harness.tools.get("advisor").execute("call", {}, undefined, undefined, harness.ctx);
		expect(harness.ctx.ui.setStatus).toHaveBeenNthCalledWith(1, "advisor", "Advising (strict) · anthropic/strong");
		expect(harness.ctx.ui.setStatus).toHaveBeenNthCalledWith(2, "advisor", undefined);
	});

	it("denies cross-provider selection without UI consent and filters unavailable direct models", async () => {
		const path = settingsFile({});
		const denied = makePi({ settingsPath: path, model: { provider: "openai", id: "executor" }, confirm: false });
		createAdvisorExtension({ settingsPath: path })(denied.pi);
		await denied.commands.get("advisor").handler("anthropic/strong", denied.ctx);
		expect(loadAdvisorSettings(path).provider).toBeUndefined();
		expect(denied.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("cancel"), "info");

		const missing = makePi({ settingsPath: path, availableModel: undefined });
		missing.ctx.modelRegistry.find.mockReturnValue(undefined);
		createAdvisorExtension({ settingsPath: path })(missing.pi);
		await missing.commands.get("advisor").handler("anthropic/missing", missing.ctx);
		expect(missing.ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("unavailable"), "error");
	});

	it("keeps the advertised tool after /advisor off", async () => {
		const path = settingsFile({ advisor: { provider: "anthropic", modelId: "strong", maxUses: 1 } });
		const harness = makePi({ settingsPath: path });
		createAdvisorExtension({ settingsPath: path })(harness.pi);
		await harness.handlers.get("session_start")({ reason: "startup" }, harness.ctx);
		await harness.commands.get("advisor").handler("off", harness.ctx);
		expect(harness.getActiveTools()).toContain("advisor");
	});

	it("proves current-turn assistant prose is visible while the advisor tool executes", async () => {
		const root = mkdtempSync(join(tmpdir(), "advisor-runtime-"));
		roots.push(root);
		const path = join(root, "settings.json");
		writeFileSync(path, JSON.stringify({ advisor: { provider: "contract", modelId: "advisor" } }));
		const faux = fauxProvider({
			provider: "contract",
			models: [
				{ id: "executor", contextWindow: 100_000 },
				{ id: "advisor", contextWindow: 100_000 },
			],
			tokensPerSecond: 100_000,
		});
		let captured: any;
		faux.setResponses([
			fauxAssistantMessage([
				fauxText("Prose before the consultation."),
				fauxToolCall("advisor", { question: "review" }, { id: "advisor-call" }),
			], { stopReason: "toolUse" }),
			(context, _options, _state, requestModel) => {
				if (requestModel.id === "advisor") captured = context;
				return fauxAssistantMessage("Advice from the faux advisor");
			},
			fauxAssistantMessage("Executor continued."),
		]);
		const runtime = await ModelRuntime.create({
			credentials: new InMemoryCredentialStore(),
			modelsPath: null,
			refreshOnCreate: false,
		});
		runtime.registerNativeProvider(faux.provider);
		const settings = SettingsManager.inMemory({ compaction: { enabled: false } });
		const loader = new DefaultResourceLoader({
			cwd: root,
			agentDir: root,
			settingsManager: settings,
			systemPromptOverride: () => "Executor system prompt",
			extensionFactories: [createAdvisorExtension({ settingsPath: path })],
		});
		await loader.reload();
		const session = await createAgentSession({
			cwd: root,
			agentDir: root,
			modelRuntime: runtime,
			model: faux.getModel("executor"),
			resourceLoader: loader,
			sessionManager: SessionManager.inMemory(root),
			settingsManager: settings,
			tools: ["advisor"],
		});
		try {
			await session.session.prompt("Start the task");
			expect(JSON.stringify(captured?.messages ?? [])).toContain("Prose before the consultation.");
			expect(JSON.stringify(captured?.messages ?? [])).not.toContain("advisor-call");
		} finally {
			session.session.dispose();
		}
	});

	it("persists a budget marker when an in-flight consultation is aborted and refuses further consultations after reopening", async () => {
		const root = mkdtempSync(join(tmpdir(), "advisor-abort-runtime-"));
		roots.push(root);
		const path = join(root, "settings.json");
		writeFileSync(path, JSON.stringify({ advisor: { provider: "contract", modelId: "advisor", maxUses: 1 } }));
		const faux = fauxProvider({
			provider: "contract",
			models: [{ id: "executor", contextWindow: 100_000 }, { id: "advisor", contextWindow: 100_000 }],
			tokensPerSecond: 5,
			tokenSize: { min: 1, max: 1 },
		});
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("advisor", {}, { id: "advisor-call" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("This deliberately long advisor answer is streamed slowly so Esc can interrupt it before it finishes. ".repeat(30)),
		]);
		const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
		runtime.registerNativeProvider(faux.provider);
		const settings = SettingsManager.inMemory({ compaction: { enabled: false } });
		const loader = new DefaultResourceLoader({
			cwd: root,
			agentDir: root,
			settingsManager: settings,
			extensionFactories: [createAdvisorExtension({ settingsPath: path })],
		});
		await loader.reload();
		const sessionManager = SessionManager.create(root, join(root, "sessions"));
		const created = await createAgentSession({
			cwd: root,
			agentDir: root,
			modelRuntime: runtime,
			model: faux.getModel("executor"),
			resourceLoader: loader,
			sessionManager,
			settingsManager: settings,
			tools: ["advisor"],
		});
		try {
			const prompt = created.session.prompt("Start");
			const deadline = Date.now() + 2_000;
			while (faux.state.callCount < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
			expect(faux.state.callCount).toBeGreaterThanOrEqual(2);
			await new Promise((resolve) => setTimeout(resolve, 50));
			await created.session.abort();
			await prompt;
			const result = sessionManager.getBranch().find((entry: any) => entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "advisor") as any;
			expect(result?.message.details).toMatchObject({ model: "contract/advisor", consumesBudget: true, truncated: false });
			const reopened = SessionManager.open(sessionManager.getSessionFile()!);
			const runner = createAdvisorRunner();
			const second = await runner.execute({
				ctx: {
					cwd: root,
					model: { provider: "contract", id: "executor" },
					signal: undefined,
					getSystemPrompt: () => "Executor system prompt",
					sessionManager: reopened,
					modelRegistry: {
						find: () => faux.getModel("advisor"),
						hasConfiguredAuth: () => true,
						complete: async () => { throw new Error("provider must not be called after the budget is exhausted"); },
					},
				} as any,
				settings: { provider: "contract", modelId: "advisor", strict: false, nudgeTurn: 3, maxUses: 1, maxUsesPerSession: 20, maxTokens: 2048, allowCrossProvider: true },
				callId: "advisor-call-2",
				activeToolNames: ["advisor"],
				allTools: [],
			});
			expect(second.content[0].text).toMatch(/^advisor_turn_budget_exhausted/);
			expect(second.details.consumesBudget).toBe(false);
		} finally {
			created.session.dispose();
		}
	});
});
