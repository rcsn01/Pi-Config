import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { profilesDirectoryFor } from "../_shared/profile-document.ts";
import { requireSubagentService } from "../_shared/subagent-service.ts";
import * as subagentExports from "./index.ts";
import subagentsExtension, {
	createSubagentsExtension,
	loadAgents,
	registerAgent,
	runSubagent,
	runSubagentsParallel,
	unregisterAgent,
} from "./index.ts";
import { agent, agentResult, deferred, memoryConfigStore, memoryRegistry } from "./test-harness.ts";

const roots: string[] = [];
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const BUNDLED_AGENTS = ["default", "explorer", "judge", "researcher", "worker"];

function extensionHarness(
	executeChild = vi.fn(async (request: any) => agentResult({ agent: request.agent.name, task: request.task })),
	options: { config?: any; settingsPath?: string; alignConfigPath?: boolean; injectConfig?: boolean } = {},
) {
	const handlers = new Map<string, any[]>();
	const commands = new Map<string, any>();
	const tools = new Map<string, any>();
	const registrations: string[] = [];
	const registry = memoryRegistry([agent(), agent({ name: "explorer", description: "Explorer" })]);
	const config = options.config ?? memoryConfigStore({ maxConcurrency: 2, defaultThinkingLevel: "minimal" });
	const injectedConfig = options.injectConfig === false ? undefined : config;
	if (options.settingsPath !== undefined && injectedConfig !== undefined && options.alignConfigPath !== false) {
		injectedConfig.setSettingsPath(options.settingsPath);
	}
	const pi = {
		on: (event: string, handler: any) => {
			registrations.push(`event:${event}`);
			const list = handlers.get(event) ?? [];
			list.push(handler); handlers.set(event, list);
			return () => { const index = list.indexOf(handler); if (index >= 0) list.splice(index, 1); };
		},
		registerCommand: (name: string, command: any) => {
			registrations.push(`command:${name}`);
			commands.set(name, command);
		},
		sendMessage: vi.fn(),
		registerTool: (tool: any) => {
			registrations.push(`tool:${tool.name}`);
			tools.set(tool.name, tool);
		},
	};
	const inspectTools = vi.fn(() => []);
	const childExecution = {
		execute: executeChild as any,
		inspectTools,
	};
	createSubagentsExtension({
		settingsPath: options.settingsPath,
		registry,
		...(injectedConfig ? { config: injectedConfig } : {}),
		childExecution,
	})(pi as any);
	const ctx = {
		cwd: "/workspace",
		isIdle: () => true,
		model: { provider: "anthropic", id: "main" },
		sessionManager: { getSessionId: () => "main-session-123", getBranch: () => [] },
		mode: "print",
		ui: { notify: vi.fn(), setStatus: vi.fn() },
		modelRegistry: { refresh: vi.fn(), getAvailable: vi.fn(() => []), find: vi.fn() },
		scopedModels: [],
	} as any;
	const emit = async (event: string, payload: any = {}, context = ctx) => {
		for (const handler of [...(handlers.get(event) ?? [])]) await handler(payload, context);
	};
	const errors = vi.fn();
	const dispatch = async (event: string, payload: any = {}, context = ctx) => {
		for (const handler of [...(handlers.get(event) ?? [])]) {
			try { await handler(payload, context); } catch (error) { errors(error); }
		}
	};
	cleanups.push(() => emit("session_shutdown", { reason: "quit" }));
	return {
		pi, emit, dispatch, errors,
		handlers,
		commands,
		tools,
		registrations,
		registry,
		config: injectedConfig ?? config,
		executeChild,
		inspectTools,
		ctx,
	};
}

describe("subagent extension interfaces", () => {
	it("rejects a settings path that conflicts with an injected configuration", () => {
		expect(() => extensionHarness(undefined, {
			settingsPath: "/other-project/settings.json",
			alignConfigPath: false,
		})).toThrow(/does not match the injected configuration path/);
	});

	it("accepts normalized-equivalent settings paths with an injected configuration", () => {
		expect(() => extensionHarness(undefined, {
			settingsPath: "/tmp/../config.json",
			alignConfigPath: false,
		})).not.toThrow();
	});

	it("creates its default configuration store from the extension settings path", async () => {
		const root = mkdtempSync(join(tmpdir(), "subagents-default-config-"));
		roots.push(root);
		const settingsPath = join(root, "settings.json");
		mkdirSync(join(root, "profiles"));
		writeFileSync(settingsPath, JSON.stringify({ subagents: { maxConcurrency: 0 } }));
		const harness = extensionHarness(undefined, { settingsPath, injectConfig: false });

		await expect(harness.emit("session_start", { reason: "startup" }, harness.ctx))
			.rejects.toThrow(/maxConcurrency/);
	});

	it("preserves public entrypoint, execution, and registration exports", () => {
		expect(subagentsExtension).toEqual(expect.any(Function));
		expect(createSubagentsExtension).toEqual(expect.any(Function));
		expect(registerAgent).toEqual(expect.any(Function));
		expect(unregisterAgent).toEqual(expect.any(Function));
		expect(loadAgents).toEqual(expect.any(Function));
		expect(runSubagent).toEqual(expect.any(Function));
		expect(runSubagentsParallel).toEqual(expect.any(Function));
		expect(subagentExports).not.toHaveProperty("runOrderedConcurrently");
		expect(subagentExports).not.toHaveProperty("createParallelRunner");
	});

	it("discovers bundled agents from the extension directory", () => {
		const agents = loadAgents();
		expect(agents.map((candidate) => candidate.name)).toEqual(expect.arrayContaining(BUNDLED_AGENTS));
		expect(agents.find((candidate) => candidate.name === "explorer")?.tools).toEqual([
			"read", "grep", "find", "ls", "repo_query",
		]);
		for (const name of BUNDLED_AGENTS) {
			const bundled = agents.find((candidate) => candidate.name === name);
			expect(bundled?.filePath, `missing file path for ${name}`).toBeTruthy();
			expect(existsSync(bundled!.filePath!), `missing agent file for ${name}`).toBe(true);
		}
	});

	it("preserves event, command, and tool registration order and metadata", () => {
		const harness = extensionHarness();
		expect(harness.registrations).toEqual([
			"event:tool_result",
			"event:agent_before_settle",
			"event:session_tree",
			"event:session_shutdown",
			"event:session_start",
			"event:session_shutdown",
			"event:session_tree",
			"tool:subagent_status",
			"tool:subagent_wait",
			"tool:subagent_cancel",
			"event:model_select",
			"command:subagents",
			"tool:subagent",
		]);
		expect(harness.commands.get("subagents").description).toBe("View and configure subagent models and thinking levels");
		expect(harness.tools.get("subagent")).toMatchObject({
			name: "subagent",
			label: "Subagent",
			description: expect.stringContaining("Delegate only bounded work that examines substantially more material than it returns"),
			promptSnippet: "Delegate tasks",
		});
		const subagentDescription = harness.tools.get("subagent").description as string;
		expect(subagentDescription).toContain("Keep architecture, interface design, planning, decomposition, and implementation in the main agent");
		expect(subagentDescription).toContain("Objective, Scope, Allowed actions, Forbidden actions, Required output, and Stop conditions");
		expect(subagentDescription).toContain("Do not assume the subagent inherits conversation context");
		expect(subagentDescription).toContain("Parallelize only independent tasks that cannot contend over mutable state");
		expect(subagentDescription).toContain("multi-source external research");
		expect(subagentDescription).toContain("running existing tests or commands");
		expect(subagentDescription).not.toContain("worker");
		expect(subagentDescription).not.toContain("judge");
		expect(harness.tools.get("subagent")).not.toHaveProperty("promptGuidelines");
		const parameters = harness.tools.get("subagent").parameters as any;
		expect(Object.keys(parameters.properties)).toEqual(["background", "tasks"]);
		expect(parameters.required).toEqual(["tasks"]);
		expect(parameters.properties.tasks.minItems).toBe(1);
		expect(parameters.properties.tasks.items.properties.agent.description).toContain(
			"Built-ins available here: default, explorer, or researcher",
		);
		expect(parameters.properties.tasks.items.properties.agent.description).not.toContain("worker");
		expect(parameters.properties.tasks.items.properties.agent.description).not.toContain("judge");
		expect(requireSubagentService().id).toBe("tools-subagents");
	});

	it("normalizes polluted parallel and legacy single arguments to the tasks-only schema", () => {
		const tool = extensionHarness().tools.get("subagent");
		const tasks = [{ agent: "explorer", task: "Inspect code", cwd: "/workspace" }];

		expect(tool.prepareArguments({ agent: "", task: "", tasks, cwd: "" })).toEqual({ tasks });
		expect(tool.prepareArguments({ agent: "explorer", task: "Inspect code", cwd: "/task" })).toEqual({
			tasks: [{ agent: "explorer", task: "Inspect code", cwd: "/task" }],
		});
	});
});

describe("subagent tool wiring", () => {
	it.each(["judge", "worker"])("keeps %s workflow-only", async (agentName) => {
		const harness = extensionHarness();
		const tool = harness.tools.get("subagent");

		await expect(tool.execute(
			"call", { tasks: [{ agent: agentName, task: "Do work" }] }, undefined, undefined, harness.ctx,
		)).rejects.toThrow(`Subagent "${agentName}" is only available to workflows.`);
		expect(harness.executeChild).not.toHaveBeenCalled();
	});

	it("routes status and direct service calls through one child execution module", async () => {
		const expectedResult = agentResult({ task: "Direct work", output: "done" });
		const executeChild = vi.fn(async () => expectedResult);
		const harness = extensionHarness(executeChild);

		await harness.commands.get("subagents").handler("status", harness.ctx);
		expect(harness.inspectTools.mock.calls).toEqual([
			[harness.registry.load()[0]!.tools],
			[harness.registry.load()[1]!.tools],
		]);

		const result = await requireSubagentService().runSubagent({
			agent: "worker",
			task: "Direct work",
			cwd: "/workspace",
		});

		expect(executeChild).toHaveBeenCalledWith(expect.objectContaining({
			agent: expect.objectContaining({ name: "worker" }),
			task: "Direct work",
			cwd: "/workspace",
			launch: { model: "openai/test-model", thinkingLevel: "minimal" },
		}));
		expect(result).toBe(expectedResult);
	});

	it("passes Pi invocation context through the Subagent invocation adapter", async () => {
		const failed = agentResult({
			exitCode: 2,
			output: "partial",
			progress: { ...agentResult().progress, status: "failed", error: "boom" },
		});
		const executeChild = vi.fn(async (request: any) => {
			request.onUpdate?.({ ...failed.progress, status: "running" });
			return failed;
		});
		const harness = extensionHarness(executeChild);
		const updates: any[] = [];
		const result = await harness.tools.get("subagent").execute(
			"call", { tasks: [{ agent: "explorer", task: "Do work", cwd: "/task" }] }, undefined,
			(update: any) => updates.push(update), harness.ctx,
		);
		expect(executeChild).toHaveBeenCalledWith(expect.objectContaining({
			agent: expect.objectContaining({ name: "explorer" }),
			task: "Do work",
			cwd: "/task",
			launch: { model: "openai/test-model", thinkingLevel: "minimal" },
			cacheSessionId: expect.stringMatching(/^subagent-/),
		}));
		expect(updates[0]).toMatchObject({ content: [{ text: "(running...)" }], details: { mode: "single" } });
		expect(result).toMatchObject({
			content: [{ type: "text", text: "partial" }],
			details: { mode: "single", results: [failed] },
			isError: true,
		});
	});

	describe("session profile binding", () => {
		it("repoints the config store at the session's profile file when a marker is present", async () => {
			const root = mkdtempSync(join(tmpdir(), "subagents-profile-"));
			roots.push(root);
			const settingsPath = join(root, "settings.json");
			mkdirSync(join(root, "profiles"));
			writeFileSync(settingsPath, "{}");
			mkdirSync(join(root, ".pi"));
			writeFileSync(join(root, ".pi", "pi-config.json"), JSON.stringify({ profile: "focused" }));
			const harness = extensionHarness(undefined, { settingsPath });
			harness.ctx.cwd = root;
			await harness.emit("session_start", { reason: "startup" }, harness.ctx);
			expect(harness.config.configPath).toBe(join(profilesDirectoryFor(settingsPath), "focused.json"));
		});

		it("applies the Profile path before migration and validation", async () => {
			const root = mkdtempSync(join(tmpdir(), "subagents-profile-order-"));
			roots.push(root);
			const settingsPath = join(root, "settings.json");
			mkdirSync(join(root, "profiles"));
			writeFileSync(settingsPath, "{}");
			mkdirSync(join(root, ".pi"));
			writeFileSync(join(root, ".pi", "pi-config.json"), JSON.stringify({ profile: "focused" }));
			const config = memoryConfigStore();
			const calls: string[] = [];
			const setSettingsPath = config.setSettingsPath.bind(config);
			config.setSettingsPath = (path) => { calls.push(`path:${path}`); setSettingsPath(path); };
			const migrateLegacy = config.migrateLegacy.bind(config);
			config.migrateLegacy = async () => { calls.push("migrate"); return migrateLegacy(); };
			const load = config.load.bind(config);
			config.load = () => { calls.push("load"); return load(); };
			const harness = extensionHarness(undefined, { settingsPath, config });
			harness.ctx.cwd = root;
			calls.length = 0;

			await harness.emit("session_start", { reason: "startup" }, harness.ctx);

			expect(calls).toEqual([
				`path:${join(profilesDirectoryFor(settingsPath), "focused.json")}`,
				"migrate",
				"load",
			]);
		});

		it("keeps the config store on settings.json when no profile is bound", async () => {
			const root = mkdtempSync(join(tmpdir(), "subagents-noprofile-"));
			roots.push(root);
			const settingsPath = join(root, "settings.json");
			mkdirSync(join(root, "profiles"));
			writeFileSync(settingsPath, JSON.stringify({}));
			const harness = extensionHarness(undefined, { settingsPath });
			await harness.emit("session_start", { reason: "startup" }, harness.ctx);
			expect(harness.config.configPath).toBe(settingsPath);
		});

		it("uses profile maxConcurrency changes on the next Pi tool invocation", async () => {
			const root = mkdtempSync(join(tmpdir(), "subagents-concurrency-"));
			roots.push(root);
			const settingsPath = join(root, "settings.json");
			const profilesPath = join(root, "profiles");
			const focusedPath = join(profilesPath, "focused.json");
			mkdirSync(profilesPath);
			writeFileSync(settingsPath, "{}");
			mkdirSync(join(root, ".pi"));
			writeFileSync(join(root, ".pi", "pi-config.json"), JSON.stringify({ profile: "focused" }));
			writeFileSync(focusedPath, JSON.stringify({ subagents: { maxConcurrency: 1 } }));

			let release!: () => void;
			const gate = new Promise<void>((resolve) => { release = resolve; });
			let active = 0;
			let peak = 0;
			const executeChild = vi.fn(async (request: any) => {
				active++;
				peak = Math.max(peak, active);
				await gate;
				active--;
				return agentResult({ agent: request.agent.name, task: request.task });
			});
			const harness = extensionHarness(executeChild, { settingsPath, injectConfig: false });
			harness.ctx.cwd = root;
			await harness.emit("session_start", { reason: "startup" }, harness.ctx);
			writeFileSync(focusedPath, JSON.stringify({ subagents: { maxConcurrency: 3 } }));

			const execution = harness.tools.get("subagent").execute("call", {
				tasks: Array.from({ length: 4 }, (_, index) => ({
					agent: "explorer",
					task: `task ${index}`,
				})),
			}, undefined, undefined, harness.ctx);

			try {
				await vi.waitFor(() => expect(peak).toBe(3));
			} finally {
				release();
				await execution;
			}
			expect(peak).toBe(3);
		});
	});
});

describe("background extension routing and ownership", () => {
	it.each(["tui", "rpc"])("acknowledges immediately in %s and reports completion exactly once", async (mode) => {
		let resolve!: (value: any) => void;
		const child = vi.fn(() => new Promise<any>((done) => { resolve = done; }));
		const h = extensionHarness(child); h.ctx.mode = mode; h.ctx.cwd = process.cwd();
		await h.emit("session_start", { reason: "startup" });
		const updates = vi.fn();
		const result = await h.tools.get("subagent").execute("id", { tasks: [{ agent: "explorer", task: "inspect" }] }, undefined, updates, h.ctx);
		expect(result.details).toMatchObject({ mode: "background", runs: [{ status: "queued" }] });
		expect(h.pi.sendMessage).not.toHaveBeenCalled();
		resolve(agentResult({ agent: "explorer", output: "done" }));
		await h.tools.get("subagent_wait").execute("wait", { runIds: [result.details.runs[0].runId] }, undefined, undefined, h.ctx);
		expect(h.pi.sendMessage).toHaveBeenCalledOnce(); expect(updates).not.toHaveBeenCalled();
		await h.emit("session_shutdown", {}, h.ctx);
	});
	it.each(["print", "json"])("rejects explicit background requests in %s before launch", async (mode) => {
		const h = extensionHarness(); h.ctx.mode = mode;
		await expect(h.tools.get("subagent").execute("id", { background: true, tasks: [{ agent: "explorer", task: "inspect" }] }, undefined, undefined, h.ctx)).rejects.toThrow(/background: false/);
		expect(h.executeChild).not.toHaveBeenCalled();
	});
	it("preserves explicit foreground execution in RPC and background normalization", async () => {
		const h = extensionHarness(); h.ctx.mode = "rpc";
		const tool = h.tools.get("subagent");
		expect(tool.prepareArguments({ agent: "explorer", task: "inspect", background: false, polluted: true })).toEqual({ tasks: [{ agent: "explorer", task: "inspect" }], background: false });
		const result = await tool.execute("id", { background: false, tasks: [{ agent: "explorer", task: "inspect" }] }, undefined, undefined, h.ctx);
		expect(result.details.mode).toBe("single"); expect(result.details.results[0].output).toBeDefined();
	});
	it.each(["session_tree", "session_shutdown"])("revokes old delivery and waits for cancellation during %s", async (event) => {
		let resolve!: (value: any) => void;
		const aborted = deferred();
		const child = vi.fn((request: any) => new Promise<any>((done) => { resolve = done; request.signal.addEventListener("abort", () => aborted.resolve(), { once: true }); }));
		const h = extensionHarness(child); h.ctx.mode = "rpc"; h.ctx.cwd = process.cwd();
		await h.emit("session_start", { reason: "startup" });
		const result = await h.tools.get("subagent").execute("id", { tasks: [{ agent: "explorer", task: "inspect" }] }, undefined, undefined, h.ctx);
		let finished = false;
		const cleanup = h.emit(event, {}, h.ctx).then(() => { finished = true; });
		await aborted.promise;
		expect(child.mock.calls[0][0].signal.aborted).toBe(true); expect(finished).toBe(false);
		resolve(agentResult()); await cleanup;
		if (event === "session_tree") expect(h.pi.sendMessage).not.toHaveBeenCalled();
		else expect(h.pi.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ details: expect.objectContaining({ status: "cancelled" }) }), { deliverAs: "followUp", triggerTurn: false });
		if (event === "session_tree") {
			await expect(h.tools.get("subagent_status").execute("id", { runId: result.details.runs[0].runId }, undefined, undefined, h.ctx)).rejects.toThrow(/unavailable/);
		}
		expect(h.ctx.ui.setStatus).toHaveBeenCalledWith("subagents", undefined);
	});
});


describe("ordered lifecycle adaptation", () => {
	it("registers queue cleanup and execution shutdown and removes the facade after failed preparation", async () => {
		const config = memoryConfigStore(); config.migrateLegacy = async () => { throw new Error("migration failed"); };
		const h = extensionHarness(undefined, { config });
		expect(h.handlers.get("session_shutdown")).toHaveLength(2);
		await expect(h.emit("session_start", { reason: "startup" })).rejects.toThrow("migration failed");
		await h.emit("session_shutdown", { reason: "quit" });
		expect(requireSubagentService).toThrow("unavailable");
	});
	it("dispatch reports a failed handler and still invokes later ordered handlers", async () => {
		const h = extensionHarness(); const order: string[] = [];
		h.pi.on("fixture", async () => { order.push("first"); throw new Error("handler failed"); });
		const unsubscribe = h.pi.on("fixture", () => { order.push("second"); });
		await h.dispatch("fixture");
		expect(order).toEqual(["first", "second"]); expect(h.errors).toHaveBeenCalledWith(expect.objectContaining({ message: "handler failed" }));
		unsubscribe(); expect(h.handlers.get("fixture")).toHaveLength(1);
	});
	it("shutdown during branch retirement stops replacement and unregisters", async () => {
		let finish!: (value: any) => void;
		const h = extensionHarness(vi.fn(() => new Promise<any>((resolve) => { finish = resolve; })));
		h.ctx.cwd = process.cwd(); h.ctx.mode = "rpc"; await h.emit("session_start", { reason: "startup" });
		await h.tools.get("subagent").execute("id", { tasks: [{ agent: "explorer", task: "inspect" }] }, undefined, undefined, h.ctx);
		const branch = h.emit("session_tree"); const shutdown = h.emit("session_shutdown");
		finish(agentResult()); await Promise.all([branch, shutdown]);
		expect(requireSubagentService).toThrow("unavailable"); expect(h.pi.sendMessage).not.toHaveBeenCalled();
		await expect(h.tools.get("subagent").execute("id", { tasks: [{ agent: "explorer", task: "again" }] }, undefined, undefined, h.ctx)).rejects.toThrow("admission is closed");
	});
});

describe("Profile binding fallback and preparation ordering", () => {
	it.each(["binding resolution", "path application"])("afterStop removes the loading facade when %s prevented initialization", async (failure) => {
		const config = memoryConfigStore(); config.migrateLegacy = vi.fn(async () => false);
		const h = extensionHarness(undefined, { config });
		if (failure === "binding resolution") h.ctx.sessionManager.getBranch = () => { throw new Error("binding failed"); };
		else config.setSettingsPath = () => { throw new Error("path failed"); };
		await expect(h.emit("session_start", { reason: "startup" })).rejects.toThrow(/failed/);
		expect(config.migrateLegacy).not.toHaveBeenCalled();
		await h.emit("session_shutdown", { reason: "quit" });
		expect(requireSubagentService).toThrow("unavailable"); expect(h.executeChild).not.toHaveBeenCalled();
	});
	it("actual Profile shutdown waits for deferred initialization before reaching the module", async () => {
		const config = memoryConfigStore(); const migration = deferred(); const begun = deferred();
		config.migrateLegacy = async () => { begun.resolve(); await migration.promise; return false; };
		const h = extensionHarness(undefined, { config });
		const startup = h.emit("session_start", { reason: "startup" }); await begun.promise;
		let stopped = false;
		const shutdown = h.emit("session_shutdown", { reason: "quit" }).then(() => { stopped = true; });
		expect(stopped).toBe(false); expect(requireSubagentService().id).toBe("tools-subagents");
		migration.resolve(); await Promise.all([startup, shutdown]);
		expect(requireSubagentService).toThrow("unavailable"); expect(h.executeChild).not.toHaveBeenCalled();
	});
});
