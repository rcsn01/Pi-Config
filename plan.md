# Plan: Plan profile transition seam for the Plan Mode lifecycle

Date: 2026-09-06 · Source: architecture review candidate 1 (Strong) ·
Status: design finalised, CONTEXT.md term added

## Objective

Extract the three inline copies of guarded Profile apply/restore/rollback from
`workflows-plan/plan-lifecycle.ts` (1084 lines) behind one internal seam,
`workflows-plan/plan-profile-transition.ts`, following the exact pattern of
the two seams already extracted from this module (Plan session currency,
Pending-mode queue). After this change the orchestration core keeps
branch reconstruction, state commits, tool projection, prompt/turn guarding,
and Plan Review host construction; every guarded Profile transition runs
through the new module's interface.

## Decisions (grilling frontier, resolved with recommended answers)

1. **Where does the seam live?** → New file `plan-profile-transition.ts`
   beside the lifecycle, private to the lifecycle's implementation — same
   convention as `plan-currency.ts` and `plan-pending-mode.ts`. A local
   function inside `plan-lifecycle.ts` would fail the file-per-seam convention
   this repo already established for its internal seams.
2. **What does the seam own?** → The complete currency-guarded Profile
   transition effect: apply via `applyModelSelection`, optional persist to the
   Session's Plan-mode persistence (skipping default-sentinel profiles),
   `preserveDefaults` at every async boundary, and rollback to a fallback
   Profile when a step fails after the target applied. Notification text, Plan
   State mutation, tool projection, and runtime warming stay in the core — the
   module returns outcomes as data.
3. **Interface shape?** (considered: (a) two lifecycle-shaped operations
   enter/exit; (b) one atomic parameterised operation) → (b). All three call
   sites share one sequence (apply → guard → optional persist → guard →
   preserve defaults → guard; on failure: guarded rollback + error capture);
   only the arguments differ. One deep operation behind a small interface
   beats two operations that mirror the callers. The enter/exit-specific
   reactions (notify labels, `warmPlanRuntime`, state reset) stay in the core.
4. **Who owns the Plan selection transition marker?** → The new module.
   `profileTransitionDepth` and `withProfileTransition` move into it behind
   `inTransition()`; `observePlanSelection` consults that instead of the raw
   counter. `profileEventQueue` and `rememberActivePlanProfile` (selection
   observation, not transition) stay in the core.
5. **Mode-transition bookkeeping duplication** (enter/exit pair at
   `:657–707`)? → Fold a private parametric runner into `plan-lifecycle.ts` on
   the same pass; it is 25 lines of bookkeeping, not a seam. No new module.
6. **Testing strategy** → New `plan-profile-transition.test.ts` tested
   directly through the module's interface with in-memory hosts (the second
   adapter that justifies the internal seam). Existing
   `plan-lifecycle.test.ts` integration tests continue to pass unchanged —
   they already test through the lifecycle's dispatch interface.
7. **Rollback trigger rule?** → Roll back only if the target Profile finished
   applying (the current `switchedSessionProfile` / `restoredSessionProfile`
   semantics). If `applyModelSelection` itself throws, no rollback is
   attempted. Staleness abandons silently at each boundary; the core's own
   `isCurrent` checks decide continuation.
8. **Scope guard** → Do not touch `reconstructState`'s profile capture, the
   no-stored-profile enter branch (no live-model transition happens there),
   `profileEventQueue` serialisation, or the Pending-mode queue. One pass,
   one seam, one helper.

## Current-state evidence

`plan-lifecycle.ts` repeats the same guarded sequence three times:

| Site | Lines | Sequence |
| --- | --- | --- |
| Enter: apply stored Plan profile | 534–546 | `withProfileTransition` → `applyModelSelection("Plan Mode profile")` → guard → `save("plan", profile)` unless `usesDefaultSentinel(storedProfile)` → guard → `preserveDefaults(capturedDefaults)` |
| Enter: rollback on failure | 557–570 | guarded `applyModelSelection(normalProfile, "Normal profile")` → guard → `preserveDefaults(capturedDefaults)`; failure captured as `rollbackError` |
| Exit: restore normal profile | 605–645 | `applyModelSelection(normalProfile, "Normal profile")` → guard → `preserveDefaults()` → guard; on failure: guarded rollback to `activePlanProfile` + `preserveDefaults()`, rollback-note formatting, notify, `warmPlanRuntime` |

Plus the marker plumbing: `profileTransitionDepth` (`:286`),
`withProfileTransition` (`:367–374`), consulted by `observePlanSelection`
(`:717`), and the duplicated enter/exit transition bookkeeping (`:657–707`).

## Target design

### New module: `workflows-plan/plan-profile-transition.ts`

```ts
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PiNativeDefaults } from "../_shared/pi-defaults.ts";
import { applyModelSelection, usesDefaultSentinel } from "../_shared/model-selection.ts";
import type { StoredModelSelectionSettings } from "../_shared/model-selection.ts";
import type { ModeModelProfile } from "./model-profile.ts";
import type { PlanSession } from "./plan-currency.ts";

export interface PlanProfileTransitionRequest {
	/** Profile to apply through Pi. Stored, not concrete: site 1 passes the
	 *  loaded `StoredModelSelectionSettings`, which may still carry
	 *  `DEFAULT_SENTINEL` fields — `ModeModelProfile` (`ConcreteModelSelection`)
	 *  forbids sentinels and would not typecheck against that call. A
	 *  `ConcreteModelSelection` (site 3's `normalProfile`/`activePlanProfile`)
	 *  is structurally a `StoredModelSelectionSettings`, so this type covers
	 *  every call site. */
	target: StoredModelSelectionSettings;
	/** Human label passed to applyModelSelection (e.g. "Plan Mode profile"). */
	label: string;
	/** Persist the applied profile to the Session's Plan-mode persistence
	 *  (using the `session` passed to `apply`), skipped entirely when
	 *  `unlessSentinel` uses the default sentinel. */
	persist?: { unlessSentinel?: StoredModelSelectionSettings };
	/** Captured normal defaults preserved after the apply (and after rollback). */
	defaults?: ModeModelProfile;
	/** On failure after the target applied: guarded restore of this fallback
	 *  followed by `preserveDefaults`. Omitted ⇒ no rollback. */
	rollback?: { target: ModeModelProfile; label: string; defaults?: ModeModelProfile };
}

export interface PlanProfileTransitionResult {
	/** True when the target applied and no later step failed. */
	ok: boolean;
	/** Profile in effect when the transition stopped (target, or fallback on
	 *  failed transition, or undefined when apply itself failed). */
	profile?: ModeModelProfile;
	/** Primary failure, if any. */
	error?: unknown;
	/** Failure while restoring the fallback, if any. */
	rollbackError?: unknown;
}

export interface PlanProfileTransitionHost {
	/** Plan session currency guard, checked at each async boundary. */
	isCurrent(session: PlanSession): boolean;
	/** The lifecycle's preserveDefaults (normal defaults restore with
	 *  waitForNativePersistence); receives explicit defaults or undefined. */
	preserveDefaults(ctx: ExtensionContext, defaults?: ModeModelProfile): Promise<void>;
}

export interface PlanProfileTransition {
	apply(
		ctx: ExtensionContext,
		session: PlanSession,
		request: PlanProfileTransitionRequest,
	): Promise<PlanProfileTransitionResult>;
	/** True while a guarded transition is in flight (the Plan selection
	 *  transition marker). */
	inTransition(): boolean;
}

export function createPlanProfileTransition(
	pi: ExtensionAPI,
	host: PlanProfileTransitionHost,
	dependencies: { nativeDefaults?: PiNativeDefaults },
): PlanProfileTransition;
```

### Semantics contract

- The marker is up (depth > 0) for the whole `apply` call; `inTransition()`
  reports it. `apply` decrements in a `finally`.
- `apply` sequence: `applyModelSelection(pi, ctx, target, { label,
  nativeDefaults })` → if stale (`isCurrent` false), return `{ ok: true,
  profile }` without further effects → if `persist` and not
  `usesDefaultSentinel(request.persist.unlessSentinel)`, `session.persistence.save("plan", profile)`
  (using the `session` passed to `apply`, not a field on the request) →
  guard → `host.preserveDefaults(ctx, request.defaults)` → guard → return
  `{ ok: true, profile }`.
- On any thrown step: if the target already applied and `rollback` was
  supplied, run the same guarded sequence for the fallback (apply → guard →
  `host.preserveDefaults(rollback.defaults)`) capturing `rollbackError`; then
  return `{ ok: false, error, rollbackError, profile: fallback? }`.
- If `applyModelSelection` itself throws, no rollback; return
  `{ ok: false, error }`.
- Staleness during the rollback stops it silently (no throw).
- The module does not notify, mutate Plan State, touch tools, or warm the
  runtime; callers react to the result.

### Call-site mapping in `plan-lifecycle.ts`

**Site 1 — enter, apply stored profile (`:534–554`).** `switchedSessionProfile`
and the nested `withProfileTransition` disappear:

```ts
const outcome = await profileTransition.apply(ctx, session, {
	target: storedProfile,
	label: "Plan Mode profile",
	persist: { unlessSentinel: storedProfile },
	defaults: capturedDefaults,
	rollback: { target: normalProfile, label: "Normal profile", defaults: capturedDefaults },
});
if (!currency.isCurrent(session)) return false;
if (!outcome.ok) { /* existing catch body: tool restore, state reset, notify with outcome.error/outcome.rollbackError */ }
const appliedProfile = outcome.profile!;
```

**Site 2 — enter rollback (`:557–570`).** Deleted; absorbed by site 1's
`rollback` argument. The `rollbackNote` suffix composes from
`outcome.rollbackError` exactly as today.

**Site 3 — exit, restore normal profile (`:605–645`).**

```ts
const outcome = await profileTransition.apply(ctx, session, {
	target: normalProfile,
	label: "Normal profile",
	defaults: undefined, // host resolves normalGlobalDefaults, as today
	rollback: activePlanProfile
		? { target: activePlanProfile, label: "Plan Mode profile", defaults: undefined }
		: undefined,
});
if (!currency.isCurrent(session)) return false;
if (!outcome.ok) {
	ctx.ui.notify(/* exit failure text from outcome.error / rollbackError */, "error");
	warmPlanRuntime(ctx);
	return false;
}
```

The explicit `currency.isCurrent` check is required here for the same reason
site 1 keeps one: per the semantics contract, staleness during the *primary*
(non-rollback) apply sequence returns `{ ok: true, profile }`, not a thrown
error — so `outcome.ok` alone cannot distinguish "applied successfully" from
"went stale mid-transition, no rollback attempted." Without this guard,
`commitPlanState` below would run against a session a branch change or
Session stop has already replaced — exactly the class of bug `isCurrent`
guards exist to prevent everywhere else in this file. It also reproduces the
original `:646` guard that already runs after the old inline `restored`
check, so this is not new call overhead, just kept explicit through the
rewrite instead of left implicit.

The `restoredSessionProfile` flag disappears (module-internal: rollback runs
iff the target applied). `rollback: activePlanProfile ? … : undefined` keeps
the current gating in the core, which owns `activePlanProfile`.

Behavior note: today the failed-exit notify sits inside the transition marker
window; after this change it runs immediately after `apply` resolves. There is
no await between the marker dropping and the notify, so no interleaving is
possible and the observable semantics are unchanged.

**Marker plumbing.** Delete `profileTransitionDepth` and
`withProfileTransition`; construct `const profileTransition =
createPlanProfileTransition(pi, { isCurrent: currency.isCurrent,
preserveDefaults }, { nativeDefaults: dependencies.nativeDefaults })` near the
other seams. `observePlanSelection` (`:717`) checks
`profileTransition.inTransition()`. `preserveDefaults` keeps its current
default-argument behavior (undefined ⇒ `normalGlobalDefaults`), so the module
can pass `undefined` for the exit path.

**Mode-transition runner (same pass, optional second commit).** Collapse the
enter/exit pair (`:657–707`) into one private helper:

```ts
async function runModeTransition(
	ctx: ExtensionContext,
	direction: "entering" | "exiting",
	isAlready: () => boolean,
	run: (session: PlanSession) => Promise<boolean>,
): Promise<boolean>
```

holding the duplicated guard (`modeTransition` in-flight notify), `beginModeTransition()`, status write, `enqueueLifecycle`, `modeTransitionPromise` bookkeeping, and the finally block. `enterPlanMode`/`exitPlanMode` become thin wrappers passing `isAlready` and the internal call.

## Implementation steps

1. **CONTEXT.md term** — done before this plan was written ("Plan profile
   transition" added; "Plan selection transition" and "Plan Mode lifecycle"
   updated), following the repo convention of naming seams before extraction
   (commit `d3482a7`).
2. **New module** `workflows-plan/plan-profile-transition.ts` with the
   interface and semantics above, module header comment in the established
   style ("Owns one currency-guarded Profile transition … the lifecycle core
   keeps notification, Plan State commits, tool projection, and runtime
   warming").
3. **New tests** `workflows-plan/plan-profile-transition.test.ts` (vitest,
   direct construction with fake hosts, style of `plan-currency.test.ts`):
   - apply success: `applyModelSelection` called with label +
     `nativeDefaults`; result `{ ok, profile }`.
   - persist: saves applied profile to `session.persistence` under `"plan"`.
   - persist sentinel skip: `unlessSentinel` uses the default sentinel ⇒ no
     save.
   - defaults preserved via the host with the request's defaults.
   - staleness: `isCurrent` false after apply ⇒ no save, no preserve, ok
     result; stale after persist ⇒ no preserve; stale after preserve ⇒ plain
     return.
   - failure during persist ⇒ rollback applied with fallback label and
     defaults, `ok: false`, `error` and `rollbackError` reported; host
     `preserveDefaults` called twice with the right arguments.
   - failure during rollback ⇒ `rollbackError` captured, no throw.
   - apply itself throws ⇒ no rollback attempted.
   - no `rollback` supplied ⇒ failure returns `{ ok: false, error }`.
   - `inTransition()` true while an in-flight `apply` is parked on a
     deferred `applyModelSelection`, false before and after.
4. **Rewire `plan-lifecycle.ts`** per the call-site mapping: construct the
   seam, replace sites 1–3, delete `withProfileTransition` +
   `profileTransitionDepth`, switch `observePlanSelection` to
   `inTransition()`, keep all notify/state/tool/runtime effects in the core.
5. **Mode-transition runner** in `plan-lifecycle.ts` (private helper;
   `enterPlanMode`/`exitPlanMode` become wrappers; behavior identical,
   including the stale-branch finally semantics and their comments).
6. **Verify**:
   - `pnpm test:plan` (all of `extensions/workflows-plan`, including the 890-line lifecycle integration suite — expected to pass unchanged).
   - `pnpm typecheck` at `.pi` root.
   - Full `pnpm test` once at the end.
7. **Align CONTEXT.md wording** if the final seam names drifted during
   implementation (the repo did this after the first two extractions:
   `f5fd432`).

## Risks and behavior notes

- **Exit-failure notify leaves the marker window** — analyzed above; no await
  between window end and notify, so event interleaving cannot occur.
- **Enter failure path shape changes** — today the rollback is a separate
  nested `withProfileTransition`; after the change it is the module's
  rollback step. Order of effects (rollback apply → preserve → then core's
  tool restore → state reset → notify) is preserved.
- **Exit `defaults: undefined`** relies on the host's default-argument
  resolution to `normalGlobalDefaults`; keep that default argument when
  rewiring, or pass the field explicitly in the exit call site.
- **Legacy profiles without `contextWindow`** flow through unchanged —
  `applyModelSelection` and the sentinel check already tolerate them.
- The `persist` save in site 1 happens inside the marker window today and
  stays inside it (module-internal); `rememberActivePlanProfile`'s separate
  save/notify flow is untouched.

## Out of scope

- `rememberActivePlanProfile` / `profileEventQueue` (selection observation).
- `reconstructState` profile capture, no-stored-profile enter branch.
- Pending-mode queue, Plan Review host, tool projection, state commits.
- Any change to `applyModelSelection`, `preserveNormalGlobalDefaults`, or
  `NormalDefaultsStore` interfaces.

## Acceptance checklist

- [x] `plan-profile-transition.ts` exists; `plan-lifecycle.ts` no longer contains `applyModelSelection` calls (1084 → 1031 lines; three inline copies deleted, replaced by the seam construction, `abortEnter`, and `runModeTransition`).
- [x] `plan-profile-transition.test.ts` covers the planned cases (14 tests, including the staleness variants).
- [x] `pnpm test:plan` green (174 passed) with lifecycle integration tests unmodified.
- [x] `pnpm typecheck` clean.
- [x] Full `pnpm test` green (exit 0, zero failures).
- [x] CONTEXT.md wording matches the landed seam names (`plan-profile-transition.ts`, marker owned by the module).