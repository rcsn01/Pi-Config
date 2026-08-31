/**
 * Runs specialized agents in isolated child Pi processes.
 * Supports single and parallel execution with verbal result handoff.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";
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
import { registerSessionProfileBinding } from "../_shared/session-profile-binding.ts";
import { PROJECT_SETTINGS_PATH } from "../_shared/settings-document.ts";
import {
	agentRegistry,
	loadAgents,
	registerAgent,
	unregisterAgent,
	type AgentRegistry,
} from "./agent-registry.ts";
import {
	createSubagentConfigStore,
	LEGACY_CONFIG_PATH,
	migrateSubagentConfigLegacy,
	type SubagentConfigStore,
} from "./config.ts";
import { createSubagentsCommand } from "./model-commands.ts";
import {
	createParallelSubagentBatch,
	DEFAULT_MAX_CONCURRENCY,
} from "./parallel-batch.ts";
import { renderSubagentCall, renderSubagentResult } from "./progress-renderer.ts";
import {
	createSubagentInvocationAdapter,
	isFailedSubagentResult,
} from "./subagent-invocation.ts";
import { createSubagentRunner, runSubagent } from "./subagent-runner.ts";

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
export { runSubagentsParallel } from "./parallel-batch.ts";

export interface SubagentsExtensionDependencies {
	settingsPath?: string;
	registry?: AgentRegistry;
	config?: SubagentConfigStore;
	runSingle?: typeof runSubagent;
}

export function createSubagentsExtension(dependencies: SubagentsExtensionDependencies = {}) {
	return (pi: ExtensionAPI): void => {
		registerToolErrorHandler(pi, ["subagent"], (event) => {
			const details = event.details as { results?: AgentResult[] } | undefined;
			return details?.results?.some(isFailedSubagentResult) ?? false;
		});

		const registry = dependencies.registry ?? agentRegistry;
		const injectedConfig = dependencies.config;
		const settingsPath = dependencies.settingsPath ?? injectedConfig?.configPath ?? PROJECT_SETTINGS_PATH;
		if (dependencies.settingsPath !== undefined && injectedConfig !== undefined &&
			resolve(dependencies.settingsPath) !== resolve(injectedConfig.configPath)) {
			throw new Error(
				`Subagent settingsPath ${dependencies.settingsPath} does not match the injected configuration path ${injectedConfig.configPath}.`,
			);
		}
		const configStore = injectedConfig ?? createSubagentConfigStore({
			settingsPath,
			legacyConfigPath: LEGACY_CONFIG_PATH,
		});
		const runSingle = dependencies.runSingle ?? createSubagentRunner({ registry, config: configStore });
		const parallelBatch = createParallelSubagentBatch({ registry, config: configStore, runSingle });
		const invocationAdapter = createSubagentInvocationAdapter({ batch: parallelBatch });
		const service: SubagentService = {
			id: "tools-subagents",
			registerAgent: (config) => registry.register(config),
			unregisterAgent: (name) => registry.unregister(name),
			loadAgents: () => registry.load(),
			runSubagent: (options) => runSingle(options),
			runSubagentsParallel: (options) => parallelBatch.runSubagentsParallel(options),
		};

		registerSubagentService(service);
		let maxConcurrency = DEFAULT_MAX_CONCURRENCY;
		const profileInitialization = registerSessionProfileBinding(
			{ settingsPath },
			{
				name: "tools-subagents",
				applyPath: (binding) => configStore.setSettingsPath(binding.settingsPath),
				async initialize(_binding, _event, ctx) {
					configStore.rememberMainModel(ctx.model);
					// One-time migration: carry a legacy config.json into the session's
					// settings document (the profile when one is active), then delete it.
					await migrateSubagentConfigLegacy(configStore.configPath, LEGACY_CONFIG_PATH);
					const config = configStore.load();
					maxConcurrency = config.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
				},
			},
		);
		registry.initialize();

		pi.on("session_start", async (event, ctx) => {
			await profileInitialization.start(event, ctx);
		});
		pi.on("session_shutdown", async (event, ctx) => {
			try {
				await profileInitialization.stop(event, ctx);
			} finally {
				profileInitialization.unregister();
			}
		});
		pi.on("model_select", (event) => configStore.rememberMainModel(event.model));

		pi.registerCommand("subagents", createSubagentsCommand({ registry, config: configStore }));

		pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description:
			"Delegate tasks to isolated subagents; include all needed context. Supply exactly one tasks[] entry for a single invocation or multiple entries for parallel invocation. Use only when the final handoff will be substantially smaller than the raw material inspected — handle simple lookups, known-symbol traces, and one-or-two-file reads locally with parallel tool calls instead. Use explorer for repository evidence across several files and researcher only when several external sources must be read and summarized; keep direct documentation lookups local. Do not delegate planning, architecture, task decomposition, or implementation decisions — the main agent owns synthesis and planning. Give each subagent a narrow question, explicit scope, and requested evidence; ask for compact findings, not a work log. After it returns, rely on its cited findings; do not repeat its searches or reread cited files unless the handoff identifies a gap or conflicting evidence.",
		promptSnippet: "Delegate tasks",
		parameters: Type.Object({
			tasks: Type.Array(
				Type.Object({
					agent: Type.String({ description: "Name of the agent to invoke" }),
					task: Type.String({ description: "Task description" }),
					cwd: Type.Optional(Type.String({ description: "Working directory for the agent process" })),
				}),
				{
					minItems: 1,
					description: "One task for a single invocation, or multiple independent tasks for parallel invocation",
				},
			),
		}),
		prepareArguments(args) {
			if (!args || typeof args !== "object") {
				return args as { tasks: Array<{ agent: string; task: string; cwd?: string }> };
			}
			const input = args as {
				agent?: unknown;
				task?: unknown;
				tasks?: unknown;
				cwd?: unknown;
			};
			if (Array.isArray(input.tasks) && input.tasks.length > 0) {
				return { tasks: input.tasks };
			}
			if (typeof input.agent === "string" && input.agent && typeof input.task === "string" && input.task) {
				return {
					tasks: [{
						agent: input.agent,
						task: input.task,
						...(typeof input.cwd === "string" && input.cwd ? { cwd: input.cwd } : {}),
					}],
				};
			}
			return args as { tasks: Array<{ agent: string; task: string; cwd?: string }> };
		},

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			configStore.rememberMainModel(ctx.model);
			return invocationAdapter.execute(params, {
				cwd: ctx.cwd,
				maxConcurrency,
				signal,
				cacheAffinitySeed: ctx.sessionManager.getSessionId(),
				onUpdate,
			});
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
