/**
 * Runs specialized agents in isolated child Pi processes.
 * Supports single and parallel execution with verbal result handoff.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";
import { createSubagentRunManager, type SubagentRunManager } from "./subagent-runs.ts";
import { createSubagentBackgroundNotifications } from "./background-notifications.ts";
import { registerStructuredTool, registerSubagentRunTools, RunDetailsSchema, formatRunReports } from "./run-tools.ts";
import { declareStatus } from "../_shared/status-registry.ts";
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
		let generation = 0;
		let owner: { ctx: ExtensionContext; sessionId: string; generation: number } | undefined;
		let manager: SubagentRunManager | undefined;
		let notifications: ReturnType<typeof createSubagentBackgroundNotifications> | undefined;
		let refreshTimer: ReturnType<typeof setTimeout> | undefined;
		let stopping: Promise<void> | undefined;
		let admissionClosed = false;
		function ensureManager(ctx?: ExtensionContext): SubagentRunManager {
			if (admissionClosed) throw new Error("Background subagent admission is closed during session cleanup.");
			if (manager) return manager;
			if (!ctx) throw new Error("No active background subagent session.");
			const sessionId = ctx.sessionManager.getSessionId();
			const token = ++generation;
			owner = { ctx, sessionId, generation: token };
			const current = () => {
				if (owner?.generation !== token || owner.sessionId !== sessionId) return false;
				try { return ctx.sessionManager.getSessionId() === sessionId; } catch { return false; }
			};
			notifications = createSubagentBackgroundNotifications(pi, { sessionId, isCurrent: current });
			const delivery = notifications;
			manager = createSubagentRunManager({ execution, childExecution,
				onTerminal: (run) => delivery.complete(run),
				onChange() {
					if (!current() || refreshTimer) return;
					refreshTimer = setTimeout(() => {
						refreshTimer = undefined;
						if (!current()) return;
						const runs = manager!.list();
						const running = runs.filter((r) => r.status === "running" || r.status === "cancelling").length;
						const queued = runs.filter((r) => r.status === "queued").length;
						ctx.ui.setStatus("subagents", running || queued ? `${running} running · ${queued} queued` : undefined);
					}, 150);
				},
			});
			return manager;
		}
		function cleanup(reason: string, unregister = false): Promise<void> {
			if (stopping) return stopping;
			admissionClosed = true;
			notifications?.disable();
			manager?.close();
			const oldOwner = owner;
			const shutdownIds = unregister ? manager?.list().filter((r) => !["completed", "failed", "cancelled"].includes(r.status)).map((r) => r.runId) ?? [] : [];
			owner = undefined;
			generation++;
			if (refreshTimer) clearTimeout(refreshTimer);
			refreshTimer = undefined;
			stopping = (async () => {
				try {
					await manager?.dispose(reason);
					if (unregister && oldOwner && oldOwner.ctx.sessionManager.getSessionId() === oldOwner.sessionId) {
						for (const id of shutdownIds) {
							const run = manager!.get(id);
							try { pi.sendMessage({ customType: "subagent-completion", content: formatRunReports([run]), display: true, details: run }, { deliverAs: "followUp", triggerTurn: false }); } catch { /* Shutdown reports are best effort. */ }
						}
					}
				}
				finally {
					try { oldOwner?.ctx.ui.setStatus("subagents", undefined); } catch { /* SDK disposal may already have invalidated the UI. */ }
					if (unregister) unregisterService();
				}
			})();
			return stopping;
		}
		const service: SubagentService = {
			id: "tools-subagents",
			cancelBackgroundRuns: async (reason) => { await manager?.cancelAll(reason); },
			registerAgent: (config) => registry.register(config),
			unregisterAgent: (name) => registry.unregister(name),
			loadAgents: () => registry.load(),
			runSubagent: (options) => execution.runSubagent(options),
			runSubagentsParallel: (options) => execution.runSubagentsParallel(options),
		};

		const unregisterService = registerSubagentService(service);
		const profileInitialization = registerSessionProfileBinding(
			{ settingsPath },
			{
				name: "tools-subagents",
				applyPath: (binding) => configStore.setSettingsPath(binding.settingsPath),
				dispose: () => cleanup("Session ended", true),
				async initialize(_binding, _event, ctx) {
					registerSubagentService(service);
					admissionClosed = false;
					stopping = undefined;
					manager = undefined;
					configStore.rememberMainModel(ctx.model);
					// Carry a legacy config.json into the active Settings document once.
					await configStore.migrateLegacy();
					configStore.load();
				},
			},
		);
		registry.initialize();

		wireSessionProfileBinding(pi, profileInitialization);
		pi.on("session_shutdown", () => cleanup("Session ended", true));
		pi.on("session_tree", async (_event, ctx) => {
			await cleanup("Session branch changed");
			manager = undefined;
			notifications = undefined;
			stopping = undefined;
			admissionClosed = false;
			ensureManager(ctx);
		});
		registerSubagentRunTools(pi, (ctx) => ensureManager(ctx));
		pi.registerMessageRenderer?.("subagent-completion", (message, options, theme) =>
			renderSubagentResult({ content: [{ type: "text", text: String(message.content) }], details: { mode: "background", runs: [message.details] } }, options, theme));
		pi.on("model_select", (event) => configStore.rememberMainModel(event.model));

		pi.registerCommand("subagents", createSubagentsCommand({
			registry,
			config: configStore,
			childExecution,
			getRuns: () => manager,
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
				const runs = ensureManager(ctx).spawn(params.tasks, { cwd: ctx.cwd, signal, cacheAffinitySeed: ctx.sessionManager.getSessionId(), sessionId: ctx.sessionManager.getSessionId() });
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
