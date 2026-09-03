/**
 * Plan Mode lifecycle.
 *
 * This module owns the live Plan Mode aggregate and the ordering between state,
 * Profile, runtime, tool, and review effects. The extension entry point only
 * adapts Pi callbacks and commands to the semantic events below.
 */

import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type {
	BashOperations,
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	InputEvent,
	InputEventResult,
	MessageEndEvent,
	ToolCallEvent,
	ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import type { PiNativeDefaults } from "../_shared/pi-defaults.ts";
import {
	createModelSelectionPersistence,
	type CreateModelSelectionPersistence,
} from "../_shared/model-selection-persistence.ts";
import type { SessionProfileBinding } from "../_shared/session-profile-binding.ts";
import {
	sessionProfileTransfer,
	type SessionProfileTransfer,
} from "../_shared/session-profile-transfer.ts";
import { UI_GLYPHS } from "../_shared/ui-style.ts";
import {
	applyModelSelection,
	usesDefaultSentinel,
	validateConcreteModelSelection,
} from "../_shared/model-selection.ts";
import {
	discardAssistantMessage,
	extractAssistantText,
	extractProposedPlan,
	planSignature,
	replaceAssistantText,
	replaceProposedPlanBlocks,
} from "./plan-content.ts";
import {
	createNormalDefaultsStore,
	type ModeModelProfile,
	type NormalDefaultsStore,
	preserveNormalGlobalDefaults,
	profileFromCurrentSession,
	profileLabel,
} from "./model-profile.ts";
import { createPlanCurrency, type PlanSession } from "./plan-currency.ts";
import { buildPlanModeSystemPrompt } from "./plan-prompt.ts";
import { updatePlanStatus } from "./plan-renderer.ts";
import {
	createPlanReviewController,
	type PlanReviewController,
} from "./plan-review.ts";
import {
	advancePlanStateRevision,
	createCommittedPlanState,
	createInitialPlanState,
	isPlanMode,
	persistPlanState,
	reconstructPlanState,
	type AgentMode,
	type AgentModeState,
	type PlanState,
} from "./plan-state.ts";
import {
	createPlanRuntimeCoordinator,
	type PlanRuntimeStatus,
} from "./plan-runtime.ts";
import { createPlanSandboxController, type PlanSandboxController } from "./plan-sandbox.ts";
import {
	createPlanWorkspace,
	type PlanWorkspace,
	type PlanWorkspaceOptions,
} from "./plan-workspace.ts";

export interface PlanModeDependencies {
	settingsPath?: string;
	createModelSelectionPersistence?: CreateModelSelectionPersistence;
	sessionProfileTransfer?: SessionProfileTransfer;
	nativeDefaults?: PiNativeDefaults;
	normalDefaultsStore?: NormalDefaultsStore;
	waitForNativePersistence?: () => Promise<void>;
	createWorkspace?: (hostRoot: string, options?: PlanWorkspaceOptions) => Promise<PlanWorkspace>;
	createSandbox?: (workspace: PlanWorkspace) => PlanSandboxController;
}

export interface PlanLifecycleSessionStarted {
	type: "sessionStarted";
	binding: SessionProfileBinding;
	ctx: ExtensionContext;
}

export interface PlanLifecycleBranchChanged {
	type: "branchChanged";
	ctx: ExtensionContext;
}

export interface PlanLifecycleSessionStopping {
	type: "sessionStopping";
	binding: SessionProfileBinding;
	ctx: ExtensionContext;
}

export interface PlanLifecycleModeToggled {
	type: "modeToggled";
	ctx: ExtensionContext;
	source: "shortcut" | "command";
}

export interface PlanLifecycleModeEntered {
	type: "modeEntered";
	ctx: ExtensionContext;
	prompt?: string;
}

export interface PlanLifecycleModeExited {
	type: "modeExited";
	ctx: ExtensionContext;
}

export interface PlanLifecycleTaskStarted {
	type: "taskStarted";
	ctx: ExtensionContext;
	task: string;
}

export interface PlanLifecycleModelChanged {
	type: "modelChanged";
	model: {
		provider: string;
		id: string;
		contextWindow: number;
	};
	source: "set" | "cycle" | "restore";
	ctx: ExtensionContext;
}

export interface PlanLifecycleThinkingLevelChanged {
	type: "thinkingLevelChanged";
	level: ModelThinkingLevel;
	ctx: ExtensionContext;
}

export interface PlanLifecycleAgentPromptConstruction {
	type: "agentPromptConstruction";
	event: BeforeAgentStartEvent;
	ctx: ExtensionContext;
}

export interface PlanLifecycleAssistantMessageCompleted {
	type: "assistantMessageCompleted";
	event: MessageEndEvent;
	ctx: ExtensionContext;
}

export interface PlanLifecycleReviewInput {
	type: "reviewInput";
	event: InputEvent;
	ctx: ExtensionContext;
}

export interface PlanLifecycleAgentSettled {
	type: "agentSettled";
	ctx: ExtensionContext;
}

export interface PlanLifecycleTurnEnded {
	type: "turnEnded";
	ctx: ExtensionContext;
}

export interface PlanLifecycleImplementCurrent {
	type: "implementCurrent";
	ctx: ExtensionContext;
}

export interface PlanLifecycleImplementFresh {
	type: "implementFresh";
	ctx: ExtensionContext;
}

export interface PlanLifecycleImplementDeferredFresh {
	type: "implementDeferredFresh";
	ctx: ExtensionCommandContext;
}

export interface PlanLifecycleReviseRequested {
	type: "reviseRequested";
	ctx: ExtensionContext;
	feedback?: string;
}

export interface PlanLifecycleShowRequested {
	type: "showRequested";
	ctx: ExtensionContext;
}

export interface PlanLifecycleStatusRequested {
	type: "statusRequested";
	ctx: ExtensionContext;
}

export interface PlanLifecycleRefreshRequested {
	type: "refreshRequested";
	ctx: ExtensionContext;
}

export interface PlanLifecycleToolCall {
	type: "toolCall";
	event: ToolCallEvent;
}

export interface PlanLifecycleIsolatedCommand {
	type: "isolatedCommand";
	command: string;
	cwd: string;
	options: Parameters<BashOperations["exec"]>[2];
}

export type PlanLifecycleEvent =
	| PlanLifecycleSessionStarted
	| PlanLifecycleBranchChanged
	| PlanLifecycleSessionStopping
	| PlanLifecycleModeToggled
	| PlanLifecycleModeEntered
	| PlanLifecycleModeExited
	| PlanLifecycleTaskStarted
	| PlanLifecycleModelChanged
	| PlanLifecycleThinkingLevelChanged
	| PlanLifecycleAgentPromptConstruction
	| PlanLifecycleAssistantMessageCompleted
	| PlanLifecycleReviewInput
	| PlanLifecycleAgentSettled
	| PlanLifecycleTurnEnded
	| PlanLifecycleImplementCurrent
	| PlanLifecycleImplementFresh
	| PlanLifecycleImplementDeferredFresh
	| PlanLifecycleReviseRequested
	| PlanLifecycleShowRequested
	| PlanLifecycleStatusRequested
	| PlanLifecycleRefreshRequested
	| PlanLifecycleToolCall
	| PlanLifecycleIsolatedCommand;

export type PlanMessageEndResult = { message?: MessageEndEvent["message"] };

export type PlanLifecycleResult<E extends PlanLifecycleEvent> =
	E extends PlanLifecycleAgentPromptConstruction ? BeforeAgentStartEventResult :
	E extends PlanLifecycleAssistantMessageCompleted ? PlanMessageEndResult | undefined :
	E extends PlanLifecycleReviewInput ? InputEventResult :
	E extends PlanLifecycleToolCall ? ToolCallEventResult | undefined :
	E extends PlanLifecycleIsolatedCommand ? Awaited<ReturnType<BashOperations["exec"]>> :
	void;

export interface PlanLifecycle {
	dispatch<E extends PlanLifecycleEvent>(event: E): Promise<PlanLifecycleResult<E>>;
}

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

export function createPlanLifecycle(
	pi: ExtensionAPI,
	dependencies: PlanModeDependencies = {},
): PlanLifecycle {
	let planState: PlanState = createInitialPlanState();
	let activePlanProfile: ModeModelProfile | undefined;
	let normalGlobalDefaults: ModeModelProfile | undefined;
	let profileTransitionDepth = 0;
	let profileEventQueue = Promise.resolve();
	let lifecycleQueue = Promise.resolve();
	let latestProposedPlan: string | undefined;
	let latestProposedPlanKey: string | undefined;
	let modeTransition: "entering" | "exiting" | undefined;
	let modeTransitionPromise: Promise<boolean> | undefined;
	let pendingModeRequest: { target: AgentMode; prompt?: string; task?: string } | undefined;
	let lastPromptedMode: AgentMode | undefined;
	let runtimeContext: ExtensionContext | undefined;
	let requestModeRevision: number | undefined;
	let requestPlanSession: PlanSession | undefined;
	let modeRevisionCounter = planState.revision;
	let hasReconstructedState = false;
	let reviewController: PlanReviewController;

	function updateRuntimeStatus(status: PlanRuntimeStatus): void {
		const ctx = runtimeContext;
		if (!ctx) return;
		if (status.phase === "warming") {
			ctx.ui.setStatus("plan-runtime", `${UI_GLYPHS.running} sandbox`);
			return;
		}
		if (status.phase === "disposing") {
			ctx.ui.setStatus("plan-runtime", `${UI_GLYPHS.running} sandbox cleanup`);
			return;
		}
		if (status.phase === "failed") {
			ctx.ui.setStatus("plan-runtime", `${UI_GLYPHS.error} sandbox`);
			if (isPlanMode(planState)) {
				ctx.ui.notify(
					`Plan Mode remains active, but isolated command execution is unavailable: ${status.error instanceof Error ? status.error.message : String(status.error)}`,
					"error",
				);
			}
			return;
		}
		ctx.ui.setStatus("plan-runtime", undefined);
	}

	const workspaceFactory = dependencies.createWorkspace ?? createPlanWorkspace;
	const sandboxFactory = dependencies.createSandbox ?? createPlanSandboxController;
	const persistenceFactory = dependencies.createModelSelectionPersistence ?? createModelSelectionPersistence;
	const normalDefaultsStore = dependencies.normalDefaultsStore ?? createNormalDefaultsStore();
	const waitForNativePersistence = dependencies.waitForNativePersistence ??
		(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

	const currency = createPlanCurrency({ createPersistence: persistenceFactory });

	const planRuntime = createPlanRuntimeCoordinator({
		createWorkspace: (hostRoot, options) => workspaceFactory(hostRoot, options),
		createSandbox: (workspace) => sandboxFactory(workspace),
		onStatus: updateRuntimeStatus,
	});

	function uniqueTools(names: string[]): string[] {
		return [...new Set(names)];
	}

	function planToolSet(normalTools: string[]): string[] {
		const retained = normalTools.filter((name) =>
			name !== "bash" && name !== "plan_bash" && !MUTATING_TOOLS.has(name)
		);
		return uniqueTools([...retained, "plan_bash"]);
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

	function enqueueLifecycle<T>(task: () => Promise<T>): Promise<T> {
		const result = lifecycleQueue.then(task, task);
		lifecycleQueue = result.then(() => undefined, () => undefined);
		return result;
	}

	async function withProfileTransition<T>(operation: () => Promise<T>): Promise<T> {
		profileTransitionDepth++;
		try {
			return await operation();
		} finally {
			profileTransitionDepth--;
		}
	}

	function warmPlanRuntime(ctx: ExtensionContext): void {
		runtimeContext = ctx;
		planRuntime.warm(ctx.cwd);
	}

	async function refreshPlanRuntime(ctx: ExtensionContext, session: PlanSession): Promise<void> {
		await enqueueLifecycle(async () => {
			if (!currency.isCurrent(session)) return;
			runtimeContext = ctx;
			await planRuntime.refresh(ctx.cwd);
		});
	}

	const reconstructState = async (ctx: ExtensionContext, session: PlanSession) => {
		const toolsAtStart = pi.getActiveTools();
		const previousState = planState;
		const previousNormalTools = previousState.normalTools;
		runtimeContext = ctx;
		try {
			await planRuntime.dispose();
		} catch (error) {
			if (currency.isCurrent(session)) {
				ctx.ui.notify(
					`Could not clean up the previous Plan Bash sandbox: ${error instanceof Error ? error.message : String(error)}`,
					"warning",
				);
			}
		}
		if (!currency.isCurrent(session)) return;

		const reconstructed = reconstructPlanState({
			entries: ctx.sessionManager.getBranch(),
			previousState,
			revisionCounter: modeRevisionCounter,
			hasReconstructedState,
			validateNormalProfile: validateConcreteModelSelection,
		});
		for (const warning of reconstructed.profileWarnings) ctx.ui.notify(warning, "warning");
		modeRevisionCounter = reconstructed.revisionCounter;
		hasReconstructedState = reconstructed.hasReconstructedState;
		planState = reconstructed.state;
		latestProposedPlan = reconstructed.latestPlan;
		latestProposedPlanKey = reconstructed.latestPlanKey;
		activePlanProfile = undefined;
		normalGlobalDefaults = undefined;
		reviewController.clearDeferredPlan();

		if (isPlanMode(planState)) {
			planState.normalTools ??= previousNormalTools ?? toolsAtStart.filter((name) => name !== "plan_bash");
			pi.setActiveTools(planToolSet(planState.normalTools));
			activePlanProfile = profileFromCurrentSession(pi, ctx);
			const fallback = planState.normalProfile ?? activePlanProfile;
			if (fallback) {
				try {
					const defaults = await normalDefaultsStore.capture(ctx.cwd, fallback);
					if (!currency.isCurrent(session)) return;
					normalGlobalDefaults = defaults;
				} catch (error) {
					if (!currency.isCurrent(session)) return;
					ctx.ui.notify(
						`Could not read Pi's normal defaults: ${error instanceof Error ? error.message : String(error)}`,
						"error",
					);
				}
			}
			if (!currency.isCurrent(session)) return;
			warmPlanRuntime(ctx);
		} else {
			ctx.ui.setStatus("plan-runtime", undefined);
			pi.setActiveTools(previousNormalTools ?? toolsAtStart.filter((name) => name !== "plan_bash"));
		}
		if (currency.isCurrent(session) && !modeTransition) updatePlanStatus(ctx, planState);
	};

	const reconstruct = (ctx: ExtensionContext): Promise<void> => {
		const session = currency.require(ctx);
		const nextSession = currency.advance(session);
		return enqueueLifecycle(() => reconstructState(ctx, nextSession));
	};

	const persist = () => persistPlanState(
		(customType, data) => pi.appendEntry(customType, data),
		planState,
	);

	async function preserveDefaults(ctx: ExtensionContext, defaults = normalGlobalDefaults): Promise<void> {
		await preserveNormalGlobalDefaults(ctx, defaults, waitForNativePersistence, normalDefaultsStore);
	}

	function commitPlanState(
		ctx: ExtensionContext,
		mode: AgentMode,
		prompt?: string,
		normalTools = planState.normalTools,
	): void {
		const active = mode === "plan";
		planState = createCommittedPlanState({
			state: planState,
			mode,
			prompt,
			latestPlan: latestProposedPlan,
			latestPlanKey: latestProposedPlanKey,
			normalTools,
		});

		// State and tools are derived from the same synchronous snapshot.
		if (active) pi.setActiveTools(planToolSet(normalTools ?? []));
		else restoreNormalTools(normalTools);

		if (!active) {
			ctx.ui.setStatus("plan-runtime", undefined);
			latestProposedPlan = undefined;
			latestProposedPlanKey = undefined;
			activePlanProfile = undefined;
			normalGlobalDefaults = undefined;
		}
		persist();
		updatePlanStatus(ctx, planState);
	}

	function clearPlanForEntry(): void {
		reviewController.clearDeferredPlan();
		latestProposedPlan = undefined;
		latestProposedPlanKey = undefined;
	}

	async function enterPlanModeInternal(
		ctx: ExtensionContext,
		session: PlanSession,
		prompt?: string,
	): Promise<boolean> {
		if (isPlanMode(planState)) return true;
		const normalProfile = profileFromCurrentSession(pi, ctx);
		if (!normalProfile) {
			ctx.ui.notify("Cannot enter Plan Mode because the current session has no model.", "error");
			return false;
		}

		let switchedSessionProfile = false;
		let capturedDefaults: ModeModelProfile | undefined;
		const normalTools = pi.getActiveTools().filter((name) => name !== "plan_bash");
		try {
			capturedDefaults = await normalDefaultsStore.capture(ctx.cwd, normalProfile);
			if (!currency.isCurrent(session)) return false;
			const storedProfile = await session.persistence.load("plan");
			if (!currency.isCurrent(session)) return false;
			if (!storedProfile) {
				await session.persistence.save("plan", normalProfile);
				if (!currency.isCurrent(session)) return false;
				normalGlobalDefaults = capturedDefaults;
				planState = { ...planState, normalProfile, normalTools };
				activePlanProfile = normalProfile;
				clearPlanForEntry();
				commitPlanState(ctx, "plan", prompt, normalTools);
				warmPlanRuntime(ctx);
				return true;
			}

			const appliedProfile = await withProfileTransition(async () => {
				const profile = await applyModelSelection(pi, ctx, storedProfile, {
					label: "Plan Mode profile",
					nativeDefaults: dependencies.nativeDefaults,
				});
				switchedSessionProfile = true;
				if (!currency.isCurrent(session)) return profile;
				if (!usesDefaultSentinel(storedProfile)) await session.persistence.save("plan", profile);
				if (!currency.isCurrent(session)) return profile;
				await preserveDefaults(ctx, capturedDefaults);
				return profile;
			});
			if (!currency.isCurrent(session)) return false;
			normalGlobalDefaults = capturedDefaults;
			planState = { ...planState, normalProfile, normalTools };
			activePlanProfile = appliedProfile;
			clearPlanForEntry();
			commitPlanState(ctx, "plan", prompt, normalTools);
			warmPlanRuntime(ctx);
			return true;
		} catch (error) {
			if (!currency.isCurrent(session)) return false;
			let rollbackError: unknown;
			if (switchedSessionProfile) {
				try {
					await withProfileTransition(async () => {
						await applyModelSelection(pi, ctx, normalProfile, {
							label: "Normal profile",
							nativeDefaults: dependencies.nativeDefaults,
						});
						if (!currency.isCurrent(session)) return;
						await preserveDefaults(ctx, capturedDefaults);
					});
				} catch (failure) {
					rollbackError = failure;
				}
			}
			if (!currency.isCurrent(session)) return false;
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

	async function exitPlanModeInternal(ctx: ExtensionContext, session: PlanSession): Promise<boolean> {
		if (!isPlanMode(planState)) return true;
		const normalTools = planState.normalTools;
		runtimeContext = ctx;
		try {
			await planRuntime.dispose();
			if (!currency.isCurrent(session)) return false;
		} catch (error) {
			if (!currency.isCurrent(session)) return false;
			ctx.ui.notify(
				`Could not exit Plan Mode because the Plan Bash sandbox could not be cleaned up: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
			return false;
		}

		const normalProfile = planState.normalProfile;
		if (normalProfile) {
			const restored = await withProfileTransition(async () => {
				let restoredSessionProfile = false;
				try {
					await applyModelSelection(pi, ctx, normalProfile, {
						label: "Normal profile",
						nativeDefaults: dependencies.nativeDefaults,
					});
					if (!currency.isCurrent(session)) return false;
					restoredSessionProfile = true;
					await preserveDefaults(ctx);
					if (!currency.isCurrent(session)) return false;
				} catch (error) {
					if (!currency.isCurrent(session)) return false;
					let rollbackError: unknown;
					if (restoredSessionProfile && activePlanProfile) {
						try {
							await applyModelSelection(pi, ctx, activePlanProfile, {
								label: "Plan Mode profile",
								nativeDefaults: dependencies.nativeDefaults,
							});
							if (!currency.isCurrent(session)) return false;
							await preserveDefaults(ctx);
						} catch (failure) {
							rollbackError = failure;
						}
					}
					if (!currency.isCurrent(session)) return false;
					const rollbackNote = rollbackError
						? ` Rollback also failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`
						: "";
					ctx.ui.notify(
						`Could not exit Plan Mode: ${error instanceof Error ? error.message : String(error)}${rollbackNote}`,
						"error",
					);
					warmPlanRuntime(ctx);
					return false;
				}
				return true;
			});
			if (!restored) return false;
		}
		if (!currency.isCurrent(session)) return false;
		commitPlanState(ctx, "default", undefined, normalTools);
		return true;
	}

	function beginModeTransition(): void {
		const advanced = advancePlanStateRevision(planState, modeRevisionCounter);
		planState = advanced.state;
		modeRevisionCounter = advanced.revisionCounter;
	}

	async function enterPlanMode(ctx: ExtensionContext, prompt?: string): Promise<boolean> {
		const session = currency.require(ctx);
		if (isPlanMode(planState)) return true;
		if (modeTransition) {
			ctx.ui.notify(`Plan Mode is already ${modeTransition}.`, "info");
			return false;
		}
		beginModeTransition();
		modeTransition = "entering";
		ctx.ui.setStatus("plan", "plan starting");
		const transition = enqueueLifecycle(() => enterPlanModeInternal(ctx, session, prompt));
		modeTransitionPromise = transition;
		try {
			return await transition;
		} finally {
			// Clear the transition bookkeeping even when invalidated by branch
			// reconstruction: nothing else frees it for this Session, and a stuck
			// marker would block every later toggle. Only the status write is
			// session-scoped; the new branch's reconstruction refreshes it.
			if (modeTransitionPromise === transition) {
				modeTransition = undefined;
				modeTransitionPromise = undefined;
				if (currency.isCurrent(session)) updatePlanStatus(ctx, planState);
			}
		}
	}

	async function exitPlanMode(ctx: ExtensionContext): Promise<boolean> {
		const session = currency.require(ctx);
		if (!isPlanMode(planState)) return true;
		if (modeTransition) {
			ctx.ui.notify(`Plan Mode is already ${modeTransition}.`, "info");
			return false;
		}
		beginModeTransition();
		modeTransition = "exiting";
		ctx.ui.setStatus("plan", "plan exiting");
		const transition = enqueueLifecycle(() => exitPlanModeInternal(ctx, session));
		modeTransitionPromise = transition;
		try {
			return await transition;
		} finally {
			// See enterPlanMode: free the transition marker even when stale.
			if (modeTransitionPromise === transition) {
				modeTransition = undefined;
				modeTransitionPromise = undefined;
				if (currency.isCurrent(session)) updatePlanStatus(ctx, planState);
			}
		}
	}

	function enqueueProfileEvent(task: () => Promise<void>): Promise<void> {
		const result = profileEventQueue.then(task, task);
		profileEventQueue = result.catch(() => {});
		return result;
	}

	function observePlanSelection(
		event: PlanLifecycleModelChanged | PlanLifecycleThinkingLevelChanged,
	): Promise<void> {
		if (!isPlanMode(planState) || profileTransitionDepth > 0) return Promise.resolve();
		if (event.type === "modelChanged" && event.source === "restore") return Promise.resolve();

		let profile: ModeModelProfile;
		if (event.type === "modelChanged") {
			profile = {
				provider: event.model.provider,
				modelId: event.model.id,
				thinkingLevel: pi.getThinkingLevel() as ModelThinkingLevel,
				contextWindow: event.model.contextWindow,
			};
		} else {
			if (!activePlanProfile) return Promise.resolve();
			profile = { ...activePlanProfile, thinkingLevel: event.level };
		}
		const session = currency.require(event.ctx);
		const defaults = normalGlobalDefaults;
		return enqueueProfileEvent(() => rememberActivePlanProfile(event.ctx, session, profile, defaults));
	}

	async function rememberActivePlanProfile(
		ctx: ExtensionContext,
		session: PlanSession,
		profile: ModeModelProfile,
		defaults: ModeModelProfile | undefined,
	): Promise<void> {
		if (!currency.isCurrent(session) || !isPlanMode(planState)) return;
		activePlanProfile = profile;
		let persistenceError: unknown;
		try {
			await session.persistence.save("plan", profile);
		} catch (error) {
			persistenceError = error;
		}
		if (!currency.isCurrent(session) || !isPlanMode(planState)) return;
		try {
			await preserveDefaults(ctx, defaults);
		} catch (error) {
			if (!currency.isCurrent(session) || !isPlanMode(planState)) return;
			ctx.ui.notify(
				`Could not preserve Pi's normal defaults: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
		}
		if (!currency.isCurrent(session) || !isPlanMode(planState)) return;
		if (persistenceError) {
			ctx.ui.notify(
				`Could not save the Plan Mode profile: ${persistenceError instanceof Error ? persistenceError.message : String(persistenceError)}`,
				"error",
			);
		}
		updatePlanStatus(ctx, planState);
	}

	reviewController = createPlanReviewController({
		getSnapshot: () => {
			const snapshot = currency.snapshot();
			return {
				state: planState,
				latestPlan: latestProposedPlan,
				latestPlanKey: latestProposedPlanKey,
				isCurrent: snapshot.isCurrent,
			};
		},
		getSessionProfileBinding: (ctx) => currency.resolve(ctx)?.binding,
		exitPlanMode,
		enterPlanMode,
		markPlanPrompted(signature) {
			planState = { ...planState, promptedPlanSignature: signature };
			persist();
		},
		restoreReviewedPlan(ctx, plan, signature) {
			latestProposedPlan = plan;
			latestProposedPlanKey = signature;
			planState = {
				...planState,
				phase: "awaiting_review",
				latestPlanSignature: signature,
				latestPlan: plan,
				promptedPlanSignature: signature,
			};
			persist();
			updatePlanStatus(ctx, planState);
		},
		appendEntry: (customType, data) => pi.appendEntry(customType, data),
		sendUserMessage: (message, options) => pi.sendUserMessage(message, options),
	}, dependencies.sessionProfileTransfer ?? sessionProfileTransfer);

	function clearPendingMode(ctx: ExtensionContext): void {
		pendingModeRequest = undefined;
		ctx.ui.setStatus("plan-pending", undefined);
	}

	function queuePendingMode(
		ctx: ExtensionContext,
		target: AgentMode,
		options: { prompt?: string; task?: string } = {},
	): void {
		if (target === planState.mode && !options.task) {
			clearPendingMode(ctx);
			ctx.ui.notify("Queued Plan Mode switch cancelled.", "info");
			return;
		}
		pendingModeRequest = { target, ...options };
		if (options.task) {
			ctx.ui.setStatus("plan-pending", "plan task queued");
			ctx.ui.notify("Plan task will start after the current run.", "info");
			return;
		}
		const label = target === "plan" ? "Plan Mode" : "normal mode";
		ctx.ui.setStatus("plan-pending", `${label} queued`);
		ctx.ui.notify(`Mode switch to ${label} queued until the current run finishes.`, "info");
	}

	function activateTask(ctx: ExtensionContext, task: string): void {
		latestProposedPlan = undefined;
		latestProposedPlanKey = undefined;
		planState = {
			...planState,
			prompt: task,
			phase: "planning",
			latestPlan: undefined,
			latestPlanSignature: undefined,
			promptedPlanSignature: undefined,
		};
		persist();
		updatePlanStatus(ctx, planState);
		ctx.ui.notify("📋 Plan mode active", "info");
		pi.sendUserMessage(task, undefined);
	}

	async function applyPendingMode(ctx: ExtensionContext): Promise<boolean> {
		const request = pendingModeRequest;
		if (!request) return false;
		clearPendingMode(ctx);
		if (request.target === "plan") {
			if (!(isPlanMode(planState) || await enterPlanMode(ctx, request.prompt ?? request.task))) return true;
			if (request.task) {
				activateTask(ctx, request.task);
				return true;
			}
			ctx.ui.notify(
				activePlanProfile
					? `📋 Plan mode active: ${profileLabel(activePlanProfile)}`
					: "📋 Plan mode active.",
				"info",
			);
			return true;
		}
		if (await exitPlanMode(ctx)) ctx.ui.notify("Plan mode exited.", "info");
		return true;
	}

	async function togglePlanMode(ctx: ExtensionContext, source: PlanLifecycleModeToggled["source"]): Promise<void> {
		currency.require(ctx);
		if (!ctx.isIdle()) {
			const effectiveTarget = pendingModeRequest?.target ?? planState.mode;
			const target = effectiveTarget === "plan" ? "default" : "plan";
			queuePendingMode(ctx, target, {
				prompt: target === "plan" && source === "shortcut" ? planState.prompt : undefined,
			});
			return;
		}
		if (isPlanMode(planState)) {
			if (!(await exitPlanMode(ctx))) return;
			ctx.ui.notify("Plan mode exited.", "info");
			return;
		}
		if (!(await enterPlanMode(ctx, source === "shortcut" ? planState.prompt : undefined))) return;
		ctx.ui.notify(
			activePlanProfile
				? `📋 Plan mode active: ${profileLabel(activePlanProfile)}`
				: "📋 Plan mode active.",
			"info",
		);
	}

	async function startTask(ctx: ExtensionContext, task: string): Promise<void> {
		currency.require(ctx);
		if (!ctx.isIdle()) {
			queuePendingMode(ctx, "plan", { task });
			return;
		}
		if (!(isPlanMode(planState) || await enterPlanMode(ctx, task))) return;
		activateTask(ctx, task);
	}

	async function refreshRequested(ctx: ExtensionContext, session: PlanSession): Promise<void> {
		if (!isPlanMode(planState)) {
			ctx.ui.notify("Plan mode is inactive; there is no disposable workspace to refresh.", "warning");
			return;
		}
		try {
			await refreshPlanRuntime(ctx, session);
			if (!currency.isCurrent(session)) return;
			ctx.ui.notify("Plan Bash disposable workspace refreshed from the host.", "info");
		} catch (error) {
			if (!currency.isCurrent(session)) return;
			ctx.ui.notify(
				`Could not refresh Plan Bash; isolated command execution is unavailable: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
		}
	}

	function statusRequested(ctx: ExtensionContext): void {
		const profileDetails = isPlanMode(planState) && activePlanProfile && planState.normalProfile
			? ` Plan: ${profileLabel(activePlanProfile)}. Normal on exit: ${profileLabel(planState.normalProfile)}.`
			: "";
		ctx.ui.notify(
			isPlanMode(planState)
				? `Plan mode active (${planState.phase || "planning"}).${profileDetails}${latestProposedPlan ? " A proposed plan is awaiting review." : ""}`
				: "Plan mode inactive.",
			"info",
		);
	}

	async function dispatch<E extends PlanLifecycleEvent>(event: E): Promise<PlanLifecycleResult<E>> {
		switch (event.type) {
			case "sessionStarted":
				await profileEventQueue;
				await enqueueLifecycle(async () => {
					const session = currency.begin(event.binding, event.ctx);
					modeTransition = undefined;
					modeTransitionPromise = undefined;
					clearPendingMode(event.ctx);
					lastPromptedMode = undefined;
					await reconstructState(event.ctx, session);
				});
				return undefined as PlanLifecycleResult<E>;
			case "branchChanged":
				clearPendingMode(event.ctx);
				await reconstruct(event.ctx);
				return undefined as PlanLifecycleResult<E>;
			case "sessionStopping":
				{
					const stoppingSession = currency.resolve(event.ctx);
					if (stoppingSession?.binding !== event.binding) return undefined as PlanLifecycleResult<E>;
					await profileEventQueue;
					await enqueueLifecycle(async () => {
						if (!currency.end(stoppingSession)) return;
						modeTransition = undefined;
						modeTransitionPromise = undefined;
						clearPendingMode(event.ctx);
						runtimeContext = event.ctx;
						try {
							await planRuntime.dispose();
						} catch (error) {
							event.ctx.ui.notify(
								`Could not clean up the Plan Bash sandbox: ${error instanceof Error ? error.message : String(error)}`,
								"warning",
							);
						}
						if (isPlanMode(planState)) restoreNormalTools();
					});
				}
				return undefined as PlanLifecycleResult<E>;
			case "modeToggled":
				await togglePlanMode(event.ctx, event.source);
				return undefined as PlanLifecycleResult<E>;
			case "modeEntered":
				if (!event.ctx.isIdle()) queuePendingMode(event.ctx, "plan", { prompt: event.prompt });
				else await enterPlanMode(event.ctx, event.prompt);
				return undefined as PlanLifecycleResult<E>;
			case "modeExited":
				if (!event.ctx.isIdle()) queuePendingMode(event.ctx, "default");
				else if (await exitPlanMode(event.ctx)) event.ctx.ui.notify("Plan mode exited.", "info");
				return undefined as PlanLifecycleResult<E>;
			case "taskStarted":
				await startTask(event.ctx, event.task);
				return undefined as PlanLifecycleResult<E>;
			case "modelChanged":
			case "thinkingLevelChanged":
				await observePlanSelection(event);
				return undefined as PlanLifecycleResult<E>;
			case "agentPromptConstruction":
				{
					const session = currency.resolve(event.ctx);
					if (!session) return { systemPrompt: event.event.systemPrompt } as PlanLifecycleResult<E>;
					const pendingTransition = modeTransitionPromise;
					if (pendingTransition) await pendingTransition;
					if (!currency.isCurrent(session)) {
						return { systemPrompt: event.event.systemPrompt } as PlanLifecycleResult<E>;
					}
					const snapshot: AgentModeState = {
						mode: planState.mode,
						revision: planState.revision,
						changedAt: planState.changedAt,
					};
					requestModeRevision = snapshot.revision;
					requestPlanSession = session;
					const modeChange = lastPromptedMode !== undefined && lastPromptedMode !== snapshot.mode
						? snapshot.mode === "plan" ? "entered" : "exited"
						: undefined;
					lastPromptedMode = snapshot.mode;
					return {
						systemPrompt: buildPlanModeSystemPrompt(
							event.event.systemPrompt,
							{ ...snapshot, phase: planState.phase },
							modeChange,
						),
					} as PlanLifecycleResult<E>;
				}
			case "assistantMessageCompleted":
				if (event.event.message.role !== "assistant") {
					return undefined as PlanLifecycleResult<E>;
				}
				{
					const session = currency.resolve(event.ctx);
					if (!session || (requestPlanSession !== undefined && requestPlanSession !== session)) {
						return { message: discardAssistantMessage(event.event.message) } as PlanLifecycleResult<E>;
					}
				}
				if (requestModeRevision !== undefined && requestModeRevision !== planState.revision) {
					return { message: discardAssistantMessage(event.event.message) } as PlanLifecycleResult<E>;
				}
				if (!isPlanMode(planState)) return undefined as PlanLifecycleResult<E>;
				{
					const text = extractAssistantText(event.event.message);
					const plan = extractProposedPlan(text);
					if (!plan) return undefined as PlanLifecycleResult<E>;

					const visibleText = replaceProposedPlanBlocks(text, plan);
					const key = planSignature(plan);
					latestProposedPlan = plan;
					latestProposedPlanKey = key;
					reviewController.clearDeferredPlan();
					planState = {
						...planState,
						phase: "awaiting_review",
						latestPlanSignature: key,
						latestPlan: plan,
					};
					persist();
					return { message: replaceAssistantText(event.event.message, visibleText) } as PlanLifecycleResult<E>;
				}
			case "reviewInput":
				if (!currency.resolve(event.ctx)) return { action: "continue" } as PlanLifecycleResult<E>;
				return await reviewController.handleInput(event.event, event.ctx) as PlanLifecycleResult<E>;
			case "agentSettled":
				if (!currency.resolve(event.ctx)) return undefined as PlanLifecycleResult<E>;
				if (await applyPendingMode(event.ctx)) return undefined as PlanLifecycleResult<E>;
				await reviewController.handleAgentSettled(event.ctx);
				return undefined as PlanLifecycleResult<E>;
			case "turnEnded":
				updatePlanStatus(event.ctx, planState);
				return undefined as PlanLifecycleResult<E>;
			case "implementCurrent":
				{
					if (!currency.resolve(event.ctx)) return undefined as PlanLifecycleResult<E>;
					const plan = reviewController.requireLatestPlan(event.ctx);
					if (plan) await reviewController.implementCurrent(event.ctx, plan);
				}
				return undefined as PlanLifecycleResult<E>;
			case "implementFresh":
				{
					if (!currency.resolve(event.ctx)) return undefined as PlanLifecycleResult<E>;
					const plan = reviewController.requireLatestPlan(event.ctx);
					if (plan) await reviewController.implementFresh(event.ctx, plan);
				}
				return undefined as PlanLifecycleResult<E>;
			case "implementDeferredFresh":
				if (!currency.resolve(event.ctx)) return undefined as PlanLifecycleResult<E>;
				await reviewController.implementDeferredFresh(event.ctx);
				return undefined as PlanLifecycleResult<E>;
			case "reviseRequested":
				if (!currency.resolve(event.ctx)) return undefined as PlanLifecycleResult<E>;
				await reviewController.revise(event.ctx, event.feedback);
				return undefined as PlanLifecycleResult<E>;
			case "showRequested":
				reviewController.show(event.ctx);
				return undefined as PlanLifecycleResult<E>;
			case "statusRequested":
				statusRequested(event.ctx);
				return undefined as PlanLifecycleResult<E>;
			case "refreshRequested":
				await refreshRequested(event.ctx, currency.require(event.ctx));
				return undefined as PlanLifecycleResult<E>;
			case "toolCall":
				if (!isPlanMode(planState)) return undefined as PlanLifecycleResult<E>;
				if (MUTATING_TOOLS.has(event.event.toolName)) {
					return {
						block: true,
						reason: `${event.event.toolName} is disabled in Plan Mode. Produce or refine a <proposed_plan> instead.`,
					} as PlanLifecycleResult<E>;
				}
				if (event.event.toolName === "bash") {
					return {
						block: true,
						reason: "Host bash is disabled in Plan Mode. Use plan_bash so command effects stay inside the disposable workspace.",
					} as PlanLifecycleResult<E>;
				}
				return undefined as PlanLifecycleResult<E>;
			case "isolatedCommand":
				{
					const sandbox = await planRuntime.require(event.options.signal);
					return await sandbox.operations.exec(event.command, event.cwd, event.options) as PlanLifecycleResult<E>;
				}
		}
	}

	return { dispatch };
}
