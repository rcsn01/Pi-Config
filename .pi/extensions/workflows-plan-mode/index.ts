/**
 * Plan Mode Extension — `/plan` command
 *
 * Composition root for Plan Mode registration, runtime lifecycle, profile
 * transactions, state/tool commits, and Pi event wiring.
 */

import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { createBashTool } from "@earendil-works/pi-coding-agent";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { PiNativeDefaults } from "../_shared/pi-defaults.ts";
import { createSessionProfileResolver, PROFILES_DIRECTORY } from "../_shared/active-profile.ts";
import { PROJECT_SETTINGS_PATH } from "../_shared/settings-document.ts";
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
	createPlanModeProfileStore,
	type ModeModelProfile,
	type NormalDefaultsStore,
	type PlanModeProfileStore,
	preserveNormalGlobalDefaults,
	profileFromCurrentSession,
	profileLabel,
} from "./model-profile.ts";
import { buildPlanModeSystemPrompt } from "./plan-prompt.ts";
import { registerPlanRenderers, updatePlanStatus } from "./plan-renderer.ts";
import {
	createPlanReviewController,
	PLAN_REVIEW_ACTIONS,
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

export { PLAN_REVIEW_ACTIONS } from "./plan-review.ts";
export type { PlanReviewAction } from "./plan-review.ts";

export interface PlanModeDependencies {
	profileStore?: PlanModeProfileStore;
	nativeDefaults?: PiNativeDefaults;
	normalDefaultsStore?: NormalDefaultsStore;
	waitForNativePersistence?: () => Promise<void>;
	createWorkspace?: (hostRoot: string, options?: PlanWorkspaceOptions) => Promise<PlanWorkspace>;
	createSandbox?: (workspace: PlanWorkspace) => PlanSandboxController;
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

export function createPlanModeExtension(dependencies: PlanModeDependencies = {}) {
	return (pi: ExtensionAPI) => registerPlanModeExtension(pi, dependencies);
}

function registerPlanModeExtension(pi: ExtensionAPI, dependencies: PlanModeDependencies): void {
	const resolver = createSessionProfileResolver({
		settingsPath: PROJECT_SETTINGS_PATH,
		profilesDirectory: PROFILES_DIRECTORY,
	});
	const profileStore = dependencies.profileStore ?? createPlanModeProfileStore();
	const normalDefaultsStore = dependencies.normalDefaultsStore ?? createNormalDefaultsStore();
	const waitForNativePersistence = dependencies.waitForNativePersistence ??
		(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
	const workspaceFactory = dependencies.createWorkspace ?? createPlanWorkspace;
	const sandboxFactory = dependencies.createSandbox ?? createPlanSandboxController;

	let planState: PlanState = createInitialPlanState();
	let activePlanProfile: ModeModelProfile | undefined;
	let normalGlobalDefaults: ModeModelProfile | undefined;
	let profileTransitionDepth = 0;
	let profileEventQueue = Promise.resolve();
	let lifecycleQueue = Promise.resolve();
	let lifecycleGeneration = 0;
	let latestProposedPlan: string | undefined;
	let latestProposedPlanKey: string | undefined;
	let modeTransition: "entering" | "exiting" | undefined;
	let modeTransitionPromise: Promise<boolean> | undefined;
	let runtimeContext: ExtensionContext | undefined;
	let requestModeRevision: number | undefined;
	let modeRevisionCounter = planState.revision;
	let hasReconstructedState = false;
	let reviewController: PlanReviewController;

	function updateRuntimeStatus(status: PlanRuntimeStatus): void {
		const ctx = runtimeContext;
		if (!ctx) return;
		if (status.phase === "warming") {
			ctx.ui.setStatus("plan-runtime", "⏳ sandbox");
			return;
		}
		if (status.phase === "disposing") {
			ctx.ui.setStatus("plan-runtime", "⏳ sandbox cleanup");
			return;
		}
		if (status.phase === "failed") {
			ctx.ui.setStatus("plan-runtime", "⚠ sandbox");
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

	const planRuntime = createPlanRuntimeCoordinator({
		createWorkspace: (hostRoot, options) => workspaceFactory(hostRoot, options),
		createSandbox: (workspace) => sandboxFactory(workspace),
		onStatus: updateRuntimeStatus,
	});

	const planBash = createBashTool(process.cwd(), {
		operations: {
			async exec(command, cwd, options) {
				const sandbox = await planRuntime.require(options.signal);
				return sandbox.operations.exec(command, cwd, options);
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
	registerPlanRenderers(pi);

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

	function warmPlanRuntime(ctx: ExtensionContext): void {
		runtimeContext = ctx;
		planRuntime.warm(ctx.cwd);
	}

	async function refreshPlanRuntime(ctx: ExtensionContext): Promise<void> {
		await enqueueLifecycle(async () => {
			runtimeContext = ctx;
			await planRuntime.refresh(ctx.cwd);
		});
	}

	const reconstructState = async (ctx: ExtensionContext, generation: number) => {
		const toolsAtStart = pi.getActiveTools();
		const previousState = planState;
		const previousNormalTools = previousState.normalTools;
		runtimeContext = ctx;
		try {
			await planRuntime.dispose();
		} catch (error) {
			if (generation === lifecycleGeneration) {
				ctx.ui.notify(
					`Could not clean up the previous Plan Bash sandbox: ${error instanceof Error ? error.message : String(error)}`,
					"warning",
				);
			}
		}
		if (generation !== lifecycleGeneration) return;

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
					if (generation !== lifecycleGeneration) return;
					normalGlobalDefaults = defaults;
				} catch (error) {
					if (generation !== lifecycleGeneration) return;
					ctx.ui.notify(
						`Could not read Pi's normal defaults: ${error instanceof Error ? error.message : String(error)}`,
						"error",
					);
				}
			}
			if (generation !== lifecycleGeneration) return;
			warmPlanRuntime(ctx);
		} else {
			ctx.ui.setStatus("plan-runtime", undefined);
			pi.setActiveTools(previousNormalTools ?? toolsAtStart.filter((name) => name !== "plan_bash"));
		}
		if (generation === lifecycleGeneration && !modeTransition) updatePlanStatus(ctx, planState);
	};

	const reconstruct = (ctx: ExtensionContext): Promise<void> => {
		const generation = ++lifecycleGeneration;
		return enqueueLifecycle(() => reconstructState(ctx, generation));
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

	async function enterPlanModeInternal(ctx: ExtensionContext, prompt?: string): Promise<boolean> {
		if (isPlanMode(planState)) return true;
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
				clearPlanForEntry();
				commitPlanState(ctx, "plan", prompt, normalTools);
				warmPlanRuntime(ctx);
				return true;
			}

			profileTransitionDepth++;
			try {
				activePlanProfile = await applyModelSelection(pi, ctx, storedProfile, {
					label: "Plan Mode profile",
					settingsStore: profileStore,
					nativeDefaults: dependencies.nativeDefaults,
				});
				switchedSessionProfile = true;
				if (!usesDefaultSentinel(storedProfile)) await profileStore.save(activePlanProfile);
				await preserveDefaults(ctx);
			} finally {
				profileTransitionDepth--;
			}
			clearPlanForEntry();
			commitPlanState(ctx, "plan", prompt, normalTools);
			warmPlanRuntime(ctx);
			return true;
		} catch (error) {
			let rollbackError: unknown;
			if (switchedSessionProfile) {
				try {
					profileTransitionDepth++;
					await applyModelSelection(pi, ctx, normalProfile, {
						label: "Normal profile",
						settingsStore: profileStore,
						nativeDefaults: dependencies.nativeDefaults,
					});
					await preserveDefaults(ctx);
				} catch (failure) {
					rollbackError = failure;
				} finally {
					profileTransitionDepth--;
				}
			}
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

	async function exitPlanModeInternal(ctx: ExtensionContext): Promise<boolean> {
		if (!isPlanMode(planState)) return true;
		const normalTools = planState.normalTools;
		runtimeContext = ctx;
		try {
			await planRuntime.dispose();
		} catch (error) {
			ctx.ui.notify(
				`Could not exit Plan Mode because the Plan Bash sandbox could not be cleaned up: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
			return false;
		}

		const normalProfile = planState.normalProfile;
		if (normalProfile) {
			let restoredSessionProfile = false;
			try {
				profileTransitionDepth++;
				await applyModelSelection(pi, ctx, normalProfile, {
					label: "Normal profile",
					settingsStore: profileStore,
					nativeDefaults: dependencies.nativeDefaults,
				});
				restoredSessionProfile = true;
				await preserveDefaults(ctx);
			} catch (error) {
				let rollbackError: unknown;
				if (restoredSessionProfile && activePlanProfile) {
					try {
						await applyModelSelection(pi, ctx, activePlanProfile, {
							label: "Plan Mode profile",
							settingsStore: profileStore,
							nativeDefaults: dependencies.nativeDefaults,
						});
						await preserveDefaults(ctx);
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
				warmPlanRuntime(ctx);
				return false;
			} finally {
				profileTransitionDepth--;
			}
		}
		commitPlanState(ctx, "default", undefined, normalTools);
		return true;
	}

	function beginModeTransition(ctx: ExtensionContext): void {
		if (!ctx.isIdle()) ctx.abort();
		const advanced = advancePlanStateRevision(planState, modeRevisionCounter);
		planState = advanced.state;
		modeRevisionCounter = advanced.revisionCounter;
	}

	async function enterPlanMode(ctx: ExtensionContext, prompt?: string): Promise<boolean> {
		if (isPlanMode(planState)) return true;
		if (modeTransition) {
			ctx.ui.notify(`Plan Mode is already ${modeTransition}.`, "info");
			return false;
		}
		beginModeTransition(ctx);
		modeTransition = "entering";
		ctx.ui.setStatus("plan", "📋 plan starting");
		const transition = enqueueLifecycle(() => enterPlanModeInternal(ctx, prompt));
		modeTransitionPromise = transition;
		try {
			return await transition;
		} finally {
			if (modeTransitionPromise === transition) {
				modeTransition = undefined;
				modeTransitionPromise = undefined;
				updatePlanStatus(ctx, planState);
			}
		}
	}

	async function exitPlanMode(ctx: ExtensionContext): Promise<boolean> {
		if (!isPlanMode(planState)) return true;
		if (modeTransition) {
			ctx.ui.notify(`Plan Mode is already ${modeTransition}.`, "info");
			return false;
		}
		beginModeTransition(ctx);
		modeTransition = "exiting";
		ctx.ui.setStatus("plan", "📋 plan exiting");
		const transition = enqueueLifecycle(() => exitPlanModeInternal(ctx));
		modeTransitionPromise = transition;
		try {
			return await transition;
		} finally {
			if (modeTransitionPromise === transition) {
				modeTransition = undefined;
				modeTransitionPromise = undefined;
				updatePlanStatus(ctx, planState);
			}
		}
	}

	reviewController = createPlanReviewController({
		getSnapshot: () => ({
			state: planState,
			latestPlan: latestProposedPlan,
			latestPlanKey: latestProposedPlanKey,
			lifecycleGeneration,
		}),
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
	});

	pi.on("session_start", async (event, ctx) => {
		// Point the profile store at the session's profile file so the Plan Mode
		// model is read/written there; no profile means settings.json.
		profileStore.setPath(resolver.resolve(ctx.sessionManager.getBranch(), event.reason));
		await reconstruct(ctx);
	});
	pi.on("session_tree", async (_event, ctx) => reconstruct(ctx));
	pi.on("session_shutdown", async (_event, ctx) => {
		lifecycleGeneration++;
		await enqueueLifecycle(async () => {
			runtimeContext = ctx;
			try {
				await planRuntime.dispose();
			} catch (error) {
				ctx.ui.notify(
					`Could not clean up the Plan Bash sandbox: ${error instanceof Error ? error.message : String(error)}`,
					"warning",
				);
			}
			if (isPlanMode(planState)) restoreNormalTools();
		});
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
		if (generation !== lifecycleGeneration || !isPlanMode(planState)) return;
		activePlanProfile = profile;
		let persistenceError: unknown;
		try {
			await profileStore.save(profile);
		} catch (error) {
			persistenceError = error;
		}
		if (generation !== lifecycleGeneration || !isPlanMode(planState)) return;
		try {
			await preserveDefaults(ctx, defaults);
		} catch (error) {
			if (generation !== lifecycleGeneration || !isPlanMode(planState)) return;
			ctx.ui.notify(
				`Could not preserve Pi's normal defaults: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
		}
		if (generation !== lifecycleGeneration || !isPlanMode(planState)) return;
		if (persistenceError) {
			ctx.ui.notify(
				`Could not save the Plan Mode profile: ${persistenceError instanceof Error ? persistenceError.message : String(persistenceError)}`,
				"error",
			);
		}
		if (generation === lifecycleGeneration && isPlanMode(planState)) updatePlanStatus(ctx, planState);
	}

	pi.on("model_select", async (event, ctx) => {
		if (!isPlanMode(planState) || profileTransitionDepth > 0 || event.source === "restore") return;
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
		if (!isPlanMode(planState) || profileTransitionDepth > 0 || !activePlanProfile) return;
		const profile = { ...activePlanProfile, thinkingLevel: event.level as ModelThinkingLevel };
		const generation = lifecycleGeneration;
		const defaults = normalGlobalDefaults;
		await enqueueProfileEvent(() => rememberActivePlanProfile(ctx, profile, generation, defaults));
	});

	pi.on("input", async (event, ctx) => reviewController.handleInput(event, ctx));
	pi.on("turn_end", async (_event, ctx) => updatePlanStatus(ctx, planState));

	pi.on("before_agent_start", async (event, _ctx) => {
		const pendingTransition = modeTransitionPromise;
		if (pendingTransition) await pendingTransition;
		const snapshot: AgentModeState = {
			mode: planState.mode,
			revision: planState.revision,
			changedAt: planState.changedAt,
		};
		requestModeRevision = snapshot.revision;
		return {
			systemPrompt: buildPlanModeSystemPrompt(event.systemPrompt, {
				...snapshot,
				phase: planState.phase,
			}),
		};
	});

	pi.on("message_end", async (event, _ctx) => {
		if (event.message.role !== "assistant") return;
		if (requestModeRevision !== undefined && requestModeRevision !== planState.revision) {
			return { message: discardAssistantMessage(event.message) };
		}
		if (!isPlanMode(planState)) return;

		const text = extractAssistantText(event.message);
		const plan = extractProposedPlan(text);
		if (!plan) return;

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
		return { message: replaceAssistantText(event.message, visibleText) };
	});

	pi.on("agent_settled", async (_event, ctx) => reviewController.handleAgentSettled(ctx));

	pi.on("tool_call", async (event) => {
		if (!isPlanMode(planState)) return;
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
	});

	pi.registerCommand("plan-implement-fresh", {
		description: "Implement the latest proposed plan in a fresh session",
		handler: async (_args, ctx) => reviewController.implementDeferredFresh(ctx),
	});

	async function togglePlanMode(ctx: ExtensionContext, prompt?: string): Promise<boolean> {
		if (isPlanMode(planState)) {
			if (!(await exitPlanMode(ctx))) return false;
			ctx.ui.notify("Plan mode exited.", "info");
			return true;
		}
		if (!(await enterPlanMode(ctx, prompt))) return false;
		ctx.ui.notify(
			activePlanProfile
				? `📋 Plan mode active: ${profileLabel(activePlanProfile)}`
				: "📋 Plan mode active.",
			"info",
		);
		return true;
	}

	pi.registerShortcut("shift+tab", {
		description: "Toggle plan mode",
		handler: async (ctx) => {
			await togglePlanMode(ctx, isPlanMode(planState) ? undefined : planState.prompt);
		},
	});

	pi.registerCommand("plan", {
		description: "Toggle plan mode, or use /plan <task|implement|fresh|revise|show|refresh|exit>",
		getArgumentCompletions: (prefix: string) => {
			const items = ["fresh", "implement", "accept", "revise ", "show", "refresh", "status", "exit"];
			return items.filter((item) => item.startsWith(prefix)).map((value) => ({ value, label: value }));
		},
		handler: async (args, ctx) => {
			const trimmed = (args || "").trim();
			const [command, ...rest] = trimmed.split(/\s+/);
			const subcommand = command?.toLowerCase();
			const feedback = rest.join(" ").trim();

			if (subcommand === "implement" || subcommand === "accept") {
				const plan = reviewController.requireLatestPlan(ctx);
				if (plan) await reviewController.implementCurrent(ctx, plan);
				return;
			}
			if (subcommand === "fresh") {
				const plan = reviewController.requireLatestPlan(ctx);
				if (plan) await reviewController.implementFresh(ctx, plan);
				return;
			}
			if (subcommand === "revise") {
				await reviewController.revise(ctx, feedback);
				return;
			}
			if (subcommand === "show") {
				reviewController.show(ctx);
				return;
			}
			if (subcommand === "refresh") {
				if (!isPlanMode(planState)) {
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
				const profileDetails = isPlanMode(planState) && activePlanProfile && planState.normalProfile
					? ` Plan: ${profileLabel(activePlanProfile)}. Normal on exit: ${profileLabel(planState.normalProfile)}.`
					: "";
				ctx.ui.notify(
					isPlanMode(planState)
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
				if (isPlanMode(planState) || await enterPlanMode(ctx, trimmed)) {
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
					updatePlanStatus(ctx, planState);
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
