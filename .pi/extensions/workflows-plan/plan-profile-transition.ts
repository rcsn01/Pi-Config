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
	usesDefaultSentinel,
	type ModelSelectionSettings,
	type StoredModelSelectionSettings,
} from "../_shared/model-selection.ts";
import type { PiNativeDefaults } from "../_shared/pi-defaults.ts";
import type { ModeModelProfile } from "./model-profile.ts";
import type { PlanSession } from "./plan-currency.ts";

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
	/** Plan session currency guard, checked at each asynchronous boundary. */
	isCurrent(session: PlanSession): boolean;
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

	async function restoreFallback(
		ctx: ExtensionContext,
		session: PlanSession,
		rollback: NonNullable<PlanProfileTransitionRequest["rollback"]>,
	): Promise<{ profile?: ModeModelProfile; rollbackError?: unknown }> {
		if (!host.isCurrent(session)) return {};
		try {
			const profile = await applyProfile(ctx, rollback.target, rollback.label);
			if (!host.isCurrent(session)) return { profile };
			await host.preserveDefaults(ctx, rollback.defaults);
			return { profile };
		} catch (error) {
			return { rollbackError: error };
		}
	}

	async function apply(
		ctx: ExtensionContext,
		session: PlanSession,
		request: PlanProfileTransitionRequest,
	): Promise<PlanProfileTransitionResult> {
		transitionDepth++;
		try {
			let profile: ModeModelProfile | undefined;
			let targetApplied = false;
			try {
				profile = await applyProfile(ctx, request.target, request.label);
				targetApplied = true;
				if (!host.isCurrent(session)) return { ok: true, profile };
				const sentinelRef = request.persist?.unlessSentinel;
				if (request.persist && !(sentinelRef !== undefined && usesDefaultSentinel(sentinelRef))) {
					await request.persist.session.persistence.save("plan", profile);
				}
				if (!host.isCurrent(session)) return { ok: true, profile };
				await host.preserveDefaults(ctx, request.defaults);
				if (!host.isCurrent(session)) return { ok: true, profile };
				return { ok: true, profile };
			} catch (error) {
				if (!targetApplied || !request.rollback) {
					return { ok: false, error, profile: targetApplied ? profile : undefined };
				}
				const restored = await restoreFallback(ctx, session, request.rollback);
				return {
					ok: false,
					error,
					profile: restored.profile,
					rollbackError: restored.rollbackError,
				};
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