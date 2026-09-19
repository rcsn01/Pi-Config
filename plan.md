# Implementation plan: deepen Goal continuation orchestration

## Outcome

Extract the live Goal continuation lifecycle from
`.pi/extensions/workflows-goal/index.ts` into a deep in-process module at
`.pi/extensions/workflows-goal/goal-lifecycle.ts`.

The new module will own the live Goal aggregate and the ordering between Goal
state, automatic-run accounting, compaction deferral, persistence requests,
continuation scheduling, and terminal transitions. The Pi extension entry point
will remain an adapter: it will register Pi callbacks, translate them into
semantic lifecycle events, provide a narrow host for Pi effects, and keep TUI
schemas/rendering at the Pi seam.

This is an orchestration deepening, not a rewrite of Goal persistence or Goal
policy. The existing `goal-state.ts`, `goal-runtime.ts`, `goal-commands.ts`,
and `goal-prompts.ts` modules remain the policy modules behind the new seam.

## Resolved design decisions

The design tree was resolved with the recommended answer for every clarification
question, as requested.

### 1. Scope

**Chosen:** extract Goal continuation and live-state orchestration only.

Keep these responsibilities where they are:

- `goal-state.ts`: validated persisted Goal state, reconstruction, immutable
  transitions, legacy identity migration, tombstones, and evidence state.
- `goal-runtime.ts`: runtime reconstruction, automatic-run observation,
  progress/failure classification, continuation charging, and bounded
  continue/skip/stop decisions.
- `goal-commands.ts`: `/goal` parsing, confirmation text, notification policy,
  transitions, kickoff text, and command status formatting.
- `goal-prompts.ts`: status-to-prompt policy.
- `index.ts`: Pi registration, TypeBox schemas, Pi tool result wrappers,
  `GoalStatusWidget`, and host methods that perform Pi effects.

The new module will coordinate these existing modules. It will not absorb the
whole Goal extension into one undifferentiated implementation.

### 2. Module shape and seam

**Chosen:** follow the existing `workflows-plan/plan-lifecycle.ts` pattern:
semantic events enter one `GoalLifecycle.dispatch()` interface, and the module
serializes them through one lifecycle queue.

This gives the Goal module a small external seam while hiding:

- the mutable Goal and runtime aggregate;
- hidden continuation identity;
- automatic-run accumulation;
- compaction deferral;
- terminal-stop policy;
- persistence and effect ordering;
- Session reset and shutdown invalidation.

The new module has two adapters at its seam:

1. the production Pi host created by `index.ts`;
2. a deterministic in-memory host used by `goal-lifecycle.test.ts`.

Tests use the lifecycle interface with the in-memory host instead of reaching
into private state.

### 3. Effect ownership

**Chosen:** the lifecycle owns *when* effects happen and in what order; the Pi
adapter owns *how* those effects reach Pi.

The lifecycle will not import `ExtensionContext` or call `ctx.ui`, `pi`, or
`appendEntry` directly. It will call a narrow `GoalLifecycleHost` supplied by
the adapter. The host will perform:

- Goal-state entry writes;
- runtime entry writes;
- notifications;
- widget refreshes;
- hidden continuation sends;
- `/goal` kickoff sends;
- idle and pending-message reads;
- confirmation prompts.

The host object is Session/branch-scoped for active lifecycle events. The
adapter will create one host for each Session/branch lifecycle and reuse that
object for every event from that lifecycle. The lifecycle will ignore an active
Session event whose host/generation is not current. This keeps old queued
callbacks from mutating a newer Session without exposing an `ExtensionContext`
or a separate currency module.

The command and tool adapters also have a narrow pre-Session path. They pass a
distinct ephemeral host while no Session is active, but that host is never
installed as `activeHost` and the lifecycle generation invalidates it when a
Session starts or stops. All other event types require the active Session/branch
host.

A failed host continuation send throws synchronously. The lifecycle must
preserve the current failure behavior: clear the pending continuation marker and
notify the user; a later settled event retries.

### 4. State ownership

**Chosen:** `goal-lifecycle.ts` becomes the sole owner of the live `goal`,
`runtime`, pending-continuation marker, automatic-run accumulator, compaction
flags, deferred Goal id, and active-host currency.

`index.ts` will hold none of the Goal or runtime lifecycle variables. It retains
only a routing reference to the current host and adapter-owned UI/rendering
state such as the `GoalStatusWidget` handle. The adapter does not inspect or
mutate the lifecycle's aggregate. This prevents the command tool, event
handlers, and continuation path from adopting different copies of the current
Goal.

On shutdown the lifecycle will clear its live aggregate and transient markers,
not merely clear the pending run. A subsequent Session reconstructs from its
own branch through `sessionStarted` or `branchChanged`.

### 5. Serialization and Session currency

**Chosen:** lifecycle effects are serialized, but Session/branch invalidation is
synchronous and happens before a reset task enters the queue.

Use an immediate-first, rejection-tolerant queue:

- when idle, begin the event task immediately so synchronous effects such as a
  compaction-state update happen before the surrounding Pi callback returns;
- when another lifecycle task is in flight, append the task after either
  fulfillment or rejection of the previous task. A bus callback queued behind
  an in-flight confirmation or event does not claim to finish synchronously;
  test that the queued compaction event still runs before later queued Goal
  work and that the queue recovers after rejection;
- return the current task's result to its caller;
- never leave the queue permanently rejected;
- preserve thrown errors for the caller-owned error handling.

Keep a private monotonic lifecycle generation alongside the active
Session-scoped host. `sessionStarted`, `branchChanged`, and `sessionStopping`
invalidate the previous generation synchronously. Every queued task captures
its host/generation and rechecks both before applying an effect. An awaited
command confirmation must recheck after the confirmation resolves before it
commits a transition. The lifecycle admits a pre-Session command or tool only
in the inactive generation in which it arrived; a Session start invalidates it
before reconstruction begins. This prevents an old command from committing into
a new Session while still allowing the existing pre-Session command behavior.

This combines Plan Mode's serialized ordering with its currency principle
without adding a second shared currency module for Goal. It preserves
synchronous `session-compaction:state` effects when the lifecycle queue is idle
and defines the queued behavior when another lifecycle task is active. The
supported ordering is Pi's serialized Session lifecycle. The plan does not claim
to make arbitrarily out-of-order Session-start callbacks safe.

### 6. Persistence compatibility

**Chosen:** retain the current persisted custom entry types and data shapes:

- `goal-state` entries continue to carry `{ action, state }`;
- `goal-runtime` entries continue to carry the runtime snapshot fields;
- legacy Goal ids, cleared tombstones, and latest-valid-entry reconstruction
  remain unchanged;
- no migration or replay format is introduced.

The lifecycle only centralizes when the existing writes occur.

### 7. Compaction ownership

**Chosen:** retain the existing `session-compaction:state` event contract and
its source semantics.

`session-compaction/index.ts` will not be redesigned. Keep the
`CompactionStateEvent` type and its raw-value validator in the lifecycle module;
the adapter calls that validator but must not duplicate its rules. The bus
adapter captures the current host when it receives a valid event; lifecycle
`dispatch` captures and checks its private generation before running the event.
If no active host exists, the adapter drops the bus event rather than creating a
Session host for it.

Validate every optional field at this boundary: an omitted `succeeded` or
`error` is allowed, but an own supplied `succeeded` must be a boolean and an own
supplied `error` must be a string. Preserve the current fallback
for a finish event that omits `succeeded`: treat it as a failure, using the
trimmed string error when present and `Session compaction failed.` otherwise. Do not
require the completion `source` to equal the start source; the current code
uses the start source only to decide whether `agent_settled` defers, and uses
the completion's `succeeded`/`resumesRun` values to decide what happens next.

The lifecycle will preserve the current distinction:

- `turn_end` compaction defers an automatic Goal settlement when the active
  Goal and source guards pass;
- `before_agent_start` compaction never defers that settlement;
- a successful compaction that resumes the run does not schedule another Goal
  continuation;
- a successful non-resuming compaction enters the normal scheduling guards and
  sends one continuation when those guards pass;
- a matching compaction failure blocks the active Goal;
- Session/branch reset invalidates a deferred compaction decision.

The producer prevents overlapping operations within its extension instance, but
the payload has no operation id. If an old completion arrives after a reset and
a newer deferral has the same Goal id, the lifecycle cannot distinguish them and
must not claim that case is safe.

### 8. Time and test determinism

**Chosen:** inject `now` through `GoalLifecycleDependencies`, defaulting to
`Date.now` in production. All lifecycle-created Goal and runtime timestamps
will use that function. Existing pure modules already accept timestamps; this
keeps the new lifecycle tests deterministic without relying on wall-clock
assertions.

### 9. Documentation

**Chosen:** update `CONTEXT.md` after implementation. It will describe
`Goal continuation lifecycle` as the deep module and revise the current Goal
runtime wording so it no longer attributes lifecycle orchestration to the thin
Pi adapter.

No ADR is present in `docs/adr/`, so there is no recorded decision to reopen.

## Current evidence and friction

`workflows-goal/index.ts` is currently a Pi adapter in name, but it also owns a
large live aggregate and the cross-event rules around it:

- `goal`, `runtime`, `pendingAutomaticGoalId`, and `automaticRun`;
- `extensionCompactionInProgress`, `extensionCompactionSource`, and
  `deferredCompactionGoalId`;
- the adapter's `runtimeContext` and `GoalStatusWidget` UI handle;
- reconstruction on `session_start` and `session_tree`;
- hidden-run recognition at `message_start`;
- multi-turn recording at `turn_end`;
- finalization, terminal handling, and continuation scheduling at
  `agent_settled`;
- compaction completion handling through a separate event bus listener;
- transition persistence and terminal cleanup used by both the tool and the
  command.

The pure modules already provide good policy boundaries, but the critical
behavior is how those policies are sequenced with Pi effects. That behavior is
spread across nested functions and event callbacks in `index.ts`. The existing
adapter tests prove the behavior, but most of their harness complexity exists
because they must construct the whole Pi registration surface to reach the
lifecycle.

The current adapter has two `pi.appendEntry` sites, one `pi.sendMessage` site,
two `pi.sendUserMessage` sites, three `ctx.ui.notify` sites, three
`ctx.ui.setWidget` sites, two `ctx.isIdle` sites, one
`ctx.hasPendingMessages` site, and one `ctx.ui.confirm` site. The host methods
must account for each effect without leaving a second implementation in the
adapter.

Deletion test: there is one current closure, so this is not a claim that several
Goal owners already disagree. Deleting the proposed lifecycle module would put
the same aggregate, ordering, stale-marker, command, and tool coordination back
inside the Pi callbacks and would remove the deterministic host seam. The
extraction earns its depth only if those cross-event rules stay behind the one
lifecycle interface; it must not grow into a second policy implementation.

## Target implementation

### New file: `workflows-goal/goal-lifecycle.ts`

Add a deep in-process module with the following public vocabulary and field
names. The responsibilities and semantics below are fixed.

#### Host interface

Define a narrow host interface that contains only effects and current Pi facts
that the lifecycle cannot own itself:

```ts
export interface GoalLifecycleHost extends GoalCommandHost {
	appendGoalTransition(outcome: AppliedGoalTransition): void;
	appendRuntime(snapshot: GoalRuntimeSnapshot): void;
	updateWidget(goal: GoalState | null): void;
	notify(message: string, severity: "info" | "warning" | "error"): void;
	sendContinuation(goalId: string): void;
	sendKickoff(message: string, queued: boolean): void;
	isIdle(): boolean;
	hasPendingMessages(): boolean;
}
```

The host implementation in `index.ts` will translate these semantic calls to
Pi:

- `appendGoalTransition` writes `GOAL_CUSTOM_TYPE` with the existing
  `{ action, state }` data.
- `appendRuntime` writes `GOAL_RUNTIME_CUSTOM_TYPE` with the existing snapshot.
- `updateWidget` calls the existing widget updater with the current Session
  context and Goal snapshot; it is a no-op without UI, and `null` clears the
  widget.
- `sendContinuation` sends the existing hidden `goal-continuation` custom
  message as a `followUp` with `triggerTurn: true`.
- `sendKickoff(message, queued)` calls `pi.sendUserMessage`; `queued` selects
  the existing `deliverAs: "followUp"` option.
- `confirm` remains the `hasUI`-guarded `ctx.ui.confirm` adapter already used by
  `runGoalCommand`.

The lifecycle will own the hidden continuation message and its custom type
constant, so there is one source of truth for hidden-run identity and prompt
text. `goal-state.ts` and `goal-runtime.ts` retain ownership of the persisted
`goal-state` and `goal-runtime` custom type constants.

#### Dependencies

```ts
export interface GoalLifecycleDependencies {
	now?: () => number;
}
```

Use `dependencies.now ?? Date.now` once at construction. Do not inject the
pure Goal state/runtime/command modules; importing them directly keeps the
lifecycle implementation cohesive and leaves the test seam at the lifecycle
interface.

#### Semantic events

Define a discriminated event union, modeled after `PlanLifecycleEvent`:

```ts
export type GoalLifecycleEvent =
	| { type: "sessionStarted"; branch: readonly unknown[]; host: GoalLifecycleHost }
	| { type: "branchChanged"; branch: readonly unknown[]; host: GoalLifecycleHost }
	| { type: "sessionStopping"; host: GoalLifecycleHost }
	| { type: "agentPromptConstruction"; systemPrompt: string; host: GoalLifecycleHost }
	| { type: "messageStarted"; role?: string; customType?: string; goalId?: string; host: GoalLifecycleHost }
	| { type: "turnEnded"; observation: GoalTurnObservation; host: GoalLifecycleHost }
	| { type: "agentSettled"; host: GoalLifecycleHost }
	| { type: "compactionStateChanged"; event: CompactionStateEvent; host: GoalLifecycleHost }
	| { type: "commandRequested"; args: string; host: GoalLifecycleHost; preSession?: true }
	| { type: "toolRequested"; request: GoalToolRequest; host: GoalLifecycleHost; preSession?: true };
```

The adapter will translate Pi event objects to these small semantic values. Do
not pass a whole `ExtensionContext` through the new module. The lifecycle only
needs the branch at reconstruction, the fields used by `GoalTurnObservation`,
and the host's narrow effect/fact interface. An active host-bearing event with
a stale host/generation must return its neutral result without applying effects.
For a stale `toolRequested`, use the same structured result as a null Goal:
status has no error, and a mutation has `No active goal.` with `isError: true`.
A stale command completes silently, and prompt construction returns `undefined`.
Only `commandRequested` and `toolRequested` set `preSession: true`; the
lifecycle admits that form only while no Session is active and never installs
its host as `activeHost`. Compaction events are host-bearing too, so a queued
old bus event cannot change a newer Session's compaction flags.

Define the result mapping explicitly so the implementation does not invent a
second result protocol:

```ts
export type GoalLifecycleResult<E extends GoalLifecycleEvent> =
	E extends { type: "agentPromptConstruction" }
		? { systemPrompt?: string } | undefined
		: E extends { type: "toolRequested" }
			? GoalToolOutcome
			: void;
```

`agentPromptConstruction` returns `undefined` when no addendum applies. It must
not return the incoming system prompt merely to signal "unchanged", because Pi
marks a returned prompt as modified and passes it through the other
`before_agent_start` handlers.

`GoalToolRequest` should represent the already-schema-validated actions and
fields without importing TypeBox or Pi result types:

```ts
export interface GoalToolRequest {
	action: "status" | "checkpoint" | "complete" | "blocked";
	summary?: string;
	remaining?: string;
	reason?: string;
	evidence?: GoalEvidence[];
}
```

Keep the defensive `evidenceError` checks at this seam rather than assuming a
direct test or another caller has run TypeBox validation.

`GoalToolOutcome` should carry the action, current Goal snapshot, runtime
snapshot, optional error text, `isError` state, and completion evidence needed by
`index.ts` to preserve the existing Pi tool result shape:

```ts
export interface GoalToolOutcome {
	action: GoalToolRequest["action"];
	state: GoalState | null;
	runtime: GoalRuntimeSnapshot | null;
	error?: string;
	isError?: boolean;
	evidence?: GoalEvidence[];
}
```

The `state` snapshot is the reconstructed cleared tombstone when one exists;
it is `null` only when the lifecycle's current pointer is null. When that pointer
is null, return `runtime: null` as well, even if a prior clear left an old
in-memory runtime unused by the current adapter. The adapter will keep
constructing `content`, `details`, and `isError` around that outcome, including
the existing no-goal and validation-error shapes.

#### Public lifecycle interface

```ts
export interface GoalLifecycle {
	dispatch<E extends GoalLifecycleEvent>(event: E): Promise<GoalLifecycleResult<E>>;
}

export function createGoalLifecycle(
	dependencies?: GoalLifecycleDependencies,
): GoalLifecycle;
```

Keep private state inside the factory:

```ts
let goal: GoalState | null = null;
let runtime: GoalRuntimeSnapshot | null = null;
let pendingAutomaticGoalId: string | null = null;
let automaticRun: AutomaticGoalRun | null = null;
let extensionCompactionInProgress = false;
let extensionCompactionSource: CompactionStateEvent["source"] | null = null;
let deferredCompactionGoalId: string | null = null;
let activeHost: GoalLifecycleHost | undefined;
let activeSession = false;
let lifecycleGeneration = 0;
let lifecycleQueue = Promise.resolve();
```

`activeSession` is intentional rather than a duplicate of `activeHost`: it
separates the narrow pre-Session command/tool admission path from events that
belong to an active Session. `lifecycleGeneration` invalidates an awaited
pre-Session confirmation and any queued work during Session reset.

Keep these fields private to the factory. `index.ts` must not regain access to
them.

### Lifecycle behavior to preserve

#### Session start and branch change

For `sessionStarted` and `branchChanged`, perform this synchronous reset
prologue before queueing reconstruction:

1. increment the lifecycle generation;
2. clear the pending continuation marker, automatic run, and deferred
   compaction decision;
3. clear compaction-in-progress/source flags;
4. install the supplied Session-scoped host as the active host and mark the
   lifecycle active.

Then queue the reconstruction task:

5. reconstruct the latest valid Goal state from `branch`;
6. reconstruct a matching runtime snapshot when the Goal exists and is not
   `cleared`; otherwise set `runtime = null`;
7. update the widget once with the reconstructed live Goal, or pass `null` to
   the host for a missing or `cleared` Goal so the widget is removed.

Keep a reconstructed `cleared` tombstone in the lifecycle's Goal pointer. Do
not normalize it to `null`: `/goal` status and the Goal tool have different
existing behavior for a reconstructed tombstone. A reconstructed tombstone
returns the current cleared state for tool status and the existing
`Cannot ...: goal is cleared.` mutation errors, while a successful `clear`
transition leaves the pointer `null` until the next reconstruction.

Any queued event carrying the previous host/generation becomes a neutral no-op.
If a newer reset arrives before reconstruction runs, the older reconstruction
must also abandon itself.

`sessionStarted` and `branchChanged` must not append entries merely because a
runtime snapshot was initialized in memory. Preserve the current lazy runtime
persistence behavior.

A branch change must invalidate any old automatic run and any compaction finish
that was waiting on it. The stale-compaction behavior currently covered in
`index.test.ts` must remain green in the lifecycle suite; the adapter suite keeps
only the Pi bus-ordering assertion.

#### Session shutdown

For `sessionStopping`:

1. ignore the event if its host is not the active host;
2. invalidate the lifecycle generation synchronously;
3. clear all live Goal/runtime and transient state;
4. mark the lifecycle inactive and clear the active host;
5. ensure queued work cannot emit Goal effects after shutdown.

Do not add a new persistence entry or a widget effect solely for shutdown. Pi
teardown owns the Session UI lifecycle; later reconstruction clears or remounts
the widget through the normal Session path. The lifecycle itself must not retain
a Session host after shutdown.

The Pi adapter will unregister its compaction bus listener during shutdown, but
only if the host captured by that shutdown callback is still the adapter's
current host. An old shutdown callback must not clear a newer host or remove the
listener needed by a newer Session.

#### Prompt construction

For `agentPromptConstruction`, call the existing `goalPromptAddendum(goal)`
with the lifecycle-owned Goal. Return `undefined` when there is no addendum. When
one exists, return this object, retaining the existing two-newline format:

```ts
{ systemPrompt: `${event.systemPrompt}\n\n${addendum}` }
```

The adapter will return the lifecycle result to Pi without adding prompt policy
itself.

#### Hidden continuation recognition

For `messageStarted`, preserve this complete role/type/id matrix:

- a custom `goal-continuation` with a string Goal id that equals both the
  pending marker and the current Goal id creates `startAutomaticRun(goalId)` and
  clears `pendingAutomaticGoalId`;
- a user message clears `pendingAutomaticGoalId`;
- any custom message that is not that exact matching continuation also clears
  it, including a missing, non-string, or wrong Goal id;
- assistant, tool-result, and any other non-user/non-custom roles leave the
  pending marker unchanged.

A continuation must become an automatic run only when both the custom type and
Goal id match the pending marker. Do not add a Goal-status check to this
recognition step; the current code correlates by Goal id, and terminal
transitions already clear the marker.

#### Turn end

For `turnEnded`:

1. if an automatic run exists, pass the semantic observation to
   `recordGoalTurn`;
2. refresh the widget through the host;
3. never send a continuation from `turnEnded` itself.

The `GoalTurnObservation` shape remains the one already consumed by
`goal-runtime.ts`: assistant role/stop reason plus tool result name, error flag,
and details.

#### Agent settled

For `agentSettled`, preserve the current ordering exactly:

1. capture the automatic run's Goal id;
2. if the automatic run still matches `runtime.goalId`, finalize it with the
   injected clock;
3. adopt the returned snapshot and persist the finalized runtime snapshot;
4. clear `automaticRun` before deciding what happens next;
5. if turn-end compaction is in progress and the Goal is active, store the
   current Goal id as deferred and return without scheduling;
6. if the settled matching automatic run ended with `aborted`, pause the
   matching active Goal, persist the transition, refresh the widget, notify
   once, and return;
7. if it ended with `error` or `length`, block the matching active Goal with
   the existing reason, persist the transition and runtime, refresh the widget,
   notify once, and return;
8. otherwise evaluate continuation scheduling.

A finalized ordinary automatic run writes runtime once before scheduling; a
successful continuation then writes a second snapshot for the continuation
charge. An automatic `error` or `length` path likewise writes once at
finalization and once in `stopGoal`; an `aborted` path writes only the
finalization snapshot before its pause transition. A run whose Goal id does not
match the runtime is cleared without finalization or runtime persistence, but
the active current Goal still reaches the ordinary scheduling path. These
write counts and orders are observable Session-entry behavior and must be tested.

When there is no matching run to finalize, the active Goal still schedules one
continuation after an ordinary run settles when the existing scheduling guards
allow it. This is intentional and must remain.

#### Continuation scheduling

Keep the current guard order:

1. active Goal exists;
2. runtime exists and has the same Goal id;
3. extension-owned compaction is not in progress;
4. the host reports idle;
5. the host reports no pending user messages;
6. no continuation is already pending.

Then call `decideGoalContinuation`:

- `skip`: do nothing;
- `stop`: apply the returned `block` or `limit` transition through the common
  transition path;
- `continue`: increment and persist the continuation counter first, set the
  pending Goal id, then ask the host to send exactly one hidden continuation.

If the host send throws synchronously, clear the pending marker and notify
`Goal continuation failed: <message>` at error severity. Do not undo the
already-persisted continuation charge; preserve the current retry behavior on a
later settlement.

#### Compaction state

Keep `CompactionStateEvent` and its validation in the lifecycle module. Export
`isCompactionStateEvent(value: unknown): value is CompactionStateEvent` for the
adapter's raw bus boundary. The adapter calls that validator, captures the
current host, and dispatches only a valid semantic event. Lifecycle dispatch
captures and checks its private generation. Do not duplicate the optional-field
validation in `index.ts`.

On `inProgress`, record the source and set the in-progress flag. The start
`resumesRun` value is carried through the event but does not need a second live
flag because the current code uses the completion's `resumesRun` value. On
completion:

- clear the in-progress/source flags;
- take and clear the deferred Goal id;
- ignore the event when there is no matching deferred active Goal;
- on successful `resumesRun: true`, do not schedule;
- on successful `resumesRun: false`, schedule through the same guard path;
- on failure, block the matching Goal with the trimmed error or
  `Session compaction failed.`, then persist, refresh, and notify.

A completion after `branchChanged` or `sessionStopping` must be a no-op when
there is no newer matching deferral. Do not add an operation id to the existing
bus payload in this extraction: the compaction producer prevents overlapping
operations within its extension instance, and the current event contract cannot
distinguish an old completion from a newer operation with the same Goal id. The
lifecycle must not claim stronger stale-completion guarantees than that contract
supports.

#### Common transition path

Move the current `applyTransition` behavior into one private lifecycle helper:

1. remember the previous Goal id;
2. adopt `outcome.goal`, retaining `null` for a successful clear transition
   while retaining a reconstructed `cleared` tombstone until the next Session
   reset;
3. ask the host to append exactly `{ action: outcome.action, state: outcome.state }`
   under the existing `goal-state` custom type;
4. clear pending/automatic/deferred transient state for terminal actions or a
   changed Goal id;
5. leave transient state intact for `checkpoint`, `edit`, and `resume`.

Keep the current terminal action set: `pause`, `clear`, `block`, `complete`,
and `limit`.

`stopGoal` should use this helper, then persist the current runtime, update the
widget, and notify in the same order as today. Preserve the existing terminal
labels (`Goal blocked`, `Goal budget limited`, `Goal paused`, and
`Goal completed`); completed notifications use `info`, and the other terminal
notifications use `warning`.

### Command and tool integration

The lifecycle will receive `/goal` and Goal-tool requests so it remains the
single owner of the live Goal aggregate.

#### `/goal` command

For `commandRequested`:

1. call `runGoalCommand(goal, args, now(), host)`;
2. if it returns a transition for `set` (a new objective or `edit`), `pause`,
   `resume`, `checkpoint`, `block`, or `clear`, apply it through the common
   transition path;
3. if the new Goal id has no matching runtime, initialize an in-memory runtime
   snapshot exactly as the current adapter does;
4. on `resume`, call `resetGoalRuntime` with the existing rule: reset the
   continuation count only when the previous status was `budget_limited`, while
   always resetting no-progress and failure counters;
5. persist the reset runtime when required;
6. deliver the outcome notification through the host. For a blank command with
   a non-null current Goal, append the existing runtime lines to the
   notification before notifying, including the current empty suffix behavior
   for a reconstructed cleared tombstone;
7. refresh the widget after a transition;
8. send the kickoff through the host, using queued delivery when the host is not
   idle.

The confirmation prompt remains supplied by the host, so the command module
still owns its question text and the Pi adapter still owns the actual prompt.
The lifecycle queue must keep the whole confirmation-to-commit sequence ordered.
A confirmation that resolves after Session currency changes completes silently
and performs no transition, write, notification, widget update, or kickoff.

#### Pre-Session command and tool calls

Preserve the current adapter behavior before the first `session_start`. Existing
harness tests invoke `/goal` before Session reconstruction, and a tool call with
no Goal before reconstruction must still return `No active goal.` rather than
throwing. When no active Session host exists, the adapter creates a distinct
ephemeral host and marks the command/tool event `preSession: true`. The
lifecycle applies a pre-Session command transition and appends it through that
host, but it must not install that host as the active Session host or create a
second Goal state. A Session start invalidates any pre-Session event that is
still waiting for confirmation. Once a Session is active, host/generation checks
apply normally. This compatibility path is narrow and must not become a second
live Goal owner.

#### Goal tool

Move the current tool state/transition switch and `evidenceError` validation
behind `toolRequested`. Keep the exact externally visible behavior:

- status with a null Goal returns `No active goal.` without an error flag;
- a reconstructed `cleared` tombstone remains visible to status and uses the
  existing `Cannot ...: goal is cleared.` mutation errors;
- mutating actions with a null Goal return the existing no-active-goal details;
- checkpoint trims the summary, rejects an empty summary at the tool seam,
  appends a truthy `remaining` value verbatim to the result text, omits the
  suffix for an empty string, and applies `checkpointGoal`;
- completion validates the summary and evidence before checking Goal status;
  it requires a non-empty trimmed summary, a non-empty evidence array whose
  every item is a non-null, non-array object, `string` requirement and
  verification fields whose trimmed values are nonempty, and `passed` on every
  evidence result. Preserve the original evidence strings in the transition
  after validation;
- blocked requires a non-empty trimmed reason;
- every successful mutation appends one Goal entry and refreshes the widget;
- completion and blocked transitions notify once;
- a successful completion does not trigger a later automatic terminal notification
  from `turn_end`.

The lifecycle returns a structured outcome. `index.ts` converts it into the
existing Pi tool result and keeps `renderCall`/`renderResult` unchanged except
for reading the returned outcome. Preserve the details shapes: any non-null
Goal status, including a reconstructed tombstone, returns
`{ action, state, runtime }`, while null-Goal status returns only `{ action }`;
checkpoint and blocked return `{ action, state }`; completion
returns `{ action, state, evidence }`; validation and no-goal mutations add
`error` and `isError` exactly as today. Move the one plain-text
`runtimeLines` helper to the runtime module and use it for both the lifecycle's
blank-command notification and the adapter's status rendering; do not duplicate
that helper in both files.

### Adapter rewrite: `workflows-goal/index.ts`

Refactor the extension entry point into a thin Pi adapter:

1. import and construct `createGoalLifecycle({ now: Date.now })`;
2. retain `GoalStatusWidget`, TypeBox schemas, glyphs, and render helpers;
3. replace the live Goal/runtime/transient variables with a Session-scoped
   `currentHost` and a `createHost(ctx)` helper implementing
   `GoalLifecycleHost`;
4. map `session_start` to `sessionStarted` with
   `ctx.sessionManager.getBranch()` and install a fresh host for that Session;
5. map `session_tree` to `branchChanged` with the new branch and replace the
   host for that Session/branch;
6. map `session_shutdown` to `sessionStopping` with the captured host. In the
   `finally` path, clear `currentHost` and unregister the compaction listener
   only when `currentHost` is still that captured host. An old shutdown callback
   must not tear down a newer Session's host or listener;
7. map `before_agent_start`, `message_start`, `turn_end`, and `agent_settled`
   to the corresponding semantic events using the same current host, and
   return/await lifecycle results. A missing current host returns the event's
   neutral result instead of manufacturing one for an active event;
8. keep the `pi.events.on("session-compaction:state", ...)` registration, call
   the lifecycle-owned validator, capture the current host, and dispatch only
   semantic compaction events. The lifecycle captures and checks its private
   generation. Drop the event when no active host exists;
9. map the registered Goal tool's `execute` call to `toolRequested` and adapt
   its structured result to the existing Pi shape;
10. map the `/goal` command to `commandRequested`, using a distinct ephemeral
    host and `preSession: true` only when no Session-scoped host exists;
11. map pre-Session tool execution the same way; when the lifecycle has no
    Goal, return the existing no-Goal result without throwing;
12. retain `registerToolErrorHandler` and all Pi registration metadata;
13. remove the now-dead local helpers and state variables from the adapter. Keep
    `GoalStatusWidget`, its width-safe rendering, the shared runtime formatter,
    and adapter-only rendering state at this seam.

The adapter must not decide when to persist, when to clear a marker, when to
block/pause a Goal, or when to schedule a continuation. `createHost(ctx)` must
guard the widget close callback with host identity so an old widget cannot clear
a newer Session's widget after a Session/branch replacement. The lifecycle passes
`null` to `updateWidget` for a missing or `cleared` Goal, and the host also treats
any received `cleared` snapshot as a clear request.

### Existing pure modules

Do not change policy behavior in these modules:

- `.pi/extensions/workflows-goal/goal-state.ts`
- `.pi/extensions/workflows-goal/goal-runtime.ts`
- `.pi/extensions/workflows-goal/goal-commands.ts`
- `.pi/extensions/workflows-goal/goal-prompts.ts`

Make only the required seam adjustments. Move the unchanged `runtimeLines`
formatter into `goal-runtime.ts` beside `DEFAULT_GOAL_RUNTIME_CONFIG` so the
lifecycle and adapter share one formatter; this is not a change to runtime
policy or persisted data. Move `CompactionStateEvent` and its validator into
`goal-lifecycle.ts`; preserve the event shape and valid-payload behavior, while
using the specified boundary rejection for malformed optional fields.

## Test migration and additions

Use replace-don't-duplicate testing. First move the continuation behavior behind
the new lifecycle interface and make the new seam tests pass; then remove duplicate
continuation assertions from the Pi adapter test rather than maintaining two
large copies of the same state machine tests.

### New `goal-lifecycle.test.ts`

Create a focused deterministic host harness with:

- a mutable branch supplied to Session events;
- injected `now` values;
- an ordered effect log plus captured Goal/runtime writes;
- captured widget snapshots;
- captured notifications;
- captured continuation/kickoff sends;
- controllable `isIdle` and `hasPendingMessages` values;
- configurable confirmation result;
- a send failure hook;
- malformed raw compaction values, including wrong optional `succeeded` or
  `error` types, for direct validator tests;
- an event helper that awaits `dispatch` and a bus helper that observes
  synchronous effects before `emit` returns.

Cover these cases through `GoalLifecycle.dispatch`:

1. Session start reconstructs an active Goal/runtime without appending an
   initialized runtime snapshot, updates the widget once, and clears the widget
   for a missing or reconstructed `cleared` Goal.
2. Branch change clears pending/automatic/deferred state and reconstructs the
   new branch.
3. Shutdown clears the live aggregate, leaves no retained host, and prevents
   later effects.
4. Prompt construction appends the addendum for active, paused, and blocked
   states, returns `undefined` for cleared/completed/budget-limited/no-Goal
   states, and preserves the incoming prompt when no addendum applies.
5. A matching hidden continuation with the matching string Goal id starts one
   automatic run.
6. The message role/type/id matrix is preserved: user and nonmatching custom
   messages clear a stranded marker, while assistant and tool-result messages
   leave it alone.
7. Multiple `turnEnded` events aggregate one automatic run.
8. `turnEnded` never sends a continuation directly.
9. `agentSettled` preserves the exact runtime write counts and order: ordinary
   continuation and error/length paths write a finalized snapshot and then a
   second scheduling/stop snapshot, aborted work writes only the finalized
   snapshot before pausing, and a mismatched run is not finalized.
10. Ordinary settled work schedules one continuation when the existing guards
    pass.
11. A second settlement cannot duplicate a pending continuation.
12. Pending user work, non-idle state, compaction, inactive Goals, and stale
    runtime suppress continuation; the continuation limit stops the Goal through
    the `limit` transition with its existing persistence, widget, and
    notification effects.
13. Synchronous continuation-send failure clears the marker, notifies, and
    permits a later retry without undoing the persisted charge; a rejected
    lifecycle task does not permanently reject later dispatches.
14. Aborted automatic work pauses once and notifies once.
15. Error and length stops block once with the existing reasons and persistence
    order.
16. The third no-progress and third failure thresholds each block through the
    common transition path with their distinct existing reasons.
17. Turn-end compaction defers settlement; resuming success does not schedule,
    non-resuming success does schedule, and failure blocks.
18. Pre-agent compaction does not defer settlement and does not later schedule
    from an empty deferred marker.
19. A branch change or shutdown before compaction completion makes the stale
    completion a no-op when no newer matching deferral exists. Do not assert a
    stronger guarantee for an old completion that races a newer same-Goal-id
    deferral because the bus payload has no operation id.
20. Every `/goal` transition arm (`set`, `pause`, `resume`, `edit`,
    `checkpoint`, `block`, and `clear`) preserves persistence, reset rules,
    notification text/severity, blank-command runtime lines, widget refresh,
    and kickoff ordering.
21. Busy `/goal` kickoff uses follow-up delivery; idle kickoff does not.
22. A confirmation and a queued compaction event serialize in admission
    order. A competing Session reset then invalidates any remaining queued work
    and the stale confirmation, which completes silently without a transition or
    effect.
23. Pre-Session command and tool calls use the ephemeral host without installing
    it as the active host; a pre-Session command write is reconstructed by the
    following Session when the Session branch contains that write.
24. Tool status and mutating no-Goal outcomes preserve the null-Goal result,
    while a reconstructed cleared tombstone preserves its distinct status and
    error results.
25. Tool checkpoint, complete, and blocked validation preserves trimmed
    summaries/reasons, verbatim `remaining` and evidence strings, exact error
    details, and the completion evidence requirement.
26. Successful tool mutations append one Goal entry and refresh the widget;
    completion and blocked transitions notify once, and completion does not
    cause a later terminal notification from `turn_end`.

The test names should describe observable lifecycle behavior rather than private
field names.

### `workflows-goal/index.test.ts`

Keep adapter-level coverage for the Pi seam, but reduce it to behavior that
requires Pi registration or rendering:

- registration of the Goal tool, command, and event handlers;
- TypeBox-facing tool execution/result adaptation;
- compact and expanded tool rendering, including failure classification;
- Goal widget creation and width-safe rendering;
- one synchronous compaction-bus ordering test: a non-resuming successful
  finish is observable before the bus emit returns, while a resuming finish
  does not create a duplicate Goal continuation;
- malformed compaction payloads are ignored, including wrong optional field
  types;
- stale shutdown cleanup does not clear a replacement host or remove its
  compaction listener.

Remove the duplicated continuation state-machine tests once the new lifecycle
suite covers them.

### `workflows-goal/index.host.test.ts`

Keep the installed-host integration test. Update its harness expectations for
the new dispatch adapter without weakening its assertions. It must continue to
prove:

- one ordinary run produces one hidden continuation;
- the continuation receives the Goal prompt addendum;
- runtime entries are persisted and capped at the existing limit;
- the Goal becomes `budget_limited` at the existing threshold.

Add no new persistence format to make this test pass.

### Existing pure tests

Run and preserve:

- `goal-state.test.ts` for reconstruction and transitions;
- `goal-runtime.test.ts` for counters, classification, limits, and the shared
  runtime-line formatter;
- `goal-commands.test.ts` for command policy;
- `goal-prompts.test.ts` for prompt policy.

Add the shared formatter assertions to `goal-runtime.test.ts` with the existing
runtime policy tests. Limit other changes in these files to type exports or test
helpers required by the seam; do not move their policy assertions into the
lifecycle suite.

## Documentation update

After the implementation, update the Goal tracking section of `CONTEXT.md`:

1. Keep the Goal state module entry, but describe persistence and Pi effects as
   owned by the lifecycle/adapter rather than the old monolithic extension
   callback.
2. Keep the Goal runtime module entry focused on counters, classification, and
   bounded decisions.
3. Add a `Goal continuation lifecycle` entry naming
   `workflows-goal/goal-lifecycle.ts` as the deep in-process module. Document
   that it owns the live aggregate, Session reconstruction/reset, hidden-run
   correlation, compaction deferral, settlement ordering, runtime persistence
   requests, and at-most-one continuation scheduling behind `GoalLifecycle`.
4. State that `workflows-goal/index.ts` is the Pi adapter for event registration,
   host effects, schemas, and TUI/tool rendering.
5. Keep the Goal command and prompt entries accurate: they remain policy modules
   consumed by the lifecycle and adapter.

Do not add a new ADR for this extraction; no existing ADR conflicts with it.

## Implementation order

1. **Create the new seam tests.** Extract the current continuation scenarios into
   `goal-lifecycle.test.ts` and define the deterministic host/event vocabulary.
   Keep the existing adapter tests temporarily so behavior remains observable
   while the new seam is built.
2. **Add `goal-lifecycle.ts`.** Implement the private aggregate, injected clock,
   serialized dispatch queue, Session reconstruction/reset, common transition
   helper, and command/tool result types.
3. **Migrate continuation events.** Move hidden-run recognition, turn recording,
   settlement finalization, scheduling, terminal handling, and compaction
   deferral into the new module. Make the new lifecycle tests pass.
4. **Migrate command and tool mutations.** Route `/goal` and Goal-tool requests
   through the lifecycle so the adapter no longer owns live state or transition
   ordering.
5. **Rewrite the adapter.** Add the narrow host, map Pi events, preserve
   registration order and rendering, and remove duplicate state/effect logic.
6. **Slim duplicate tests.** Keep Pi registration/rendering/host smoke coverage;
   delete only the continuation assertions now replaced by lifecycle tests.
7. **Update `CONTEXT.md`.** Record the final module, interface, seam, adapters,
   and ownership invariants.
8. **Run focused verification, then the full suite.** Do not commit as part of
   this implementation plan. Handle commits only through a separate request.

## Compatibility and non-goals

- No change to the `goal-state` or `goal-runtime` persisted custom entry
  formats.
- No change to Goal ids, legacy migration, cleared tombstones, status names,
  runtime limits, continuation prompt text, or terminal notification wording.
- No change to the `session-compaction:state` event payload or compaction
  implementation.
- No change to Plan Mode or the catalog conflict rule.
- No change to Goal widget layout or tool rendering beyond adapting the new
  structured lifecycle outcome.
- No new dependency.
- No handler composition or priority system.
- No second source of Goal state in the Pi adapter.
- No direct Pi context dependency in the new lifecycle module.

## Verification checklist

Run package commands from `.pi`.

### Narrow checks

```bash
(cd .pi && pnpm exec vitest run extensions/workflows-goal)
(cd .pi && pnpm typecheck)
```

Expected result: all Goal tests pass, including the new lifecycle suite and the
installed-host test; TypeScript emits no errors.

### Repository checks

```bash
(cd .pi && pnpm test)
git diff --check
git status --short
```

The full suite must have no failures. Inspect the final status for the intended
Goal lifecycle implementation, tests, documentation, and `plan.md`, while
leaving any pre-existing unrelated changes untouched.

### Manual TUI flow when available

Exercise the primary user-visible path in a real TUI Session:

1. set a Goal with `/goal <objective>`;
2. let one ordinary run settle and confirm one hidden continuation begins;
3. observe a checkpoint and confirm counters reset as expected;
4. queue a user message while the agent is active and confirm it prevents an
   extra continuation;
5. trigger or wait for extension-owned compaction and confirm the Goal waits for
   the matching compaction result;
6. pause, resume, block, complete, and clear the Goal and verify widget and
   notification ordering;
7. shut down and start a fresh Session to confirm no pending continuation or
   stale Goal host survives.

If an interactive TUI is unavailable, report that limitation rather than
claiming manual validation.

## Completion criteria

The extraction is complete when:

- `goal-lifecycle.ts` is the only owner of live Goal continuation state;
- `index.ts` only adapts Pi callbacks/effects and renders Pi-facing results;
- lifecycle tests cross the `GoalLifecycle` interface and cover every current
  continuation, compaction, terminal, Session, command, and tool path;
- installed-host behavior and persisted entry formats remain compatible;
- `CONTEXT.md` names the final module and seam;
- focused tests, typecheck, full tests, and diff checks pass;
- manual TUI verification is attempted and reported when available.
