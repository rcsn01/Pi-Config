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
import { registerSessionProfileBinding, wireSessionProfileBinding } from "../_shared/session-profile-binding.ts";
import { PROJECT_SETTINGS_PATH } from "../_shared/settings-document.ts";
import {
	agentRegistry,
	loadAgents,
	registerAgent,
	unregisterAgent,
	type AgentRegistry,
} from "./agent-registry.ts";
import {
	createSubagentChildExecution,
	type SubagentChildExecution,
} from "./child-execution.ts";
import {
	createSubagentConfigStore,
	LEGACY_CONFIG_PATH,
	type SubagentConfigStore,
} from "./config.ts";
import { createSubagentsCommand } from "./model-commands.ts";
import { renderSubagentCall, renderSubagentResult } from "./progress-renderer.ts";
import { createSubagentExecution } from "./subagent-execution.ts";
import {
	createSubagentInvocationAdapter,
	isFailedSubagentResult,
} from "./subagent-invocation.ts";

export type {
	AgentConfig,
	AgentProgress,
	AgentResult,
	RunSubagentOptions,
	RunSubagentsParallelOptions,
	SubagentProgressEvent,
} from "../_shared/subagent-service.ts";
export { loadAgents, registerAgent, unregisterAgent } from "./agent-registry.ts";
export { runSubagent, runSubagentsParallel } from "./subagent-execution.ts";

export interface SubagentsExtensionDependencies {
	settingsPath?: string;
	registry?: AgentRegistry;
	config?: SubagentConfigStore;
	childExecution?: SubagentChildExecution;
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
		const childExecution = dependencies.childExecution ?? createSubagentChildExecution();
		const execution = createSubagentExecution({ registry, config: configStore, childExecution });
		const invocationAdapter = createSubagentInvocationAdapter({ batch: execution });
		const service: SubagentService = {
			id: "tools-subagents",
			registerAgent: (config) => registry.register(config),
			unregisterAgent: (name) => registry.unregister(name),
			loadAgents: () => registry.load(),
			runSubagent: (options) => execution.runSubagent(options),
			runSubagentsParallel: (options) => execution.runSubagentsParallel(options),
		};

		registerSubagentService(service);
		const profileInitialization = registerSessionProfileBinding(
			{ settingsPath },
			{
				name: "tools-subagents",
				applyPath: (binding) => configStore.setSettingsPath(binding.settingsPath),
				async initialize(_binding, _event, ctx) {
					configStore.rememberMainModel(ctx.model);
					// Carry a legacy config.json into the active Settings document once.
					await configStore.migrateLegacy();
					configStore.load();
				},
			},
		);
		registry.initialize();

		wireSessionProfileBinding(pi, profileInitialization);
		pi.on("model_select", (event) => configStore.rememberMainModel(event.model));

		pi.registerCommand("subagents", createSubagentsCommand({ registry, config: configStore }));

		pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description:
			"Use this tool only when a subagent will inspect substantially more material than it returns. Do not delegate planning, architecture, design alternatives, task decomposition, or implementation decisions; the main agent must do those itself. Available agents, using these exact names: explorer for read-only investigation across several repository files; researcher for research requiring several external sources; worker for implementing a bounded change after the main agent has decided the design; judge for evaluating supplied work against an explicit rubric; default for small general delegated work. Use parallel tasks only when they are independent. Give each task all necessary context, a narrow scope, and the evidence or output required. Do not use this tool for simple lookups, known-symbol traces, direct documentation reads, or one-or-two-file inspections; use local tools, including parallel tool calls, instead. Supply exactly one tasks[] entry for a single invocation or multiple entries for parallel invocation. Ask for compact findings, not a work log. After a subagent returns, rely on its cited findings; do not repeat its searches or reread cited files unless the handoff identifies a gap or conflicting evidence.",
		promptSnippet: "Delegate tasks",
		parameters: Type.Object({
			tasks: Type.Array(
				Type.Object({
					agent: Type.String({
						description: "Exact registered agent name: default, explorer, worker, researcher, or judge. Never invent a role name.",
					}),
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
