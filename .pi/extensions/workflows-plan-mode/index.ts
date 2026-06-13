/**
 * Plan Mode Extension — `/plan` command
 *
 * Codex-style planning mode:
 *   /plan                  - Toggle plan mode
 *   /plan <task>           - Enter plan mode and plan the task
 *
 * Plan mode asks the model to explore non-mutatingly and finalize plans in a
 * <proposed_plan> block. The extension extracts that block into a custom
 * rendered message and blocks common mutating tools while plan mode is active.
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

type PlanPhase = "planning" | "awaiting_review";

interface PlanState {
	active: boolean;
	phase?: PlanPhase;
	prompt?: string;
	setAt: number;
	latestPlanSignature?: string;
}

interface ProposedPlanDetails {
	createdAt: number;
	signature?: string;
}

interface PlanQuestionAnswer {
	id: string;
	question: string;
	answer: string | null;
	index?: number;
	cancelled?: boolean;
}

interface PlanQuestionDetails {
	answers: PlanQuestionAnswer[];
	cancelled: boolean;
}

const PLAN_CUSTOM_TYPE = "plan-mode-state";
const PROPOSED_PLAN_CUSTOM_TYPE = "proposed-plan";

const PROPOSED_PLAN_OPEN = "<proposed_plan>";
const PROPOSED_PLAN_CLOSE = "</proposed_plan>";
const PLAN_IMPLEMENT_FRESH_COMMAND = "/plan-implement-fresh";
const PLAN_IMPLEMENT_FRESH_PREFIX =
	"A previous agent produced the plan below to accomplish the user's task. " +
	"Implement the plan in a fresh context. Treat the plan as the source of user intent, " +
	"re-read files as needed, and carry the work through implementation and verification.";

const PlanQuestionOptionSchema = Type.Object({
	label: Type.String({ description: "Short option label shown to the user" }),
	description: Type.Optional(Type.String({ description: "Optional explanation shown next to the option" })),
});

const PlanQuestionSchema = Type.Object({
	id: Type.String({ description: "Stable short identifier for this question, e.g. scope or style" }),
	question: Type.String({ description: "The clarification question to ask the user" }),
	options: Type.Array(PlanQuestionOptionSchema, {
		description: "Two to five meaningful options for the user to choose from",
	}),
	recommended: Type.Optional(Type.String({ description: "Optional label of the recommended option" })),
});

const PlanQuestionParams = Type.Object({
	questions: Type.Array(PlanQuestionSchema, {
		description: "One to three multiple-choice clarification questions",
	}),
});

const PLAN_MODE_PROMPT = `

<collaboration_mode>
# Plan Mode (Conversational)

You are in **Plan Mode** until system/developer instructions say otherwise. User intent, tone, or imperative language does not end Plan Mode. If the user asks for execution while still in Plan Mode, treat that as a request to **plan the execution**, not perform it.

## Plan Mode vs todo/update_plan

Plan Mode is a collaboration mode for producing a decision-complete implementation plan. It is separate from TODO/checklist/progress tools. Do not use todo/update_plan-style tools while in Plan Mode.

## Execution vs. mutation in Plan Mode

You may explore and execute **non-mutating** actions that improve the plan. You must not perform **mutating** actions.

Allowed non-mutating actions include:
- Reading or searching files, configs, schemas, types, manifests, docs, and logs
- Static analysis, repository exploration, and dry-run style commands
- Tests, builds, or checks when their purpose is to validate feasibility and they do not edit repo-tracked files

Not allowed:
- Editing or writing files
- Running formatters, migrations, codegen, or linters that rewrite files
- Applying patches
- Creating/removing worktrees, syncing external project managers, or otherwise changing repo/external state
- Side-effectful commands whose purpose is doing the work rather than planning it

When in doubt: if the action would reasonably be described as "doing the work" rather than "planning the work," do not do it.

## Phase 1 — Ground in the environment

Start by discovering facts. Before asking the user a question, do at least one targeted non-mutating exploration pass unless no local environment/repo is available. Do not ask questions that can be answered from the repo or system.

## Phase 2 — Clarify intent

Ask only questions that materially affect the plan, confirm important assumptions, or choose between meaningful tradeoffs. Prefer concrete options and recommend a default.

If important ambiguity remains after exploration, use the \`plan_question\` tool to ask 1–3 concise multiple-choice questions. Each question must have meaningful options, and you should mark a recommended option when appropriate. Incorporate the selected answers before finalizing the plan. Do not ask clarification questions that can be answered by non-mutating exploration.

## Phase 3 — Finalize the implementation plan

Only output the final plan when it is decision complete and leaves no decisions to the implementer.

When presenting the official plan, wrap it exactly in one block:

<proposed_plan>
# Title

## Summary
...

## Implementation Changes
...

## Test Plan
...

## Assumptions
...
</proposed_plan>

Rules for the proposed plan:
- Opening and closing tags must be on their own lines.
- Use Markdown inside the block.
- Produce exactly one <proposed_plan> block when finalizing a plan, and no other plan text outside the block.
- If revising a previous plan and the feedback materially changes the plan, output a complete replacement plan.
- If revising feedback is a no-op, ambiguous, or repeats the existing plan, do not emit another <proposed_plan>; briefly say that the current plan already covers it and ask for specific changes.
- If the user says "continue", "ok", "go ahead", "implement", or repeats the same plan after a proposed plan exists, do not restate the plan. Treat it as plan review/acceptance ambiguity and respond briefly unless the Plan Mode extension intercepts it.
- Do not ask "should I proceed?" in the final plan; the user can leave Plan Mode and request implementation.
</collaboration_mode>`;

const MUTATING_TOOLS = new Set([
	"edit",
	"write",
	"todo",
	"goal",
	"worktree_create",
	"worktree_remove",
	"plane_sync_workspace",
	"plane_upsert_work_item",
]);

const READ_ONLY_BASH_PREFIXES = [
	"awk ",
	"bun --check ",
	"bun test",
	"cargo check",
	"cargo test",
	"cat ",
	"deno check ",
	"du ",
	"file ",
	"find ",
	"git branch",
	"git diff",
	"git grep",
	"git log",
	"git ls-files",
	"git show",
	"git status",
	"go test",
	"grep ",
	"head ",
	"ls",
	"npm test",
	"npm run build",
	"npm run check",
	"npm run lint",
	"npm run test",
	"npm run typecheck",
	"pnpm test",
	"pnpm run build",
	"pnpm run check",
	"pnpm run lint",
	"pnpm run test",
	"pnpm run typecheck",
	"pwd",
	"python -m pytest",
	"pytest",
	"rg ",
	"sed ",
	"tail ",
	"tree",
	"tsc",
	"wc ",
	"yarn test",
	"yarn build",
	"yarn lint",
	"yarn typecheck",
];

const OBVIOUSLY_MUTATING_BASH = /(^|\s)(>|>>|tee\b|rm\b|mv\b|cp\b|mkdir\b|touch\b|chmod\b|chown\b|install\b|apply_patch\b|git\s+(add|commit|checkout|switch|merge|rebase|reset|clean|stash|apply|am|cherry-pick|worktree)\b|npm\s+install\b|pnpm\s+(add|install)\b|yarn\s+(add|install)\b|bun\s+(add|install)\b|cargo\s+(fix|fmt)\b)/;

function extractText(message: any): string {
	if (!Array.isArray(message.content)) return typeof message.content === "string" ? message.content : "";
	return message.content
		.filter((part: any) => part?.type === "text" && typeof part.text === "string")
		.map((part: any) => part.text)
		.join("");
}

function extractProposedPlan(text: string): string | undefined {
	// Match Codex's behavior conceptually: if the model emits multiple blocks,
	// treat the last complete block as the authoritative replacement plan.
	let plan: string | undefined;
	const pattern = /<proposed_plan>\s*([\s\S]*?)\s*<\/proposed_plan>/g;
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(text)) !== null) {
		plan = match[1].trim();
	}
	return plan;
}

function stripProposedPlanBlocks(text: string): string {
	return text
		.replace(/\n?\s*<proposed_plan>\s*[\s\S]*?\s*<\/proposed_plan>\s*/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

function replaceAssistantText(message: any, text: string): any {
	if (!Array.isArray(message.content)) return message;

	let inserted = false;
	const content = [];
	for (const part of message.content) {
		if (part?.type === "text") {
			if (!inserted && text) {
				content.push({ ...part, text });
				inserted = true;
			}
			continue;
		}
		content.push(part);
	}

	if (!inserted && text) content.push({ type: "text", text });
	return { ...message, content };
}

function isReadOnlyBash(command: string): boolean {
	const trimmed = command.trim();
	if (!trimmed) return true;
	if (OBVIOUSLY_MUTATING_BASH.test(trimmed)) return false;
	return READ_ONLY_BASH_PREFIXES.some((prefix) => trimmed === prefix.trim() || trimmed.startsWith(prefix));
}

function planSignature(plan: string): string {
	let hash = 0;
	for (let i = 0; i < plan.length; i++) {
		hash = (hash * 31 + plan.charCodeAt(i)) | 0;
	}
	return `${plan.length}:${hash}`;
}

function stripPlanTags(text: string): string {
	const extracted = extractProposedPlan(text);
	return (extracted ?? text)
		.replaceAll(PROPOSED_PLAN_OPEN, "")
		.replaceAll(PROPOSED_PLAN_CLOSE, "")
		.trim();
}

function normalizeComparableText(text: string): string {
	return stripPlanTags(text)
		.toLowerCase()
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/[^a-z0-9]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function wordSet(text: string): Set<string> {
	return new Set(normalizeComparableText(text).split(" ").filter((word) => word.length > 2));
}

function jaccardSimilarity(a: string, b: string): number {
	const left = wordSet(a);
	const right = wordSet(b);
	if (left.size === 0 || right.size === 0) return 0;
	let intersection = 0;
	for (const word of left) {
		if (right.has(word)) intersection++;
	}
	return intersection / (left.size + right.size - intersection);
}

function isDuplicatePlanText(input: string, plan: string): boolean {
	const normalizedInput = normalizeComparableText(input);
	const normalizedPlan = normalizeComparableText(plan);
	if (!normalizedInput || !normalizedPlan) return false;
	if (normalizedInput === normalizedPlan) return true;
	if (normalizedInput.length > 500 && (normalizedInput.includes(normalizedPlan) || normalizedPlan.includes(normalizedInput))) return true;
	return normalizedInput.length > 500 && jaccardSimilarity(normalizedInput, normalizedPlan) >= 0.82;
}

function isAmbiguousPlanAcceptance(input: string): boolean {
	const normalized = normalizeComparableText(input);
	return /^(continue|ok|okay|yes|yep|yeah|sure|proceed|go ahead|do it|looks good|sounds good|approved|approve|accept|accepted|implement|ship it)$/.test(normalized);
}

function customMessageFromEntry(entry: any): { customType: string; content: unknown; details?: any } | undefined {
	if (entry?.type === "custom_message" && typeof entry.customType === "string") {
		return { customType: entry.customType, content: entry.content, details: entry.details };
	}
	if (entry?.type === "message" && entry.message?.role === "custom" && typeof entry.message.customType === "string") {
		return { customType: entry.message.customType, content: entry.message.content, details: entry.message.details };
	}
	return undefined;
}

function customMessageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((part: any) => part?.type === "text" && typeof part.text === "string")
			.map((part: any) => part.text)
			.join("\n");
	}
	return "";
}

function rememberOnce(seen: Set<string>, key: string, limit = 50): boolean {
	if (seen.has(key)) return false;
	seen.add(key);
	while (seen.size > limit) {
		const first = seen.values().next().value;
		if (first === undefined) break;
		seen.delete(first);
	}
	return true;
}

function updateStatus(ctx: ExtensionContext, state: PlanState): void {
	if (!state.active) {
		ctx.ui.setStatus("plan", undefined);
		return;
	}
	ctx.ui.setStatus("plan", state.phase === "awaiting_review" ? "📋 PLAN REVIEW" : "📋 PLAN MODE");
}

function optionDisplay(option: { label: string; description?: string }, index: number, recommended?: string): string {
	const suffix = option.description ? ` — ${option.description}` : "";
	const recommendedSuffix = recommended && option.label === recommended ? " (recommended)" : "";
	return `${index + 1}. ${option.label}${recommendedSuffix}${suffix}`;
}

export default function (pi: ExtensionAPI) {
	let planState: PlanState = { active: false, setAt: Date.now() };
	let latestProposedPlan: string | undefined;
	let latestProposedPlanKey: string | undefined;
	let pendingFreshImplementationPlan: string | undefined;
	let pendingProposedPlanRender: { plan: string; key: string; createdAt: number } | undefined;
	const renderedPlanKeys = new Set<string>();
	const promptedPlanKeys = new Set<string>();

	// ── Plan Mode clarification tool ───────────────────────────────────────

	pi.registerTool({
		name: "plan_question",
		label: "Plan Question",
		description:
			"Plan Mode only. Ask the user 1-3 concise multiple-choice clarification questions before finalizing a proposed plan.",
		promptSnippet:
			"plan_question: in Plan Mode, ask 1-3 multiple-choice clarification questions when important ambiguity remains after exploration.",
		parameters: PlanQuestionParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!planState.active) {
				return {
					content: [{ type: "text", text: "Error: plan_question is only available in Plan Mode." }],
					details: { answers: [], cancelled: true } as PlanQuestionDetails,
					isError: true,
				};
			}

			if (ctx.mode !== "tui") {
				return {
					content: [
						{
							type: "text",
							text: "Error: plan_question requires the interactive TUI so the user can select answers.",
						},
					],
					details: { answers: [], cancelled: true } as PlanQuestionDetails,
					isError: true,
				};
			}

			if (params.questions.length === 0 || params.questions.length > 3) {
				return {
					content: [{ type: "text", text: "Error: ask between 1 and 3 questions." }],
					details: { answers: [], cancelled: true } as PlanQuestionDetails,
					isError: true,
				};
			}

			const answers: PlanQuestionAnswer[] = [];
			for (const question of params.questions) {
				if (question.options.length < 2 || question.options.length > 5) {
					return {
						content: [
							{
								type: "text",
								text: `Error: question ${question.id} must have between 2 and 5 options.`,
							},
						],
						details: { answers, cancelled: true } as PlanQuestionDetails,
						isError: true,
					};
				}

				const choices = question.options.map((option, index) =>
					optionDisplay(option, index, question.recommended),
				);
				const selected = await ctx.ui.select(question.question, choices);
				if (!selected) {
					answers.push({ id: question.id, question: question.question, answer: null, cancelled: true });
					return {
						content: [{ type: "text", text: "User cancelled clarification questions." }],
						details: { answers, cancelled: true } as PlanQuestionDetails,
					};
				}

				const index = Math.max(0, choices.indexOf(selected));
				const option = question.options[index];
				answers.push({
					id: question.id,
					question: question.question,
					answer: option.label,
					index: index + 1,
				});
			}

			const lines = answers.map((answer) => `- ${answer.id}: ${answer.index}. ${answer.answer}`);
			return {
				content: [{ type: "text", text: `User answered clarification questions:\n${lines.join("\n")}` }],
				details: { answers, cancelled: false } as PlanQuestionDetails,
			};
		},

		renderCall(args, theme, _context) {
			const count = Array.isArray(args.questions) ? args.questions.length : 0;
			const text = theme.fg("toolTitle", theme.bold("plan_question ")) + theme.fg("muted", `${count} question${count === 1 ? "" : "s"}`);
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme, _context) {
			const details = result.details as PlanQuestionDetails | undefined;
			if (!details) {
				const first = result.content[0];
				return new Text(first?.type === "text" ? first.text : "", 0, 0);
			}
			if (details.cancelled) {
				return new Text(theme.fg("warning", "Clarification cancelled"), 0, 0);
			}
			const text = details.answers
				.map((answer) => `${theme.fg("success", "✓")} ${answer.id}: ${theme.fg("accent", answer.answer ?? "")}`)
				.join("\n");
			return new Text(text, 0, 0);
		},
	});

	// ── Custom proposed-plan rendering ──────────────────────────────────────

	pi.registerMessageRenderer<ProposedPlanDetails>(PROPOSED_PLAN_CUSTOM_TYPE, (message, { expanded }, theme) => {
		const content = typeof message.content === "string" ? message.content : "";
		let text = `${theme.fg("accent", "Proposed Plan")}\n\n${content}`;
		if (expanded && message.details?.createdAt) {
			text += `\n\n${theme.fg("dim", `created ${new Date(message.details.createdAt).toLocaleString()}`)}`;
		}

		const box = new Box(1, 1, (value) => theme.bg("customMessageBg", value));
		box.addChild(new Text(text, 0, 0));
		return box;
	});

	// ── State Reconstruction ──────────────────────────────────────────────

	const reconstruct = (ctx: ExtensionContext) => {
		planState = { active: false, setAt: Date.now() };
		latestProposedPlan = undefined;
		latestProposedPlanKey = undefined;
		renderedPlanKeys.clear();
		promptedPlanKeys.clear();
		pendingProposedPlanRender = undefined;

		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === PLAN_CUSTOM_TYPE) {
				const data = entry.data as PlanState | undefined;
				if (data) planState = data;
				continue;
			}

			const custom = customMessageFromEntry(entry);
			if (custom?.customType === PROPOSED_PLAN_CUSTOM_TYPE) {
				const plan = customMessageText(custom.content).trim();
				if (plan) {
					const key = custom.details?.signature || planSignature(plan);
					latestProposedPlan = plan;
					latestProposedPlanKey = key;
					renderedPlanKeys.add(key);
				}
			}
		}

		if (planState.active && latestProposedPlan && planState.phase !== "planning") {
			planState = { ...planState, phase: "awaiting_review", latestPlanSignature: latestProposedPlanKey };
		}
		updateStatus(ctx, planState);
	};

	const persist = () => {
		pi.appendEntry(PLAN_CUSTOM_TYPE, { ...planState });
	};

	function requireLatestPlan(ctx: ExtensionContext): string | undefined {
		if (latestProposedPlan?.trim()) return latestProposedPlan;
		ctx.ui.notify("No proposed plan is available yet.", "warning");
		return undefined;
	}

	function sendPlanImplementation(ctx: ExtensionContext, plan: string): void {
		setPlanMode(ctx, false, undefined);
		ctx.ui.notify("Plan mode exited. Implementing proposed plan...", "info");
		pi.sendUserMessage(`Implement this proposed plan:\n\n${plan}`, ctx.isIdle() ? undefined : { deliverAs: "followUp" });
	}

	function isCommandContext(ctx: ExtensionContext): ctx is ExtensionCommandContext {
		return typeof (ctx as any).newSession === "function";
	}

	async function startFreshPlanImplementation(ctx: ExtensionCommandContext, plan: string): Promise<void> {
		const signature = planSignature(plan);
		pendingFreshImplementationPlan = undefined;
		setPlanMode(ctx, false, undefined);
		ctx.ui.notify("Plan mode exited. Starting fresh implementation session...", "info");

		const parentSession = ctx.sessionManager.getSessionFile();
		const handoffPrompt = `${PLAN_IMPLEMENT_FRESH_PREFIX}\n\n${plan}`;
		const result = await ctx.newSession({
			parentSession: parentSession || undefined,
			withSession: async (freshCtx) => {
				await freshCtx.sendUserMessage(handoffPrompt);
			},
		});

		if (result.cancelled) {
			latestProposedPlan = plan;
			latestProposedPlanKey = signature;
			planState = {
				active: true,
				phase: "awaiting_review",
				setAt: Date.now(),
				latestPlanSignature: signature,
			};
			persist();
			updateStatus(ctx, planState);
			ctx.ui.notify("Fresh implementation session cancelled. Plan mode restored.", "info");
		}
	}

	async function sendFreshPlanImplementation(ctx: ExtensionContext, plan: string): Promise<void> {
		if (isCommandContext(ctx)) {
			await startFreshPlanImplementation(ctx, plan);
			return;
		}

		pendingFreshImplementationPlan = plan;
		const signature = planSignature(plan);
		setPlanMode(ctx, false, undefined);
		latestProposedPlan = plan;
		latestProposedPlanKey = signature;
		if (ctx.hasUI) ctx.ui.setEditorText(PLAN_IMPLEMENT_FRESH_COMMAND);
		ctx.ui.notify(
			`Plan mode exited. ${PLAN_IMPLEMENT_FRESH_COMMAND} has been placed in the editor; press Enter to start a fresh implementation session.`,
			"info",
		);
	}

	async function sendPlanRevision(ctx: ExtensionContext, feedback?: string): Promise<void> {
		const plan = requireLatestPlan(ctx);
		if (!plan) return;
		const trimmed = feedback?.trim() || (await ctx.ui.editor("What should Pi do differently?", ""))?.trim();
		if (!trimmed) {
			ctx.ui.notify("Plan revision cancelled.", "info");
			return;
		}
		pi.sendUserMessage(
			`Revise the current proposed plan with this feedback. If the feedback is already covered, say that briefly and do not restate the plan.\n\nFeedback:\n${trimmed}`,
			ctx.isIdle() ? undefined : { deliverAs: "followUp" },
		);
	}

	function showLatestPlan(ctx: ExtensionContext): void {
		const plan = requireLatestPlan(ctx);
		if (!plan) return;
		pi.sendMessage<ProposedPlanDetails>(
			{
				customType: PROPOSED_PLAN_CUSTOM_TYPE,
				content: plan,
				display: true,
				details: { createdAt: Date.now(), signature: latestProposedPlanKey },
			},
			{ triggerTurn: false },
		);
	}

	function flushPendingProposedPlanRender(): void {
		const pending = pendingProposedPlanRender;
		if (!pending) return;
		pendingProposedPlanRender = undefined;
		pi.sendMessage<ProposedPlanDetails>(
			{
				customType: PROPOSED_PLAN_CUSTOM_TYPE,
				content: pending.plan,
				display: true,
				details: { createdAt: pending.createdAt, signature: pending.key },
			},
			{ triggerTurn: false },
		);
	}

	async function promptForPlanReviewAction(ctx: ExtensionContext, reason: string): Promise<void> {
		const plan = requireLatestPlan(ctx);
		if (!plan) return;

		if (!ctx.hasUI) {
			ctx.ui.notify(`${reason}\n\nUse /plan implement, /plan revise <feedback>, /plan show, or /plan exit.`, "info");
			return;
		}

		const implement = "Implement current plan";
		const implementFresh = "Clear context and implement";
		const revise = "Revise current plan";
		const show = "Show current plan";
		const stay = "Stay in plan mode";
		const selected = await ctx.ui.select(reason, [implement, implementFresh, revise, show, stay]);
		if (!selected || selected === stay) return;
		if (selected === implement) return sendPlanImplementation(ctx, plan);
		if (selected === implementFresh) return await sendFreshPlanImplementation(ctx, plan);
		if (selected === revise) return sendPlanRevision(ctx);
		if (selected === show) return showLatestPlan(ctx);
	}

	pi.on("session_start", async (_event, ctx) => reconstruct(ctx));
	pi.on("session_tree", async (_event, ctx) => reconstruct(ctx));

	// ── Intercept repeated/ambiguous review input ──────────────────────────

	pi.on("input", async (event, ctx) => {
		if (!planState.active || planState.phase !== "awaiting_review" || !latestProposedPlan) return { action: "continue" };
		if (event.source === "extension") return { action: "continue" };
		if (event.text.trim().startsWith("/")) return { action: "continue" };
		if (!ctx.hasUI) return { action: "continue" };

		if (isDuplicatePlanText(event.text, latestProposedPlan)) {
			await promptForPlanReviewAction(ctx, "That appears to repeat the current proposed plan. What should Pi do next?");
			return { action: "handled" };
		}

		if (isAmbiguousPlanAcceptance(event.text)) {
			await promptForPlanReviewAction(ctx, "A proposed plan is ready. What should Pi do next?");
			return { action: "handled" };
		}

		return { action: "continue" };
	});

	// ── Status Widget ─────────────────────────────────────────────────────

	pi.on("turn_end", async (_event, ctx) => updateStatus(ctx, planState));

	// ── Inject plan mode into system prompt ───────────────────────────────

	pi.on("before_agent_start", async (event, _ctx) => {
		if (!planState.active) return;
		const reviewPrompt = planState.phase === "awaiting_review"
			? `\n\n<plan_review_state>\nA proposed plan already exists. Prefer targeted revision or concise no-op acknowledgement over restating the whole plan. Only emit a new <proposed_plan> block when the user's latest feedback materially changes the plan.\n</plan_review_state>`
			: "";
		return { systemPrompt: event.systemPrompt + PLAN_MODE_PROMPT + reviewPrompt };
	});

	// ── Extract and render <proposed_plan> blocks ─────────────────────────

	pi.on("message_end", async (event, _ctx) => {
		if (!planState.active || event.message.role !== "assistant") return;

		const text = extractText(event.message);
		const plan = extractProposedPlan(text);
		if (!plan) return;

		const visibleText = stripProposedPlanBlocks(text);
		const key = planSignature(plan);
		latestProposedPlan = plan;
		latestProposedPlanKey = key;
		planState = { ...planState, phase: "awaiting_review", latestPlanSignature: key };
		persist();

		// Deduplicate by plan content, not assistant-message timestamp. If the model
		// repeats the same plan in a later turn, keep the transcript clean and avoid
		// prompting the user to review the same plan again.
		//
		// Do not call pi.sendMessage() from message_end: while the agent is still
		// streaming, pi treats that as a steer message and feeds the custom plan
		// back into the active agent. That skips the review prompt and can cause the
		// model to repeat the same <proposed_plan> block. Defer display until
		// agent_end, where sendMessage({ triggerTurn: false }) is append-only.
		if (rememberOnce(renderedPlanKeys, key)) {
			pendingProposedPlanRender = { plan, key, createdAt: Date.now() };
		}

		return { message: replaceAssistantText(event.message, visibleText) };
	});

	// ── Post-plan implementation prompt ───────────────────────────────────

	pi.on("agent_end", async (_event, ctx) => {
		if (!planState.active) return;
		flushPendingProposedPlanRender();
		if (ctx.mode !== "tui") return;
		if (ctx.hasPendingMessages()) return;
		if (!latestProposedPlan || !latestProposedPlanKey) return;
		if (!rememberOnce(promptedPlanKeys, latestProposedPlanKey)) return;

		const implement = "Yes, implement this plan";
		const implementFresh = "Yes, clear context and implement";
		const revise = "No, and tell Pi what to do differently";
		const selected = await ctx.ui.select("Implement this plan?", [implement, implementFresh, revise]);
		if (!selected) return;

		if (selected === implement) {
			sendPlanImplementation(ctx, latestProposedPlan);
			return;
		}

		if (selected === implementFresh) {
			await sendFreshPlanImplementation(ctx, latestProposedPlan);
			return;
		}

		await sendPlanRevision(ctx);
	});

	// ── Block common mutations while planning ─────────────────────────────

	pi.on("tool_call", async (event) => {
		if (!planState.active) return;

		if (MUTATING_TOOLS.has(event.toolName)) {
			return {
				block: true,
				reason: `${event.toolName} is disabled in Plan Mode. Produce or refine a <proposed_plan> instead.`,
			};
		}

		if (event.toolName === "bash") {
			const command = typeof event.input.command === "string" ? event.input.command : "";
			if (!isReadOnlyBash(command)) {
				return {
					block: true,
					reason: "Plan Mode only allows non-mutating exploration commands. Avoid shell commands that may change files or external state.",
				};
			}
		}
	});

	// ── Command: /plan ────────────────────────────────────────────────────

	function setPlanMode(ctx: ExtensionContext, active: boolean, prompt?: string): void {
		planState = {
			active,
			prompt,
			phase: active ? "planning" : undefined,
			setAt: Date.now(),
			latestPlanSignature: active ? latestProposedPlanKey : undefined,
		};
		if (!active) {
			latestProposedPlan = undefined;
			latestProposedPlanKey = undefined;
		}
		persist();
		updateStatus(ctx, planState);
	}

	pi.registerCommand("plan-implement-fresh", {
		description: "Implement the latest proposed plan in a fresh session",
		handler: async (_args, ctx) => {
			const plan = pendingFreshImplementationPlan || latestProposedPlan;
			if (!plan?.trim()) {
				ctx.ui.notify("No proposed plan is available for fresh implementation.", "warning");
				return;
			}

			await startFreshPlanImplementation(ctx, plan);
		},
	});

	pi.registerShortcut("shift+tab", {
		description: "Toggle plan mode",
		handler: async (ctx) => {
			setPlanMode(ctx, !planState.active, planState.active ? undefined : planState.prompt);
			ctx.ui.notify(
				planState.active
					? "📋 Plan mode active. The agent will create a proposed plan before implementation."
					: "Plan mode exited.",
				"info",
			);
		},
	});

	pi.registerCommand("plan", {
		description: "Toggle plan mode, or use /plan <task|implement|fresh|revise|show|exit>",
		getArgumentCompletions: (prefix: string) => {
			const items = ["implement", "accept", "fresh", "revise ", "show", "status", "exit"];
			return items.filter((item) => item.startsWith(prefix)).map((value) => ({ value, label: value }));
		},
		handler: async (args, ctx) => {
			const trimmed = (args || "").trim();
			const [command, ...rest] = trimmed.split(/\s+/);
			const subcommand = command?.toLowerCase();
			const feedback = rest.join(" ").trim();

			if (subcommand === "implement" || subcommand === "accept") {
				const plan = requireLatestPlan(ctx);
				if (plan) sendPlanImplementation(ctx, plan);
				return;
			}

			if (subcommand === "fresh") {
				const plan = requireLatestPlan(ctx);
				if (plan) await sendFreshPlanImplementation(ctx, plan);
				return;
			}

			if (subcommand === "revise") {
				await sendPlanRevision(ctx, feedback);
				return;
			}

			if (subcommand === "show") {
				showLatestPlan(ctx);
				return;
			}

			if (subcommand === "status") {
				ctx.ui.notify(
					planState.active
						? `Plan mode active (${planState.phase || "planning"}).${latestProposedPlan ? " A proposed plan is awaiting review." : ""}`
						: "Plan mode inactive.",
					"info",
				);
				return;
			}

			if (subcommand === "exit") {
				setPlanMode(ctx, false, undefined);
				ctx.ui.notify("Plan mode exited.", "info");
				return;
			}

			if (trimmed) {
				latestProposedPlan = undefined;
				latestProposedPlanKey = undefined;
				setPlanMode(ctx, true, trimmed);
				ctx.ui.notify("📋 Plan mode active", "info");
				pi.sendUserMessage(trimmed, ctx.isIdle() ? undefined : { deliverAs: "followUp" });
				return;
			}

			setPlanMode(ctx, !planState.active, undefined);
			ctx.ui.notify(
				planState.active
					? "📋 Plan mode active. The agent will create a proposed plan before implementation."
					: "Plan mode exited.",
				"info",
			);
		},
	});
}
