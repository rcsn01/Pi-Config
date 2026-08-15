import type {
	ExtensionAPI,
	ExtensionContext,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import {
	CHECKPOINT_THRESHOLDS,
	STRONG_THRESHOLDS,
	collectEfficiencyMetrics,
	efficiencyLevel,
	efficiencyLevelRank,
	type EfficiencyLevel,
	type EfficiencyMetrics,
} from "./budget-model.ts";

const STATE_ENTRY_TYPE = "efficiency-guardrail-state";
const MESSAGE_TYPE = "efficiency-checkpoint";
const STATUS_KEY = "efficiency-budget";

interface PersistedState {
	level: EfficiencyLevel;
}

function persistedLevel(entries: readonly SessionEntry[]): EfficiencyLevel {
	let level: EfficiencyLevel = "none";
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== STATE_ENTRY_TYPE) continue;
		const candidate = (entry.data as Partial<PersistedState> | undefined)?.level;
		if (candidate && efficiencyLevelRank(candidate) > efficiencyLevelRank(level)) level = candidate;
	}
	return level;
}

function formatMoney(value: number): string {
	return `$${value.toFixed(2)}`;
}

function metricsSummary(metrics: EfficiencyMetrics): string {
	return [
		`${metrics.modelCalls} model calls`,
		`${metrics.toolCalls} tool calls`,
		`${metrics.testRuns} test runs`,
		formatMoney(metrics.cost),
		`${metrics.contextPercent.toFixed(0)}% context`,
	].join(" · ");
}

function checkpointMessage(level: Exclude<EfficiencyLevel, "none">, metrics: EfficiencyMetrics): string {
	const instruction = level === "strong"
		? "Stop broadening the work. Reassess the minimum remaining scope, batch the remaining actions, and run no additional test or review variants unless a current failure requires them."
		: "Pause and reassess the remaining scope. Batch the remaining actions and avoid redundant exploration, tests, and reviews.";
	return `Efficiency ${level === "strong" ? "strong checkpoint" : "checkpoint"}: ${metricsSummary(metrics)}. ${instruction}`;
}

function thresholdSummary(): string {
	return [
		`Checkpoint: ${CHECKPOINT_THRESHOLDS.modelCalls} calls / ${CHECKPOINT_THRESHOLDS.testRuns} tests / ${formatMoney(CHECKPOINT_THRESHOLDS.cost)} / ${CHECKPOINT_THRESHOLDS.contextPercent}% context`,
		`Strong: ${STRONG_THRESHOLDS.modelCalls} calls / ${STRONG_THRESHOLDS.testRuns} tests / ${formatMoney(STRONG_THRESHOLDS.cost)} / ${STRONG_THRESHOLDS.contextPercent}% context`,
	].join("\n");
}

export default function efficiencyGuardrailExtension(pi: ExtensionAPI): void {
	let reachedLevel: EfficiencyLevel = "none";

	function updateStatus(ctx: ExtensionContext): void {
		const text = reachedLevel === "strong" ? "‼ efficiency" : reachedLevel === "checkpoint" ? "⚠ efficiency" : undefined;
		ctx.ui.setStatus(STATUS_KEY, text);
	}

	function evaluate(ctx: ExtensionContext): EfficiencyMetrics {
		const entries = ctx.sessionManager.getEntries();
		const persisted = persistedLevel(entries);
		if (efficiencyLevelRank(persisted) > efficiencyLevelRank(reachedLevel)) reachedLevel = persisted;

		const metrics = collectEfficiencyMetrics(entries, ctx.getContextUsage());
		const target = efficiencyLevel(metrics);
		if (efficiencyLevelRank(target) > efficiencyLevelRank(reachedLevel)) {
			reachedLevel = target;
			pi.appendEntry(STATE_ENTRY_TYPE, { level: target } satisfies PersistedState);
			pi.sendMessage({
				customType: MESSAGE_TYPE,
				content: checkpointMessage(target as Exclude<EfficiencyLevel, "none">, metrics),
				display: true,
				details: { level: target, metrics },
			}, {
				triggerTurn: false,
				...(ctx.isIdle() ? {} : { deliverAs: "steer" as const }),
			});
		}
		updateStatus(ctx);
		return metrics;
	}

	function reconstruct(ctx: ExtensionContext): void {
		reachedLevel = persistedLevel(ctx.sessionManager.getEntries());
		evaluate(ctx);
	}

	pi.on("session_start", (_event, ctx) => reconstruct(ctx));
	pi.on("session_tree", (_event, ctx) => reconstruct(ctx));
	pi.on("session_compact", (_event, ctx) => { evaluate(ctx); });
	pi.on("turn_end", (_event, ctx) => { evaluate(ctx); });
	pi.on("agent_settled", (_event, ctx) => { evaluate(ctx); });
	pi.on("session_shutdown", (_event, ctx) => ctx.ui.setStatus(STATUS_KEY, undefined));

	pi.registerCommand("efficiency", {
		description: "show session efficiency metrics and checkpoint thresholds",
		handler: async (_args, ctx) => {
			const metrics = evaluate(ctx);
			ctx.ui.notify(
				`${metricsSummary(metrics)}\nState: ${reachedLevel}\n${thresholdSummary()}`,
				reachedLevel === "strong" ? "warning" : "info",
			);
		},
	});
}
