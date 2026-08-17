import { existsSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { requireSubagentService } from "../_shared/subagent-service.ts";
import subagentsExtension, {
	createSubagentsExtension,
	loadAgents,
	registerAgent,
	runSubagent,
	runSubagentsParallel,
	unregisterAgent,
} from "./index.ts";
import { agent, agentResult, memoryConfigStore, memoryRegistry } from "./test-harness.ts";

const BUNDLED_AGENTS = ["default", "explorer", "judge", "researcher", "worker"];

function extensionHarness(runSingle = vi.fn(async (options: any) => agentResult({ agent: options.agent.name, task: options.task }))) {
	const handlers = new Map<string, any>();
	const commands = new Map<string, any>();
	const tools = new Map<string, any>();
	const registrations: string[] = [];
	const registry = memoryRegistry([agent(), agent({ name: "explorer", description: "Explorer" })]);
	const config = memoryConfigStore({ maxConcurrency: 2, defaultThinkingLevel: "minimal" });
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
	createSubagentsExtension({ registry, config, runSingle: runSingle as any })(pi as any);
	const ctx = {
		cwd: "/workspace",
		model: { provider: "anthropic", id: "main" },
		sessionManager: { getSessionId: () => "main-session-123" },
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
	});

	it("discovers bundled agents from the extension directory", () => {
		const agents = loadAgents();
		expect(agents.map((candidate) => candidate.name)).toEqual(expect.arrayContaining(BUNDLED_AGENTS));
		for (const name of BUNDLED_AGENTS) {
			const bundled = agents.find((candidate) => candidate.name === name);
			expect(bundled?.filePath, `missing file path for ${name}`).toBeTruthy();
			expect(existsSync(bundled!.filePath!), `missing agent file for ${name}`).toBe(true);
		}
	});

	it("preserves event, command, and tool registration order and metadata", () => {
		const harness = extensionHarness();
		expect(harness.registrations).toEqual([
			"event:session_start",
			"event:model_select",
			"command:subagents",
			"tool:subagent",
		]);
		expect(harness.commands.get("subagents").description).toBe("View and configure subagent models and thinking levels");
		expect(harness.tools.get("subagent")).toMatchObject({
			name: "subagent",
			label: "Subagent",
			description: "Delegate a task to an isolated subagent; include all needed context.",
			promptSnippet: "Delegate tasks",
			promptGuidelines: [
				expect.stringContaining("primary parallelism mechanism"),
				expect.stringContaining("context-heavy, bounded work"),
				expect.stringContaining("parallel mode"),
			],
		});
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

	it("adapts parallel pending/running/final results in input order without top-level isError", async () => {
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
		expect(result).not.toHaveProperty("isError");
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
});
