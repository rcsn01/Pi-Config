# Deepen the Workflow run event module

## Goal

Turn the current open Workflow run event record and reducer switch into one deep in-process module with a typed interface for engine-owned writes and an open compatibility interface for durable reads.

The implementation must improve locality without changing persisted data or moving Workflow run lifecycle policy. After the change:

- engine-owned event producers are checked against one canonical event vocabulary;
- durable JSONL remains forward-compatible with unknown event types and fields;
- event interpretation, legacy aliases, usage normalization, live reduction, and replay live in one module;
- the Workflow run lifecycle still owns when an event is recorded and the `append -> reduce -> projection` ordering;
- `run-store.ts` still owns persistence, JSONL shape checks, and path safety, but no event interpretation;
- recovery still treats `events.jsonl` as canonical and uses `state.json` only when the event log is missing;
- raw event inspection keeps its existing JSON-cloned view of parsed JSONL records;
- tests exercise event behavior through the event module's interface.

No event-log migration is required.

## Why this is the right scope

Recent changes make Workflow runs a hot area. The current event seam is real and load-bearing:

- `WorkflowRun.recordOnQueue()` applies events during live execution.
- `recoverWorkflowRunState()` replays the same events during durable recovery.
- `/workflows raw <run-id>` exposes the records for inspection.
- `FileRunPersistence` and `InMemoryRunPersistence` are two adapters at the existing persistence seam.

The reducer has meaningful depth, but its interface is shallow:

```ts
export interface WorkflowRunEventView {
  ts?: number;
  type: string;
  [key: string]: unknown;
}

export type WorkflowRunEventToPersist = WorkflowRunEventView;
```

Every event producer can miss a required field, misspell a type, or attach the wrong payload without a compile error. The reducer then recovers meaning through casts and coercions spread across a large switch.

Applying the deletion test shows that reduction earns its seam. Deleting `applyEvent()` and `rebuildState()` would spread live state transitions and durable replay across lifecycle and recovery. The current Node integration helper also calls replay directly, but that helper duplicates production behavior and this plan removes it rather than treating it as a reason for another interface. The right change is to deepen the reducer module, not remove it and not add a pass-through module.

## Verified source inventory

This inventory was derived from the current source with repository-wide `rg`, file reads, and counts. It is the migration checklist.

- `workflow-run.ts` has 27 event-construction expressions: the initialization event plus 26 calls to `record()` or `recordOnQueue()`. Two expressions select between two names (`run_started`/`run_resumed` and `invalidated`/`dependency_invalidated`), and `run_paused` appears at two sites. Together they produce 28 unique event names and 29 literal name alternatives.
- `workflow-run-state.ts` handles `run_created` before its switch and has 27 switch labels for the other 27 names. The producer and reducer vocabularies match exactly. There are no producer-only or reducer-only names.
- `workflow-run-state.ts` is the sole current definition site for `WorkflowRunEventView` and `WorkflowRunEventToPersist`, the sole implementation site for `applyEvent()` and `rebuildState()`, and the sole implementation site for the three private reducer helpers `usageFromEvent()`, `addUsage()`, and `dependencyEdges()`.
- Live reduction has exactly two call sites in `workflow-run.ts`: new-run initialization and `recordOnQueue()`. Durable replay has one production call site in `workflow-run-recovery.ts`.
- The open persistence type is used by `run-store.ts` and `test-support.ts`. `run-store.ts` has the `RunPersistence` declaration and the `FileRunPersistence` method implementations. `test-support.ts` has the in-memory implementation, event getter, and seeding helpers.
- `workflow-run.ts` re-exports `WorkflowRunEventView`. `commands.ts` consumes that re-export in `WorkflowCommandService` and renders raw records with `JSON.stringify(event)` in stored order. Production `readWorkflowEvents()` first applies `cloneJson(log.events)`, so raw output is not object-identical to `readEventLog()` output: JSON negative zero becomes zero and parsed numeric overflow such as `1e400` becomes `null` during the clone. No caller outside `extensions/workflows-engine` uses any current event or reducer symbol.
- Tests call reduction directly at one `applyEvent()` site in `workflow-run.test.ts`, one `rebuildState()` helper in `workflow-run-recovery.test.ts`, and three `runState.rebuildState()` sites in `tests/runtime.test.mjs`.
- Tests append open records directly through persistence at two fixture sites in `workflow-run.test.ts`, one site in `run-store.test.ts`, two sites in `workflow-run-recovery.test.ts`, and the two `TestStore` methods in `runtime.test.mjs`. These remain open-data callers; they must not be forced through `KnownWorkflowRunEvent`.
- Existing tests cover supplied numeric timestamp preservation and missing versus empty logs in `run-store.test.ts`; recovery precedence and failure identity in `workflow-run-recovery.test.ts`; and lifecycle event order, append failure, projection recovery, stale-attempt suppression, progress mapping, restart, and worktree behavior in `workflow-run.test.ts` and `runtime.test.mjs`. They do not currently cover raw rendering of unknown fields, unknown-event replay, legacy aliases, malformed event record classes, most reducer branches, timestamp/coercion boundaries, or compile-time producer rejection.
- `CONTEXT.md` names `workflow-run-state.ts` as reducer owner once. The Workflow README describes canonical `events.jsonl` once but does not describe the open-read/closed-write split. `.pi/package.json` lists seven Workflow Vitest files explicitly and then runs the unchanged `tests/*.test.mjs` Node glob.

## Final design decisions

These settle the design tree using the recommended answer for each choice.

### 1. Keep the module pure and in-process

Create `.pi/extensions/workflows-engine/lib/workflow-run-events.ts` as a pure in-process module.

It owns:

- the engine-owned event vocabulary;
- typed event payloads for production writers;
- interpretation of durable event records;
- compatibility aliases and coercions;
- one-event reduction;
- ordered replay.

It does not own:

- persistence calls or JSONL/path validation;
- queue or lease ownership;
- operation-attempt suppression;
- terminal settlement bookkeeping;
- projection writes;
- recovery precedence;
- worktree behavior;
- command rendering.

This keeps the seam narrow. No new adapter is needed because the module has no I/O dependency.

### 2. Separate trusted writes from durable reads

Use two event types with different jobs.

`KnownWorkflowRunEvent` is a closed discriminated union for events created by `WorkflowRun`. It catches misspelled event names, missing payload fields, and payload fields attached to the wrong event.

`WorkflowRunEventView` remains an open JSON record for records read from `events.jsonl`:

```ts
export interface WorkflowRunEventView {
  ts?: number;
  type: string;
  [key: string]: unknown;
}
```

The open read type is required for forward compatibility. A newer process may have written an event that an older process does not know. The older process must still read it, show it through `/workflows raw`, and replay it as a no-op after `run_created`.

Do not use one closed union at the file adapter seam. That would make historical and future records pretend to be known events.

### 3. Keep lifecycle ordering in `WorkflowRun`

Do not adopt a stateful event journal that calls persistence itself. `WorkflowRun.recordOnQueue()` must remain the only ordinary lifecycle commit path:

```text
check stale attempt
clone and stamp event
append events.jsonl
reduce the same stamped event
mark terminal lifecycle state when applicable
write state.json best-effort
```

Initialization keeps the same order after `initializeInput()`.

This preserves the Workflow run lifecycle ownership recorded in `CONTEXT.md`: lifecycle writes and persistence ordering stay in `workflow-run.ts`. Moving reduction and replay from `workflow-run-state.ts` into the new Workflow run event module is an intentional ownership change. Materialized state shape, validation, and read-model projection remain in `workflow-run-state.ts`. The `CONTEXT.md` update in this plan is therefore mandatory.

### 4. Do not add an event registry

The Workflow engine has one built-in event vocabulary. There is no requirement for third-party event definitions or runtime registration.

Do not add:

- event definition registration;
- canonical-name and alias maps;
- injected event modules;
- event factory objects;
- runtime brands;
- queue lease tokens;
- global registries;
- schema version envelopes;
- event ids.

Those ideas add interface area without a second implementation or a confirmed extension requirement. A discriminated union plus the private reducer implementation is enough.

### 5. Preserve compatibility exactly

This refactor must not change accepted logs or materialized state behavior.

Keep these rules:

- Every event, including an ignored or target-missing event, computes `Number(event.ts || Date.now())` and sets `state.updatedAt` once state exists. Missing, `null`, `0`, `false`, and `""` timestamps use `Date.now()`. Truthy numeric strings convert to numbers, negative numbers remain negative, and truthy nonnumeric values produce `NaN`; recovery later rejects non-finite projected timestamps through `validateProjection()`. `run_created` also calls `Date.now()` inside `initialState()` even when it has an explicit timestamp, then overwrites both state timestamps with the effective event timestamp. Preserve that call behavior by moving the code unchanged.
- `run_created` is recognized before the switch. It may occur anywhere in a log, not only first. Every occurrence discards the accumulated state, creates a new initial state object, then applies its effective timestamp to both `startedAt` and `updatedAt`. Other events mutate and return the input state object.
- `run_created` uses these exact conversions: `String(runId)`; `String(workflowName || workflow)`; `trust || "project"`; `String(args || "")`; `String(sourceHash || "")`; `String(description || "")`; `costShape || "unknown"`; and unchecked pass-through casts for `sourceSnapshotPath` and `canEditFiles`. A truthy `workflowName` wins; a missing or falsey value falls back to legacy `workflow`.
- Usage reads `event.usage || {}`. `input`, `output`, `cacheRead`, and `cacheWrite` each use truthiness fallback to the corresponding legacy `*Tokens` name, then to zero. `turns` and `cost` use truthiness fallback to zero. `Number(...)` performs the final conversion, so a current zero falls back to a truthy legacy value and a truthy nonnumeric value produces `NaN`.
- Unknown event names after creation change only `updatedAt`. An empty string is a valid persisted `type` because the adapter requires a string, not a non-empty string. Before creation, known, unknown, and empty-string types throw `Cannot apply <type> before run_created` using the type verbatim.
- Fields converted with unconditional `String(...)` are `runId`, the selected Workflow name, phase names, step and agent keys, agent names on start/completion/failure, and artifact paths. Missing values therefore become `"undefined"`. Fields using truthiness fallback before `String(...)` are run args/source hash/description, failed/stopped/phase/step/agent/parallel error text, and log messages. `run_paused.error` instead becomes `undefined` when falsey. `parallel_started.count`, `parallel_started.concurrency`, and `parallel_completed.count` use `Number(value || 0)`, with the same falsey fallback and nonnumeric `NaN` behavior as usage. `prompt`, `sourceSnapshotPath`, `dependsOn`, `metadata`, `details`, `worktree`, `result`, `raw`, progress payloads, tool names/args, and the `stopped` flag retain their existing unchecked pass-through or truthiness behavior.
- `dependsOn` uses `(dependsOn as string[] | undefined) || []` and iterates the value. Missing and falsey values add no edges; arrays work as expected; a string iterates by character; and a truthy non-iterable throws. Preserve that compatibility behavior rather than adding durable-read validation in this refactor. Dependency edge targets are deduplicated, while the `dependsOn` array stored on step or agent state is not normalized. Starting the same key again with different dependencies does not remove old reverse edges.
- Target-missing cases retain their asymmetry. `step_reused`, `agent_reused`, `agent_progress`, and `agent_tool` make no target-specific change, but still update global `updatedAt`. Completion and failure events create a step or agent if one is absent and still change counters. Invalidation always adds its key once even if no matching step or agent exists. When a target exists, invalidation changes its status but not its own `updatedAt`.
- Only `run_completed` writes `result`; every other noncreation run event retains an older result. Run completion does not clear an older error. Phase completion/failure does not clear `currentPhase`. Step completion replaces the whole prior step, while step failure merges prior fields. Agent start replaces the whole prior agent and increments both counters on every occurrence, even for the same key. Agent completion/failure merge prior fields, retain stale fields not overwritten by that arm, decrement running no lower than zero, and increment their terminal counter on every occurrence even if the target was absent. Parallel completion/failure merge prior fields. Artifact paths are unique by their converted string. Progress keeps the last 50 records.
- Unknown fields remain in raw reads and are not written into `state.json` unless existing reduction already carries them into state through a pass-through field.
- No existing event is renamed, wrapped, rejected, or normalized on write.

Move the current reducer logic largely verbatim. Do not add a normalized-transition layer: it has no current consumer and would create a second representation whose compatibility would need separate proof.

### 6. Make the event interface the test surface

Add focused tests for the new module. These tests should call its exported one-event and replay functions rather than private helpers.

Keep adapter tests focused on JSONL and path behavior. Keep lifecycle tests focused on ordering, operation policy, and observable run behavior. Keep recovery tests focused on canonical-log precedence and projection fallback.

Do not add tests for private switch branches through exported implementation details.

## Proposed module interface

Add `.pi/extensions/workflows-engine/lib/workflow-run-events.ts` with this interface shape and these type names.

```ts
import type { RunState } from "./workflow-run-state.ts";

export interface WorkflowRunEventView {
  ts?: number;
  type: string;
  [key: string]: unknown;
}

interface WorkflowRunEventPayloads {
  run_created: {
    runId: string;
    workflowName: string;
    trust: WorkflowTrust;
    args: string;
    sourceHash: string;
    sourceSnapshotPath?: string;
    description: string;
    costShape: RegistryEntry["cost"];
    canEditFiles?: boolean;
  };
  run_started: Record<never, never>;
  run_pausing: { mode: "after-current" | "now" };
  run_paused: { error?: string };
  run_resumed: Record<never, never>;
  run_completed: { result: unknown };
  run_failed: { error: string };
  run_stopped: { error: string };
  phase_started: { name: string };
  phase_completed: { name: string };
  phase_failed: { name: string; error: string };
  step_started: {
    key: string;
    dependsOn?: string[];
    metadata?: Record<string, unknown>;
  };
  step_completed: { key: string; result: unknown };
  step_failed: { key: string; error: string };
  step_reused: { key: string };
  agent_started: {
    key: string;
    agent: string;
    prompt: string;
    dependsOn?: string[];
    metadata?: Record<string, unknown>;
    worktree?: WorktreeInfo;
  };
  agent_progress: { key: string; event: SubagentProgressEvent };
  agent_tool: {
    key: string;
    event: Extract<SubagentProgressEvent, { type: "tool_call" }>;
    tool: string;
    args?: string;
  };
  agent_completed: {
    key: string;
    agent: string;
    result: unknown;
    raw: AgentResult;
    usage: AgentResult["usage"];
  };
  agent_failed: {
    key: string;
    agent: string;
    error: string;
    stopped: boolean;
  };
  agent_reused: { key: string; agent: string };
  parallel_started: { key: string; count: number; concurrency: number };
  parallel_completed: { key: string; count: number };
  parallel_failed: { key: string; error: string };
  artifact_written: { path: string };
  log: { message: string; details?: Record<string, unknown> };
  invalidated: { key: string; root: string };
  dependency_invalidated: { key: string; root: string };
}

export type KnownWorkflowRunEvent = {
  [K in keyof WorkflowRunEventPayloads]:
    { type: K; ts?: number } & WorkflowRunEventPayloads[K]
}[keyof WorkflowRunEventPayloads];

export function applyWorkflowRunEvent(
  state: RunState | undefined,
  event: WorkflowRunEventView,
): RunState;

export function rebuildWorkflowRunState(
  events: readonly WorkflowRunEventView[],
): RunState;
```

Derive field types from the producer values in `workflow-run.ts`. Use type-only imports for `WorkflowTrust`, `RegistryEntry`, `AgentResult`, `SubagentProgressEvent`, and `WorktreeInfo`. Keep the pause mode payload as the same literal union used by the lifecycle rather than importing back from `workflow-run.ts` and creating a reverse dependency. Keep `WorkflowRunEventPayloads` private: no current caller needs the map itself, and exporting it would add a second public event vocabulary without a consumer.

`Record<never, never>` was compiled against the repository's TypeScript 7.0.2 with this mapped union. Fresh no-payload literals containing an extra field fail with TS2353, as do wrong-family payload fields. Use it directly and retain compile-time assertions in the repository typecheck to prevent regression.

The persistence seam should remain open:

```ts
export interface RunPersistence {
  appendEvent(event: WorkflowRunEventView): Promise<void>;
  readEventLog(): Promise<{
    exists: boolean;
    events: readonly WorkflowRunEventView[];
  }>;
  // existing methods unchanged
}
```

The lifecycle seam becomes closed for ordinary engine writes:

```ts
private record(
  event: KnownWorkflowRunEvent,
  attempt?: number,
): Promise<RunState>;

private recordOnQueue(
  event: KnownWorkflowRunEvent,
  attempt?: number,
): Promise<RunState>;
```

`run_created` initialization should also use `KnownWorkflowRunEvent`. Historical test fixtures and the file adapter may continue to accept `WorkflowRunEventView` because their purpose is to represent external durable data, including legacy and unknown records.

## Canonical engine-owned event vocabulary

Implement the write union from the events currently produced in `workflow-run.ts`. Preserve these names and fields.

| Event type | Engine-owned payload | State effect |
| --- | --- | --- |
| `run_created` | `runId`, `workflowName`, `trust`, `args`, `sourceHash`, `description`, `costShape`, optional `sourceSnapshotPath`, optional `canEditFiles` | Resets all accumulated state, creates initial state, and applies the timestamp |
| `run_started` | none | Sets running; clears error and completion time; retains any result |
| `run_pausing` | `mode` | Sets pausing; reducer ignores `mode` |
| `run_paused` | optional `error` | Sets paused and completion time; falsey error becomes absent |
| `run_resumed` | none | Sets running; clears error and completion time; retains any result |
| `run_completed` | `result` | Sets completed, result, and completion time; does not clear an older error |
| `run_failed` | `error` | Sets failed, fallback error text, and completion time |
| `run_stopped` | `error` | Sets stopped, fallback error text, and completion time |
| `phase_started` | `name` | Sets current phase and replaces that phase with running state |
| `phase_completed` | `name` | Replaces phase state with completed; retains current phase |
| `phase_failed` | `name`, `error` | Replaces phase state with failed/error; retains current phase |
| `step_started` | `key`, optional `dependsOn`, optional `metadata` | Replaces step with running state; stores payload unchanged; adds deduplicated edges |
| `step_completed` | `key`, `result` | Replaces the whole step with completed result and clears invalidation |
| `step_failed` | `key`, `error` | Merges prior fields and marks failed; creates a minimal step if absent |
| `step_reused` | `key` | Updates an existing step timestamp; absent target changes only global time |
| `agent_started` | `key`, `agent`, `prompt`, optional `dependsOn`, optional `metadata`, optional `worktree` | Replaces agent with running state, increments started/running, adds edges |
| `agent_progress` | `key`, `event` | Appends raw progress for an existing agent, capped at 50; absent target is ignored |
| `agent_tool` | `key`, `event`, `tool`, optional `args` | Appends `{ type: "tool", tool, args }`, capped at 50; reducer ignores `event` |
| `agent_completed` | `key`, `agent`, `result`, `raw`, `usage` | Merges/creates completed agent, updates counters, clears invalidation, accumulates usage |
| `agent_failed` | `key`, `agent`, `error`, `stopped` | Merges/creates failed or stopped agent and updates counters |
| `agent_reused` | `key`, `agent` | Updates an existing agent timestamp; absent target is ignored; reducer ignores `agent` |
| `parallel_started` | `key`, `count`, `concurrency` | Replaces parallel state with running/count/concurrency |
| `parallel_completed` | `key`, `count` | Merges/creates completed state and count, preserving prior concurrency/error |
| `parallel_failed` | `key`, `error` | Merges/creates failed state and error, preserving prior count/concurrency |
| `artifact_written` | `path` | Adds the converted string path once |
| `log` | `message`, optional `details` | Appends a timestamped log; falsey message becomes empty string |
| `invalidated` | `key`, `root` | Adds key once and marks matching step and agent; reducer ignores `root` |
| `dependency_invalidated` | `key`, `root` | Same reducer behavior as `invalidated` |

The reducer can continue ignoring fields that are durable diagnostics rather than state inputs. For example, `run_pausing.mode`, `agent_tool.event`, `agent_reused.agent`, and invalidation `root` are persisted for meaning even where current state reduction does not consume them.

## File-by-file implementation plan

### 1. Add `lib/workflow-run-events.ts`

Move event-specific code out of `workflow-run-state.ts`:

- `WorkflowRunEventView`;
- `WorkflowRunEventToPersist`, which is deleted rather than forwarded because `KnownWorkflowRunEvent` replaces it for lifecycle writes and `WorkflowRunEventView` remains the persistence type;
- `usageFromEvent()`;
- `addUsage()`;
- `dependencyEdges()`;
- `applyEvent()`;
- `rebuildState()`.

Add the closed engine-write vocabulary and export it as `KnownWorkflowRunEvent`.

Rename the public reduction functions to state their domain:

- `applyWorkflowRunEvent()`;
- `rebuildWorkflowRunState()`.

Keep the single switch and its helpers private. Do not split it into one function per family or event during this move. Such a split would enlarge the diff without removing current duplication or changing the two-function interface.

Preserve the current mutation model inside reduction for this refactor. Changing to immutable state transitions at the same time would increase risk and is not needed to deepen the seam. Continue cloning at existing lifecycle, persistence, and read-model points.

### 2. Narrow `lib/workflow-run-state.ts`

Leave state shape, projection validation, initial-state creation, read-model projection, path validation, and cleanup projection helpers in this file.

Remove event vocabulary and reduction code after callers migrate.

Expected retained responsibilities include:

- `RunStatus` and all `Run*State` types;
- `RunState`;
- `WorkflowRunSummary` and detail view types;
- `cloneJson()`;
- `validateProjection()`;
- `initialState()`;
- `projectDetail()`, `projectSummary()`, and their validation/path-safety helpers.

This keeps materialized state meaning separate from event interpretation while avoiding a cycle. `workflow-run-events.ts` may import `RunState`, `RunUsage`, `RunStepState`, `RunAgentState`, `RunParallelState`, and `initialState()` from `workflow-run-state.ts`. `workflow-run-state.ts` must not import the event module.

### 3. Update `lib/workflow-run.ts`

Import `KnownWorkflowRunEvent`, `WorkflowRunEventView`, and `applyWorkflowRunEvent()` from the new module.

Change `record()` and `recordOnQueue()` to accept `KnownWorkflowRunEvent`.

Type the initialization event as `KnownWorkflowRunEvent`, or use `satisfies KnownWorkflowRunEvent`, so `run_created` receives the same compile-time check as later events.

Replace live calls to `applyEvent()` with `applyWorkflowRunEvent()` in:

- new-run initialization;
- `recordOnQueue()`.

Do not otherwise change `recordOnQueue()` ordering or policy:

1. return current state for a terminal attempt;
2. reject an uninitialized run;
3. clone and stamp the event;
4. append it;
5. reduce it;
6. set `terminalAttempt` and `settled` for terminal event types;
7. write the projection best-effort.

Keep the event literal call sites inline. A factory call around every event would add syntax without hiding caller knowledge. The closed parameter type provides contextual checking.

Continue exporting `WorkflowRunEventView` from `workflow-run.ts` for command-facing compatibility, but source that export from `workflow-run-events.ts`.

Do not alter:

- `WorkflowRunHandle`;
- `WorkflowRunModule`;
- coordinator behavior;
- pause, stop, resume, or restart semantics;
- worktree admission and cleanup;
- Subagent execution;
- artifact writes;
- status rendering.

### 4. Update `lib/workflow-run-recovery.ts`

Import `rebuildWorkflowRunState()` from the new module.

Keep recovery flow exactly as it is:

- read the event log first;
- throw `WorkflowEventLogEmptyError` if it exists with no parsed events;
- replay and validate when it exists;
- repair `state.json` best-effort;
- consult `state.json` only when the event log is missing;
- preserve error classes, codes, messages, and `isWorkflowRunNotFound()`.

Do not move recovery into the event module. Recovery depends on persistence availability and canonical-source policy, while the event module is pure.

### 5. Update `lib/run-store.ts`

Import `WorkflowRunEventView` from `workflow-run-events.ts`.

Keep `RunPersistence.appendEvent()` open to `WorkflowRunEventView`. The file adapter is a system seam for durable records, not only a sink for current engine writes.

Keep all existing file behavior:

- append `{ ts: Date.now(), ...event }` so a supplied timestamp wins;
- one JSON object per line;
- skip blank lines;
- reject malformed JSON with path and line number;
- reject parsed values that are not objects with a string `type`;
- accept unknown event names and fields;
- distinguish missing and existing-empty logs;
- retain symlink and path-containment checks.

Do not validate known event payloads in `run-store.ts`. Event meaning belongs to the event module, and strict payload validation would risk rejecting old logs.

### 6. Update `lib/test-support.ts`

Import `WorkflowRunEventView` from the event module.

Keep `InMemoryRunPersistence` as a persistence adapter with the same JSON serialization and timestamp-spread behavior as `FileRunPersistence`.

Its `appendEvent()` should accept the open event view. Its seed methods must continue accepting arbitrary historical and unknown records so recovery tests can represent external data.

Do not add reduction or event factories to the adapter.

### 7. Update `lib/commands.ts` and raw event consumers

Keep `commands.ts` behavior unchanged and continue receiving `WorkflowRunEventView` through the exported Workflow run module interface.

Verify `/workflows raw <run-id>` still:

- returns every event in stored order after the existing `cloneJson(log.events)` step;
- uses `JSON.stringify(event)` without further normalization;
- returns unknown fields, subject to the existing JSON clone's value semantics;
- returns an empty notification body for an existing empty log;
- reports a missing event log through the existing not-found path.

### 8. Update `CONTEXT.md`

Replace the current Workflow run state sentence with explicit ownership for the deepened module. Keep the recorded persistence and lifecycle decisions.

Add wording equivalent to:

> **Workflow run event module**: the pure in-process module in `workflows-engine/lib/workflow-run-events.ts` that owns the engine event vocabulary, compatibility interpretation, live reduction, and durable replay behind a typed write interface and an open durable-read interface. Unknown events remain replayable no-ops after `run_created`; legacy Workflow and usage aliases remain event interpretation. The Workflow run lifecycle retains append, reduction, and projection ordering. Run persistence owns file I/O, JSONL record-shape checks, and path safety, but not event interpretation.

Update the Workflow run persistence entry, which currently names `workflow-run-state.ts` as the reducer owner.

No ADR is needed. This refactor follows, rather than reverses, the existing recorded ownership.

### 9. Update `workflows-engine/README.md`

Keep the run directory and canonical-log sections. Add one concise implementation note near the `events.jsonl` paragraph:

- engine writes use a closed event vocabulary;
- durable reads remain open for forward compatibility;
- unknown events are visible in raw output and do not change known state after creation.

Do not turn the README into an event schema reference. The event payload map in code is authoritative.

## Test plan

### A. Add `lib/workflow-run-events.test.ts`

This becomes the event module's main test surface.

#### Creation and ordering

- `run_created` builds the full initial state from current fields, including optional source snapshot and edit capability.
- The event timestamp becomes `startedAt` and `updatedAt`.
- A second `run_created` later in the log resets all accumulated state and starts from the second record.
- Assert object identity: creation returns a new state and does not mutate a prior state object, while each noncreation event mutates and returns the supplied state.
- With mocked time, assert creation's existing `initialState()` clock call even when `event.ts` is explicit, and both clock calls when the timestamp is falsey.
- A noncreation event before `run_created` throws the exact existing message.
- Unknown and empty-string event names before `run_created` throw with the supplied type in that message.
- Replay applies events in input order; order-sensitive pairs include start/completion, invalidation/completion, and completion/failure.
- Replay of an empty array throws `Workflow event log is empty`.

#### Run and phase transitions

Cover started, pausing, paused, resumed, completed, failed, and stopped status effects. Assert the fields each arm deliberately retains: start/resume retain result, completion retains an older error, pausing changes no terminal fields beyond status, and paused applies its distinct falsey-error rule.

Cover phase start, completion, and failure, including replacement of phase state, timestamps, fallback error text, and retention of `currentPhase` after completion or failure.

#### Step and dependency transitions

- `step_started` replaces prior step state while storing dependencies and metadata unchanged.
- Dependency edge targets are deduplicated without normalizing the stored `dependsOn` array. Re-starting one key with new dependencies leaves its old reverse edges in place.
- Missing/falsey `dependsOn` adds no edges, a string iterates by character, and a truthy non-iterable throws.
- `step_completed` replaces all prior step fields with status/result/time and removes every matching key from `invalidatedKeys`.
- `step_failed` retains prior fields and creates a minimal failed step when no prior step exists.
- `step_reused` updates only an existing step; an absent target still advances global time.
- Both invalidation names add an absent target key once, deduplicate repeated invalidation, and mark matching steps and agents without changing target timestamps.
- Re-completion clears step or agent invalidation; step/agent failure does not.

#### Agent transitions and usage

- `agent_started` increments `agentsStarted` and `agentsRunning`.
- Progress and tool events ignore an unknown agent except for global time.
- Raw progress appends for a known agent and retains only the last 50 records; cover exactly 50 and 51 records.
- Tool progress stores `{ type: "tool", tool, args }` and ignores the durable diagnostic `event` field during reduction.
- Repeated start for the same key still replaces the agent and increments started/running each time.
- Completion decrements running without going negative, increments completed, stores result/raw, clears invalidation, and creates a minimal agent when absent. Repeated completion increments again and preserves stale prior fields such as an error.
- Failure decrements running without going negative, increments failed, maps truthy `stopped` to stopped, and creates a minimal agent when absent. Repeated failure increments again and preserves stale prior fields such as result/raw.
- Reuse updates only an existing agent and ignores its diagnostic `agent` field during reduction.
- Current usage names accumulate correctly.
- Legacy usage names accumulate to the same state.
- Multiple completions accumulate usage and update total tokens and cost.

#### Parallel, artifact, and log transitions

- Parallel start replaces prior state. Completion and failure merge existing state, including stale fields, and also create state when no start exists.
- Duplicate artifact paths are stored once after unconditional string conversion.
- Logs preserve details and effective timestamp; falsey messages become `""`.

#### Compatibility

- `run_created.workflow` works when `workflowName` is absent or falsey, and a truthy `workflowName` wins when both names exist.
- Characterize every `run_created` fallback and pass-through listed in Final design decision 5, including missing values, falsey current values, and invalid trust reaching later projection validation.
- Current usage fields keep their truthiness fallback to legacy usage fields, including current zero with truthy legacy data. Cover missing, falsey primitive, truthy primitive, and array `usage` values as well as current-only, legacy-only, mixed, numeric strings, negative values, and truthy nonnumeric fields.
- Unknown and empty-string event names after creation do not change known state except `updatedAt`; unknown fields on known and unknown events do not cause rejection.
- Characterize unconditional String conversion with missing values and truthiness-based String fallback with `undefined`, `null`, `false`, `0`, and `""`. Cover `run_paused.error` separately because it becomes absent rather than fallback text.
- Characterize timestamps with an omitted value, each JSON falsey value (`null`, `0`, `false`, `""`), a numeric string, a negative number, and a truthy nonnumeric string. Inject or mock `Date.now()` so falsey cases are deterministic. Assert that pure reduction can contain `NaN` while recovery rejects it during projection validation.
- Characterize parallel count/concurrency conversion with zero, numeric strings, negative numbers, and truthy nonnumeric strings.
- Characterize unchecked pass-through fields with representative noncanonical durable data. The event module must neither clone nor normalize those values.

#### Compile-time write vocabulary

Add type assertions in the test file or a small compile-only block using `satisfies KnownWorkflowRunEvent` and `// @ts-expect-error`.

Prove that:

- the mapped union contains all 28 valid event names and representative run, step, agent, and no-payload literals accept their required payloads;
- an unknown engine event name is rejected;
- a required field omission is rejected;
- a phase field cannot be attached to a step event;
- no-payload events reject accidental payload fields;
- optional fields remain optional;
- `WorkflowRunEventView` still accepts unknown durable event names and fields.

Do not add one compile assertion per trivial field. The private payload map is the exhaustive 28-name inventory; representative positive and negative assertions prove the mapped-union mechanics, while runtime reducer tests provide the behavior matrix.

### B. Refocus `lib/workflow-run.test.ts`

Keep lifecycle and integration tests. They verify behavior that the pure event module cannot:

- event append order produced by real workflow execution;
- durable reuse and restart;
- append failure does not advance state;
- projection failure leaves canonical events recoverable;
- terminal attempts suppress late writes;
- parallel admission limits;
- pause, stop, and resume behavior;
- Subagent progress mapping;
- worktree cleanup and projection fallback.

Remove direct reducer setup from this file where it only exists to build fixture state. Prefer one of:

- `rebuildWorkflowRunState()` with an explicit fixture log;
- `InMemoryRunPersistence.seedProjection()` with a validated fixture;
- focused event-module helpers local to the test.

For the projection-fallback worktree cleanup test, use the new event module name rather than importing `applyEvent()` from the state module.

Add an instrumented persistence test for both creation and an ordinary `recordOnQueue()` event. For each event, assert `appendEvent` precedes `writeProjection` and inspect the projection argument to prove reduction occurred between those calls. Keep the existing late-write test as the proof of terminal-attempt suppression.

The existing append-failure test covers creation only. Keep it and add an ordinary-event append failure test that proves neither private state nor projection advances. Strengthen projection-failure coverage so an ordinary event's failed projection remains recoverable from its appended canonical event; initialization-only failure is not enough.

### C. Keep and update `lib/workflow-run-recovery.test.ts`

Change imports and helper names from `rebuildState()` to `rebuildWorkflowRunState()`.

Keep all canonical-source tests:

- event log wins over conflicting projection;
- missing event log permits projection fallback;
- missing both reports stable not-found details;
- existing empty log is authoritative;
- reducer failures do not fall back;
- run-id mismatch does not fall back;
- projection repair is best-effort;
- malformed JSONL does not fall back;
- whitespace-only JSONL is existing-empty;
- projection validation failures propagate;
- compatibility error exports remain identical.

Add an event-log recovery case with an unknown event after `run_created`. Assert recovery succeeds, the unknown event advances `updatedAt`, unknown fields do not enter projected state, and projection repair writes the rebuilt state.

Add one file-backed recovery case that crosses JSONL parsing with legacy `workflow` and legacy usage aliases. Also add a truthy nonnumeric timestamp case and assert recovery rejects it through projection validation without consulting fallback state. Focused event tests alone do not cover these adapter/recovery seams.

### D. Keep `lib/run-store.test.ts` adapter-focused

Update imports through `run-store.ts` as needed, but do not move event semantics into this suite.

Add focused read tests for the external-data seam:

- table-test `null`, arrays, strings, numbers, and booleans as invalid top-level records, with file and line in every error;
- reject objects with missing, `null`, numeric, boolean, array, or object `type` values;
- accept an empty-string `type`, because the current check requires only a string;
- accept an unknown type with nested unknown fields unchanged;
- preserve supplied timestamp values unchanged, including zero and a numeric string.

Keep existing layout, missing-versus-empty, artifact, and run-id tests.

### E. Update `tests/runtime.test.mjs`

Import the new event module and replace the `readPersistedState()` replay call with `runEvents.rebuildWorkflowRunState()`.

Keep the Node integration suite. It covers plain Node loading, bundled workflows, registered Subagent behavior, durable resume, worktree artifacts, and the real file adapter in combinations not duplicated by focused Vitest tests.

Delete `TestStore` and its two reducer-heavy tests. That helper reimplements initialize/append/replay/projection behavior outside production, and the two tests duplicate the new event matrix plus existing file-adapter and real-lifecycle coverage. Other Node tests already exercise file-backed replay through `createWorkflowRun()`. Keep `readPersistedState()` and `readPersistedEvents()` as read-only integration helpers, importing replay from the event module.

### F. Commands tests

Current command coverage checks only the missing raw-log path. Add a raw-log success case with two records, an unknown type, nested unknown fields, and deliberate field order. Assert the exact newline-joined `JSON.stringify` output and stored order. Add an existing-empty case and assert the info notification body is exactly `""`.

In `workflow-run.test.ts`, characterize the production raw-read clone once with a file-backed log containing unknown fields whose JSON values include `-0` and `1e400`. Assert `workflowRunModule.readEvents()` retains the fields and order but returns zero and `null`, respectively. This prevents the refactor from accidentally promising or introducing byte-preserving raw reads.

### G. Update the Workflow test script

Add `extensions/workflows-engine/lib/workflow-run-events.test.ts` to the explicit Vitest file list in `.pi/package.json` under `test:workflows`. Keep the Node test glob unchanged.

This makes `pnpm test:workflows` include the new event module test rather than relying only on the separate focused command.

## Implementation sequence

Implement this as one coherent refactor, with checks after each stable step.

1. Add `workflow-run-events.ts` with moved reducer behavior, the open durable-read view, and the closed engine-write union.
2. Add `workflow-run-events.test.ts` by moving reducer expectations from broad integration fixtures where appropriate and adding compatibility and compile-time coverage.
3. Update `workflow-run-recovery.ts` and its tests to replay through the new module.
4. Update `run-store.ts` and `test-support.ts` to import the open view from the new module.
5. Update `workflow-run.ts` to type ordinary writes with the closed union and reduce through the new module while preserving ordering.
6. Update Workflow run lifecycle tests and add the missing raw-command success/empty coverage.
7. Update the Node integration suite import, delete `TestStore` and its duplicate reducer tests, and keep the real end-to-end coverage.
8. Remove event exports and implementation from `workflow-run-state.ts` once `rg` shows no callers.
9. Update `CONTEXT.md` and the Workflow engine README.
10. Add the new event test file to `.pi/package.json`'s `test:workflows` Vitest list.
11. Run focused tests, typechecking, then the broader Workflow suite.

Do not leave temporary compatibility aliases in `workflow-run-state.ts`. The repository-wide caller audit found no consumer outside the mapped Workflow engine files, so all callers move atomically.

## Verification commands

Run from `.pi/` unless noted.

### Static caller audit

```bash
rg -n 'WorkflowRunEventView|WorkflowRunEventToPersist|KnownWorkflowRunEvent|applyEvent|rebuildState|applyWorkflowRunEvent|rebuildWorkflowRunState' extensions/workflows-engine
```

Expected result:

- event types and reducer functions originate in `workflow-run-events.ts`;
- `workflow-run-state.ts` has no event reducer implementation;
- ordinary `WorkflowRun` recording accepts `KnownWorkflowRunEvent`;
- persistence and raw readers use `WorkflowRunEventView`;
- no stale `WorkflowRunEventToPersist`, `applyEvent`, or `rebuildState` definitions, imports, or calls remain.

### Focused tests

```bash
pnpm exec vitest run \
  extensions/workflows-engine/lib/workflow-run-events.test.ts \
  extensions/workflows-engine/lib/run-store.test.ts \
  extensions/workflows-engine/lib/workflow-run-recovery.test.ts \
  extensions/workflows-engine/lib/workflow-run.test.ts \
  extensions/workflows-engine/lib/commands.test.ts
```

### Typecheck

```bash
pnpm typecheck
```

The typecheck is required because the main benefit includes compile-time rejection of malformed engine-owned event literals.

### Workflow integration suite

```bash
pnpm test:workflows
```

This runs both the selected Vitest files and `node --test extensions/workflows-engine/tests/*.test.mjs` through the repository script.

The verified caller set is confined to `workflows-engine`. `pnpm test:workflows` plus `pnpm typecheck` is the required broad check; the full repository suite is not required for this internal refactor.

## Risks and mitigations

### Persisted event drift

Risk: typed event construction or reducer movement accidentally changes field names, omitted fields, or timestamps.

Mitigation:

- keep inline event literals and the existing clone/stamp logic;
- add exact raw event assertions around representative lifecycle flows;
- retain file adapter timestamp tests;
- do not add an envelope or normalization write step.

### Compatibility rejection

Risk: the moved reducer becomes stricter than the current reducer and rejects old logs.

Mitigation:

- preserve the characterized legacy aliases and coercions listed in Final design decision 5;
- accept open durable views;
- preserve unknown-event behavior;
- keep strict shape validation limited to materialized projections, as today.

### Import cycle

Risk: event payload types import runtime values from state or registry and create a cycle.

Mitigation:

- use type-only imports for payload vocabulary;
- keep `workflow-run-state.ts` independent of the event module;
- let the event module depend one way on state types and `initialState()`;
- run the Node integration suite to prove the new import graph loads.

### False type safety at the adapter seam

Risk: making `RunPersistence.appendEvent()` accept only known events suggests that historical and future records cannot pass through it.

Mitigation:

- keep persistence on `WorkflowRunEventView`;
- apply `KnownWorkflowRunEvent` only to lifecycle production methods;
- keep seed helpers open.

### Overgrown interface

Risk: one constructor or method per event makes the event module shallow.

Mitigation:

- export a discriminated union and two reduction functions;
- keep reducer helpers private;
- add no registry or factory object.

### Test duplication

Risk: exhaustive reducer tests are copied into lifecycle, recovery, file adapter, and Node suites.

Mitigation:

- event tests own transition semantics;
- lifecycle tests own ordering and control policy;
- recovery tests own source precedence;
- adapter tests own JSONL parsing and paths;
- Node tests retain representative end-to-end behavior.

## Non-goals

This plan does not:

- change Workflow behavior;
- migrate or rewrite existing run directories;
- validate every known payload at JSONL parse time;
- add event schema versions;
- add cross-process locking;
- make projection writes canonical;
- change state mutation to immutable transitions;
- redesign `RunState` or command detail views;
- merge Workflow worktree policies with `tools-worktree`;
- change Subagent progress meaning;
- introduce extensible event registration;
- move queue, persistence, or recovery policy into the event module.

## Acceptance criteria

The work is complete when all of the following hold:

1. `.pi/extensions/workflows-engine/lib/workflow-run-events.ts` is the single owner of Workflow run event vocabulary, compatibility interpretation, live reduction, and replay.
2. `WorkflowRun` engine-owned event writes are compile-checked through `KnownWorkflowRunEvent`.
3. File and in-memory persistence continue accepting open `WorkflowRunEventView` records.
4. Existing `events.jsonl` records replay without migration.
5. Unknown event names and fields remain present through the existing JSON-cloned raw read and replay as no-ops after `run_created`.
6. Legacy `workflow` and usage aliases produce the same materialized state as before.
7. `WorkflowRun.recordOnQueue()` still owns and preserves append, reduction, terminal bookkeeping, and best-effort projection ordering.
8. Recovery behavior, error identity, and fallback rules do not change.
9. `workflow-run-state.ts` no longer carries event vocabulary or reducer implementation.
10. Focused event, lifecycle, recovery, adapter, commands, and Node integration tests pass.
11. `pnpm typecheck` passes and includes compile-time malformed-event assertions.
12. `CONTEXT.md` and the Workflow engine README describe the final ownership accurately.
