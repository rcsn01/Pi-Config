import type { AgentResult } from "../_shared/subagent-service.ts";
import type { SubagentExecution, SubagentExecutionTask } from "./subagent-execution.ts";

export interface SubagentInvocationParameters {
	tasks: readonly SubagentExecutionTask[];
}

export interface SubagentInvocationOptions {
	cwd: string;
	maxConcurrency?: number;
	signal?: AbortSignal;
	cacheAffinitySeed?: string;
	onUpdate?: (update: SubagentInvocationResult) => void;
}

export interface SubagentInvocationResult {
	content: [{ type: "text"; text: string }];
	details: {
		mode: "single" | "parallel";
		results: readonly AgentResult[];
	};
	isError?: true;
}

export interface SubagentInvocationAdapter {
	execute(
		parameters: SubagentInvocationParameters,
		options: SubagentInvocationOptions,
	): Promise<SubagentInvocationResult>;
}

export function isFailedSubagentResult(result: AgentResult): boolean {
	return result.exitCode !== 0 || result.progress.status === "failed" || Boolean(result.progress.error);
}

function createCancellableThrottle(callback: () => void, delayMs: number) {
	let lastCall: number | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	return {
		call() {
			const now = Date.now();
			if (lastCall === undefined || now - lastCall >= delayMs) {
				lastCall = now;
				if (timer) clearTimeout(timer);
				timer = undefined;
				callback();
				return;
			}
			if (!timer) {
				timer = setTimeout(() => {
					lastCall = Date.now();
					timer = undefined;
					callback();
				}, delayMs - (now - lastCall));
			}
		},
		cancel() {
			if (timer) clearTimeout(timer);
			timer = undefined;
		},
	};
}

export function createSubagentInvocationAdapter(
	dependencies: { batch: Pick<SubagentExecution, "runBatch"> },
): SubagentInvocationAdapter {
	return {
		async execute(parameters, options) {
			if (parameters.tasks.length === 0) {
				throw new Error("Provide at least one subagent task.");
			}

			const tasks = parameters.tasks;
			const mode = tasks.length === 1 ? "single" : "parallel";
			let displayedResults: readonly AgentResult[] = [];
			const publishUpdate = () => options.onUpdate?.({
				content: [{
					type: "text",
					text: mode === "parallel" ? `Running ${tasks.length} tasks...` : "(running...)",
				}],
				details: { mode, results: displayedResults },
			});
			const throttledParallelUpdate = createCancellableThrottle(publishUpdate, 150);
			let acceptingSnapshots = true;
			let results: AgentResult[];
			try {
				results = await dependencies.batch.runBatch(tasks, {
					cwd: options.cwd,
					maxConcurrency: options.maxConcurrency,
					signal: options.signal,
					cacheAffinitySeed: options.cacheAffinitySeed,
					onSnapshot: (snapshot) => {
						if (!acceptingSnapshots) return;
						displayedResults = snapshot.results;
						if (mode === "single") {
							if (snapshot.phase === "progress") publishUpdate();
							return;
						}
						if (snapshot.phase === "progress") throttledParallelUpdate.call();
						else {
							throttledParallelUpdate.cancel();
							publishUpdate();
						}
					},
				});
			} finally {
				acceptingSnapshots = false;
				throttledParallelUpdate.cancel();
			}
			const text = mode === "parallel"
				? results.map((result) =>
					`## ${result.agent}${isFailedSubagentResult(result) ? " (FAILED)" : ""}\n\n${result.output || "(no output)"}`
				).join("\n\n---\n\n")
				: results[0].output || "(no output)";
			return {
				content: [{ type: "text", text }],
				details: { mode, results },
				...(results.some(isFailedSubagentResult) ? { isError: true as const } : {}),
			};
		},
	};
}
