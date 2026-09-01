# Plan: Harden Plan Mode lifecycle staleness coverage

**Status:** Evaluated and narrowed; implementation has not started.

## Outcome

Keep the current Plan Mode lifecycle design and strengthen its tests around
stale asynchronous work. Do not add a `PlanLifecycleHost`, a per-task
`PlanEffects` bundle, or a second test seam unless a concrete defect first
shows that one is needed.

This is deliberately a small hardening pass. The current code already has the
right currency token (`PlanSession` plus `lifecycleGeneration`), explicit
checks at the control-flow points where stale work must stop, and queues for
the operations that must finish in order.

## Why the original proposal was too large

1. **The proposed currency object duplicates existing state.**
   `isCurrentPlanSession(session)` already compares the captured Session object
   and its generation with the live lifecycle state. A new per-task snapshot
   would contain the same information.
2. **Guarded writes cannot replace most post-await checks.**
   Entry, exit, rollback, reconstruction, refresh, and profile persistence need
   to stop the rest of their control flow when an await becomes stale. Making
   `notify`, `setStatus`, or Plan State writes silently no-op would still leave
   explicit checks necessary, while making the mutation sites harder to read.
3. **Some awaited operations mutate outside the lifecycle.**
   `applyModelSelection`, runtime disposal/refresh, persistence, and normal
   defaults work cannot be made atomic merely by wrapping the lifecycle's next
   write. Truly cancelling or compensating those operations would be a much
   larger behavioral redesign.
4. **A single host adapter is a poor fit for callback-scoped context.**
   Pi supplies `ExtensionContext` with each event and command. A host created
   once in `index.ts` cannot represent that context without passing it through,
   rebuilding an adapter per callback, or storing mutable ambient context. None
   of those options makes this module materially safer today.
5. **The current harness is intentionally an integration seam.**
   It verifies extension registration, event adaptation, commands, shortcuts,
   tools, model echo events, and lifecycle behavior together. Replacing it with
   a lifecycle-only fake would remove coverage; retaining both would increase
   maintenance. “Under half the lines” is not a useful design constraint.
6. **Session replacement is already serialized with lifecycle transitions.**
   `sessionStarted` waits for profile work and enters `lifecycleQueue`, so it
   does not replace a Session in the middle of an older queued entry or exit.
   Branch reconstruction is the important invalidation path because it advances
   the generation before its reconstruction task reaches the queue.

## Scope

- Audit each await in `plan-lifecycle.ts` that is followed by lifecycle-owned
  state, tool, status, notification, transcript, or persistence effects.
- Keep `isCurrentPlanSession` and direct generation comparisons explicit at
  points where stale work must return or choose a different result.
- Add focused tests for meaningful invalidation boundaries not already pinned
  by the suite.
- Change production code only if the audit or a failing test exposes a missing
  check or incorrect stale outcome.
- Make small test-harness extractions only when they reduce duplication in the
  new tests; do not replace the extension-level harness.

## Out of scope

- A `PlanLifecycleHost` abstraction or changes to lifecycle event payloads.
- A `PlanEffects`/guarded-primitives layer.
- Combining `lifecycleQueue` and `profileEventQueue`.
- Changing the silent stale-work policy.
- Redesigning `applyModelSelection`, Plan Review, or Plan Runtime cancellation.
- Production refactoring justified only by reducing the number of grep hits.
- A line-count target for `test-harness.ts`.
- New glossary terms for abstractions that are not being implemented.

## Implementation sequence

1. Run `cd .pi && pnpm test:plan` to establish the baseline.
2. Build a short audit table for the awaits in `plan-lifecycle.ts` with:
   operation, possible invalidator, next effect, and existing guard. Treat
   Session start/stop queue ordering separately from branch-generation
   invalidation so tests model races that can actually occur.
3. Add or strengthen integration tests using deferred promises for these
   cases, where not already covered:
   - a branch change while Plan Mode entry or exit is awaiting profile/runtime
     work does not commit the old transition or emit its late notification;
   - a branch change while refresh is awaiting runtime work suppresses the old
     success or error notification;
   - queued profile persistence that becomes stale does not update status or
     report a late persistence/defaults error for the old branch;
   - `before_agent_start` waiting on a transition returns the original system
     prompt if branch reconstruction invalidates that transition.
4. Preserve and rely on existing coverage for:
   - draining an old Profile save before constructing the next Session store;
   - finishing an old Plan exit before reconstructing a newly started Session;
   - dropping a queued switch on branch change;
   - serialization of reconstruction with exit;
   - ignoring a late shutdown from an older Session;
   - Plan Review's revision and generation checks.
5. If a test fails because a guard is missing, add the smallest guard at the
   control-flow boundary and pin the intended silent outcome. Do not introduce
   a general effects framework for a local defect.
6. Run `cd .pi && pnpm test:plan && pnpm typecheck`. Run the full `.pi` test
   suite only if production code or a shared interface changes.

## Behavior invariants

- Stale work returns silently: no new notification, error, or log.
- A stale transition cannot commit Plan State, project tools, status, or
  transcript entries for the newer branch.
- `agentPromptConstruction` returns the unchanged input system prompt when its
  awaited transition becomes stale.
- `profileEventQueue` drains before Session start/stop as it does today.
- `lifecycleQueue` ordering and `profileTransitionDepth` echo suppression stay
  unchanged.
- Plan Review and Plan Runtime retain their own independent generation checks.

## Completion criteria

- The await audit finds no unguarded stale mutation, or every discovered gap
  has a focused regression test and a local fix.
- New tests exercise real branch/session ordering rather than impossible
  interleavings.
- `pnpm test:plan` and `pnpm typecheck` pass.
- The production diff is empty unless a test demonstrates a correctness gap.
