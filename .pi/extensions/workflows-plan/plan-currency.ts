/**
 * Plan session currency for the Plan Mode lifecycle.
 *
 * Owns the current `PlanSession` identity, the monotonic lifecycle generation,
 * Session-id resolution, and staleness checks. `plan-lifecycle.ts` constructs
 * it once and routes Session-start, branch-change, and Session-stop identity
 * events through it; stale flows abandon before their next effect.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ModelSelectionPersistence } from "../_shared/model-selection-persistence.ts";
import type { SessionProfileBinding } from "../_shared/session-profile-binding.ts";

export interface PlanSession {
	readonly binding: SessionProfileBinding;
	readonly sessionId: string;
	readonly persistence: ModelSelectionPersistence;
	readonly generation: number;
}

export interface PlanCurrencyDependencies {
	createPersistence(settingsPath: string): ModelSelectionPersistence;
}

export interface PlanCurrency {
	/** sessionStarted: bind a fresh Session (fresh persistence, generation from begin). */
	begin(binding: SessionProfileBinding, ctx: ExtensionContext): PlanSession;
	/** branchChanged: derive a new identity from `session`, invalidating every older flow. */
	advance(session: PlanSession): PlanSession;
	/**
	 * sessionStopping prologue: clear the identity and invalidate, if `session`
	 * is still current. Returns whether it ended (the caller skips its Session
	 * teardown effects when a newer identity already replaced `session`).
	 */
	end(session: PlanSession): boolean;
	/** planSessionFor: the current session iff ctx still matches its Session id. */
	resolve(ctx: ExtensionContext): PlanSession | undefined;
	/** requirePlanSession. */
	require(ctx: ExtensionContext): PlanSession;
	/** isCurrentPlanSession. */
	isCurrent(session: PlanSession): boolean;
	/** Review-host snapshot: capture (session, generation) once; isCurrent() stays meaningful. */
	snapshot(): { isCurrent(): boolean };
}

export function createPlanCurrency(dependencies: PlanCurrencyDependencies): PlanCurrency {
	let currentSession: PlanSession | undefined;
	let generation = 0;

	function begin(binding: SessionProfileBinding, ctx: ExtensionContext): PlanSession {
		const nextGeneration = ++generation;
		currentSession = undefined;
		const session: PlanSession = {
			binding,
			sessionId: ctx.sessionManager.getSessionId(),
			persistence: dependencies.createPersistence(binding.settingsPath),
			generation: nextGeneration,
		};
		currentSession = session;
		return session;
	}

	function advance(session: PlanSession): PlanSession {
		const nextSession = { ...session, generation: ++generation };
		currentSession = nextSession;
		return nextSession;
	}

	function end(session: PlanSession): boolean {
		if (currentSession !== session) return false;
		currentSession = undefined;
		generation++;
		return true;
	}

	function resolve(ctx: ExtensionContext): PlanSession | undefined {
		const session = currentSession;
		return session?.sessionId === ctx.sessionManager.getSessionId() ? session : undefined;
	}

	function require(ctx: ExtensionContext): PlanSession {
		const session = resolve(ctx);
		if (!session) {
			throw new Error("Plan Mode lifecycle is not initialized for this Session.");
		}
		return session;
	}

	function isCurrent(session: PlanSession): boolean {
		return currentSession === session && generation === session.generation;
	}

	function snapshot(): { isCurrent(): boolean } {
		const snapshotSession = currentSession;
		const snapshotGeneration = generation;
		return {
			isCurrent: () => currentSession === snapshotSession && generation === snapshotGeneration,
		};
	}

	return { begin, advance, end, resolve, require, isCurrent, snapshot };
}