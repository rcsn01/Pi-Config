import type {
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { EditorComponent } from "@earendil-works/pi-tui";
import {
	CONFIG_PROFILES_ENTRY_TYPE,
	sessionProfileName,
} from "../_shared/active-profile.ts";
import {
	isAmbiguousPlanAcceptance,
	isDuplicatePlanText,
	planSignature,
	PROPOSED_PLAN_ENTRY_TYPE,
} from "./plan-content.ts";
import { isPlanMode, type PlanState } from "./plan-state.ts";

export const PLAN_REVIEW_ACTIONS = [
	{ value: "fresh", label: "Clear context and implement (recommended)" },
	{ value: "implement", label: "Implement in current session" },
	{ value: "revise", label: "Revise current plan" },
	{ value: "stay", label: "Stay in Plan Mode" },
] as const;

export type PlanReviewAction = (typeof PLAN_REVIEW_ACTIONS)[number]["value"];

export const PLAN_IMPLEMENT_FRESH_COMMAND = "/plan-implement-fresh";
export const PLAN_IMPLEMENT_FRESH_PREFIX =
	"A previous agent produced the plan below to accomplish the user's task. " +
	"Implement the plan in a fresh context. Treat the plan as the source of user intent, " +
	"re-read files as needed, and carry the work through implementation and verification.";

export interface PlanReviewSnapshot {
	state: PlanState;
	latestPlan?: string;
	latestPlanKey?: string;
	lifecycleGeneration: number;
}

export interface PlanReviewHost {
	getSnapshot(): PlanReviewSnapshot;
	exitPlanMode(ctx: ExtensionContext): Promise<boolean>;
	enterPlanMode(ctx: ExtensionContext): Promise<boolean>;
	markPlanPrompted(signature: string): void;
	restoreReviewedPlan(ctx: ExtensionContext, plan: string, signature: string): void;
	appendEntry(customType: string, data: unknown): void;
	sendUserMessage(message: string, options?: { deliverAs: "followUp" }): void;
}

export interface PlanReviewController {
	clearDeferredPlan(): void;
	requireLatestPlan(ctx: ExtensionContext): string | undefined;
	implementCurrent(ctx: ExtensionContext, plan: string): Promise<void>;
	implementFresh(ctx: ExtensionContext, plan: string): Promise<void>;
	implementDeferredFresh(ctx: ExtensionCommandContext): Promise<void>;
	revise(ctx: ExtensionContext, feedback?: string): Promise<void>;
	show(ctx: ExtensionContext): void;
	prompt(ctx: ExtensionContext, reason: string): Promise<void>;
	handleInput(event: { text: string; source?: string }, ctx: ExtensionContext): Promise<{ action: "continue" | "handled" }>;
	handleAgentSettled(ctx: ExtensionContext): Promise<void>;
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
		// Pi wires this callback to the same command path used by interactive Enter.
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

function isCommandContext(ctx: ExtensionContext): ctx is ExtensionCommandContext {
	return typeof (ctx as any).newSession === "function";
}

export function createPlanReviewController(host: PlanReviewHost): PlanReviewController {
	let pendingFreshImplementationPlan: string | undefined;

	function clearDeferredPlan(): void {
		pendingFreshImplementationPlan = undefined;
	}

	function requireLatestPlan(ctx: ExtensionContext): string | undefined {
		const plan = host.getSnapshot().latestPlan;
		if (plan?.trim()) return plan;
		ctx.ui.notify("No proposed plan is available yet.", "warning");
		return undefined;
	}

	async function implementCurrent(ctx: ExtensionContext, plan: string): Promise<void> {
		if (!(await host.exitPlanMode(ctx))) return;
		ctx.ui.notify("Plan mode exited. Implementing proposed plan...", "info");
		host.sendUserMessage(
			`Implement this proposed plan:\n\n${plan}`,
			ctx.isIdle() ? undefined : { deliverAs: "followUp" },
		);
	}

	async function startFreshImplementation(ctx: ExtensionCommandContext, plan: string): Promise<void> {
		const signature = planSignature(plan);
		const profileName = sessionProfileName(ctx.sessionManager.getBranch());
		pendingFreshImplementationPlan = undefined;
		if (!(await host.exitPlanMode(ctx))) return;
		ctx.ui.notify("Plan mode exited. Starting fresh implementation session...", "info");

		const parentSession = ctx.sessionManager.getSessionFile();
		const handoffPrompt = `${PLAN_IMPLEMENT_FRESH_PREFIX}\n\n${plan}`;
		const result = await ctx.newSession({
			parentSession: parentSession || undefined,
			setup: async (sessionManager) => {
				if (profileName) {
					sessionManager.appendCustomEntry(CONFIG_PROFILES_ENTRY_TYPE, { active: profileName });
				}
			},
			withSession: async (freshCtx) => {
				await freshCtx.sendUserMessage(handoffPrompt);
			},
		});

		if (result.cancelled && await host.enterPlanMode(ctx)) {
			host.restoreReviewedPlan(ctx, plan, signature);
			ctx.ui.notify("Fresh implementation session cancelled. Plan mode restored.", "info");
		}
	}

	async function implementFresh(ctx: ExtensionContext, plan: string): Promise<void> {
		if (isCommandContext(ctx)) {
			await startFreshImplementation(ctx, plan);
			return;
		}

		pendingFreshImplementationPlan = plan;
		if (!(await host.exitPlanMode(ctx))) {
			pendingFreshImplementationPlan = undefined;
			return;
		}
		if (await submitEditorCommand(ctx, PLAN_IMPLEMENT_FRESH_COMMAND)) return;

		if (ctx.hasUI) ctx.ui.setEditorText(PLAN_IMPLEMENT_FRESH_COMMAND);
		ctx.ui.notify(
			`Plan mode exited. Automatic command submission was unavailable, so ${PLAN_IMPLEMENT_FRESH_COMMAND} has been placed in the editor.`,
			"warning",
		);
	}

	async function implementDeferredFresh(ctx: ExtensionCommandContext): Promise<void> {
		const plan = pendingFreshImplementationPlan || host.getSnapshot().latestPlan;
		if (!plan?.trim()) {
			ctx.ui.notify("No proposed plan is available for fresh implementation.", "warning");
			return;
		}
		await startFreshImplementation(ctx, plan);
	}

	async function revise(ctx: ExtensionContext, feedback?: string): Promise<void> {
		const plan = requireLatestPlan(ctx);
		if (!plan) return;
		const snapshot = host.getSnapshot();
		const revision = snapshot.state.revision;
		const generation = snapshot.lifecycleGeneration;
		const signature = snapshot.latestPlanKey ?? planSignature(plan);
		const trimmed = feedback?.trim() || (await ctx.ui.editor("What should Pi do differently?", ""))?.trim();
		if (!trimmed) {
			ctx.ui.notify("Plan revision cancelled.", "info");
			return;
		}
		const current = host.getSnapshot();
		if (
			!isPlanMode(current.state) ||
			current.state.revision !== revision ||
			current.lifecycleGeneration !== generation ||
			current.latestPlanKey !== signature
		) {
			ctx.ui.notify(
				"The plan or runtime mode changed while revision feedback was open. No feedback was sent.",
				"warning",
			);
			return;
		}
		host.sendUserMessage(
			`Revise the current proposed plan with this feedback. If the feedback is already covered, say that briefly and do not restate the plan.\n\nFeedback:\n${trimmed}`,
			ctx.isIdle() ? undefined : { deliverAs: "followUp" },
		);
	}

	function show(ctx: ExtensionContext): void {
		const plan = requireLatestPlan(ctx);
		if (!plan) return;
		const snapshot = host.getSnapshot();
		host.appendEntry(PROPOSED_PLAN_ENTRY_TYPE, {
			content: plan,
			createdAt: Date.now(),
			signature: snapshot.latestPlanKey,
		});
	}

	function printReviewInstructions(ctx: ExtensionContext, reason: string): void {
		const instructions = `${reason}\n\nUse /plan fresh (recommended), /plan implement, /plan revise, or /plan show.`;
		if (ctx.hasUI) {
			ctx.ui.notify(instructions, "info");
			return;
		}
		process.stderr.write(`[Plan Mode] ${instructions}\n`);
	}

	async function selectAction(ctx: ExtensionContext, reason: string): Promise<PlanReviewAction> {
		if (ctx.mode !== "tui") {
			printReviewInstructions(ctx, reason);
			return "stay";
		}
		const selected = await ctx.ui.select(reason, PLAN_REVIEW_ACTIONS.map((action) => action.label));
		return PLAN_REVIEW_ACTIONS.find((action) => action.label === selected)?.value ?? "stay";
	}

	async function handleAction(ctx: ExtensionContext, plan: string, reason: string): Promise<void> {
		const snapshot = host.getSnapshot();
		const reviewRevision = snapshot.state.revision;
		const reviewGeneration = snapshot.lifecycleGeneration;
		const reviewSignature = snapshot.latestPlanKey ?? planSignature(plan);
		const selected = await selectAction(ctx, reason);
		if (selected === "stay") return;
		const current = host.getSnapshot();
		if (
			!isPlanMode(current.state) ||
			current.state.revision !== reviewRevision ||
			current.lifecycleGeneration !== reviewGeneration ||
			current.latestPlanKey !== reviewSignature
		) {
			ctx.ui.notify(
				"The reviewed plan or runtime mode changed while the action menu was open. No action was taken.",
				"warning",
			);
			return;
		}
		if (selected === "implement") return implementCurrent(ctx, plan);
		if (selected === "fresh") return implementFresh(ctx, plan);
		if (selected === "revise") return revise(ctx);
	}

	async function prompt(ctx: ExtensionContext, reason: string): Promise<void> {
		const plan = requireLatestPlan(ctx);
		if (!plan) return;
		await handleAction(ctx, plan, reason);
	}

	async function handleInput(
		event: { text: string; source?: string },
		ctx: ExtensionContext,
	): Promise<{ action: "continue" | "handled" }> {
		const snapshot = host.getSnapshot();
		if (
			!isPlanMode(snapshot.state) ||
			snapshot.state.phase !== "awaiting_review" ||
			!snapshot.latestPlan ||
			event.source === "extension" ||
			event.text.trim().startsWith("/")
		) return { action: "continue" };

		if (isDuplicatePlanText(event.text, snapshot.latestPlan)) {
			await prompt(ctx, "That input appears to repeat the current proposed plan.");
			return { action: "handled" };
		}
		if (isAmbiguousPlanAcceptance(event.text)) {
			await prompt(ctx, "That input may be approval to implement the proposed plan.");
			return { action: "handled" };
		}
		return { action: "continue" };
	}

	async function handleAgentSettled(ctx: ExtensionContext): Promise<void> {
		const snapshot = host.getSnapshot();
		if (!isPlanMode(snapshot.state)) return;
		if (!snapshot.latestPlan || !snapshot.latestPlanKey) return;
		if (snapshot.state.promptedPlanSignature === snapshot.latestPlanKey) return;

		const plan = snapshot.latestPlan;
		const signature = snapshot.latestPlanKey;
		host.markPlanPrompted(signature);
		await handleAction(ctx, plan, "A proposed plan is ready for review.");
	}

	return {
		clearDeferredPlan,
		requireLatestPlan,
		implementCurrent,
		implementFresh,
		implementDeferredFresh,
		revise,
		show,
		prompt,
		handleInput,
		handleAgentSettled,
	};
}
