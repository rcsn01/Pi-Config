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
import { agent, agentResult, memoryConfigStore, memoryRegistry } from "./test-harness.ts";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const BUNDLED_AGENTS = ["default", "explorer", "judge", "researcher", "worker"];

function extensionHarness(
	executeChild = vi.fn(async (request: any) => agentResult({ agent: request.agent.name, task: request.task })),
	options: { config?: any; settingsPath?: string; alignConfigPath?: boolean; injectConfig?: boolean } = {},
) {
	const handlers = new Map<string, any>();
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
			handlers.set(event, handler);
		},
		registerCommand: (name: string, command: any) => {
			registrations.push(`command:${name}`);
			commands.set(name, command);
		},
		registerTool: (tool: any) => {
			registrations.push(`tool:${tool.name}`);
			tools.set(tool.name, tool);
		},
	};
	createSubagentsExtension({
		settingsPath: options.settingsPath,
		registry,
		...(injectedConfig ? { config: injectedConfig } : {}),
		childExecution: { execute: executeChild as any },
	})(pi as any);
	const ctx = {
		cwd: "/workspace",
		model: { provider: "anthropic", id: "main" },
		sessionManager: { getSessionId: () => "main-session-123", getBranch: () => [] },
		mode: "print",
		ui: { notify: vi.fn() },
		modelRegistry: { refresh: vi.fn(), getAvailable: vi.fn(() => []), find: vi.fn() },
		scopedModels: [],
	} as any;
	return { handlers, commands, tools, registrations, registry, config: injectedConfig ?? config, executeChild, ctx };
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

		await expect(harness.handlers.get("session_start")({ reason: "startup" }, harness.ctx))
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
			"event:session_start",
			"event:session_shutdown",
			"event:model_select",
			"command:subagents",
			"tool:subagent",
		]);
		expect(harness.commands.get("subagents").description).toBe("View and configure subagent models and thinking levels");
		expect(harness.tools.get("subagent")).toMatchObject({
			name: "subagent",
			label: "Subagent",
			description: expect.stringContaining("Use this tool only when a subagent will inspect substantially more material than it returns"),
			promptSnippet: "Delegate tasks",
		});
		const subagentDescription = harness.tools.get("subagent").description as string;
		expect(subagentDescription).toContain("Do not delegate planning, architecture, design alternatives");
		expect(subagentDescription).toContain("Available agents, using these exact names");
		expect(subagentDescription).toContain("worker for implementing a bounded change after the main agent has decided the design");
		expect(subagentDescription).toContain("Use parallel tasks only when they are independent");
		expect(subagentDescription).toContain("one-or-two-file inspections");
		expect(subagentDescription).toContain("narrow scope");
		expect(subagentDescription).toContain("several external sources");
		expect(subagentDescription).toContain("tasks[] entry");
		expect(harness.tools.get("subagent")).not.toHaveProperty("promptGuidelines");
		const parameters = harness.tools.get("subagent").parameters as any;
		expect(Object.keys(parameters.properties)).toEqual(["tasks"]);
		expect(parameters.required).toEqual(["tasks"]);
		expect(parameters.properties.tasks.minItems).toBe(1);
		expect(parameters.properties.tasks.items.properties.agent.description).toContain(
			"Exact registered agent name: default, explorer, worker, researcher, or judge",
		);
		expect(requireSubagentService().id).toBe("tools-subagents");
	});

	it("normalizes polluted parallel and legacy single arguments to the tasks-only schema", () => {
		const tool = extensionHarness().tools.get("subagent");
		const tasks = [{ agent: "explorer", task: "Inspect code", cwd: "/workspace" }];

		expect(tool.prepareArguments({ agent: "", task: "", tasks, cwd: "" })).toEqual({ tasks });
		expect(tool.prepareArguments({ agent: "worker", task: "Fix code", cwd: "/task" })).toEqual({
			tasks: [{ agent: "worker", task: "Fix code", cwd: "/task" }],
		});
	});
});

describe("subagent tool wiring", () => {
	it("routes direct service calls through prepared child execution", async () => {
		const expectedResult = agentResult({ task: "Direct work", output: "done" });
		const executeChild = vi.fn(async () => expectedResult);
		extensionHarness(executeChild);

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
			"call", { tasks: [{ agent: "worker", task: "Do work", cwd: "/task" }] }, undefined,
			(update: any) => updates.push(update), harness.ctx,
		);
		expect(executeChild).toHaveBeenCalledWith(expect.objectContaining({
			agent: expect.objectContaining({ name: "worker" }),
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
			writeFileSync(settingsPath, JSON.stringify({ configProfiles: { active: "focused" } }));
			const harness = extensionHarness(undefined, { settingsPath });
			await harness.handlers.get("session_start")({ reason: "startup" }, harness.ctx);
			expect(harness.config.configPath).toBe(join(profilesDirectoryFor(settingsPath), "focused.json"));
		});

		it("keeps the config store on settings.json when no profile is bound", async () => {
			const root = mkdtempSync(join(tmpdir(), "subagents-noprofile-"));
			roots.push(root);
			const settingsPath = join(root, "settings.json");
			mkdirSync(join(root, "profiles"));
			writeFileSync(settingsPath, JSON.stringify({}));
			const harness = extensionHarness(undefined, { settingsPath });
			await harness.handlers.get("session_start")({ reason: "startup" }, harness.ctx);
			expect(harness.config.configPath).toBe(settingsPath);
		});

		it("uses profile maxConcurrency changes on the next Pi tool invocation", async () => {
			const root = mkdtempSync(join(tmpdir(), "subagents-concurrency-"));
			roots.push(root);
			const settingsPath = join(root, "settings.json");
			const profilesPath = join(root, "profiles");
			const focusedPath = join(profilesPath, "focused.json");
			mkdirSync(profilesPath);
			writeFileSync(settingsPath, JSON.stringify({ configProfiles: { active: "focused" } }));
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
			await harness.handlers.get("session_start")({ reason: "startup" }, harness.ctx);
			writeFileSync(focusedPath, JSON.stringify({ subagents: { maxConcurrency: 3 } }));

			const execution = harness.tools.get("subagent").execute("call", {
				tasks: Array.from({ length: 4 }, (_, index) => ({
					agent: index % 2 === 0 ? "worker" : "explorer",
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
