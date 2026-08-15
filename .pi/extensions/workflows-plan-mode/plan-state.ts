import type { ModeModelProfile } from "./model-profile.ts";
import {
	customMessageFromEntry,
	extractLegacyCustomMessageContent,
	planSignature,
	PROPOSED_PLAN_CUSTOM_TYPE,
} from "./plan-content.ts";

export type AgentMode = "default" | "plan";
export type PlanPhase = "planning" | "awaiting_review";

export interface AgentModeState {
	mode: AgentMode;
	revision: number;
	changedAt: string;
}

export interface PlanState extends AgentModeState {
	phase?: PlanPhase;
	prompt?: string;
	latestPlanSignature?: string;
	latestPlan?: string;
	promptedPlanSignature?: string;
	normalProfile?: ModeModelProfile;
	normalTools?: string[];
}

export type LegacyPlanState = Partial<PlanState> & { active?: boolean; setAt?: number };

export const PLAN_STATE_ENTRY_TYPE = "plan-mode-state";

export function createInitialPlanState(mode: AgentMode = "default", revision = 0): PlanState {
	return { mode, revision, changedAt: new Date().toISOString() };
}

export function isPlanMode(state: AgentModeState): boolean {
	return state.mode === "plan";
}

export function normalizePersistedPlanState(data: LegacyPlanState): PlanState {
	const { active, setAt, ...current } = data;
	const mode = current.mode === "plan" || current.mode === "default"
		? current.mode
		: active ? "plan" : "default";
	const revision = Number.isSafeInteger(current.revision) && (current.revision ?? -1) >= 0
		? current.revision!
		: 0;
	const changedAt = typeof current.changedAt === "string"
		? current.changedAt
		: new Date(typeof setAt === "number" ? setAt : Date.now()).toISOString();
	return { ...current, mode, revision, changedAt };
}

export interface ReconstructPlanStateOptions {
	entries: readonly any[];
	previousState: PlanState;
	revisionCounter: number;
	hasReconstructedState: boolean;
	validateNormalProfile?: (value: unknown, label: string) => ModeModelProfile;
}

export interface ReconstructedPlanState {
	state: PlanState;
	latestPlan?: string;
	latestPlanKey?: string;
	revisionCounter: number;
	hasReconstructedState: true;
	profileWarnings: string[];
}

/**
 * Reconstruct the durable Plan Mode snapshot from one branch.
 *
 * The highest persisted state revision wins (with later equal revisions taking
 * precedence), while legacy proposed-plan messages remain recoverable. A
 * reconstruction after the first advances the runtime revision monotonically,
 * even when branch navigation selects older durable state.
 */
export function reconstructPlanState(options: ReconstructPlanStateOptions): ReconstructedPlanState {
	let state = createInitialPlanState();
	let latestPlan: string | undefined;
	let latestPlanKey: string | undefined;
	let legacyPlanMessage = false;
	const profileWarnings: string[] = [];

	for (const entry of options.entries) {
		if (entry.type === "custom" && entry.customType === PLAN_STATE_ENTRY_TYPE) {
			const data = entry.data as LegacyPlanState | undefined;
			if (data) {
				let normalProfile: ModeModelProfile | undefined;
				try {
					normalProfile = data.normalProfile && options.validateNormalProfile
						? options.validateNormalProfile(data.normalProfile, "Session normal profile")
						: data.normalProfile;
				} catch (error) {
					profileWarnings.push(error instanceof Error ? error.message : String(error));
				}
				const candidate = { ...normalizePersistedPlanState(data), normalProfile };
				if (candidate.revision < state.revision) continue;
				state = candidate;
				latestPlan = typeof data.latestPlan === "string" && data.latestPlan.trim()
					? data.latestPlan.trim()
					: undefined;
				latestPlanKey = latestPlan
					? data.latestPlanSignature || planSignature(latestPlan)
					: undefined;
				legacyPlanMessage = false;
			}
			continue;
		}

		const custom = customMessageFromEntry(entry);
		if (custom?.customType === PROPOSED_PLAN_CUSTOM_TYPE) {
			const plan = extractLegacyCustomMessageContent(custom.content).trim();
			if (plan) {
				latestPlan = plan;
				latestPlanKey = custom.details?.signature || planSignature(plan);
				legacyPlanMessage = true;
			}
		}
	}

	if (!isPlanMode(state)) {
		latestPlan = undefined;
		latestPlanKey = undefined;
		legacyPlanMessage = false;
	} else if (latestPlan && state.phase !== "planning") {
		const signature = latestPlanKey;
		state = {
			...state,
			phase: "awaiting_review",
			latestPlanSignature: signature,
			promptedPlanSignature:
				state.promptedPlanSignature ??
				(legacyPlanMessage || state.latestPlanSignature === signature ? signature : undefined),
		};
	}

	let revisionCounter = Math.max(
		options.revisionCounter,
		options.previousState.revision,
		state.revision,
	);
	if (options.hasReconstructedState) {
		revisionCounter++;
		state = { ...state, revision: revisionCounter, changedAt: new Date().toISOString() };
	}
	revisionCounter = state.revision;

	return {
		state,
		latestPlan,
		latestPlanKey,
		revisionCounter,
		hasReconstructedState: true,
		profileWarnings,
	};
}

export function advancePlanStateRevision(
	state: PlanState,
	revisionCounter: number,
): { state: PlanState; revisionCounter: number } {
	const nextRevision = Math.max(revisionCounter, state.revision) + 1;
	return {
		state: { ...state, revision: nextRevision, changedAt: new Date().toISOString() },
		revisionCounter: nextRevision,
	};
}

export interface CommitPlanStateOptions {
	state: PlanState;
	mode: AgentMode;
	prompt?: string;
	latestPlan?: string;
	latestPlanKey?: string;
	normalTools?: string[];
}

export function createCommittedPlanState(options: CommitPlanStateOptions): PlanState {
	const active = options.mode === "plan";
	return {
		mode: options.mode,
		revision: options.state.revision,
		changedAt: options.state.changedAt,
		prompt: options.prompt,
		phase: active ? "planning" : undefined,
		latestPlanSignature: active ? options.latestPlanKey : undefined,
		latestPlan: active ? options.latestPlan : undefined,
		promptedPlanSignature: active ? options.state.promptedPlanSignature : undefined,
		normalProfile: active ? options.state.normalProfile : undefined,
		normalTools: active ? options.normalTools : undefined,
	};
}

export function persistPlanState(
	appendEntry: (customType: string, data: PlanState) => void,
	state: PlanState,
): void {
	appendEntry(PLAN_STATE_ENTRY_TYPE, { ...state });
}
