import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PROFILES_DIRECTORY } from "../_shared/profile-document.ts";
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

// The extension hardcodes PROJECT_SETTINGS_PATH; redirect it to a per-test
// fixture so the session profile binding is exercised hermetically.
const profileFixture = vi.hoisted(() => ({ settingsPath: "" }));

vi.mock("./settings-store.ts", async (importOriginal) => {
	const original = await importOriginal<typeof import("./settings-store.ts")>();
	return {
		...original,
		get PROJECT_SETTINGS_PATH() {
			return profileFixture.settingsPath;
		},
	};
});

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const BUNDLED_AGENTS = ["default", "explorer", "judge", "researcher", "worker"];

function extensionHarness(
	runSingle = vi.fn(async (options: any) => agentResult({ agent: options.agent.name, task: options.task })),
	options: { config?: any } = {},
) {
	const handlers = new Map<string, any>();
	const commands = new Map<string, any>();
	const tools = new Map<string, any>();
	const registrations: string[] = [];
	const registry = memoryRegistry([agent(), agent({ name: "explorer", description: "Explorer" })]);
	const config = options.config ?? memoryConfigStore({ maxConcurrency: 2, defaultThinkingLevel: "minimal" });
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
		registry,
		config,
		runSingle: runSingle as any,
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
	return { handlers, commands, tools, registrations, registry, config, runSingle, ctx };
}

describe("subagent extension interfaces", () => {
	it("preserves public entrypoint, runner, and registration exports", () => {
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
			description: expect.stringContaining("Delegate a task to an isolated subagent"),
			promptSnippet: "Delegate tasks",
		});
		const subagentDescription = harness.tools.get("subagent").description as string;
		expect(subagentDescription).toContain("substantially smaller than the raw material");
		expect(subagentDescription).toContain("one-or-two-file reads");
		expect(subagentDescription).toContain("Do not delegate planning");
		expect(subagentDescription).toContain("narrow question");
		expect(subagentDescription).toContain("several external sources");
		expect(subagentDescription).toContain("tasks[] array");
		expect(harness.tools.get("subagent")).not.toHaveProperty("promptGuidelines");
		expect(Object.keys((harness.tools.get("subagent").parameters as any).properties)).toEqual(["agent", "task", "tasks", "cwd"]);
		expect(requireSubagentService().id).toBe("tools-subagents");
	});
});

describe("subagent tool adaptation", () => {
	it("adapts single progress and failed results with isError", async () => {
		const failed = agentResult({
			exitCode: 2,
			output: "partial",
			progress: { ...agentResult().progress, status: "failed", error: "boom" },
		});
		const runSingle = vi.fn(async (options: any) => {
			options.onUpdate?.({ ...failed.progress, status: "running" });
			return failed;
		});
		const harness = extensionHarness(runSingle);
		const updates: any[] = [];
		const result = await harness.tools.get("subagent").execute(
			"call", { agent: "worker", task: "Do work", cwd: "/task" }, undefined,
			(update: any) => updates.push(update), harness.ctx,
		);
		expect(runSingle).toHaveBeenCalledWith(expect.objectContaining({
			agent: expect.objectContaining({ name: "worker" }),
			task: "Do work",
			cwd: "/task",
			cacheAffinitySeed: "main-session-123",
		}));
		expect(updates[0]).toMatchObject({ content: [{ text: "(running...)" }], details: { mode: "single" } });
		expect(result).toMatchObject({
			content: [{ type: "text", text: "partial" }],
			details: { mode: "single", results: [failed] },
			isError: true,
		});
	});

	it("adapts parallel pending/running/final results in input order with top-level isError", async () => {
		const runSingle = vi.fn(async (options: any) => options.agent.name === "worker"
			? agentResult({ agent: "worker", task: options.task })
			: agentResult({ agent: "explorer", task: options.task, exitCode: 1, output: "partial", progress: { ...agentResult().progress, agent: "explorer", status: "failed" } }));
		const harness = extensionHarness(runSingle);
		const updates: any[] = [];
		const result = await harness.tools.get("subagent").execute("call", {
			tasks: [
				{ agent: "worker", task: "first" },
				{ agent: "explorer", task: "second", cwd: "/other" },
			],
		}, undefined, (update: any) => updates.push(update), harness.ctx);
		expect(updates.length).toBeGreaterThanOrEqual(4);
		expect(result.content[0].text).toBe("## worker\n\nDone\n\n---\n\n## explorer (FAILED)\n\npartial");
		expect(result.details.results.map((item: any) => item.agent)).toEqual(["worker", "explorer"]);
		expect(result).toHaveProperty("isError", true);
		expect(runSingle.mock.calls[1][0].cwd).toBe("/other");
		expect(runSingle.mock.calls.map(([options]) => options.cacheAffinitySeed)).toEqual([
			"main-session-123",
			"main-session-123",
		]);
	});

	it("preserves invalid invocation and unknown-agent errors", async () => {
		const harness = extensionHarness();
		const execute = harness.tools.get("subagent").execute;
		await expect(execute("call", {}, undefined, undefined, harness.ctx)).rejects.toThrow("Provide either");
		await expect(execute("call", { agent: "missing", task: "x" }, undefined, undefined, harness.ctx))
			.rejects.toThrow("Unknown agent: missing. Available agents: worker, explorer");
		await expect(execute("call", { tasks: [{ agent: "missing", task: "x" }] }, undefined, undefined, harness.ctx))
			.rejects.toThrow("Unknown agent: missing. Available agents: worker, explorer");
	});

	describe("session profile binding", () => {
		it("repoints the config store at the session's profile file when a marker is present", async () => {
			const root = mkdtempSync(join(tmpdir(), "subagents-profile-"));
			roots.push(root);
			const settingsPath = join(root, "settings.json");
			mkdirSync(join(root, "profiles"));
			writeFileSync(settingsPath, JSON.stringify({ configProfiles: { active: "focused" } }));
			profileFixture.settingsPath = settingsPath;
			try {
				const harness = extensionHarness();
				await harness.handlers.get("session_start")({ reason: "startup" }, harness.ctx);
				expect(harness.config.configPath).toBe(join(PROFILES_DIRECTORY, "focused.json"));
			} finally {
				profileFixture.settingsPath = "";
			}
		});

		it("keeps the config store on settings.json when no profile is bound", async () => {
			const root = mkdtempSync(join(tmpdir(), "subagents-noprofile-"));
			roots.push(root);
			const settingsPath = join(root, "settings.json");
			mkdirSync(join(root, "profiles"));
			writeFileSync(settingsPath, JSON.stringify({}));
			profileFixture.settingsPath = settingsPath;
			try {
				const harness = extensionHarness();
				await harness.handlers.get("session_start")({ reason: "startup" }, harness.ctx);
				expect(harness.config.configPath).toBe(settingsPath);
			} finally {
				profileFixture.settingsPath = "";
			}
		});

		it("loads profile-specific maxConcurrency after applying the session path", async () => {
			const root = mkdtempSync(join(tmpdir(), "subagents-concurrency-"));
			roots.push(root);
			const settingsPath = join(root, "settings.json");
			mkdirSync(join(root, "profiles"));
			writeFileSync(settingsPath, JSON.stringify({ configProfiles: { active: "focused" } }));
			profileFixture.settingsPath = settingsPath;

			const config = memoryConfigStore({ maxConcurrency: 2, defaultThinkingLevel: "minimal" });
			const originalSetSettingsPath = config.setSettingsPath;
			config.setSettingsPath = (path) => {
				originalSetSettingsPath(path);
				config.document.maxConcurrency = 7;
			};
			let release!: () => void;
			const gate = new Promise<void>((resolve) => { release = resolve; });
			let active = 0;
			let peak = 0;
			const runSingle = vi.fn(async (options: any) => {
				active++;
				peak = Math.max(peak, active);
				await gate;
				active--;
				return agentResult({ agent: options.agent.name, task: options.task });
			});
			try {
				const harness = extensionHarness(runSingle, { config });
				await harness.handlers.get("session_start")({ reason: "startup" }, harness.ctx);
				const execution = harness.tools.get("subagent").execute("call", {
					tasks: Array.from({ length: 8 }, (_, index) => ({
						agent: index % 2 === 0 ? "worker" : "explorer",
						task: `task ${index}`,
					})),
				}, undefined, undefined, harness.ctx);

				await vi.waitFor(() => expect(peak).toBe(7));
				release();
				await execution;
				expect(peak).toBe(7);
			} finally {
				profileFixture.settingsPath = "";
			}
		});
	});
});
