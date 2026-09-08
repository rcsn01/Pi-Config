/**
 * Cross-extension marker for profile-driven model applications.
 *
 * When config-profiles applies a switched-to profile's model selection, that
 * live model change is not a user selection: observers (e.g. the Plan Mode
 * lifecycle's model_select persistence) must not record it into the currently
 * bound profile's slots — the session is still bound to the profile being
 * switched FROM, so the write would mix the target profile's settings into
 * the source profile's file.
 *
 * The flag lives on a global symbol so separately loaded extension modules
 * share one state, matching the session-profile-binding registry pattern.
 */

const PROFILE_MODEL_APPLICATION_KEY = Symbol.for("pi.extensions.profile-model-application.v1");

interface ProfileModelApplicationState {
	depth: number;
}

function state(): ProfileModelApplicationState {
	const globals = globalThis as typeof globalThis & {
		[PROFILE_MODEL_APPLICATION_KEY]?: ProfileModelApplicationState;
	};
	return globals[PROFILE_MODEL_APPLICATION_KEY] ??= { depth: 0 };
}

/** Mark one profile-driven model application; returns the idempotent end hook. */
export function beginProfileModelApplication(): () => void {
	const current = state();
	current.depth++;
	let done = false;
	return () => {
		if (done) return;
		done = true;
		current.depth--;
	};
}

/** True while a profile-driven model application is in flight. */
export function isProfileModelApplicationInFlight(): boolean {
	return state().depth > 0;
}