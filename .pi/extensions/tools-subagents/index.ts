/**
 * Runs specialized agents in isolated child Pi processes.
 * Supports single and parallel execution with verbal result handoff.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";
import { createSubagentSessionExecution, type SubagentSessionHost } from "./session-execution.ts";
import { registerStructuredTool, registerSubagentRunTools, RunDetailsSchema, formatRunReports } from "./run-tools.ts";
import { backgroundNotifications } from "../_shared/background-notifications.ts";
import { declareStatus } from "../_shared/status-registry.ts";
import { Type } from "typebox";
import { registerToolErrorHandler } from "../_shared/tool-result-ui.ts";
import {
	type AgentConfig,
	type AgentProgress,
	type AgentResult,
	type RunSubagentOptions,
	type RunSubagentsParallelOptions,
	type SubagentProgressEvent,
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

declareStatus({ id: "subagents", style: "muted", order: 75 });

const WORKFLOW_ONLY_AGENTS = new Set(["judge", "worker"]);

function assertPublicAgentAccess(tasks: readonly { agent: string }[]): void {
	const restricted = tasks.find((task) => WORKFLOW_ONLY_AGENTS.has(task.agent));
	if (restricted) throw new Error(`Subagent "${restricted.agent}" is only available to workflows.`);
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
		const notifications = backgroundNotifications(pi);
		const sessionExecution = createSubagentSessionExecution({ execution, registry, childExecution });
		function sessionHost(ctx: ExtensionContext): SubagentSessionHost {
			return {
				sessionId: ctx.sessionManager.getSessionId(),
				getSessionId: () => ctx.sessionManager.getSessionId(),
				setStatus: (status) => ctx.ui.setStatus("subagents", status),
				publishCompletion: (run, options) => notifications.publish({
					source: "subagent", runId: run.runId, timestamp: Date.now(),
					customType: "subagent-completion", content: formatRunReports([run]), details: run, wake: options.triggerTurn,
				}, ctx),
			};
		}
		const profileInitialization = registerSessionProfileBinding(
			{ settingsPath },
			{
				name: "tools-subagents",
				applyPath: (binding) => configStore.setSettingsPath(binding.settingsPath),
				dispose: () => sessionExecution.handle({ type: "shutdown", reason: "Session ended" }),
				initialize(_binding, _event, ctx) {
					const mainModel = ctx.model;
					return sessionExecution.handle({
						type: "sessionStarted", host: sessionHost(ctx),
						prepare: async () => {
							configStore.rememberMainModel(mainModel);
							await configStore.migrateLegacy();
							configStore.load();
						},
					});
				},
			},
		);
		registry.initialize();
		wireSessionProfileBinding(pi, profileInitialization, {
			afterStop: () => sessionExecution.handle({ type: "shutdown", reason: "Session ended" }),
		});
		pi.on("session_tree", (_event, ctx) => sessionExecution.handle({ type: "branchChanged", host: sessionHost(ctx) }));
		registerSubagentRunTools(pi, sessionExecution.runs);
		pi.registerMessageRenderer?.("subagent-completion", (message, options, theme) =>
			renderSubagentResult({ content: [{ type: "text", text: String(message.content) }], details: { mode: "background", runs: [message.details] } }, options, theme));
		pi.on("model_select", (event) => configStore.rememberMainModel(event.model));

		pi.registerCommand("subagents", createSubagentsCommand({
			registry,
			config: configStore,
			childExecution,
			runs: sessionExecution.runs,
		}));

		registerStructuredTool(pi, {
		name: "subagent",
		label: "Subagent",
		description:
			"Delegate only bounded work that examines substantially more material than it returns. Choose the agent by role: explorer for multi-file repository investigation, researcher for multi-source external research, and default for small bounded tasks such as running existing tests or commands. Keep architecture, interface design, planning, decomposition, and implementation in the main agent. Every delegated task must explicitly state: Objective, Scope, Allowed actions, Forbidden actions, Required output, and Stop conditions. Do not assume the subagent inherits conversation context; include all facts and constraints it needs. Use local tools for simple lookups, known-symbol traces, direct documentation, and quick commands. Parallelize only independent tasks that cannot contend over mutable state. Request concise findings with evidence rather than logs. In TUI/RPC, background is the default: accepted run IDs return immediately and final results arrive as follow-up messages. Continue unrelated work; use subagent_status to inspect, subagent_wait to wait, and subagent_cancel to stop runs. Set background: false to await final results. Print/JSON only support foreground. Children are one-shot.",
		promptSnippet: "Delegate tasks",
		outputSchema: Type.Union([RunDetailsSchema, Type.Object({ mode: Type.Union([Type.Literal("single"), Type.Literal("parallel")]), results: Type.Array(Type.Unknown()) })]),
		parameters: Type.Object({
			background: Type.Optional(Type.Boolean()),
			tasks: Type.Array(
				Type.Object({
					agent: Type.String({
						description: "Registered agent name. Built-ins available here: default, explorer, or researcher.",
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
				background?: unknown;
				agent?: unknown;
				task?: unknown;
				tasks?: unknown;
				cwd?: unknown;
			};
			if (Array.isArray(input.tasks) && input.tasks.length > 0) {
				return { tasks: input.tasks, ...(input.background !== undefined ? { background: input.background as boolean } : {}) };
			}
			if (typeof input.agent === "string" && input.agent && typeof input.task === "string" && input.task) {
				return {
					...(input.background !== undefined ? { background: input.background as boolean } : {}),
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
			assertPublicAgentAccess(params.tasks);
			configStore.rememberMainModel(ctx.model);
			const longLived = ctx.mode === "tui" || ctx.mode === "rpc";
			const background = params.background ?? longLived;
			if (background && !longLived) throw new Error("Background subagents require TUI or RPC mode. Use background: false in print/JSON mode.");
			if (background) {
				const runs = sessionExecution.spawn(params.tasks, { cwd: ctx.cwd, signal });
				const details = { mode: "background" as const, runs };
				return { content: [{ type: "text", text: `Accepted background runs. Continue working; results will arrive later.\n\n${formatRunReports(runs, false)}` }], details, structuredContent: details };
			}
			const result = await invocationAdapter.execute(params, {
				cwd: ctx.cwd,
				signal,
				cacheAffinitySeed: ctx.sessionManager.getSessionId(),
				onUpdate,
			});
			return { ...result, structuredContent: result.details };
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
