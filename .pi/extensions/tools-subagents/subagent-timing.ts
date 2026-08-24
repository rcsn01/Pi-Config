import type { SubagentTiming } from "../_shared/subagent-service.ts";

interface Interval {
	start: number;
	end: number;
}

interface ActiveTool {
	name: string;
	start: number;
}

export interface SubagentTimingRecorder {
	recordEvent(event: unknown, timestamp?: number): void;
	finish(timestamp?: number): SubagentTiming;
}

/**
 * Classify child-process wall time from Pi's JSON event stream.
 *
 * Tool time takes precedence over overlapping model/provider time. repo_query
 * time is reported as a labeled subset of tool time, not as another part of
 * the total. Missing or malformed event pairs make the result partial.
 */
export function createSubagentTimingRecorder(
	clock: () => number = monotonicNow,
): SubagentTimingRecorder {
	const startedAt = clock();
	let agentStartedAt: number | undefined;
	let sawAgentEnd = false;
	let activeTurn: number | undefined;
	let anomalyCount = 0;
	let repositoryQueries = 0;
	let repositoryOperations = 0;
	const activeTools = new Map<string, ActiveTool>();
	const modelIntervals: Interval[] = [];
	const toolIntervals: Interval[] = [];
	const repoQueryIntervals: Interval[] = [];

	const recordEvent = (event: unknown, timestamp = clock()): void => {
		if (!isRecord(event) || typeof event.type !== "string") return;
		const at = Math.max(startedAt, timestamp);

		switch (event.type) {
			case "agent_start":
				if (agentStartedAt === undefined) agentStartedAt = at;
				else anomalyCount++;
				break;
			case "agent_end":
				sawAgentEnd = true;
				break;
			case "turn_start":
				if (activeTurn === undefined) activeTurn = at;
				else anomalyCount++;
				break;
			case "message_end":
				if (isAssistantMessage(event.message)) {
					if (activeTurn === undefined) anomalyCount++;
					else {
						modelIntervals.push(interval(activeTurn, at));
						activeTurn = undefined;
					}
				}
				break;
			case "tool_execution_start": {
				const id = event.toolCallId;
				const name = event.toolName;
				if (typeof id !== "string" || typeof name !== "string") {
					anomalyCount++;
					break;
				}
				if (activeTools.has(id)) {
					anomalyCount++;
					break;
				}
				activeTools.set(id, { name, start: at });
				if (name === "repo_query") repositoryQueries++;
				break;
			}
			case "tool_execution_end": {
				const id = event.toolCallId;
				if (typeof id !== "string") {
					anomalyCount++;
					break;
				}
				const active = activeTools.get(id);
				if (!active) {
					anomalyCount++;
					break;
				}
				activeTools.delete(id);
				const completed = interval(active.start, at);
				toolIntervals.push(completed);
				if (active.name === "repo_query") {
					repoQueryIntervals.push(completed);
					repositoryOperations += operationCount(event.result);
				}
				break;
			}
		}
	};

	const finish = (timestamp = clock()): SubagentTiming => {
		const finishedAt = Math.max(startedAt, timestamp);
		if (activeTurn !== undefined) {
			modelIntervals.push(interval(activeTurn, finishedAt));
			activeTurn = undefined;
			anomalyCount++;
		}
		for (const active of activeTools.values()) {
			const unfinished = interval(active.start, finishedAt);
			toolIntervals.push(unfinished);
			if (active.name === "repo_query") repoQueryIntervals.push(unfinished);
			anomalyCount++;
		}
		activeTools.clear();

		const totalInterval = interval(startedAt, finishedAt);
		const startupIntervals = agentStartedAt === undefined
			? []
			: [interval(startedAt, Math.min(agentStartedAt, finishedAt))];
		const startupMs = agentStartedAt === undefined ? undefined : unionDuration(startupIntervals);
		const toolWallMs = exclusiveDuration(toolIntervals, startupIntervals, totalInterval);
		const modelPhaseMs = exclusiveDuration(modelIntervals, [...startupIntervals, ...toolIntervals], totalInterval);
		const classifiedMs = (startupMs ?? 0) + toolWallMs + modelPhaseMs;
		const totalMs = duration(totalInterval);

		return {
			totalMs,
			startupMs,
			modelPhaseMs,
			toolWallMs,
			repoQueryWallMs: exclusiveDuration(repoQueryIntervals, startupIntervals, totalInterval),
			unclassifiedMs: Math.max(0, totalMs - classifiedMs),
			repositoryQueries,
			repositoryOperations,
			partial: agentStartedAt === undefined || !sawAgentEnd || anomalyCount > 0,
			anomalyCount,
		};
	};

	return { recordEvent, finish };
}

function operationCount(result: unknown): number {
	if (!isRecord(result) || !isRecord(result.details)) return 0;
	return Array.isArray(result.details.operations) ? result.details.operations.length : 0;
}

function isAssistantMessage(value: unknown): boolean {
	return isRecord(value) && value.role === "assistant";
}

function interval(start: number, end: number): Interval {
	return { start, end: Math.max(start, end) };
}

function duration(value: Interval): number {
	return Math.max(0, value.end - value.start);
}

function exclusiveDuration(intervals: Interval[], blockers: Interval[], bounds: Interval): number {
	const clipped = intervals
		.map((value) => ({ start: Math.max(bounds.start, value.start), end: Math.min(bounds.end, value.end) }))
		.filter((value) => value.end > value.start);
	const blocked = mergeIntervals(blockers);
	const remaining: Interval[] = [];

	for (const value of clipped) {
		let fragments = [value];
		for (const blocker of blocked) {
			fragments = fragments.flatMap((fragment) => subtractInterval(fragment, blocker));
			if (fragments.length === 0) break;
		}
		remaining.push(...fragments);
	}
	return unionDuration(remaining);
}

function subtractInterval(value: Interval, blocker: Interval): Interval[] {
	if (blocker.end <= value.start || blocker.start >= value.end) return [value];
	const result: Interval[] = [];
	if (blocker.start > value.start) result.push({ start: value.start, end: Math.min(blocker.start, value.end) });
	if (blocker.end < value.end) result.push({ start: Math.max(blocker.end, value.start), end: value.end });
	return result;
}

function unionDuration(intervals: Interval[]): number {
	return mergeIntervals(intervals).reduce((sum, value) => sum + duration(value), 0);
}

function mergeIntervals(intervals: Interval[]): Interval[] {
	const sorted = intervals
		.filter((value) => value.end > value.start)
		.sort((left, right) => left.start - right.start || left.end - right.end);
	const merged: Interval[] = [];
	for (const value of sorted) {
		const previous = merged.at(-1);
		if (!previous || value.start > previous.end) merged.push({ ...value });
		else previous.end = Math.max(previous.end, value.end);
	}
	return merged;
}

function isRecord(value: unknown): value is Record<string, any> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function monotonicNow(): number {
	return performance.now();
}
