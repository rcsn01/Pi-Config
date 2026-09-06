# Plan · Guarded-effect seam for the Plan session currency

**Candidate:** #1 from the 2026-09-06 architecture review (`/tmp/architecture-review-20260906-221408.html`)
**Scope:** `.pi/extensions/workflows-plan/` — `plan-currency.ts`, `plan-lifecycle.ts`, `plan-profile-transition.ts`
**Status:** decided (design-it-twice run 2026-09-06; three interface designs compared, Design 3 core selected with refinements)
**Baseline commit:** `e8f60f8` — all line references below refer to this state

---

## 1 · Goal

The Plan Mode lifecycle hand-writes ~23 currency staleness guards of the shape
`if (!currency.isCurrent(session)) return …` at async boundaries across six
flows, plus four compound guards `!isCurrent(session) || !isPlanMode(planState)`
repeated inside one function, and the Plan profile transition module re-checks
`host.isCurrent` five times. The staleness invariant lives in the heads of
maintainers, not in code: every new async step must remember to re-check, and
the failure mode of a forgotten check is *an effect executing on a stale
Session*.

Deepen the Plan session currency module with a **Plan guarded effect** runner
(see CONTEXT.md): callers declare steps, the runner re-evaluates staleness live
before every step and after the last, abandons remaining steps silently on
staleness, and reports staleness as data. The Plan profile transition module
consumes the same seam through its host. After the change:

- 23 mid-flow guard sites across the two modules collapse into step
  declarations; the compound predicate is declared once per run instead of 4×.
- The forgotten-guard bug class is deleted by construction: an undeclared
  boundary degrades to "step skipped by the runner", never "effect on a stale
  Session".
- `plan-lifecycle.ts` shrinks; staleness policy concentrates in the module
  that already owns Session identity (locality), and both modules test
  staleness at one seam instead of per flow (leverage).

**Deletion test:** deleting the runner would reappear as ~23 scattered guards
across every caller — it earns its keep.

## 2 · Design decision

Three interface designs were produced in parallel (minimize-interface,
maximize-flexibility, optimize-for-common-caller). Selected: the
**variadic boolean runner** (smallest interface, live re-evaluation), with two
refinements from the other designs.

Why this shape:

- **Live re-evaluation, no latching.** Today's checks are live; the compound
  predicate `isPlanMode(planState)` can flip back to true mid-run, and today's
  code would continue. A latching runner (rejected Design 1) would permanently
  abandon on a transient flip — a semantics change.
- **Boolean staleness.** The dominant flow shape is 3–5 linear steps with
  silent abandonment and a boolean/void result. Value retention is handled by
  closure locals (no discriminated union, no generics).
- **Live `isCurrent()` on the guard.** Caller-owned error boundaries (catch
  blocks) and positive-gated writes ("notify only if still current") reuse the
  same declared predicate instead of re-deriving `currency.isCurrent(session)`
  by hand at the easiest places to forget.
- **Second consumer justifies the seam.** The lifecycle flows and the Plan
  profile transition module both consume `currency.guard` — a real seam, not a
  hypothetical one (one-adapter rule satisfied).

### 2.1 · Interface (additive to `plan-currency.ts`)

```ts
/** One declared step of a Plan guarded effect. Errors are caller-owned: the
 *  runner never catches. Sync steps are allowed; every step is a boundary. */
export type PlanGuardStep = () => void | Promise<void>;

/** One currency-guarded effect run, bound to a PlanSession. */
export interface PlanGuard {
	/** The run's identity anchor. */
	readonly session: PlanSession;
	/**
	 * The full liveness predicate — currency identity (session + generation)
	 * plus the run's compound predicate, evaluated live. For caller-owned
	 * error boundaries and positive-gated reporting.
	 */
	isCurrent(): boolean;
	/**
	 * Run the declared steps in order. Staleness is checked before every step
	 * (entry included) and once after the final step. On staleness the
	 * remaining steps are abandoned silently — no notify, no throw — and the
	 * run resolves `false`. A throwing step propagates unchanged. Resolves
	 * `true` iff every step ran and the final boundary held.
	 */
	run(...steps: PlanGuardStep[]): Promise<boolean>;
}

export interface PlanCurrency {
	// …existing members unchanged (begin, advance, end, resolve, require,
	// isCurrent, snapshot)…

	/**
	 * Plan guarded effect seam: declare the run's compound liveness predicate
	 * once (e.g. the lifecycle's isPlanMode); the runner owns every
	 * awaited-boundary staleness check. `whileValid` is evaluated live after
	 * the currency check at each boundary.
	 */
	guard(session: PlanSession, whileValid?: () => boolean): PlanGuard;
}
```

### 2.2 · Implementation (inside `createPlanCurrency`)

```ts
function guard(session: PlanSession, whileValid?: () => boolean): PlanGuard {
	const live = () => isCurrent(session) && (whileValid === undefined || whileValid());
	return {
		session,
		isCurrent: live,
		async run(...steps: PlanGuardStep[]): Promise<boolean> {
			for (const step of steps) {
				if (!live()) return false;
				await step();
			}
			return live();
		},
	};
}
```

(~10 lines. The `whileValid` predicate is **never latched** — re-evaluated live
at every boundary, matching today's re-check semantics.)

### 2.3 · Adoption rules (the contract)

| # | Rule |
|---|------|
| R1 | A boundary exists **before every step (entry included)** and **after the final step** (trailing). Sync steps are still boundaries. |
| R2 | Staleness never throws. `run` resolves `false`; remaining steps are skipped silently; effects already committed stay committed. |
| R3 | Step errors propagate untouched. Catch blocks are caller-owned and read `guard.isCurrent()` (or raw `currency.isCurrent(session)`) to distinguish staleness from real failures. |
| R4 | **One awaited effect per step.** A synchronous commit that must not land after another step's await belongs to the next step (or sits behind `guard.isCurrent()`). |
| R5 | **Head-outside rule:** effects that must run even when stale at entry (sandbox `dispose` cleanup) or are pinned to run stale-at-entry (the transition's apply) stay outside the run as an unguarded head. |
| R6 | Dispatch-level admissions (`currency.resolve(ctx)`), entry preconditions (`currency.require(ctx)`), and positive-gated writes (`if (isCurrent) updatePlanStatus`) are **not** boundaries — they stay raw. |
| R7 | `whileValid` (compound predicate) is declared once per run, evaluated after the currency check, live — never latched. |
| R8 | Guards are function-local; never stored beyond the flow that created them (the `whileValid` closure reads live lifecycle state). |

## 3 · Migration map (boundary-for-boundary)

Line numbers are today's. "→" maps each existing guard to its new owner.

### 3.1 · `refreshPlanRuntime` + `refreshRequested` (L375–381, L816–832)

```ts
async function refreshPlanRuntime(ctx: ExtensionContext, session: PlanSession): Promise<boolean> {
	return enqueueLifecycle(async () => {
		const guard = currency.guard(session);
		return guard.run(() => {
			runtimeContext = ctx;
			return planRuntime.refresh(ctx.cwd);
		});
	});
}

async function refreshRequested(ctx: ExtensionContext, session: PlanSession): Promise<void> {
	if (!isPlanMode(planState)) { /* unchanged warning */ return; }
	try {
		if (await refreshPlanRuntime(ctx, session)) {
			ctx.ui.notify("Plan Bash disposable workspace refreshed from the host.", "info");
		}
	} catch (error) {
		if (!currency.isCurrent(session)) return;
		ctx.ui.notify(`Could not refresh Plan Bash; isolated command execution is unavailable: ${fmt(error)}`, "error");
	}
}
```

| Today | New |
|-------|-----|
| L377 entry guard | `run` entry check |
| L823 post-await check | `run` trailing check → boolean gates the success notify |
| L826 catch check | stays raw (R3) |

Pinned by: "suppresses a stale refresh success notification", "suppresses a
stale refresh failure notification".

### 3.2 · `reconstructState` (L383–442)

```ts
const reconstructState = async (ctx: ExtensionContext, session: PlanSession) => {
	const toolsAtStart = pi.getActiveTools();
	const previousState = planState;
	const previousNormalTools = previousState.normalTools;
	runtimeContext = ctx;
	const guard = currency.guard(session);
	try {
		await planRuntime.dispose();            // head-outside (R5): cleanup always runs
	} catch (error) {
		if (guard.isCurrent()) ctx.ui.notify(`Could not clean up the previous Plan Bash sandbox: ${fmt(error)}`, "warning");
	}
	if (!guard.isCurrent()) return;             // was L398

	const reconstructed = reconstructPlanState({ /* unchanged sync block */ });
	/* …unchanged sync assignments… */
	reviewController.clearDeferredPlan();

	if (isPlanMode(planState)) {
		planState.normalTools ??= …;
		pi.setActiveTools(planToolSet(planState.normalTools));
		activePlanProfile = profileFromCurrentSession(pi, ctx);
		const fallback = planState.normalProfile ?? activePlanProfile;
		if (fallback) {
			let captured: ModeModelProfile | undefined;
			const held = await guard.run(async () => { captured = await normalDefaultsStore.capture(ctx.cwd, fallback); });
			if (!held) return;                  // was L425
			normalGlobalDefaults = captured;
			— catch variant: was L428 → catch { if (!guard.isCurrent()) return; notify }
		}
		const warmed = await guard.run(() => warmPlanRuntime(ctx));   // entry check = L435
		void warmed;
	} else {
		ctx.ui.setStatus("plan-runtime", undefined);
		pi.setActiveTools(previousNormalTools ?? toolsAtStart.filter((name) => name !== "plan_bash"));
	}
	if (guard.isCurrent() && !modeTransition) updatePlanStatus(ctx, planState);   // was L441
};
```

Notes: the dispose **head stays outside** any run (R5 — a stale-at-entry run
must not skip sandbox cleanup); the sync reconstruct block needs no boundary
(no invalidation window between sync statements); L425's value flows through a
closure local (R4); L391/L428 catch-gates become `guard.isCurrent()` reads
(same predicate, new owner).

### 3.3 · `enterPlanModeInternal` (L496–561)

```ts
async function enterPlanModeInternal(ctx, session, prompt?): Promise<boolean> {
	if (isPlanMode(planState)) return true;
	const normalProfile = profileFromCurrentSession(pi, ctx);
	if (!normalProfile) { /* unchanged notify */ return false; }

	const normalTools = pi.getActiveTools().filter((name) => name !== "plan_bash");
	const abortEnter = (error: unknown, rollbackError?: unknown): false => { /* unchanged */ };

	const guard = currency.guard(session);
	let capturedDefaults: ModeModelProfile | undefined;
	let stored: Awaited<ReturnType<ModelSelectionPersistence["load"]>>;  // "plan" slot
	try {
		const prepared = await guard.run(
			async () => { capturedDefaults = await normalDefaultsStore.capture(ctx.cwd, normalProfile); },
			async () => { stored = await session.persistence.load("plan"); },
		);
		if (!prepared) return false;            // boundaries = old L526, L528

		// Shared adopt block (today duplicated at L531–535 and L546–555):
		const adoptEntry = (profile: ModeModelProfile): PlanGuardStep => () => {
			normalGlobalDefaults = capturedDefaults;
			planState = { ...planState, normalProfile, normalTools };
			activePlanProfile = profile;
			clearPlanForEntry();
			commitPlanState(ctx, "plan", prompt, normalTools);
			warmPlanRuntime(ctx);
		};

		if (!stored) {
			return await guard.run(
				async () => { await session.persistence.save("plan", normalProfile); },
				adoptEntry(normalProfile),
			);                                      // mid-check = old L531; entry check new-but-safe
		}

		const outcome = await profileTransition.apply(ctx, session, {
			target: stored,
			label: "Plan Mode profile",
			persist: { session, unlessSentinel: stored },
			defaults: capturedDefaults,
			rollback: { target: normalProfile, label: "Normal profile", defaults: capturedDefaults },
		});
		if (!guard.isCurrent()) return false;   // was L548
		if (!outcome.ok) return abortEnter(outcome.error, outcome.rollbackError);
		return await guard.run(adoptEntry(outcome.profile!));
	} catch (error) {
		if (!guard.isCurrent()) return false;   // was L558
		return abortEnter(error);
	}
}
```

Notes: the run's entry check before `capture` is new behavior only when the
flow is stale *before* its first effect — verified unpinned (the
"drops an entry invalidated by a branch change" test pins outcomes, not
effect execution; staleness in that test arises while `load` is pending).
The duplicated adopt blocks (review finding 7) collapse into `adoptEntry` —
same behavior, one block.

Pinned by: "drops an entry invalidated by a branch change…", "returns the
original system prompt when branch reconstruction invalidates the awaited
transition".

### 3.4 · `exitPlanModeInternal` (L563–605)

```ts
async function exitPlanModeInternal(ctx, session): Promise<boolean> {
	if (!isPlanMode(planState)) return true;
	const normalTools = planState.normalTools;
	runtimeContext = ctx;
	const guard = currency.guard(session);
	try {
		await planRuntime.dispose();            // head-outside (R5)
	} catch (error) {
		if (!guard.isCurrent()) return false;   // was L591
		ctx.ui.notify(`Could not exit Plan Mode because the Plan Bash sandbox could not be cleaned up: ${fmt(error)}`, "error");
		return false;
	}
	if (!guard.isCurrent()) return false;       // was L589

	const normalProfile = planState.normalProfile;
	if (normalProfile) {
		const outcome = await profileTransition.apply(ctx, session, { /* unchanged */ });
		if (!guard.isCurrent()) return false;   // new position = old L602 semantics
		if (!outcome.ok) { /* unchanged rollback-note notify + warmPlanRuntime + return false */ }
	}
	commitPlanState(ctx, "default", undefined, normalTools);
	return true;
}
```

(The old L602 check sat between the `!outcome.ok` branch and the commit; keep
that order — staleness check **before** the ok-check.)

### 3.5 · `rememberActivePlanProfile` (L684–716) — the compound-predicate exemplar

```ts
async function rememberActivePlanProfile(
	ctx: ExtensionContext,
	session: PlanSession,
	profile: ModeModelProfile,
	defaults: ModeModelProfile | undefined,
): Promise<void> {
	const guard = currency.guard(session, () => isPlanMode(planState));  // declared once (R7)
	let persistenceError: unknown;
	await guard.run(
		() => { activePlanProfile = profile; },
		async () => {
			try { await session.persistence.save("plan", profile); }
			catch (error) { persistenceError = error; }          // error-as-data, reported in step 4
		},
		async () => {
			try { await preserveDefaults(ctx, defaults); }
			catch (error) {
				if (!guard.isCurrent()) return;                  // was L702
				ctx.ui.notify(`Could not preserve Pi's normal defaults: ${fmt(error)}`, "error");
			}
		},
		() => {
			if (persistenceError) {
				ctx.ui.notify(`Could not save the Plan Mode profile: ${fmt(persistenceError)}`, "error");
			}
			updatePlanStatus(ctx, planState);
		},
	);
}
```

| Today | New |
|-------|-----|
| L690 compound guard | run entry check |
| L698 compound guard | boundary between save and preserve steps |
| L702 compound guard (inside preserve catch) | `guard.isCurrent()` |
| L708 compound guard | boundary between preserve and notify/status steps |

The four duplicated `!isCurrent || !isPlanMode` expressions collapse into one
`whileValid` declaration. Pinned by: "silences a stale profile persistence
failure after a branch change", "silences a stale normal-defaults failure
after a branch change".

### 3.6 · Sites that stay raw (R1/R6 — deliberately unchanged)

| Site | Why it stays |
|------|--------------|
| L333 `isCurrent: (session) => currency.isCurrent(session)` | replaced by `createGuard` adapter (§3.7) |
| L640 `runModeTransition` finally | positive-gated status write at caller-owned boundary |
| L725 review snapshot | Plan Review's captured-snapshot contract |
| L728 `getSessionProfileBinding` | `resolve`-based lookup, not a boundary |
| L910 `agentPromptConstruction` | dispatch admission (class b) |
| L966–995 dispatch admissions | event routing (class b) |
| sessionStarted/sessionStopping `begin`/`end` | identity transitions, not guards |

After migration, `plan-lifecycle.ts` retains ~8 raw currency reads (all
class b/c or positive-gated), down from 26 `currency.` guard/adapter sites.

### 3.7 · `plan-profile-transition.ts` — host swap + guarded steps

Host interface change (type-only import from `plan-currency.ts`; dependency
direction unchanged — the transition still never imports the currency
implementation):

```ts
export interface PlanProfileTransitionHost {
	/** One Plan guarded effect per transition; staleness is checked at every
	 *  boundary the transition declares. Replaces isCurrent(session). */
	createGuard(session: PlanSession): PlanGuard;
	/** The lifecycle's normal-defaults preservation; undefined defaults fall
	 *  back to the lifecycle's captured normal defaults. */
	preserveDefaults(ctx: ExtensionContext, defaults?: ModeModelProfile): Promise<void>;
}
```

Lifecycle construction site (one line changes):

```ts
const profileTransition = createPlanProfileTransition(pi, {
	createGuard: (session) => currency.guard(session),
	preserveDefaults,
}, { nativeDefaults: dependencies.nativeDefaults });
```

`apply` — the target apply is an **unguarded head** (its test pins that the
apply runs and reports `{ ok: true, profile }` even when stale at entry):

```ts
async function apply(ctx, session, request): Promise<PlanProfileTransitionResult> {
	transitionDepth++;
	try {
		const guard = host.createGuard(session);
		let profile: ModeModelProfile | undefined;
		let applied = false;
		try {
			profile = await applyProfile(ctx, request.target, request.label);   // unguarded head (R5)
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
						try { rollbackProfile = await applyProfile(ctx, request.rollback!.target, request.rollback!.label); }
						catch (error) { rollbackError = error; throw error; }   // rethrow: skips step 2 (today's semantics)
					},
					async () => {
						try { await host.preserveDefaults(ctx, request.rollback!.defaults); }
						catch (error) { rollbackError = error; }                // error-as-data (today's semantics)
					},
				);
			} catch {
				// step-1 failure already captured as rollbackError; step 2 was skipped by the runner
			}
			return { ok: false, error, profile: rollbackProfile, rollbackError };
		}
	} finally {
		transitionDepth--;
	}
}
```

Boundary mapping (old `host.isCurrent` positions → new):

| Old position | New owner |
|--------------|-----------|
| apply L119 (post-apply) | persist-run entry check |
| apply L124 (post-persist) | boundary between persist and preserve steps |
| apply L126 (post-preserve) | persist-run trailing check |
| restore L96 (leading) | rollback-run entry check |
| restore L99 (post-apply-rollback) | boundary between rollback steps |

The rollback-run entry check doubles as today's restore-leading check — when
stale there, the run returns at entry (steps skipped), producing exactly
today's `{ ok: false, error, profile: undefined, rollbackError: undefined }`.
`inTransition()` / `transitionDepth` are untouched.

## 4 · Test plan

Per DEEPENING.md: replace, don't layer — but the existing suites are
behavioral and survive. The interface is the test surface.

### 4.1 · `plan-currency.test.ts` — survives untouched; gains a guard block

New cases (all through `currency.guard`):

1. `run` executes steps in order and resolves `true` when current throughout.
2. Entry staleness: predicate false before the first step → no step runs, resolves `false`.
3. Mid-run abandonment: predicate flips after step 2 → steps 3+ never run, resolves `false`.
4. Trailing staleness: predicate flips during the last step → all steps ran, resolves `false`.
5. Compound `whileValid`: currency current but `whileValid` false → abandoned; `whileValid` flip mid-run abandons; flip back does **not** resurrect (subsequent boundaries re-evaluate live — a run that already returned `false` is done, but a fresh run proceeds).
6. Evaluation order: currency short-circuits before `whileValid` (spy call counts).
7. Throwing step propagates; later steps never run; `guard.isCurrent()` still live afterwards.
8. Sync (`void`) steps work and are boundaries.
9. `guard.isCurrent()` reflects the live predicate (`true` → `advance` → `false`).
10. A guard bound to a stale session (advance after begin) abandons at entry.
11. A run never mutates currency state (isCurrent unchanged after a `false` run).

### 4.2 · `plan-profile-transition.test.ts` — outcome assertions survive; staleness scripting migrates

The host fake changes shape (`isCurrent` → `createGuard`). The fake wraps a
**real** `createPlanCurrency` and scripts staleness by advancing it:

```ts
function createHost() {
	const preserveDefaults = vi.fn(async () => {});
	const currency = createPlanCurrency({ createPersistence: () => persistence });
	const session = currency.begin(binding, ctxFor("session-a"));  // real PlanSession
	const goStale = () => { currency.advance(session); };
	return { preserveDefaults, session, goStale, createGuard: (s: PlanSession) => currency.guard(s) };
}
```

Per-test scripting map (assertions unchanged; only the staleness trigger moves):

| Test | Old scripting | New scripting |
|------|---------------|---------------|
| "abandons silently when the session goes stale after the apply" | `isCurrent.mockReturnValue(false)` | `applyModelSelection` mock: `async () => { host.goStale(); return appliedProfile; }` |
| "abandons the remaining effects when the session goes stale after persisting" | `mockReturnValueOnce(true).mockReturnValue(false)` | `persistence.save` mock: `async () => { host.goStale(); }` |
| "abandons with a plain result when the session goes stale after preserving defaults" | always true (assert-only) | `host.preserveDefaults` mock: `async () => { host.goStale(); }` |
| "skips the rollback when the session went stale before it could start" | `mockReturnValueOnce(true).mockReturnValueOnce(false)` | `persistence.save` mock: `async () => { host.goStale(); throw failure; }` |
| "rolls back to the fallback when a later step fails" | none (always true) | unchanged |
| all others | none / assert-only | unchanged |

Verified by hand against the boundary map in §3.7: every outcome assertion
(`toEqual` payloads, save/preserve call counts, rollback error reporting,
`inTransition` behavior) holds with identical values.

### 4.3 · `plan-lifecycle.test.ts` (890 lines) — survives

Drives events through public `dispatch` (zero coupling to `currency`
internals) and pins behavioral outcomes: commits, notifications, tool state,
status writes, later-toggle recovery. The §3 migration is
boundary-for-boundary, so notify text, rollback notes, and return values are
identical. One strictly-safer behavior addition (stale-at-entry flows skip
their first effect) is not pinned anywhere — verified against the staleness
suite (L644–884) and the queueing/toggle suites.

### 4.4 · New behavior coverage to add (lifecycle suite, optional but recommended)

- A stale-at-entry `modeToggled` entry performs no persistence `load`/`save`
  and no notify (pins the entry-check semantics deliberately).

## 5 · Implementation order (each step keeps the suite green)

1. **Add the seam.** `plan-currency.ts`: `PlanGuardStep`, `PlanGuard`,
   `guard()` (+ interface member). `plan-currency.test.ts`: the 11 guard
   cases. Verify: `cd .pi && pnpm test:plan && pnpm typecheck`.
2. **Migrate `rememberActivePlanProfile`** (compound exemplar). Verify:
   `pnpm test:plan` — the two "silences a stale …" tests must pass unchanged.
3. **Migrate `refreshPlanRuntime` + `refreshRequested`** (boolean return).
   Verify: refresh staleness tests unchanged.
4. **Migrate `enterPlanModeInternal`** (+ `adoptEntry` dedupe). Verify:
   entry-drop and prompt-invalidation tests unchanged.
5. **Migrate `exitPlanModeInternal`** and **`reconstructState`** (head-outside
   dispose). Verify: full `pnpm test:plan` including the sandbox integration
   test.
6. **Swap the transition host** (`createGuard`) and migrate `apply`/rollback to
   guarded steps; re-script the four staleness tests per §4.2. Verify:
   `pnpm test:plan`.
7. **Delete dead raw guards.** Remove the old adapter lambda (L333) and every
   collapsed site; grep-verify no `if (!currency.isCurrent(` remains in the six
   migrated flows (raw reads allowed only per §3.6).
8. **Docs.** CONTEXT.md already updated (Plan guarded effect entry, Plan
   session currency + Plan profile transition wording) — verify it matches the
   landed shape; adjust the Plan Mode lifecycle entry's seam list only if
   naming shifted.
9. **Full verification.** `cd .pi && pnpm typecheck && pnpm test:plan`;
   then `pnpm test` (full matrix) before merge — the seam is internal to
   `workflows-plan`, but the full suite guards accidental cross-extension
   drift.

## 6 · Risks & mitigations

| Risk | Mitigation |
|------|-----------|
| Step-fusion mistake moves an effect past its boundary (R4 violation) | One-await-per-step discipline; per-flow boundary maps above; behavioral suites pin outcomes |
| Entry-check behavior change (first effect skipped when stale at entry) | Verified unpinned; strictly safer; §4.4 pins it deliberately |
| Transition test mock-call drift | §4.2 scripting map; assertions verbatim |
| Guard outliving its flow (`whileValid` reads live `planState`) | R8: guards are function-local; all migrations create them at flow top |
| Name shadowing (`isCurrent` module fn vs guard method) | Internal alias `live` in `createPlanCurrency` |
| New flows regressing to hand-written checks | The runner is the path of least resistance; §3.6 documents the legitimate raw sites; review checklist item: "new async step → new guarded step, not a new `if (!isCurrent)`" |
| Rollback reporting delta: when the rollback apply succeeds but the rollback's `preserveDefaults` then fails, today's `restoreFallback` drops `profile` from the result (single try/catch swallows it); the guarded rollback's two-step form reports `profile: rollbackProfile` alongside `rollbackError` instead | Unpinned by any current test (no test rejects `preserveDefaults` only on the rollback leg). Inert today: both callers (`enterPlanModeInternal` via `abortEnter`, `exitPlanModeInternal`) read `outcome.profile` only on the `ok: true` path, never on `ok: false` — verified via `plan-lifecycle.ts:549,552,590–595`. Flag if a future caller starts reading `profile` on failure |

## 7 · Out of scope (recorded, not forgotten)

- **Turn-identity staleness** (`requestPlanSession` / `requestModeRevision` /
  `lastPromptedMode`, L288–292, 918–941) — a different staleness discipline
  (per-turn, not per-Session); folding it into the currency seam is a separate
  decision.
- **Queues + busy-admission** (architecture-review candidate 2: the two
  hand-rolled promise queues, three admission sites, transition-marker
  cleanup) — its own candidate.
- **Mode-announcement dedupe** and the `preserveDefaults` three-file bounce —
  separate micro-candidates surfaced by the same review.

## 8 · Vocabulary

All terms per the codebase-design skill and CONTEXT.md: **module**
(Plan session currency), **interface** (`PlanCurrency.guard` / `PlanGuard`),
**implementation** (the ~10-line runner), **seam** (the guarded-effect seam,
internal to the Plan Mode lifecycle's implementation), **adapter** (the
transition's host `createGuard`), **depth** (boundary discipline hidden behind
two methods), **leverage** (one seam, two consumers, N flows), **locality**
(staleness policy in one module).