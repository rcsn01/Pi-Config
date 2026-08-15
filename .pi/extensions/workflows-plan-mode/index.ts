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
 * It also keeps a global Plan Mode provider/model/thinking/context profile while
 * preserving each conversation's complete normal profile and Pi's native defaults.
 */

import type { Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { createBashTool } from "@earendil-works/pi-coding-agent";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { Box, Markdown, Text, type EditorComponent, type MarkdownTheme } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { createPlanSandboxController, type PlanSandboxController } from "./plan-sandbox.ts";
import { createPlanWorkspace, type PlanWorkspace } from "./plan-workspace.ts";
import {
	createNormalDefaultsStore,
	createPlanModeProfileStore,
	type ModeModelProfile,
	type NormalDefaultsStore,
	type PlanModeProfileStore,
	validateModeModelProfile,
} from "./model-profile.ts";

type PlanPhase = "planning" | "awaiting_review";

interface PlanState {
	active: boolean;
	phase?: PlanPhase;
	prompt?: string;
	setAt: number;
	latestPlanSignature?: string;
	latestPlan?: string;
	promptedPlanSignature?: string;
	normalProfile?: ModeModelProfile;
	normalTools?: string[];
}

export interface PlanModeDependencies {
	profileStore?: PlanModeProfileStore;
	normalDefaultsStore?: NormalDefaultsStore;
	waitForNativePersistence?: () => Promise<void>;
	createWorkspace?: (hostRoot: string) => Promise<PlanWorkspace>;
	createSandbox?: (workspace: PlanWorkspace) => PlanSandboxController;
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

export const PLAN_REVIEW_ACTIONS = [
	{ value: "implement", label: "Implement current plan" },
	{ value: "fresh", label: "Clear context and implement" },
	{ value: "revise", label: "Revise current plan" },
	{ value: "stay", label: "Stay in Plan Mode" },
] as const;

export type PlanReviewAction = (typeof PLAN_REVIEW_ACTIONS)[number]["value"];

function createPlanMarkdownTheme(theme: Theme): MarkdownTheme {
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

const PLAN_CUSTOM_TYPE = "plan-mode-state";
// Kept for rendering/reconstructing messages written by older versions.
const PROPOSED_PLAN_CUSTOM_TYPE = "proposed-plan";
const PROPOSED_PLAN_ENTRY_TYPE = "proposed-plan-display";

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
- Tests, builds, or checks when their purpose is to validate feasibility
- Arbitrary shell commands through \`plan_bash\`, which runs in a disposable isolated copy of the workspace

\`plan_bash\` cannot modify the host workspace or external filesystem state. Its generated files are discarded when Plan Mode exits. Native \`read\`, \`grep\`, \`find\`, and \`ls\` tools continue to inspect the live host workspace. If the host changes while planning, use \`/plan refresh\` to rebuild the disposable copy. External network access is unavailable; use dedicated research tools instead.

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

function replaceProposedPlanBlocks(text: string, plan: string): string {
	// Keep only the last complete block, which extractProposedPlan treats as the
	// authoritative plan. Besides being durable, keeping it in the assistant
	// message preserves it in model context without injecting a second message.
	const pattern = /<proposed_plan>\s*[\s\S]*?\s*<\/proposed_plan>/g;
	const matches = [...text.matchAll(pattern)];
	if (matches.length === 0) return plan;

	let cursor = 0;
	let result = "";
	for (let index = 0; index < matches.length; index++) {
		const match = matches[index];
		const start = match.index;
		result += text.slice(cursor, start);
		if (index === matches.length - 1) result += plan;
		cursor = start + match[0].length;
	}
	result += text.slice(cursor);
	return result.replace(/\n{3,}/g, "\n\n").trim();
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

function profileLabel(profile: Pick<ModeModelProfile, "provider" | "modelId" | "thinkingLevel" | "contextWindow">): string {
	const context = profile.contextWindow === undefined ? "legacy context" : `${profile.contextWindow.toLocaleString()} ctx`;
	return `${profile.provider}/${profile.modelId} · ${profile.thinkingLevel} · ${context}`;
}

function profileFromCurrentSession(pi: ExtensionAPI, ctx: ExtensionContext): ModeModelProfile | undefined {
	if (!ctx.model) return undefined;
	return {
		provider: ctx.model.provider,
		modelId: ctx.model.id,
		thinkingLevel: pi.getThinkingLevel() as ModelThinkingLevel,
		contextWindow: ctx.model.contextWindow,
	};
}

function updateStatus(ctx: ExtensionContext, state: PlanState): void {
	if (!state.active) {
		ctx.ui.setStatus("plan", undefined);
		return;
	}
	const phase = state.phase === "awaiting_review" ? "PLAN REVIEW" : "PLAN";
	ctx.ui.setStatus("plan", `📋 ${phase}`);
}

function optionDisplay(option: { label: string; description?: string }, index: number, recommended?: string): string {
	const suffix = option.description ? ` — ${option.description}` : "";
	const recommendedSuffix = recommended && option.label === recommended ? " (recommended)" : "";
	return `${index + 1}. ${option.label}${recommendedSuffix}${suffix}`;
}

function createCommandSubmitBridge(): EditorComponent {
	let text = "";
	return {
		getText: () => text,
		setText: (value) => {
			text = value;
		},
		handleInput: () => {},
		render: () => [],
		invalidate: () => {},
	};
}

async function submitEditorCommand(ctx: ExtensionContext, command: string): Promise<boolean> {
	if (ctx.mode !== "tui") return false;

	const previousEditorFactory = ctx.ui.getEditorComponent();
	let bridge: EditorComponent | undefined;
	let submit: EditorComponent["onSubmit"];
	try {
		// Pi wires the active editor's onSubmit callback to the same path used by
		// interactive Enter presses. Submitting through that callback gives the
		// slash command a proper ExtensionCommandContext without asking the user
		// to press Enter a second time.
		ctx.ui.setEditorComponent(() => {
			bridge = createCommandSubmitBridge();
			return bridge;
		});
		submit = bridge?.onSubmit;
	} finally {
		ctx.ui.setEditorComponent(previousEditorFactory);
	}

	if (!submit) return false;
	await submit(command);
	return true;
}

export function createPlanModeExtension(dependencies: PlanModeDependencies = {}) {
	return (pi: ExtensionAPI) => registerPlanModeExtension(pi, dependencies);
}

function registerPlanModeExtension(pi: ExtensionAPI, dependencies: PlanModeDependencies): void {
	const profileStore = dependencies.profileStore ?? createPlanModeProfileStore();
	const normalDefaultsStore = dependencies.normalDefaultsStore ?? createNormalDefaultsStore();
	const waitForNativePersistence = dependencies.waitForNativePersistence ??
		(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
	const workspaceFactory = dependencies.createWorkspace ?? createPlanWorkspace;
	const sandboxFactory = dependencies.createSandbox ?? createPlanSandboxController;

	let planState: PlanState = { active: false, setAt: Date.now() };
	let activePlanProfile: ModeModelProfile | undefined;
	let normalGlobalDefaults: ModeModelProfile | undefined;
	let profileTransitionDepth = 0;
	let profileEventQueue = Promise.resolve();
	let lifecycleGeneration = 0;
	let latestProposedPlan: string | undefined;
	let latestProposedPlanKey: string | undefined;
	let pendingFreshImplementationPlan: string | undefined;
	let planWorkspace: PlanWorkspace | undefined;
	let planSandbox: PlanSandboxController | undefined;

	const planBash = createBashTool(process.cwd(), {
		operations: {
			exec(command, cwd, options) {
				if (!planSandbox) throw new Error("Plan Bash is unavailable because its sandbox is not initialized.");
				return planSandbox.operations.exec(command, cwd, options);
			},
		},
	});
	pi.registerTool({
		...planBash,
		name: "plan_bash",
		label: "Plan Bash (isolated)",
		description:
			"Plan Mode only. Execute any shell command in a disposable, network-restricted copy of the workspace. Host files are not modified.",
		promptSnippet: "Execute arbitrary checks in an isolated disposable workspace",
		promptGuidelines: [
			"Use plan_bash for tests, builds, and shell exploration while Plan Mode is active; its filesystem changes are discarded.",
		],
	});

	// ── Plan Mode clarification tool ───────────────────────────────────────

	pi.registerTool({
		name: "plan_question",
		label: "Plan Question",
		description:
			"Plan Mode only. Ask the user 1-3 concise multiple-choice clarification questions before finalizing a proposed plan.",
		promptSnippet: "Ask planning questions",
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

	function renderProposedPlan(content: string, createdAt: number | undefined, expanded: boolean, theme: Theme) {
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

	// Backward compatibility for durable custom messages created by older versions.
	pi.registerMessageRenderer<ProposedPlanDetails>(PROPOSED_PLAN_CUSTOM_TYPE, (message, { expanded }, theme) =>
		renderProposedPlan(typeof message.content === "string" ? message.content : "", message.details?.createdAt, expanded, theme)
	);

	// Explicit /plan show output is transcript-only and must not be fed back to the model.
	pi.registerEntryRenderer(PROPOSED_PLAN_ENTRY_TYPE, (entry, { expanded }, theme) => {
		const data = entry.data as { content?: string; createdAt?: number } | undefined;
		return renderProposedPlan(data?.content ?? "", data?.createdAt, expanded, theme);
	});

	// ── Isolated Plan Bash lifecycle ──────────────────────────────────────

	function uniqueTools(names: string[]): string[] {
		return [...new Set(names)];
	}

	function planToolSet(normalTools: string[], sandboxReady: boolean): string[] {
		const retained = normalTools.filter((name) =>
			name !== "bash" && name !== "plan_bash" && !MUTATING_TOOLS.has(name)
		);
		return uniqueTools([...retained, "plan_question", ...(sandboxReady ? ["plan_bash"] : [])]);
	}

	function restoreNormalTools(fallback?: string[]): void {
		const normalTools = planState.normalTools ?? fallback;
		if (normalTools) {
			pi.setActiveTools(normalTools);
			return;
		}
		const current = pi.getActiveTools().filter((name) => name !== "plan_bash");
		pi.setActiveTools(uniqueTools([...current, "bash"]));
	}

	async function disposePlanRuntime(): Promise<void> {
		const sandbox = planSandbox;
		const workspace = planWorkspace;
		planSandbox = undefined;
		planWorkspace = undefined;
		let firstError: unknown;
		try {
			await sandbox?.dispose();
		} catch (error) {
			firstError = error;
		}
		try {
			await workspace?.dispose();
		} catch (error) {
			firstError ??= error;
		}
		if (firstError) throw firstError;
	}

	async function initializePlanRuntime(ctx: ExtensionContext): Promise<void> {
		if (planSandbox && planWorkspace) {
			pi.setActiveTools(planToolSet(planState.normalTools ?? pi.getActiveTools(), true));
			return;
		}
		const workspace = await workspaceFactory(ctx.cwd);
		const sandbox = sandboxFactory(workspace);
		try {
			await sandbox.initialize();
			planWorkspace = workspace;
			planSandbox = sandbox;
			pi.setActiveTools(planToolSet(planState.normalTools ?? pi.getActiveTools(), true));
		} catch (error) {
			try { await sandbox.dispose(); } catch { /* preserve initialization error */ }
			try { await workspace.dispose(); } catch { /* preserve initialization error */ }
			pi.setActiveTools(planToolSet(planState.normalTools ?? pi.getActiveTools(), false));
			throw error;
		}
	}

	async function refreshPlanRuntime(ctx: ExtensionContext): Promise<void> {
		await disposePlanRuntime();
		await initializePlanRuntime(ctx);
	}

	// ── State Reconstruction ──────────────────────────────────────────────

	const reconstruct = async (ctx: ExtensionContext) => {
		const generation = ++lifecycleGeneration;
		const toolsAtStart = pi.getActiveTools();
		const previousNormalTools = planState.normalTools;
		try {
			await disposePlanRuntime();
		} catch (error) {
			ctx.ui.notify(`Could not clean up the previous Plan Bash sandbox: ${error instanceof Error ? error.message : String(error)}`, "warning");
		}
		planState = { active: false, setAt: Date.now() };
		activePlanProfile = undefined;
		normalGlobalDefaults = undefined;
		latestProposedPlan = undefined;
		latestProposedPlanKey = undefined;

		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === PLAN_CUSTOM_TYPE) {
				const data = entry.data as PlanState | undefined;
				if (data) {
					let normalProfile: ModeModelProfile | undefined;
					try {
						normalProfile = data.normalProfile
							? validateModeModelProfile(data.normalProfile, "Session normal profile")
							: undefined;
					} catch (error) {
						ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
					}
					planState = { ...data, normalProfile };
					if (typeof data.latestPlan === "string" && data.latestPlan.trim()) {
						latestProposedPlan = data.latestPlan.trim();
						latestProposedPlanKey = data.latestPlanSignature || planSignature(latestProposedPlan);
					}
				}
				continue;
			}

			const custom = customMessageFromEntry(entry);
			if (custom?.customType === PROPOSED_PLAN_CUSTOM_TYPE) {
				const plan = customMessageText(custom.content).trim();
				if (plan) {
					const key = custom.details?.signature || planSignature(plan);
					latestProposedPlan = plan;
					latestProposedPlanKey = key;
				}
			}
		}

		if (planState.active && latestProposedPlan && planState.phase !== "planning") {
			const reconstructedSignature = latestProposedPlanKey;
			planState = {
				...planState,
				phase: "awaiting_review",
				latestPlanSignature: reconstructedSignature,
				// Older sessions predate promptedPlanSignature. A matching durable
				// proposed-plan message means that plan already reached its review stage.
				promptedPlanSignature:
					planState.promptedPlanSignature ??
					(planState.latestPlanSignature === reconstructedSignature ? reconstructedSignature : undefined),
			};
		}

		if (planState.active) {
			planState.normalTools ??= previousNormalTools ?? toolsAtStart.filter((name) => name !== "plan_bash");
			activePlanProfile = profileFromCurrentSession(pi, ctx);
			const fallback = planState.normalProfile ?? activePlanProfile;
			if (fallback) {
				try {
					const defaults = await normalDefaultsStore.capture(ctx.cwd, fallback);
					if (generation === lifecycleGeneration) normalGlobalDefaults = defaults;
				} catch (error) {
					ctx.ui.notify(`Could not read Pi's normal defaults: ${error instanceof Error ? error.message : String(error)}`, "error");
				}
			}
			try {
				await initializePlanRuntime(ctx);
			} catch (error) {
				ctx.ui.notify(
					`Plan Mode remains active, but isolated command execution is unavailable: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
		} else {
			pi.setActiveTools(previousNormalTools ?? toolsAtStart.filter((name) => name !== "plan_bash"));
		}
		if (generation === lifecycleGeneration) updateStatus(ctx, planState);
	};

	const persist = () => {
		pi.appendEntry(PLAN_CUSTOM_TYPE, { ...planState });
	};

	function requireLatestPlan(ctx: ExtensionContext): string | undefined {
		if (latestProposedPlan?.trim()) return latestProposedPlan;
		ctx.ui.notify("No proposed plan is available yet.", "warning");
		return undefined;
	}

	async function resolveProfileModel(ctx: ExtensionContext, profile: ModeModelProfile): Promise<Model<any>> {
		const refresh = await ctx.modelRegistry.refresh({ allowNetwork: false, providers: [profile.provider] });
		if (refresh.aborted) throw new Error(`Refreshing ${profile.provider} was aborted.`);
		const refreshError = refresh.errors.get(profile.provider);
		if (refreshError) throw refreshError;
		const model = ctx.modelRegistry.find(profile.provider, profile.modelId);
		if (!model) throw new Error(`Plan Mode model ${profile.provider}/${profile.modelId} is unavailable.`);
		if (
			ctx.scopedModels.length > 0 &&
			!ctx.scopedModels.some((entry) => entry.model.provider === profile.provider && entry.model.id === profile.modelId)
		) {
			throw new Error(`Plan Mode model ${profile.provider}/${profile.modelId} is outside this session's model scope.`);
		}
		return model;
	}

	async function applySessionProfile(ctx: ExtensionContext, profile: ModeModelProfile): Promise<ModeModelProfile> {
		const catalogueModel = await resolveProfileModel(ctx, profile);
		const model = profile.contextWindow === undefined
			? catalogueModel
			: { ...catalogueModel, contextWindow: profile.contextWindow };
		const changed = await pi.setModel(model);
		if (!changed) throw new Error(`No configured authentication for ${profile.provider}/${profile.modelId}.`);
		pi.setThinkingLevel(profile.thinkingLevel);
		return {
			...profile,
			thinkingLevel: pi.getThinkingLevel() as ModelThinkingLevel,
			contextWindow: model.contextWindow,
		};
	}

	async function preserveNormalGlobalDefaults(
		ctx: ExtensionContext,
		defaults = normalGlobalDefaults,
	): Promise<void> {
		if (!defaults) return;
		await waitForNativePersistence();
		await normalDefaultsStore.restore(ctx.cwd, defaults);
	}

	function commitPlanState(ctx: ExtensionContext, active: boolean, prompt?: string): void {
		planState = {
			active,
			prompt,
			phase: active ? "planning" : undefined,
			setAt: Date.now(),
			latestPlanSignature: active ? latestProposedPlanKey : undefined,
			latestPlan: active ? latestProposedPlan : undefined,
			promptedPlanSignature: active ? planState.promptedPlanSignature : undefined,
			normalProfile: active ? planState.normalProfile : undefined,
			normalTools: active ? planState.normalTools : undefined,
		};
		if (!active) {
			latestProposedPlan = undefined;
			latestProposedPlanKey = undefined;
			activePlanProfile = undefined;
			normalGlobalDefaults = undefined;
		}
		persist();
		updateStatus(ctx, planState);
	}

	async function enterPlanMode(ctx: ExtensionContext, prompt?: string): Promise<boolean> {
		if (planState.active) return true;
		const normalProfile = profileFromCurrentSession(pi, ctx);
		if (!normalProfile) {
			ctx.ui.notify("Cannot enter Plan Mode because the current session has no model.", "error");
			return false;
		}

		let switchedSessionProfile = false;
		const normalTools = pi.getActiveTools().filter((name) => name !== "plan_bash");
		try {
			normalGlobalDefaults = await normalDefaultsStore.capture(ctx.cwd, normalProfile);
			const storedProfile = await profileStore.load();
			planState = { ...planState, normalProfile, normalTools };
			if (!storedProfile) {
				await profileStore.save(normalProfile);
				activePlanProfile = normalProfile;
				await initializePlanRuntime(ctx);
				commitPlanState(ctx, true, prompt);
				return true;
			}

			profileTransitionDepth++;
			try {
				activePlanProfile = await applySessionProfile(ctx, storedProfile);
				switchedSessionProfile = true;
				await profileStore.save(activePlanProfile);
				await preserveNormalGlobalDefaults(ctx);
			} finally {
				profileTransitionDepth--;
			}
			await initializePlanRuntime(ctx);
			commitPlanState(ctx, true, prompt);
			return true;
		} catch (error) {
			let rollbackError: unknown;
			if (switchedSessionProfile) {
				try {
					profileTransitionDepth++;
					await applySessionProfile(ctx, normalProfile);
					await preserveNormalGlobalDefaults(ctx);
				} catch (failure) {
					rollbackError = failure;
				} finally {
					profileTransitionDepth--;
				}
			}
			try { await disposePlanRuntime(); } catch { /* preserve entry error */ }
			pi.setActiveTools(normalTools);
			activePlanProfile = undefined;
			normalGlobalDefaults = undefined;
			planState = { ...planState, normalProfile: undefined, normalTools: undefined };
			const rollbackNote = rollbackError
				? ` Rollback also failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`
				: "";
			ctx.ui.notify(
				`Could not enter Plan Mode: ${error instanceof Error ? error.message : String(error)}${rollbackNote}`,
				"error",
			);
			return false;
		}
	}

	async function exitPlanMode(ctx: ExtensionContext): Promise<boolean> {
		if (!planState.active) return true;
		const normalProfile = planState.normalProfile;
		if (normalProfile) {
			let restoredSessionProfile = false;
			try {
				profileTransitionDepth++;
				await applySessionProfile(ctx, normalProfile);
				restoredSessionProfile = true;
				await preserveNormalGlobalDefaults(ctx);
			} catch (error) {
				let rollbackError: unknown;
				if (restoredSessionProfile && activePlanProfile) {
					try {
						await applySessionProfile(ctx, activePlanProfile);
						await preserveNormalGlobalDefaults(ctx);
					} catch (failure) {
						rollbackError = failure;
					}
				}
				const rollbackNote = rollbackError
					? ` Rollback also failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`
					: "";
				ctx.ui.notify(
					`Could not exit Plan Mode: ${error instanceof Error ? error.message : String(error)}${rollbackNote}`,
					"error",
				);
				return false;
			} finally {
				profileTransitionDepth--;
			}
		}
		const normalTools = planState.normalTools;
		try {
			await disposePlanRuntime();
		} catch (error) {
			ctx.ui.notify(`Could not fully clean up the Plan Bash sandbox: ${error instanceof Error ? error.message : String(error)}`, "warning");
		}
		restoreNormalTools(normalTools);
		commitPlanState(ctx, false, undefined);
		return true;
	}

	async function sendPlanImplementation(ctx: ExtensionContext, plan: string): Promise<void> {
		if (!(await exitPlanMode(ctx))) return;
		ctx.ui.notify("Plan mode exited. Implementing proposed plan...", "info");
		pi.sendUserMessage(`Implement this proposed plan:\n\n${plan}`, ctx.isIdle() ? undefined : { deliverAs: "followUp" });
	}

	function isCommandContext(ctx: ExtensionContext): ctx is ExtensionCommandContext {
		return typeof (ctx as any).newSession === "function";
	}

	async function startFreshPlanImplementation(ctx: ExtensionCommandContext, plan: string): Promise<void> {
		const signature = planSignature(plan);
		pendingFreshImplementationPlan = undefined;
		if (!(await exitPlanMode(ctx))) return;
		ctx.ui.notify("Plan mode exited. Starting fresh implementation session...", "info");

		const parentSession = ctx.sessionManager.getSessionFile();
		const handoffPrompt = `${PLAN_IMPLEMENT_FRESH_PREFIX}\n\n${plan}`;
		const result = await ctx.newSession({
			parentSession: parentSession || undefined,
			withSession: async (freshCtx) => {
				await freshCtx.sendUserMessage(handoffPrompt);
			},
		});

		if (result.cancelled && await enterPlanMode(ctx)) {
			latestProposedPlan = plan;
			latestProposedPlanKey = signature;
			planState = {
				...planState,
				phase: "awaiting_review",
				setAt: Date.now(),
				latestPlanSignature: signature,
				promptedPlanSignature: signature,
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
		if (!(await exitPlanMode(ctx))) {
			pendingFreshImplementationPlan = undefined;
			return;
		}
		latestProposedPlan = plan;
		latestProposedPlanKey = signature;
		if (await submitEditorCommand(ctx, PLAN_IMPLEMENT_FRESH_COMMAND)) return;

		if (ctx.hasUI) ctx.ui.setEditorText(PLAN_IMPLEMENT_FRESH_COMMAND);
		ctx.ui.notify(
			`Plan mode exited. Automatic command submission was unavailable, so ${PLAN_IMPLEMENT_FRESH_COMMAND} has been placed in the editor.`,
			"warning",
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
		pi.appendEntry(PROPOSED_PLAN_ENTRY_TYPE, {
			content: plan,
			createdAt: Date.now(),
			signature: latestProposedPlanKey,
		});
	}

	function printPlanReviewInstructions(ctx: ExtensionContext, reason: string): void {
		const instructions = `${reason}\n\nUse /plan implement, /plan fresh, /plan revise, or /plan show.`;
		if (ctx.hasUI) {
			ctx.ui.notify(instructions, "info");
			return;
		}
		process.stderr.write(`[Plan Mode] ${instructions}\n`);
	}

	async function showPlanReview(ctx: ExtensionContext, reason: string): Promise<PlanReviewAction> {
		if (ctx.mode !== "tui") {
			printPlanReviewInstructions(ctx, reason);
			return "stay";
		}

		const selected = await ctx.ui.select(
			reason,
			PLAN_REVIEW_ACTIONS.map((action) => action.label),
		);
		return PLAN_REVIEW_ACTIONS.find((action) => action.label === selected)?.value ?? "stay";
	}

	async function handlePlanReviewAction(
		ctx: ExtensionContext,
		plan: string,
		reason: string,
	): Promise<void> {
		const selected = await showPlanReview(ctx, reason);
		if (selected === "implement") return sendPlanImplementation(ctx, plan);
		if (selected === "fresh") return await sendFreshPlanImplementation(ctx, plan);
		if (selected === "revise") return sendPlanRevision(ctx);
	}

	async function promptForPlanReviewAction(ctx: ExtensionContext, reason: string): Promise<void> {
		const plan = requireLatestPlan(ctx);
		if (!plan) return;
		await handlePlanReviewAction(ctx, plan, reason);
	}

	pi.on("session_start", async (_event, ctx) => reconstruct(ctx));
	pi.on("session_tree", async (_event, ctx) => reconstruct(ctx));
	pi.on("session_shutdown", async (_event, ctx) => {
		lifecycleGeneration++;
		try {
			await disposePlanRuntime();
		} catch (error) {
			ctx.ui.notify(`Could not clean up the Plan Bash sandbox: ${error instanceof Error ? error.message : String(error)}`, "warning");
		}
		if (planState.active) restoreNormalTools();
	});

	function enqueueProfileEvent(task: () => Promise<void>): Promise<void> {
		const result = profileEventQueue.then(task, task);
		profileEventQueue = result.catch(() => {});
		return result;
	}

	async function rememberActivePlanProfile(
		ctx: ExtensionContext,
		profile: ModeModelProfile,
		generation: number,
		defaults: ModeModelProfile | undefined,
	): Promise<void> {
		if (generation !== lifecycleGeneration || !planState.active) return;
		activePlanProfile = profile;
		let persistenceError: unknown;
		try {
			await profileStore.save(profile);
		} catch (error) {
			persistenceError = error;
		}
		try {
			await preserveNormalGlobalDefaults(ctx, defaults);
		} catch (error) {
			ctx.ui.notify(
				`Could not preserve Pi's normal defaults: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
		}
		if (persistenceError) {
			ctx.ui.notify(
				`Could not save the Plan Mode profile: ${persistenceError instanceof Error ? persistenceError.message : String(persistenceError)}`,
				"error",
			);
		}
		if (generation === lifecycleGeneration && planState.active) updateStatus(ctx, planState);
	}

	pi.on("model_select", async (event, ctx) => {
		if (!planState.active || profileTransitionDepth > 0 || event.source === "restore") return;
		const profile: ModeModelProfile = {
			provider: event.model.provider,
			modelId: event.model.id,
			thinkingLevel: pi.getThinkingLevel() as ModelThinkingLevel,
			contextWindow: event.model.contextWindow,
		};
		const generation = lifecycleGeneration;
		const defaults = normalGlobalDefaults;
		await enqueueProfileEvent(() => rememberActivePlanProfile(ctx, profile, generation, defaults));
	});

	pi.on("thinking_level_select", async (event, ctx) => {
		if (!planState.active || profileTransitionDepth > 0 || !activePlanProfile) return;
		const profile = { ...activePlanProfile, thinkingLevel: event.level as ModelThinkingLevel };
		const generation = lifecycleGeneration;
		const defaults = normalGlobalDefaults;
		await enqueueProfileEvent(() => rememberActivePlanProfile(ctx, profile, generation, defaults));
	});

	// ── Intercept repeated/ambiguous review input ──────────────────────────

	pi.on("input", async (event, ctx) => {
		if (!planState.active || planState.phase !== "awaiting_review" || !latestProposedPlan) return { action: "continue" };
		if (event.source === "extension") return { action: "continue" };
		if (event.text.trim().startsWith("/")) return { action: "continue" };

		if (isDuplicatePlanText(event.text, latestProposedPlan)) {
			await promptForPlanReviewAction(ctx, "That input appears to repeat the current proposed plan.");
			return { action: "handled" };
		}

		if (isAmbiguousPlanAcceptance(event.text)) {
			await promptForPlanReviewAction(ctx, "That input may be approval to implement the proposed plan.");
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

		const visibleText = replaceProposedPlanBlocks(text, plan);
		const key = planSignature(plan);
		latestProposedPlan = plan;
		latestProposedPlanKey = key;
		planState = {
			...planState,
			phase: "awaiting_review",
			latestPlanSignature: key,
			latestPlan: plan,
		};
		persist();

		// The streamed tags are normalized only after completion. Most importantly,
		// the plan remains part of this assistant message instead of disappearing
		// and being re-injected later as an extension message.
		return { message: replaceAssistantText(event.message, visibleText) };
	});

	// ── Post-plan implementation prompt ───────────────────────────────────

	pi.on("agent_settled", async (_event, ctx) => {
		if (!planState.active) return;

		if (!latestProposedPlan || !latestProposedPlanKey) return;
		if (planState.promptedPlanSignature === latestProposedPlanKey) return;

		const plan = latestProposedPlan;
		const signature = latestProposedPlanKey;
		planState = { ...planState, promptedPlanSignature: signature };
		persist();
		await handlePlanReviewAction(ctx, plan, "A proposed plan is ready for review.");
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
			return {
				block: true,
				reason: "Host bash is disabled in Plan Mode. Use plan_bash so command effects stay inside the disposable workspace.",
			};
		}

		if (event.toolName === "plan_bash" && !planSandbox) {
			return {
				block: true,
				reason: "plan_bash is unavailable because the Plan Mode sandbox failed to initialize.",
			};
		}
	});

	// ── Command: /plan ────────────────────────────────────────────────────

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

	async function togglePlanMode(ctx: ExtensionContext, prompt?: string): Promise<boolean> {
		if (planState.active) {
			if (!(await exitPlanMode(ctx))) return false;
			ctx.ui.notify("Plan mode exited.", "info");
			return true;
		}
		if (!(await enterPlanMode(ctx, prompt))) return false;
		ctx.ui.notify(
			activePlanProfile
				? `📋 Plan mode active: ${profileLabel(activePlanProfile)}. Normal on exit: ${profileLabel(planState.normalProfile!)}`
				: "📋 Plan mode active.",
			"info",
		);
		return true;
	}

	pi.registerShortcut("shift+tab", {
		description: "Toggle plan mode",
		handler: async (ctx) => {
			await togglePlanMode(ctx, planState.active ? undefined : planState.prompt);
		},
	});

	pi.registerCommand("plan", {
		description: "Toggle plan mode, or use /plan <task|implement|fresh|revise|show|refresh|exit>",
		getArgumentCompletions: (prefix: string) => {
			const items = ["implement", "accept", "fresh", "revise ", "show", "refresh", "status", "exit"];
			return items.filter((item) => item.startsWith(prefix)).map((value) => ({ value, label: value }));
		},
		handler: async (args, ctx) => {
			const trimmed = (args || "").trim();
			const [command, ...rest] = trimmed.split(/\s+/);
			const subcommand = command?.toLowerCase();
			const feedback = rest.join(" ").trim();

			if (subcommand === "implement" || subcommand === "accept") {
				const plan = requireLatestPlan(ctx);
				if (plan) await sendPlanImplementation(ctx, plan);
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

			if (subcommand === "refresh") {
				if (!planState.active) {
					ctx.ui.notify("Plan mode is inactive; there is no disposable workspace to refresh.", "warning");
					return;
				}
				try {
					await refreshPlanRuntime(ctx);
					ctx.ui.notify("Plan Bash disposable workspace refreshed from the host.", "info");
				} catch (error) {
					ctx.ui.notify(
						`Could not refresh Plan Bash; isolated command execution is unavailable: ${error instanceof Error ? error.message : String(error)}`,
						"error",
					);
				}
				return;
			}

			if (subcommand === "status") {
				const profileDetails = planState.active && activePlanProfile && planState.normalProfile
					? ` Plan: ${profileLabel(activePlanProfile)}. Normal on exit: ${profileLabel(planState.normalProfile)}.`
					: "";
				ctx.ui.notify(
					planState.active
						? `Plan mode active (${planState.phase || "planning"}).${profileDetails}${latestProposedPlan ? " A proposed plan is awaiting review." : ""}`
						: "Plan mode inactive.",
					"info",
				);
				return;
			}

			if (subcommand === "exit") {
				if (await exitPlanMode(ctx)) ctx.ui.notify("Plan mode exited.", "info");
				return;
			}

			if (trimmed) {
				if (planState.active || await enterPlanMode(ctx, trimmed)) {
					latestProposedPlan = undefined;
					latestProposedPlanKey = undefined;
					planState = {
						...planState,
						prompt: trimmed,
						phase: "planning",
						latestPlan: undefined,
						latestPlanSignature: undefined,
						promptedPlanSignature: undefined,
					};
					persist();
					updateStatus(ctx, planState);
					ctx.ui.notify("📋 Plan mode active", "info");
					pi.sendUserMessage(trimmed, ctx.isIdle() ? undefined : { deliverAs: "followUp" });
				}
				return;
			}

			await togglePlanMode(ctx);
		},
	});
}

export default createPlanModeExtension();
