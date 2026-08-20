import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Box, MarkdownTheme } from "@earendil-works/pi-tui";
import {
	createSemanticMarkdownTheme,
	normalizeTranscriptContent,
	renderTranscriptCard,
} from "../_shared/transcript-card.ts";
import {
	PROPOSED_PLAN_CUSTOM_TYPE,
	PROPOSED_PLAN_ENTRY_TYPE,
	type ProposedPlanDetails,
} from "./plan-content.ts";
import { isPlanMode, type PlanState } from "./plan-state.ts";

/** Backward-compatible export for callers that used the plan-specific Markdown theme. */
export function createPlanMarkdownTheme(theme: Theme): MarkdownTheme {
	return createSemanticMarkdownTheme(theme);
}

export function renderProposedPlan(
	content: string,
	createdAt: number | undefined,
	expanded: boolean,
	theme: Theme,
): Box {
	return renderTranscriptCard(theme, {
		title: "Proposed Plan",
		body: content,
		summary: "Plan ready · expand to view",
		metadata: createdAt ? [`created ${new Date(createdAt).toLocaleString()}`] : undefined,
		expanded,
	});
}

/** Register both durable legacy and transcript-only proposed-plan renderers. */
export function registerPlanRenderers(pi: ExtensionAPI): void {
	pi.registerMessageRenderer<ProposedPlanDetails>(
		PROPOSED_PLAN_CUSTOM_TYPE,
		(message, { expanded }, theme) => renderProposedPlan(
			normalizeTranscriptContent(message.content),
			message.details?.createdAt,
			expanded,
			theme,
		),
	);

	pi.registerEntryRenderer(PROPOSED_PLAN_ENTRY_TYPE, (entry, { expanded }, theme) => {
		const data = entry.data as { content?: unknown; createdAt?: number } | undefined;
		return renderProposedPlan(normalizeTranscriptContent(data?.content), data?.createdAt, expanded, theme);
	});
}

/** Render status from an immutable state snapshot. */
export function updatePlanStatus(ctx: ExtensionContext, state: PlanState): void {
	if (!isPlanMode(state)) {
		ctx.ui.setStatus("plan", undefined);
		return;
	}
	const phase = state.phase === "awaiting_review" ? "plan review" : "plan";
	ctx.ui.setStatus("plan", phase);
}
