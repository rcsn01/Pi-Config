import type { AgentResult } from "../_shared/subagent-service.ts";
import type { ParallelBatchTask, ParallelSubagentBatch } from "./parallel-batch.ts";

export interface SubagentInvocationParameters {
	agent?: string;
	task?: string;
	tasks?: readonly ParallelBatchTask[];
	cwd?: string;
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
	dependencies: { batch: Pick<ParallelSubagentBatch, "runBatch"> },
): SubagentInvocationAdapter {
	return {
		async execute(parameters, options) {
			const hasParallelInvocation = Boolean(parameters.tasks?.length);
			const hasSingleFields = parameters.agent !== undefined || parameters.task !== undefined || parameters.cwd !== undefined;
			const hasCompleteSingleInvocation = Boolean(parameters.agent && parameters.task);
			if (
				(hasParallelInvocation && hasSingleFields) ||
				(!hasParallelInvocation && !hasCompleteSingleInvocation)
			) {
				throw new Error("Provide exactly one invocation mode: agent + task for single mode, or a non-empty tasks[] for parallel mode.");
			}

			const mode = hasParallelInvocation ? "parallel" : "single";
			const tasks = mode === "parallel"
				? parameters.tasks!
				: [{
					agent: parameters.agent!,
					task: parameters.task!,
					...(parameters.cwd ? { cwd: parameters.cwd } : {}),
				}];
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
