import type { ContextUsage, SessionEntry } from "@earendil-works/pi-coding-agent";

export type EfficiencyLevel = "none" | "checkpoint" | "strong";

export interface EfficiencyMetrics {
	modelCalls: number;
	toolCalls: number;
	testRuns: number;
	cost: number;
	contextPercent: number;
}

export interface EfficiencyThresholds {
	modelCalls: number;
	testRuns: number;
	cost: number;
	contextPercent: number;
}

export const CHECKPOINT_THRESHOLDS: EfficiencyThresholds = {
	modelCalls: 30,
	testRuns: 8,
	cost: 3,
	contextPercent: 60,
};

export const STRONG_THRESHOLDS: EfficiencyThresholds = {
	modelCalls: 60,
	testRuns: 15,
	cost: 7,
	contextPercent: 75,
};

const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);
const PACKAGE_OPTIONS_WITH_VALUE = new Set(["--dir", "--prefix", "--cwd", "--filter", "-C"]);
const DIRECT_RUNNERS = new Set(["vitest", "jest", "pytest"]);

function shellTokens(segment: string): string[] {
	return segment.match(/(?:[^\s"'\\]+|"(?:\\.|[^"])*"|'[^']*')+/g)
		?.map((token) => token.replace(/^(["'])(.*)\1$/, "$2")) ?? [];
}

function skipOptions(tokens: readonly string[], start: number): number {
	let index = start;
	while (index < tokens.length && tokens[index]!.startsWith("-")) {
		const option = tokens[index++]!;
		if (PACKAGE_OPTIONS_WITH_VALUE.has(option) && index < tokens.length) index++;
	}
	return index;
}

function isTestSegment(segment: string): boolean {
	const tokens = shellTokens(segment);
	let index = 0;
	while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index] ?? "")) index++;
	if (tokens[index] === "env") {
		index = skipOptions(tokens, index + 1);
		while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index] ?? "")) index++;
	}
	if (tokens[index] === "sudo") index = skipOptions(tokens, index + 1);

	const executable = tokens[index]?.replace(/^.*[\\/]/, "").toLowerCase();
	if (!executable) return false;
	if (DIRECT_RUNNERS.has(executable)) return true;
	if ((executable === "npx" || executable === "bunx") && DIRECT_RUNNERS.has(tokens[index + 1]?.toLowerCase() ?? "")) return true;
	if (executable === "python" || executable === "python3") {
		return tokens[index + 1] === "-m" && tokens[index + 2]?.toLowerCase() === "pytest";
	}
	if (executable === "go" || executable === "cargo" || executable === "dotnet") return tokens[index + 1] === "test";
	if (executable === "node") return tokens.slice(index + 1).includes("--test");
	if (executable === "mvn" || executable === "mvnw" || executable === "gradle" || executable === "gradlew") {
		const commandIndex = skipOptions(tokens, index + 1);
		return tokens[commandIndex] === "test";
	}
	if (!PACKAGE_MANAGERS.has(executable)) return false;

	index = skipOptions(tokens, index + 1);
	if (tokens[index] === "exec" || (executable === "yarn" && tokens[index] === "dlx")) {
		return DIRECT_RUNNERS.has(tokens[index + 1]?.toLowerCase() ?? "");
	}
	if (tokens[index] === "run") index++;
	const script = tokens[index]?.toLowerCase() ?? "";
	return script === "t" || script === "test" || script.startsWith("test:");
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function usageCost(value: unknown): number {
	const usage = record(value);
	const cost = record(usage?.cost);
	if (!cost) return 0;
	const total = cost.total;
	if (typeof total === "number" && Number.isFinite(total)) return Math.max(0, total);
	return ["input", "output", "cacheRead", "cacheWrite"]
		.reduce((sum, key) => {
			const amount = cost[key];
			return sum + (typeof amount === "number" && Number.isFinite(amount) ? Math.max(0, amount) : 0);
		}, 0);
}

export function isRecognizedTestCommand(command: string): boolean {
	return command.split(/&&|\|\||[;\n]/).some(isTestSegment);
}

export function collectEfficiencyMetrics(
	entries: readonly SessionEntry[],
	contextUsage?: ContextUsage,
): EfficiencyMetrics {
	let modelCalls = 0;
	let toolCalls = 0;
	let testRuns = 0;
	let cost = 0;

	for (const entry of entries) {
		const item = record(entry)!;
		const message = record(item.message);
		const usage = message?.usage ?? item.usage;
		cost += usageCost(usage);

		if ((message?.role === "assistant" || item.type === "compaction" || item.type === "branch_summary") && record(usage)) {
			modelCalls++;
		}
		if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const blockValue of message.content) {
			const block = record(blockValue);
			if (block?.type !== "toolCall") continue;
			toolCalls++;
			if (block.name !== "bash" && block.name !== "plan_bash") continue;
			const args = record(block.arguments);
			if (typeof args?.command === "string" && isRecognizedTestCommand(args.command)) testRuns++;
		}
	}

	const reportedPercent = contextUsage?.percent;
	const calculatedPercent = contextUsage?.tokens != null && contextUsage.contextWindow > 0
		? contextUsage.tokens / contextUsage.contextWindow * 100
		: 0;
	const contextPercent = Math.max(
		0,
		Math.min(100, typeof reportedPercent === "number" && Number.isFinite(reportedPercent) ? reportedPercent : calculatedPercent),
	);

	return { modelCalls, toolCalls, testRuns, cost, contextPercent };
}

function crosses(metrics: EfficiencyMetrics, thresholds: EfficiencyThresholds): boolean {
	return metrics.modelCalls >= thresholds.modelCalls ||
		metrics.testRuns >= thresholds.testRuns ||
		metrics.cost >= thresholds.cost ||
		metrics.contextPercent >= thresholds.contextPercent;
}

export function efficiencyLevel(metrics: EfficiencyMetrics): EfficiencyLevel {
	if (crosses(metrics, STRONG_THRESHOLDS)) return "strong";
	if (crosses(metrics, CHECKPOINT_THRESHOLDS)) return "checkpoint";
	return "none";
}

export function efficiencyLevelRank(level: EfficiencyLevel): number {
	return level === "strong" ? 2 : level === "checkpoint" ? 1 : 0;
}
