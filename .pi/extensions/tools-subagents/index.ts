/**
 * Runs specialized agents in isolated child Pi processes.
 * Supports single and parallel execution with verbal result handoff.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { registerToolErrorHandler } from "../_shared/tool-result-ui.ts";
import {
	registerSubagentService,
	type AgentConfig,
	type AgentProgress,
	type AgentResult,
	type RunSubagentOptions,
	type RunSubagentsParallelOptions,
	type SubagentProgressEvent,
	type SubagentService,
} from "../_shared/subagent-service.ts";
import { createSessionProfileResolver, PROFILES_DIRECTORY } from "../_shared/active-profile.ts";
import {
	agentRegistry,
	loadAgents,
	registerAgent,
	unregisterAgent,
	type AgentRegistry,
} from "./agent-registry.ts";
import { LEGACY_CONFIG_PATH, migrateSubagentConfigLegacy, subagentConfig, type SubagentConfigStore } from "./config.ts";
import { PROJECT_SETTINGS_PATH } from "./settings-store.ts";
import { createSubagentsCommand } from "./model-commands.ts";
import {
	createParallelRunner,
	DEFAULT_MAX_CONCURRENCY,
	runOrderedConcurrently,
	runSubagentsParallel,
} from "./parallel-runner.ts";
import { renderSubagentCall, renderSubagentResult } from "./progress-renderer.ts";
import { createSubagentRunner, runSubagent, throttle } from "./subagent-runner.ts";

export type {
	AgentConfig,
	AgentProgress,
	AgentResult,
	RunSubagentOptions,
	RunSubagentsParallelOptions,
	SubagentProgressEvent,
} from "../_shared/subagent-service.ts";
export { loadAgents, registerAgent, unregisterAgent } from "./agent-registry.ts";
export { runSubagent } from "./subagent-runner.ts";
export { runSubagentsParallel } from "./parallel-runner.ts";

export interface SubagentsExtensionDependencies {
	registry?: AgentRegistry;
	config?: SubagentConfigStore;
	runSingle?: typeof runSubagent;
	runParallel?: typeof runSubagentsParallel;
	runOrdered?: typeof runOrderedConcurrently;
}

export function createSubagentsExtension(dependencies: SubagentsExtensionDependencies = {}) {
	const resolver = createSessionProfileResolver({
		settingsPath: PROJECT_SETTINGS_PATH,
		profilesDirectory: PROFILES_DIRECTORY,
	});
	return (pi: ExtensionAPI): void => {
		registerToolErrorHandler(pi, ["subagent"], (event) => {
			const details = event.details as { results?: AgentResult[] } | undefined;
			return details?.results?.some((result) =>
				result.exitCode !== 0 || result.progress.status === "failed" || Boolean(result.progress.error),
			) ?? false;
		});

		const registry = dependencies.registry ?? agentRegistry;
		const configStore = dependencies.config ?? subagentConfig;
		const hasInjectedRuntime = dependencies.registry !== undefined || dependencies.config !== undefined;
		const runSingle = dependencies.runSingle ?? (hasInjectedRuntime
			? createSubagentRunner({ registry, config: configStore })
			: runSubagent);
		const runParallel = dependencies.runParallel ?? (hasInjectedRuntime
			? createParallelRunner({ registry, config: configStore, runSingle })
			: runSubagentsParallel);
		const runOrdered = dependencies.runOrdered ?? runOrderedConcurrently;
		const service: SubagentService = {
			id: "tools-subagents",
			registerAgent: (config) => registry.register(config),
			unregisterAgent: (name) => registry.unregister(name),
			loadAgents: () => registry.load(),
			runSubagent: (options) => runSingle(options),
			runSubagentsParallel: (options) => runParallel(options),
		};

		registerSubagentService(service);
		const config = configStore.load();
		const maxConcurrency = config.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
		registry.initialize();

		pi.on("session_start", async (event, ctx) => {
			configStore.rememberMainModel(ctx.model);
			// Point the config store at the session's profile file; no profile
			// means settings.json.
			configStore.setSettingsPath(resolver.resolve(ctx.sessionManager.getBranch(), event.reason));
			// One-time migration: carry a legacy config.json into the session's
			// settings document (the profile when one is active), then delete it.
			await migrateSubagentConfigLegacy(configStore.configPath, LEGACY_CONFIG_PATH);
		});
		pi.on("model_select", (event) => configStore.rememberMainModel(event.model));

		pi.registerCommand("subagents", createSubagentsCommand({ registry, config: configStore }));

		pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: "Delegate a task to an isolated subagent; include all needed context.",
		promptSnippet: "Delegate tasks",
		promptGuidelines: [
			"Use subagents only when their final handoff will be substantially smaller than the raw material they inspect.",
			"Keep simple lookups, known-symbol traces, and reads of one or two files local. Use parallel tool calls for independent I/O.",
			"Use explorer to gather repository evidence across several files. Do not delegate planning, architecture, task decomposition, or implementation decisions. The main agent owns synthesis and planning.",
			"After a subagent returns, rely on its cited findings. Do not repeat its searches or reread cited files unless the handoff identifies a gap or conflicting evidence.",
			"Give subagents a narrow question, explicit scope, and requested evidence. Ask for compact findings rather than a work log.",
			"Use researcher only when several external sources must be read and summarized. Keep direct documentation lookups local.",
			"For multiple independent subagent tasks, use parallel mode with tasks[] array.",
		],
		parameters: Type.Object({
			agent: Type.Optional(
				Type.String({ description: "Name of the agent to invoke (SINGLE mode)" }),
			),
			task: Type.Optional(Type.String({ description: "Task description (SINGLE mode)" })),
			tasks: Type.Optional(
				Type.Array(
					Type.Object({
						agent: Type.String({ description: "Name of the agent to invoke" }),
						task: Type.String({ description: "Task description" }),
						cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
					}),
					{ description: "PARALLEL mode: array of {agent, task} objects" },
				),
			),
			cwd: Type.Optional(Type.String({ description: "Working directory for the agent process (single mode)" })),
		}),

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const cwd = ctx.cwd;
			const cacheAffinitySeed = ctx.sessionManager.getSessionId();
			configStore.rememberMainModel(ctx.model);
			const agents = registry.load();

			// Validate mode
			if (params.tasks && params.tasks.length > 0) {
				// ── Parallel mode ──
				const taskList = params.tasks;

				// Validate all agents
				const available = agents.map((a) => a.name).join(", ") || "none";
				for (const t of taskList) {
					if (!agents.find((a) => a.name === t.agent)) {
						throw new Error(`Unknown agent: ${t.agent}. Available agents: ${available}`);
					}
				}

				const allResults: AgentResult[] = [];

				// Initialize all result slots as pending
				for (let i = 0; i < taskList.length; i++) {
					allResults[i] = {
						agent: taskList[i].agent,
						task: taskList[i].task,
						output: "",
						exitCode: -1,
						model: undefined,
						usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
						progress: { agent: taskList[i].agent, status: "pending" as any, task: taskList[i].task, recentTools: [], toolCount: 0, tokens: 0, durationMs: 0, lastMessage: "" },
					};
				}

				const flushParallelUpdate = () => {
					onUpdate?.({
						content: [{ type: "text", text: `Running ${taskList.length} tasks...` }],
						details: {
							mode: "parallel" as const,
							results: [...allResults],
						},
					});
				};
				const fireParallelUpdate = throttle(flushParallelUpdate, 150);

				const results = await runOrdered(taskList, maxConcurrency, async (t, idx) => {
					const agent = agents.find((a) => a.name === t.agent)!;
					const launch = configStore.resolveLaunch(agent);
					allResults[idx].model = launch.model;
					allResults[idx].thinkingLevel = launch.thinkingLevel;
					allResults[idx].progress.status = "running";
					flushParallelUpdate();
					const result = await runSingle({
						agent,
						task: t.task,
						cwd: t.cwd ?? cwd,
						signal,
						cacheAffinitySeed,
						onUpdate: (progress) => {
							allResults[idx].progress = progress;
							fireParallelUpdate();
						},
					});

					// Update allResults with the completed result so the UI reflects it immediately
					allResults[idx] = result;
					flushParallelUpdate();

					return result;
				});

				// Build final output text
				const outputParts = results.map((r) => {
					const failed = r.exitCode !== 0 || r.progress.status === "failed" || Boolean(r.progress.error);
					const header = `## ${r.agent}${failed ? " (FAILED)" : ""}`;
					return `${header}\n\n${r.output || "(no output)"}`;
				});

				const isError = results.some((result) => result.exitCode !== 0 || !!result.progress.error);
				return {
					content: [{ type: "text", text: outputParts.join("\n\n---\n\n") }],
					details: { mode: "parallel" as const, results },
					...(isError ? { isError: true } : {}),
				};
			} else if (params.agent && params.task) {
				// ── Single mode ──
				const agent = agents.find((a) => a.name === params.agent);
				if (!agent) {
					const available = agents.map((a) => a.name).join(", ") || "none";
					throw new Error(`Unknown agent: ${params.agent}. Available agents: ${available}`);
				}

				const launch = configStore.resolveLaunch(agent);
				const liveResult: AgentResult = {
					agent: params.agent!,
					task: params.task!,
					output: "",
					exitCode: -1,
					model: launch.model,
					thinkingLevel: launch.thinkingLevel,
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
					progress: { agent: params.agent!, status: "running" as const, task: params.task!, recentTools: [], toolCount: 0, tokens: 0, durationMs: 0, lastMessage: "" },
				};
				const result = await runSingle({
					agent,
					task: params.task,
					cwd: params.cwd ?? cwd,
					signal,
					cacheAffinitySeed,
					onUpdate: (progress) => {
						liveResult.progress = progress;
						onUpdate?.({
							content: [{ type: "text", text: "(running...)" }],
							details: { mode: "single" as const, results: [liveResult] },
						});
					},
				});

				const isError = result.exitCode !== 0 || !!result.progress.error;
				return {
					content: [{ type: "text", text: result.output || "(no output)" }],
					details: { mode: "single" as const, results: [result] },
					...(isError ? { isError: true } : {}),
				};
			} else {
				throw new Error("Provide either (agent + task) for single mode, or tasks[] for parallel mode.");
			}
		},

		renderCall(args, theme, _context) {
			return renderSubagentCall(args, theme);
		},

		renderResult(result, options, theme, context) {
			return renderSubagentResult(result, options, theme, undefined, context);
		},
		});
	};
}

export default createSubagentsExtension();
