import { vi } from "vitest";
import { createSubagentRunManager } from "./subagent-runs.ts";
import { createSubagentExecution } from "./subagent-execution.ts";
import { agentResult, memoryRegistry, memoryConfigStore } from "./test-harness.ts";
import { deferred } from "./test-harness.ts";

export function runHarness(concurrency = 4) {
	const requests: any[] = [];
	const gates: ReturnType<typeof deferred<ReturnType<typeof agentResult>>>[] = [];
	const child = {
		inspectTools: vi.fn(() => [] as any[]),
		execute: vi.fn(async (request: any) => {
			requests.push(request);
			const gate = deferred<ReturnType<typeof agentResult>>(); gates.push(gate);
			return gate.promise;
		}),
	};
	const config = memoryConfigStore({ maxConcurrency: concurrency });
	const execution = createSubagentExecution({ registry: memoryRegistry(), config, childExecution: child });
	const terminal = vi.fn();
	const manager = createSubagentRunManager({ execution, childExecution: child, onTerminal: terminal });
	const spawn = (count = 1, signal?: AbortSignal) => manager.spawn(Array.from({ length: count }, (_, i) => ({ agent: "worker", task: `task ${i}` })), { cwd: process.cwd(), sessionId: "session", signal });
	return { manager, spawn, gates, requests, terminal, child, config, execution };
}
