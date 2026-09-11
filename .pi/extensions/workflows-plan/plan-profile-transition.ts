/**
 * Plan profile transition for the Plan Mode lifecycle.
 *
 * Owns one currency-guarded Profile transition: apply a target Profile through
 * Pi, optionally persist it to the Session's Plan-mode persistence (skipping
 * default-sentinel profiles), preserve captured normal defaults, and, when a
 * step fails after the target applied, roll back to a fallback Profile before
 * reporting the primary and rollback errors as data. It also owns the Plan
 * selection transition marker: Model and thinking feedback emitted inside the
 * transition window is not treated as a user selection. Notification text,
 * Plan State commits, tool projection, and runtime warming stay in the
 * lifecycle core.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	applyModelSelection,
} from "../_shared/model-selection-runtime.ts";
import {
	usesDefaultSentinel,
	type ModelSelectionSettings,
	type StoredModelSelectionSettings,
} from "../_shared/model-selection.ts";
import type { PiNativeDefaults } from "../_shared/pi-defaults.ts";
import type { ModeModelProfile } from "./model-profile.ts";
import type { PlanGuard, PlanSession } from "./plan-currency.ts";

export interface PlanProfileTransitionRequest {
	/** Profile to apply through Pi; as stored, so default sentinels still resolve. */
	target: StoredModelSelectionSettings;
	/** Human label used in error messages, e.g. "Plan Mode profile". */
	label: string;
	/** Persist the applied profile to the Session's Plan-mode persistence. */
	persist?: { session: PlanSession; unlessSentinel?: StoredModelSelectionSettings };
	/** Captured normal defaults preserved after the apply and after a rollback. */
	defaults?: ModeModelProfile;
	/** When a step fails after the target applied: guarded restore of this
	 *  fallback. Omitted means no rollback. */
	rollback?: { target: ModeModelProfile; label: string; defaults?: ModeModelProfile };
}

export interface PlanProfileTransitionResult {
	/** True when the target applied and no later step failed. */
	ok: boolean;
	/** Profile in effect when the transition stopped: the target, or the
	 *  fallback after a successful rollback, or undefined when the apply
	 *  itself failed. */
	profile?: ModeModelProfile;
	/** Primary failure, if any. */
	error?: unknown;
	/** Failure while restoring the fallback, if any. */
	rollbackError?: unknown;
}

export interface PlanProfileTransitionHost {
	/** One Plan guarded effect per transition; staleness is checked at every
	 *  boundary the transition declares. Replaces isCurrent(session). */
	createGuard(session: PlanSession): PlanGuard;
	/** The lifecycle's normal-defaults preservation; undefined defaults fall
	 *  back to the lifecycle's captured normal defaults. */
	preserveDefaults(ctx: ExtensionContext, defaults?: ModeModelProfile): Promise<void>;
}

export interface PlanProfileTransition {
	/** Apply one guarded Profile transition and report the outcome as data. */
	apply(
		ctx: ExtensionContext,
		session: PlanSession,
		request: PlanProfileTransitionRequest,
	): Promise<PlanProfileTransitionResult>;
	/** The Plan selection transition marker: true while a guarded transition
	 *  is in flight. */
	inTransition(): boolean;
}

export function createPlanProfileTransition(
	pi: ExtensionAPI,
	host: PlanProfileTransitionHost,
	dependencies: { nativeDefaults?: PiNativeDefaults },
): PlanProfileTransition {
	let transitionDepth = 0;

	async function applyProfile(
		ctx: ExtensionContext,
		target: StoredModelSelectionSettings,
		label: string,
	): Promise<ModelSelectionSettings> {
		return await applyModelSelection(pi, ctx, target, {
			label,
			nativeDefaults: dependencies.nativeDefaults,
		});
	}

	async function apply(
		ctx: ExtensionContext,
		session: PlanSession,
		request: PlanProfileTransitionRequest,
	): Promise<PlanProfileTransitionResult> {
		transitionDepth++;
		try {
			const guard = host.createGuard(session);
			let profile: ModeModelProfile | undefined;
			let applied = false;
			try {
				// Unguarded head: the apply runs even when the session went
				// stale at entry, so the profile never sticks half-applied.
				profile = await applyProfile(ctx, request.target, request.label);
				applied = true;
				await guard.run(
					async () => {
						const sentinelRef = request.persist?.unlessSentinel;
						if (request.persist && !(sentinelRef !== undefined && usesDefaultSentinel(sentinelRef))) {
							await request.persist.session.persistence.save("plan", profile!);
						}
					},
					() => host.preserveDefaults(ctx, request.defaults),
				);
				return { ok: true, profile };
			} catch (error) {
				if (!applied || !request.rollback) {
					return { ok: false, error, profile: applied ? profile : undefined };
				}
				let rollbackProfile: ModeModelProfile | undefined;
				let rollbackError: unknown;
				try {
					await guard.run(
						async () => {
							try {
								rollbackProfile = await applyProfile(ctx, request.rollback!.target, request.rollback!.label);
							} catch (error) {
								// Capture as data, then rethrow so the runner skips
								// the restore step (today's semantics).
								rollbackError = error;
								throw error;
							}
						},
						async () => {
							try {
								await host.preserveDefaults(ctx, request.rollback!.defaults);
							} catch (error) {
								rollbackError = error; // error-as-data: keep reporting the primary error
							}
						},
					);
				} catch {
					// Step-1 failure already captured as rollbackError; step 2 was
					// skipped by the runner.
				}
				return { ok: false, error, profile: rollbackProfile, rollbackError };
			}
		} finally {
			transitionDepth--;
		}
	}

	return {
		apply,
		inTransition: () => transitionDepth > 0,
	};
}