import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { vi } from "vitest";
import type { AgentConfig, AgentResult } from "../_shared/subagent-service.ts";
import { createAgentRegistry, type AgentRegistry } from "./agent-registry.ts";
import {
	applySubagentConfigurationChanges,
	normalizeModelSetting,
	parseModelConfiguration,
	resolveSubagentAssignment,
	type ExtensionConfig,
	type SubagentConfigStore,
} from "./config.ts";
import type { SpawnSubagentProcess } from "./child-execution.ts";

export function agent(overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name: "worker",
		description: "Worker",
		tools: ["read", "safe_bash"],
		model: "openai/test-model",
		systemPrompt: "You are a worker.",
		filePath: "/agents/worker.md",
		...overrides,
	};
}

export function agentResult(overrides: Partial<AgentResult> = {}): AgentResult {
	const name = overrides.agent ?? "worker";
	const task = overrides.task ?? "Do work";
	return {
		agent: name,
		task,
		output: "Done",
		exitCode: 0,
		model: "openai/test-model",
		thinkingLevel: "minimal",
		usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.01, turns: 1 },
		progress: {
			agent: name,
			status: "completed",
			task,
			recentTools: [],
			toolCount: 0,
			tokens: 15,
			durationMs: 100,
			lastMessage: "Done",
		},
		...overrides,
	};
}

export interface MemoryConfigStore extends SubagentConfigStore {
	document: Record<string, unknown>;
	updates: Record<string, unknown>[];
}

export function memoryConfigStore(initial: Record<string, unknown> = {}): MemoryConfigStore {
	let activeMainModel: string | undefined;
	let settingsPath = "/config.json";
	const store: MemoryConfigStore = {
		get configPath() {
			return settingsPath;
		},
		document: structuredClone(initial),
		updates: [],
		load: () => {
			const parsed = parseModelConfiguration(store.document);
			return { ...parsed, maxConcurrency: store.document.maxConcurrency as number | undefined } satisfies ExtensionConfig;
		},
		async applyChanges(changes) {
			store.document = applySubagentConfigurationChanges(structuredClone(store.document), changes);
			store.updates.push(structuredClone(store.document));
		},
		rememberMainModel(model) {
			if (!model) {
				activeMainModel = undefined;
				return;
			}
			if (typeof model.provider !== "string" || typeof model.id !== "string") {
				throw new Error('Cannot resolve subagent model "main": the main session has no active model.');
			}
			activeMainModel = normalizeModelSetting(`${model.provider}/${model.id}`, "main session model");
		},
		resolveMainModel: () => {
			if (!activeMainModel) throw new Error('Cannot resolve subagent model "main": the main session has no active model.');
			return activeMainModel;
		},
		resolveAssignment(config, options = {}) {
			let document: unknown = options.snapshot ?? store.document;
			if (options.changes) document = applySubagentConfigurationChanges(document, options.changes);
			return resolveSubagentAssignment({
				agentName: config.name,
				config: document,
				explicitModel: options.explicitModel,
				explicitThinkingLevel: options.explicitThinkingLevel,
				frontmatterModel: config.model,
				mainModel: activeMainModel,
			});
		},
		resolveLaunch(config, explicitModel, explicitThinkingLevel) {
			return store.resolveAssignment(config, { explicitModel, explicitThinkingLevel }).launch;
		},
		setSettingsPath: (path: string) => {
			settingsPath = path;
		},
		migrateLegacy: async () => false,
	};
	return store;
}

export function memoryRegistry(agents: AgentConfig[] = [agent()]): AgentRegistry {
	const registry = createAgentRegistry("/path/that/does/not/exist");
	for (const config of agents) registry.register(config);
	return registry;
}

export interface FakeProcess extends EventEmitter {
	stdout: PassThrough;
	stderr: PassThrough;
	stdio: [null, PassThrough, PassThrough, PassThrough, null];
	killed: boolean;
	kill: ReturnType<typeof vi.fn>;
}

export function fakeProcess(closeOnKill = false): FakeProcess {
	const process = new EventEmitter() as FakeProcess;
	process.stdout = new PassThrough();
	process.stderr = new PassThrough();
	process.stdio = [null, process.stdout, process.stderr, new PassThrough(), null];
	process.killed = false;
	process.kill = vi.fn((_signal?: string) => {
		process.killed = true;
		if (closeOnKill) queueMicrotask(() => process.emit("close", 143));
		return true;
	});
	return process;
}

export function spawnHarness() {
	const processes: FakeProcess[] = [];
	const spawnProcess = vi.fn<SpawnSubagentProcess>((_command, _args, _options) => {
		const process = fakeProcess();
		processes.push(process);
		return process as unknown as ChildProcessWithoutNullStreams;
	});
	return { processes, spawnProcess };
}

export function emitProcessResult(
	process: FakeProcess,
	options: { stdout?: string | string[]; stderr?: string; exitCode?: number } = {},
): void {
	for (const chunk of typeof options.stdout === "string" ? [options.stdout] : options.stdout ?? []) {
		process.stdout.write(chunk);
	}
	if (options.stderr) process.stderr.write(options.stderr);
	process.emit("close", options.exitCode ?? 0);
}

export function theme() {
	return {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	} as any;
}
