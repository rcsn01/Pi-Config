import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Box, Markdown, Text, type MarkdownTheme } from "@earendil-works/pi-tui";
import {
	PROPOSED_PLAN_CUSTOM_TYPE,
	PROPOSED_PLAN_ENTRY_TYPE,
	type ProposedPlanDetails,
} from "./plan-content.ts";
import { isPlanMode, type PlanState } from "./plan-state.ts";

export function createPlanMarkdownTheme(theme: Theme): MarkdownTheme {
	return {
		heading: (text) => theme.fg("mdHeading", text),
		link: (text) => theme.fg("mdLink", text),
		linkUrl: (text) => theme.fg("mdLinkUrl", text),
		code: (text) => theme.fg("mdCode", text),
		codeBlock: (text) => theme.fg("mdCodeBlock", text),
		codeBlockBorder: (text) => theme.fg("mdCodeBlockBorder", text),
		quote: (text) => theme.fg("mdQuote", text),
		quoteBorder: (text) => theme.fg("mdQuoteBorder", text),
		hr: (text) => theme.fg("mdHr", text),
		listBullet: (text) => theme.fg("mdListBullet", text),
		bold: (text) => theme.bold(text),
		italic: (text) => theme.italic(text),
		strikethrough: (text) => theme.strikethrough(text),
		underline: (text) => theme.underline(text),
	};
}

export function renderProposedPlan(
	content: string,
	createdAt: number | undefined,
	expanded: boolean,
	theme: Theme,
): Box {
	const box = new Box(1, 1, (value) => theme.bg("customMessageBg", value));
	box.addChild(new Text(`${theme.fg("accent", theme.bold("Proposed Plan"))}\n`, 0, 0));
	box.addChild(
		new Markdown(
			content,
			0,
			0,
			createPlanMarkdownTheme(theme),
			{ color: (text) => theme.fg("customMessageText", text) },
		),
	);
	if (expanded && createdAt) {
		box.addChild(new Text(theme.fg("dim", `\ncreated ${new Date(createdAt).toLocaleString()}`), 0, 0));
	}
	return box;
}

/** Register both durable legacy and transcript-only proposed-plan renderers. */
export function registerPlanRenderers(pi: ExtensionAPI): void {
	pi.registerMessageRenderer<ProposedPlanDetails>(
		PROPOSED_PLAN_CUSTOM_TYPE,
		(message, { expanded }, theme) => renderProposedPlan(
			typeof message.content === "string" ? message.content : "",
			message.details?.createdAt,
			expanded,
			theme,
		),
	);

	pi.registerEntryRenderer(PROPOSED_PLAN_ENTRY_TYPE, (entry, { expanded }, theme) => {
		const data = entry.data as { content?: string; createdAt?: number } | undefined;
		return renderProposedPlan(data?.content ?? "", data?.createdAt, expanded, theme);
	});
}

/** Render status from an immutable state snapshot. */
export function updatePlanStatus(ctx: ExtensionContext, state: PlanState): void {
	if (!isPlanMode(state)) {
		ctx.ui.setStatus("plan", undefined);
		return;
	}
	const phase = state.phase === "awaiting_review" ? "plan review" : "plan";
	ctx.ui.setStatus("plan", `📋 ${phase}`);
}
