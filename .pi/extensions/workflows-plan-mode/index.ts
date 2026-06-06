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

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

interface PlanState {
	active: boolean;
	prompt?: string;
	setAt: number;
}

interface ProposedPlanDetails {
	createdAt: number;
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
- If revising a previous plan, output a complete replacement plan.
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

function updateStatus(ctx: ExtensionContext, active: boolean): void {
	ctx.ui.setStatus("plan", active ? "📋 PLAN MODE" : undefined);
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
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === PLAN_CUSTOM_TYPE) {
				const data = entry.data as PlanState | undefined;
				if (data) planState = data;
			}
		}
		updateStatus(ctx, planState.active);
	};

	const persist = () => {
		pi.appendEntry(PLAN_CUSTOM_TYPE, { ...planState });
	};

	pi.on("session_start", async (_event, ctx) => reconstruct(ctx));
	pi.on("session_tree", async (_event, ctx) => reconstruct(ctx));

	// ── Status Widget ─────────────────────────────────────────────────────

	pi.on("turn_end", async (_event, ctx) => updateStatus(ctx, planState.active));

	// ── Inject plan mode into system prompt ───────────────────────────────

	pi.on("before_agent_start", async (event, _ctx) => {
		if (!planState.active) return;
		return { systemPrompt: event.systemPrompt + PLAN_MODE_PROMPT };
	});

	// ── Extract and render <proposed_plan> blocks ─────────────────────────

	pi.on("message_end", async (event, _ctx) => {
		if (!planState.active || event.message.role !== "assistant") return;

		const text = extractText(event.message);
		const plan = extractProposedPlan(text);
		if (!plan) return;

		const visibleText = stripProposedPlanBlocks(text);
		const key = `${event.message.timestamp ?? "unknown"}:${planSignature(plan)}`;
		latestProposedPlan = plan;
		latestProposedPlanKey = key;

		// message_end should only run once per assistant response, but keep an
		// idempotency guard so reloads/event replays do not create duplicate
		// custom Proposed Plan messages. The assistant replacement is still
		// returned so raw tags stay stripped even if the custom message is skipped.
		if (rememberOnce(renderedPlanKeys, key)) {
			pi.sendMessage<ProposedPlanDetails>({
				customType: PROPOSED_PLAN_CUSTOM_TYPE,
				content: plan,
				display: true,
				details: { createdAt: Date.now() },
			});
		}

		return { message: replaceAssistantText(event.message, visibleText) };
	});

	// ── Post-plan implementation prompt ───────────────────────────────────

	pi.on("agent_end", async (_event, ctx) => {
		if (!planState.active) return;
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
			const plan = latestProposedPlan;
			setPlanMode(ctx, false, undefined);
			ctx.ui.notify("Plan mode exited. Implementing proposed plan...", "info");
			pi.sendUserMessage(`Implement this proposed plan:\n\n${plan}`, ctx.isIdle() ? undefined : { deliverAs: "followUp" });
			return;
		}

		if (selected === implementFresh) {
			pendingFreshImplementationPlan = latestProposedPlan;
			setPlanMode(ctx, false, undefined);
			ctx.ui.notify("Plan mode exited. Starting fresh implementation session...", "info");
			pi.sendUserMessage(PLAN_IMPLEMENT_FRESH_COMMAND, ctx.isIdle() ? undefined : { deliverAs: "followUp" });
			return;
		}

		const feedback = await ctx.ui.editor("What should Pi do differently?", "");
		const trimmed = feedback?.trim();
		if (!trimmed) {
			ctx.ui.notify("Plan revision cancelled.", "info");
			return;
		}

		pi.sendUserMessage(
			`Revise the proposed plan with this feedback:\n\n${trimmed}`,
			ctx.isIdle() ? undefined : { deliverAs: "followUp" },
		);
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
		planState = { active, prompt, setAt: Date.now() };
		if (!active) {
			latestProposedPlan = undefined;
			latestProposedPlanKey = undefined;
		}
		persist();
		updateStatus(ctx, active);
	}

	pi.registerCommand("plan-implement-fresh", {
		description: "Internal: implement the latest proposed plan in a fresh session",
		handler: async (_args, ctx) => {
			const plan = pendingFreshImplementationPlan;
			if (!plan?.trim()) {
				ctx.ui.notify("No proposed plan is available for fresh implementation.", "warning");
				return;
			}

			pendingFreshImplementationPlan = undefined;
			setPlanMode(ctx, false, undefined);
			const handoffPrompt = `${PLAN_IMPLEMENT_FRESH_PREFIX}\n\n${plan}`;
			const result = await ctx.newSession({
				withSession: async (freshCtx) => {
					await freshCtx.sendUserMessage(handoffPrompt);
				},
			});

			if (result.cancelled) {
				pendingFreshImplementationPlan = plan;
				ctx.ui.notify("Fresh implementation session cancelled.", "info");
			}
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
		description: "Toggle plan mode, or /plan <task> to plan a task",
		handler: async (args, ctx) => {
			const trimmed = (args || "").trim();

			if (trimmed) {
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
