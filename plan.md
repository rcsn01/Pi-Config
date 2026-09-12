# Implementation plan: deepen the workflow run module

## Status

Ready for implementation. This plan records the recommended decisions for option 1, so implementation can proceed without another clarification round.

Planning baseline:

- Checkout: `af47494` (`HEAD` at review time)
- Scope: `.pi/extensions/workflows-engine/`, `.pi/package.json`, `.pi/extensions/workflows-engine/README.md`, and `CONTEXT.md`
- Baseline typecheck: `pnpm --dir .pi typecheck` passes
- Baseline workflow tests: `pnpm --dir .pi test:workflows` passes, 7 Vitest tests and 17 Node tests, 24 tests total
- Existing command surface and persisted run files are compatibility requirements
- The current state root comes from `projectStatePath()`: `PI_CONFIG_STATE_DIR` when set, otherwise the home-state directory. It is not normally `.pi/workflow-runs/` under the checkout.

## Objective

Make one deep workflow run module the sole owner of a run's lifecycle and persisted writes. Keep the public `WorkflowContext` used by workflow authors stable, keep the JSONL and materialized-state formats stable, and make Pi commands adapters over a small run interface instead of readers and writers of raw `RunState`.

The target is depth at the run interface. A caller can start, resume, pause, stop, restart, and inspect a run without knowing how events reduce into state, how files are written, how progress is capped, how durable keys are reused, or how worktree results are nested inside an agent result. That gives callers leverage and gives lifecycle changes locality.

## Recommended decisions applied

| Decision | Recommended answer | Consequence |
| --- | --- | --- |
| Scope | Refactor ownership while preserving the command and persistence contracts. | Keep command names, workflow authoring, event names, run-directory layout, and result shapes compatible. The intentional observable changes are exactly seven: (1) lease rejection of a second active operation, together with serialized `maxAgents` admission that can no longer oversubscribe; (2) shutdown stop-and-wait instead of a command-level `run_stopped` append; (3) command pause/stop reaching the run control path, which now writes `run_pausing`, checks pause/stop immediately before `run_completed`, and drops post-terminal writes from a settled attempt; (4) run-id, path, worktree-id, and result-shape validation; (5) `/workflows raw` reporting a missing log as not-found instead of empty output; (6) `/workflow source` falling back to the registry only on not-found; (7) a cache-affinity seed captured once per run instead of read per agent. |
| Deep module | Add a `WorkflowRun` facade for one run. | It owns lifecycle transitions, event creation, state projection, control, durable keys, execution, and typed read views. |
| External interface | Expose a run handle plus read queries. | Commands use `execute`, `restart`, `requestPause`, `requestStop`, `inspect`, `list`, and `readEvents`. Descendant invalidation is reachable only inside `restart()`, so no caller mutates raw state. |
| Persistence | Put one internal persistence seam behind the facade. | Production uses a file adapter; tests use an in-memory adapter. The adapter does I/O only, while the run facade reduces events and owns lifecycle policy. |
| State | Keep the event log canonical and the state file a materialized projection. | Existing event ordering and recovery semantics remain valid. The reducer moves behind the run facade. |
| Control | The run handle owns pause and stop control. | Commands send requests; they do not append lifecycle events themselves. |
| Concurrency | One coordinator, keyed by canonical run storage root, owns the active lease and write queue for a run. | A concurrent resume or restart is rejected rather than producing competing in-process writers. |
| Restart | Make invalidation plus replay one handle operation. | `/workflow restart` cannot release the run lease between descendant invalidation and `execute`. |
| Worktrees | Preserve the workflow runner's distinct worktree policy. | Do not merge it with `tools-worktree`. Continue using the existing Git executor and worktree artifact module. |
| Subagents | Keep the existing Subagent execution seam. | The production composition adapter delegates to the registered Subagent execution module; tests inject a fake runner. |
| Replay | Do not change bundled replay semantics. | Project workflows still replay from their source snapshot. Bundled workflows still use the current bundled definition. |
| Testing | Replace direct state/store tests with tests through the deep interface, retaining file and end-to-end coverage. | The interface becomes the test surface; shallow implementation tests are removed once their behavior has coverage. |
| Documentation | Update `CONTEXT.md` when the implementation lands. | Record the new Workflow run lifecycle module and its seam without changing it during this planning task. |
| Read-path reads | Route `inspect`, `list`, and `readEvents` through the same per-run queue as writes. | A reader can no longer see a partial JSONL line or overwrite a newer `state.json` with an older rebuild. |

## Current architecture and evidence

### The run concept is split across three files

- `lib/runner.ts:117-385` contains `WorkflowRun`, mutable run state, execution, phases, durable steps, agents, parallel work, artifacts, progress, budgets, status output, and workflow-specific worktree creation. Its `pi` field is unused. Its `requestPause()` method exists, but the command adapter does not call it.
- `lib/run-store.ts:19-51` defines a broad `RunState`; `:156-310` reduces every event into that state; `:332-406` appends JSONL, rebuilds state, writes `state.json`, and serializes writes only per `RunStore` instance. `appendRunEvent()` and `readRunState()` bypass that instance queue, and `invalidateKeyAndDependents()` creates a new `RunStore` for each invalidation event.
- `lib/commands.ts:53-87` owns execution reporting and background state; `:89-121` controls active runs; `:136-176` reads nested worktree data with `any`; `:195-272` reads raw state, appends a shutdown event outside the active store, performs invalidation outside the running handle, and formats command output.
- `lib/ui.ts:51-88` formats the raw `RunState` directly.

The result is a shallow seam. The command adapter must know the event store, the full state shape, the event-log path, the source-snapshot path, and the location of worktree information inside arbitrary agent results. The implementation's lifecycle knowledge is spread across callers instead of concentrated behind one interface. The new seam must also correct the path and competing-writer hazards rather than merely move them.

### Important existing behavior to preserve

The current runtime tests in `tests/runtime.test.mjs` are the characterization suite:

- Definition normalization and registry trust handling at lines 161-254.
- Event projection, progress retention, dependency recording, invalidation, and artifact path safety at lines 256-308.
- Resume and durable-key reuse at lines 310-343.
- Abort and stopped-state handling at lines 345-385.
- Subagent task mapping, progress events, preflight failure, authoritative failed status, and abort classification at lines 387-589.
- Bundled workflow execution and artifact output at lines 591-651.
- Worktree creation, normalization, reuse, preservation metadata, patch collection, and applicability at lines 653-750.

The refactor must preserve these facts, including the boundary cases that the current code actually implements:

1. `prepareNewWorkflowRun()` writes a source snapshot before importing a project workflow. It writes the new run's `input.json` and then `run_created`, after import succeeds. Bundled runs also receive a snapshot file, although resume uses the bundled definition rather than importing that snapshot.
2. `events.jsonl` is append-only. `state.json` is a materialized projection written through a temporary file and rename. If an event file exists, it is authoritative; an existing but empty event file is an error rather than a projection fallback. The default storage root is the external project-state directory described above.
3. The current `RunStore` queue serializes calls made through one instance only. Progress events from one `WorkflowRun` can interleave across agents, but direct `appendRunEvent()` calls and different `RunStore` instances can race. The new coordinator must provide the stronger one-queue guarantee for all facade writes.
4. `step` and `agent` reuse only a record whose status is `completed` and whose key is not in `invalidatedKeys`. `step_reused` and `agent_reused` update the record timestamp but do not change its status to `reused`.
5. Dependency edges are recorded only when `step_started` or `agent_started` events carry `dependsOn`. Missing dependency records are accepted, duplicate edges are deduplicated, and invalidation walks the recorded graph breadth-first with one event per visited key per invalidation operation. Cycles must terminate through the existing visited set.
6. Worktree target preparation occurs before `agent_started`. A target-preparation failure therefore produces neither `agent_started` nor `agent_failed`; once `agent_started` is appended, a Subagent preflight or execution rejection enters the catch path and produces `agent_failed`.
7. The current `maxAgents` check runs before waiting for the semaphore, so concurrent callers can pass a stale `agentsStarted` count. The refactor must make the check and admission reservation one serialized operation without changing the total-attempt meaning of `agentsStarted`.
8. A child result with authoritative `progress.status === "failed"` fails the workflow even if its process exit code is zero. Success must not be inferred from exit code or error text.
9. The materialized `agent.progress` array retains only its latest 50 entries per agent. The raw event log retains every progress event. `tool_call` becomes `agent_tool`; every other Subagent progress event is recorded as `agent_progress` with the current event payload.
10. `ctx.agent({ output: "json" })` retains the current parser order: direct JSON, an optional-json fenced block, then the first-to-last object span, then the first-to-last array span. Invalid or empty output still throws `Agent did not return valid JSON`.
11. Stop and pause classification wins over generic failure in the execution catch path. `pause-now` remains replayable, and completed durable results remain available. A pause-after-current request is observed only at the existing scheduling boundaries: before a phase, step, agent, or parallel block, and at each parallel-worker iteration. If the workflow returns without another boundary, the current implementation completes normally.
12. Workflow worktree ids are lowercased, invalid runs are replaced with `-`, leading/trailing hyphens are trimmed, and the result is capped at 80 characters. Existing paths are reused based on the current existence check, and `preserve` and `fileOwnership` metadata are retained. The refactor must additionally reject normalized `.`/`..` and `.lock` forms and prove the resolved path stays under the managed directory; this closes a path escape without merging the workflow policy with `tools-worktree`.
13. Worktree patches and summaries are written through `worktree-artifacts.ts` and the run artifact writer before `agent_completed`. No worktree is silently integrated into the main checkout. A clean worktree still receives a JSON summary but no patch artifact.
14. The current `RunState.tokens` calculation is `usage.inputTokens + usage.outputTokens`; cache counts, turns, and progress-message token fields do not contribute. Preserve this calculation and all serialized event/state field names, including the current usage aliases and counter behavior.
15. Project workflows replay from the approved source snapshot. Bundled workflows use the current bundled definition on resume, but `prepareExistingWorkflowRun()` currently requires a non-empty `sourceSnapshotPath` for both trust modes before it reaches either loading path. Preserve that guard.
16. `parallel()` records `parallel_started` before workers and either records `parallel_completed` or `parallel_failed`. With `stopOnError: false`, a worker error becomes a result object and the block completes; with the default fail-fast behavior, already-running workers are not cancelled and the first observed error is rethrown.
17. The command adapter currently trusts a caller-supplied run id in `runPaths()`, a persisted source-snapshot path, a persisted patch path, and the nested agent result. The facade must validate run ids and all paths it returns to commands. It must expose worktree metadata only when the run recorded a worktree for that agent, so an ordinary JSON agent result cannot manufacture an integration artifact.
18. `listRunStates()` reads every run directory, silently drops any run whose read throws, and sorts by `updatedAt` descending; `formatRunList` then shows the first 30. `list()` must keep all three behaviors, so one malformed run directory cannot break `/workflows`.
19. `runAndReport` currently classifies a rejected execution into three notifications by reading the shared `control.pauseMode` and `controller.signal.aborted`: `Workflow paused: <name>`, `Workflow stopped: <name>`, and `Workflow failed: <message>`. Both of those inputs disappear with the handle refactor, so the handle must supply the replacement classification (see the command adapter section).
20. Two read commands are looser than their messages suggest. `/workflows raw <run-id>` on a run with no event file currently notifies an empty string at `info` rather than the adjacent not-found message, because `readEvents()` returns `[]` for a missing file. `/workflow source <run-id>` wraps both the state read and the snapshot `readFile` in one `try`, so an unreadable snapshot also falls through to the live registry lookup. The facade narrows both to not-found only; these are the two read-path behavior changes recorded in the decisions table.

## Target architecture

### The deep module

Add `lib/workflow-run.ts`. It is the external seam for one prepared workflow run and the only per-run lifecycle writer. Its implementation contains private helpers for state reduction, control, persistence, worktree policy, and agent execution. Those internal seams must not leak into commands or workflow definitions.

The module owns:

- The current private `RunState`.
- Creation, start, resume, completion, pause, failure, and stopped transitions.
- The `WorkflowContext` passed to workflow definitions.
- Phase, step, agent, parallel, artifact, and log operations.
- Durable-key reuse and invalidation.
- Dependency graph updates.
- Agent admission and budget checks.
- Event construction and ordered persistence.
- Materialized-state projection and recovery after a projection write failure.
- Run-level pause and stop control.
- Typed read models for commands and text formatting.
- Extraction and validation of worktree artifact metadata from agent results.
- The workflow-specific worktree policy currently implemented by `prepareAgentTarget`.

It does not own:

- Workflow discovery, approval, source loading, or source snapshots.
- Pi command parsing, prompts, notifications, or transcript rendering.
- The Subagent execution implementation.
- The Git executor implementation.
- Applying a patch to the main checkout or removing a worktree from a command.

Those remain adapters or existing deep modules at the appropriate seam.

### Recommended external interface

The run module is constructed with the prepared definition, a `RunPersistence`, the parent signal, the captured cache-affinity seed, the status callback, and the Subagent callback. Its read methods take `cwd` and `runId`; a command service binds those methods to a project. Creation is asynchronous because a new handle must finish the `input.json` and `run_created` writes, and a resumed handle must load or rebuild its state before it is returned.

```ts
type WorkflowPauseMode = "after-current" | "now";

interface WorkflowRunHandle<TResult = unknown> {
  readonly runId: string;
  execute(): Promise<TResult>;
  restart(key: string): Promise<TResult>;
  requestPause(mode?: WorkflowPauseMode): Promise<void>;
  requestStop(reason?: string): void;
  inspect(): Promise<WorkflowRunDetail>;
}

interface WorkflowRunModule {
  create(options: PreparedWorkflowRunOptions): Promise<WorkflowRunHandle>;
  inspect(cwd: string, runId: string): Promise<WorkflowRunDetail>;
  list(cwd: string): Promise<readonly WorkflowRunSummary[]>;
  readEvents(cwd: string, runId: string): Promise<readonly WorkflowRunEventView[]>;
}
```

`PreparedWorkflowRunOptions` is the composition record enumerated in the `runner.ts` section below: normalized entry/definition, run id, resume mode, `cwd`, parent signal, captured cache-affinity seed, persistence adapter, Subagent callback, and status callback. Nothing else.

`create()` performs new-run initialization when `resume` is false and loads the existing event log or projection when `resume` is true. It returns a handle that has not started workflow execution. `execute()` is single-flight: the first call owns the execution attempt, and every later `execute()` call, including calls after settlement, returns the same promise. It never appends a second start event. The first operation is either `execute()` or `restart()`; later calls return that cached promise, while a restart request made after an ordinary execution has started is rejected. A resumed handle is used for `restart()` before its first execution attempt.

`restart(key)` is the atomic command operation. It acquires the run lease, reloads current state, invalidates the key and its recorded descendants through the run queue, then resumes execution without releasing the lease between those steps. A second handle cannot mutate the same canonical run root while it is active. This removes the race in today's separate `invalidateKeyAndDependents()` call followed by a fresh `prepareExistingWorkflowRun()` and execute. Descendant invalidation has no other entry point: it is a private step of `restart()`, not a public handle method, because after this refactor no command invalidates without replaying. It keeps the current `Durable key not found in run <runId>: <key>` error when the key exists in neither `steps` nor `agents`, and it raises that error before appending any event or `run_resumed`.

`requestPause()` is valid for an active or about-to-start execution and resolves after its request event is queued. An identical pending request is a no-op; `now` upgrades a pending `after-current` request by queuing one new `run_pausing` event with the stronger mode, then aborts the owned signal. The execution catch path writes `run_paused`; `requestPause("now")` does not throw the execution's abort error itself. Requests after terminal settlement are no-ops and never append after a terminal event. `requestStop()` records no separate request event, stores the supplied reason, and aborts the owned signal; the execution catch path writes the one `run_stopped` event. If pause and stop are both pending, pause classification retains the current catch-path precedence.

`WorkflowRunDetail` and `WorkflowRunSummary` are read models, not aliases for mutable `RunState`. The summary model contains exactly what `formatRunList` reads: `runId`, `workflowName`, `status`, `currentPhase`, `error`, `startedAt`, `completedAt`, `agentsStarted`, `agentsCompleted`, `agentsFailed`, `tokens`, and `cost`. The detail model contains the current UI fields: run identity, workflow metadata needed for replay, trust, arguments, source hash, timestamps, status, current phase, counts, usage, token total, cost, error, result, source snapshot path, event-log path, phase/step/parallel/artifact views, and agent views. The agent view contains only status, name, error, and an optional `WorkflowWorktreeView`. Dependencies, logs, invalidation internals, raw child results, and the mutable state object stay private because no current command or formatter consumes them.

`WorkflowWorktreeView` contains the recorded worktree path and branch metadata, changed files and status, the original run-root-relative patch artifact path for display, and an absolute patch path after containment validation. It is returned only when the agent's `agent_started` record proves that the run created a worktree and the completed result carries the matching worktree summary. A clean worktree has no patch path but still has a view for cleanup. `eventLogPath` and `sourceSnapshotPath` are validated paths, not paths copied from arbitrary command input. The command adapter must never inspect `agent.result`, its nested `result.output.worktree`, or a mutable state record.

### Persistence seam

Refactor `lib/run-store.ts` into the production file adapter behind an internal persistence interface. The interface is used by `workflow-run.ts` and its tests, not by `commands.ts`.

The persistence interface must preserve the distinction between a missing event file and an existing empty event file:

```ts
interface RunPersistence {
  initializeInput(input: RunInput): Promise<void>;
  appendEvent(event: WorkflowRunEventToPersist): Promise<void>;
  readEventLog(): Promise<{ exists: boolean; events: readonly WorkflowRunEventView[] }>;
  readProjection(): Promise<unknown | undefined>;
  writeProjection(projection: unknown): Promise<void>;
  writeArtifact(requestedPath: string, data: string): Promise<string>;
  paths(): InternalRunPaths;
}
```

`writeArtifact()` accepts the same run-relative request accepted by `ctx.artifact()`, writes below the run's `artifacts` directory, and returns the current persisted path relative to the run root, such as `artifacts/diffs/edit.patch`. It takes an already-serialized string: the current `typeof data === "string" ? data : JSON.stringify(data, null, 2)` rule stays in the run module so artifact bytes are unchanged and the adapter stays I/O-only. It does not append `artifact_written`; the run's single event-recording method does that after the file write succeeds.

The implementation rules are:

- `FileRunPersistence` retains `projectStatePath`, the current run-directory layout, `input.json` contents, JSONL parsing, atomic `state.json` writes, and artifact path traversal protection. `initializeInput()` keeps the current `RunStore.initialize` side effect of creating the run's `artifacts/` directory before writing `input.json`, so a run with no artifacts still has the documented directory. Run ids are validated before they become path segments: they must be non-empty single path components, cannot be `.` or `..`, cannot contain `/` or `\\`, and their resolved run root must remain below the project-state root.
- When appending, the file adapter preserves the current serialized timestamp behavior: it writes `{ ts: Date.now(), ...event }`, so an explicitly supplied `ts` still wins. It preserves event field names and JSON serialization behavior.
- `InMemoryRunPersistence` lives in test support. It records the same JSON-shaped events and artifacts without filesystem I/O and has deterministic append and projection failure switches, including one-shot failures. It must emulate the file adapter's timestamp, missing-versus-empty log, and JSON round-trip semantics so it does not create a second behavior.
- The production adapter does not reduce events. It appends and reads durable data. The run module owns event reduction and decides when to rebuild from the event log.
- The run module keeps the commit ordering: append the event first, apply it to private state, then attempt the materialized projection. A failed append leaves private state unchanged. A successful append followed by a projection failure advances private state, marks the projection dirty, and does not append a compensating failure event. The durable event remains recoverable.
- On open, an existing non-empty event log is rebuilt and takes precedence over `state.json`. When the event file is missing, the materialized projection is read for compatibility with existing run directories. An existing empty event file remains an error when a run is expected to exist. A projection write failure while repairing a read is nonfatal to the rebuilt read model; the next write or open retries the repair.
- `paths()` is an internal dependency. Commands receive selected validated paths through read models, not the persistence object. Raw event reads are serialized through the same per-run coordinator so they cannot observe a partial append.

### State and event implementation

Add `lib/workflow-run-state.ts` as an internal implementation module. It is a private sibling of the deep run module, not a second external seam.

This module must contain:

- The current `RunStatus`, usage shape, private state shape, and event builders.
- Initial-state construction.
- The event reducer and full-log rebuild function.
- Read-model projection helpers that JSON-clone values before exposure. The in-memory adapter must use the same clone boundary as the file adapter.
- Runtime validation for the persisted projection, worktree artifact metadata, source-snapshot paths, event-log paths, and relative artifact paths.

The reducer must cover all 28 current persisted event types (8 run + 3 phase + 4 step + 6 agent + 3 parallel + `artifact_written` + `log` + 2 invalidation): `run_created`, `run_started`, `run_resumed`, `run_completed`, `run_pausing`, `run_paused`, `run_failed`, `run_stopped`, `phase_started`, `phase_completed`, `phase_failed`, `step_started`, `step_completed`, `step_failed`, `step_reused`, `agent_started`, `agent_progress`, `agent_tool`, `agent_completed`, `agent_failed`, `agent_reused`, `parallel_started`, `parallel_completed`, `parallel_failed`, `artifact_written`, `log`, `invalidated`, and `dependency_invalidated`. The `agent_progress` and `agent_tool` builders preserve the current mapping from Subagent progress events, which is asymmetric and easy to flatten by accident: a `tool_call` event becomes `agent_tool` carrying `{ key, event, tool, args }` and projects into the agent's progress array as `{ type: "tool", tool, args }`, while every other event becomes `agent_progress` carrying the same fields but projects the whole `event` object. Both projections are then truncated to the last 50 entries.

The event union used for append operations is private. The read-only raw-event view exposes the parsed `{ ts?: number; type: string; ... }` shape, but no caller can append an arbitrary lifecycle event. Serialized fields and event names stay compatible with existing JSONL. Unknown event types retain the current forward-compatible behavior of leaving known domain fields unchanged while applying the normal timestamp update, rather than rejecting a valid old log. Keep missing dependency records, duplicate-edge deduplication, breadth-first invalidation, counter accumulation, reuse timestamp updates, usage aliases, and `tokens = inputTokens + outputTokens` exactly as they are.

### Control and concurrency

The deep module must close the current competing-writer gap without pretending to solve cross-process locking.

1. Create one in-process coordinator registry keyed by the canonical run storage root, not by bare `runId`. Each coordinator owns the per-run `AsyncQueue` and the current handle owner. Every handle for the same project/run pair shares that coordinator, even if it has a separate `FileRunPersistence` instance. `AsyncQueue` is currently declared in `run-store.ts` and used only by `RunStore`; move it next to the coordinator rather than deleting it with `RunStore`.
2. `execute()` and `restart()` acquire the coordinator lease before reading mutable state or appending. A second handle attempting either operation receives a stable `RunAlreadyActiveError`. The lease is released in `finally`; `restart()` holds it through invalidation, `run_resumed`, execution, and terminal settlement.
3. `inspect()` returns a cloned private read model when the calling handle is the coordinator's current owner, and a module-level `inspect(cwd, runId)` for a run that has an owner is answered from that owner's private state for the same reason. With no owner, inspect rebuilds from a queued event-log read and then rewrites `state.json` in that same queued operation, exactly as `readRunState()` does today; no staleness comparison is needed, and a rewrite failure is nonfatal. Running the read and the repair inside one queued operation is what stops a reader from overwriting a newer projection with an older rebuild. `readEvents()` is also queued per run; a missing event log raises the typed not-found error, while an existing empty log returns an empty raw view. `list(cwd)` performs the same queued per-run read for each run directory and keeps the current drop-on-error and `updatedAt`-descending behavior. This prevents inspection, `/workflows`, and `/workflows raw` from racing a file append or seeing a partial JSONL line.
4. All event writes, including agent progress, pause requests, stop classification, shutdown handling, artifact records, and descendant invalidation, pass through the coordinator queue. No command or helper calls the file adapter's append method directly.
5. Acquire a scheduler slot first, keep the existing in-slot pause/abort boundary immediately after acquisition, then perform the `maxAgents` check and worktree target preparation in one serialized admission operation. The check runs before target creation so a rejected attempt creates no worktree. A successful target preparation is followed immediately by `agent_started`; a target-preparation failure still produces neither start nor failed event, as it does today. Once `agent_started` is durable, every Subagent rejection enters the agent catch path and produces `agent_failed`. The event log must contain no more admitted attempts than `maxAgents`, including retries after invalidation.
6. Keep `maxTokens` as a post-usage guard and preserve the current error wording. Usage is added on `agent_completed`; a completion that crosses the limit therefore retains the current `agent_completed` followed by `agent_failed` sequence, while a progress callback that crosses it fails before completion.
7. `requestPause("after-current")` queues one `run_pausing` event. The next existing scheduling boundary queues `run_paused` and unwinds. `requestPause("now")` queues `run_pausing`, then aborts the owned signal and classifies the run as paused. The execution path checks pause/stop state immediately before `run_completed`, so a child or workflow that ignores abort cannot turn an already-requested immediate pause into completion. A pause-after-current request still completes if the workflow returns without another scheduling boundary.
8. `requestStop(reason)` aborts the owned signal and records the supplied reason for the catch path. The catch path writes `run_stopped` once; for an unrequested `AbortError` or an aborted parent signal without a supplied reason it keeps `Workflow stopped by abort signal`. Commands never append `run_stopped`.
9. Link the parent Pi signal to the run-owned signal and remove the listener when the handle settles. `session_shutdown` calls `requestStop("Pi session shut down")` on each active handle and waits for every recorded execution promise with `Promise.allSettled()` before returning. A stop request after the workflow has already reached terminal settlement is a no-op, so shutdown cannot append a duplicate terminal event.
10. Within one execution attempt, the terminal event is last until an atomic restart begins the next attempt. The Subagent contract says progress callbacks are awaited, and `parallel()` awaits every worker before it settles, so the ordinary paths already respect this. The gate covers the paths that do not: an agent the workflow launched without awaiting, and a child that keeps emitting after the run's catch path has written `run_stopped`. Gate every queued write on the attempt that opened it, not only progress callbacks — once an attempt has appended its terminal event, any further write from that attempt is dropped, and the check happens inside the queued operation so it cannot be read stale. A new attempt started by `restart()` clears the gate, which is why `restart()` may append `invalidated` and `run_resumed` after a terminal event.
11. A failed event append does not mutate private state. A successful append followed by a projection failure leaves the event durable, advances private state, marks the projection dirty, and lets the next open rebuild from JSONL. Do not append a compensating failure merely because the projection write failed.
12. Validate every run id before path composition. Validate source snapshots and artifact paths as regular files below the run root, resolve existing paths before containment checks so symlinks cannot escape their root, require integration patches below `artifacts`, and validate recorded workflow worktree directories below the project managed-worktree directory before exposing them to commands.

The coordinator and lease are in-process only. Two Pi processes writing the same run directory remain unsupported and must be documented as such; do not imply that a TypeScript map is a cross-process lock.

### Worktree policy and existing deep modules

Keep the workflow-specific policy separate from `tools-worktree` exactly as `CONTEXT.md` requires:

- Generated ids use `workflow-<runId>-<key>` and the existing normalization rules.
- Caller-supplied ids are normalized rather than rejected solely for punctuation.
- After normalization, reject empty, `.`/`..`, `.lock`-suffixed, or otherwise unsafe results, resolve an existing target before containment checking, and assert that the target stays below `<cwd>/.pi/worktrees`. This is a path-safety correction, not a merge of the two policies.
- Existing paths below the managed directory are reused for replay without invoking `worktree add`; the existing path must be a directory, and the workflow retains this reuse behavior rather than adopting the public tool's refusal policy.
- `preserve` and `fileOwnership` metadata survive in the result.
- The workflow path remains relative to the workflow command's `cwd`, under `.pi/worktrees/`, with a `fleet/` branch. Do not silently switch it to the repository-root behavior of `tools-worktree`.

Keep the policy as a private helper in `workflow-run.ts`. Do not add a public worktree-policy callback or share it with `tools-worktree`. Continue delegating process execution to `_shared/git.ts` and patch collection to `lib/worktree-artifacts.ts`.

The Subagent execution module remains the owner of child process lifetime and authoritative child status. `WorkflowRun` supplies the prompt as the service's `task`, the normalized target cwd, the run-owned signal, the captured cache-affinity seed, and the awaited progress callback. It must not infer success from exit code or error text.

The run wraps a worktree agent's return value exactly one way today: an object result becomes `{ ...returned, worktree }` and any other result becomes `{ output: returned, worktree }`, so the collected summary is always at top-level `result.worktree`. `commands.ts:138` additionally reads `result.output.worktree`, but no code path produces that shape; it is reachable only when an agent's own JSON output fabricates it. The worktree view therefore reads `result.worktree` only, drops the `output.worktree` branch, and requires the recorded `agent_started.worktree` before exposing anything: an agent that ran without a worktree gets no view regardless of what its JSON says, and a recorded worktree whose summary `path`/`branchId` do not match the recorded metadata is rejected rather than displayed.

## File-by-file implementation plan

### Add `lib/workflow-run.ts`

1. Move the `WorkflowRun` implementation out of `runner.ts` and expose the `WorkflowRunHandle` and `WorkflowRunModule` seam described above. `create()` is asynchronous, performs new-run initialization or resumed-state loading before returning the handle, and holds the coordinator's initialization lease while a new run writes `input.json` and `run_created`.
2. Remove the unused `ExtensionAPI` field and stop passing `ExtensionContext` into the core. The composition record must contain only normalized entry/definition, run id, resume mode, `cwd`, parent signal, captured cache-affinity seed, persistence adapter, Subagent callback, and status callback. Keep worktree policy and artifact collection private to the module, with the existing collector available through a narrow test-only function boundary.
3. Build `WorkflowContext` without exposing any host object. Its `cwd`, owned `signal`, `runId`, and string `args` are plain values owned by the handle; retain the public generic `WorkflowContext` authoring type through the implementation cast.
4. Centralize event recording in one private queued method. It must append before reducing, reduce before attempting projection, and use the exact event builders and timestamp behavior listed in `workflow-run-state.ts`. Every lifecycle mutation, including progress, artifact records, pause, and invalidation, goes through it.
5. Move `execute`, phase, step, agent, parallel, artifact, log, pause, budget, and dependency logic behind the handle. Preserve empty parallel blocks, stop-on-error result objects, missing dependency acceptance, and the current counter and usage semantics.
6. Make `execute()` and `restart()` single-flight and hold the shared lease until their terminal event and cleanup settle. Gate a second call to the same handle to the cached promise.
7. Implement `requestPause`, `requestStop`, and atomic `restart` against the shared coordinator. `restart` performs descendant invalidation and replay under one lease, with invalidation as a private step.
8. Link and remove the parent-signal listener, retain explicit stop reasons, and make status updates best-effort. A throwing `setStatus` callback must not append a failure or change a successful workflow's result.
9. Expose immutable read models through `inspect`, and export the `workflowRunKey(cwd, runId)` helper used by the command registry and the coordinator. It must return the canonical run storage root, that is `runPaths(cwd, runId).root`, not a string concatenation of `cwd` and `runId`: `projectStateRoot()` resolves `cwd` through `fs.realpathSync.native`, so two spellings of the same project (a symlink and its target) must land on one key while the same run id in two different projects must not. Keep raw `RunState`, reducer functions, arbitrary agent results, and persistence objects private. Clone nested result, phase, step, agent, parallel, artifact, and usage values before returning them.
10. Keep JSON result cloning and the exact direct/fenced/object-span/array-span output parsing order. Preserve the existing return-shape wrapping around worktree results.
11. Preserve the current ordering where a successfully prepared target is followed by `agent_started` before Subagent preflight, and where worktree artifacts are collected before `agent_completed`. Keep target-preparation failures outside that start/fail pair.

### Refactor `lib/run-store.ts`

1. Extract the current filesystem operations into `FileRunPersistence` and keep only the adapter/path helpers in this file. Do not retain a final `RunStore` compatibility class.
2. Keep `runPaths`, `writeJson`, JSONL parsing, atomic projection writes, and `safeArtifactPath` in the file adapter or a private persistence helper. Add a validated run-id helper before any command-supplied id reaches `path.join`.
3. Remove lifecycle policy from the file adapter. It must not know whether an event means pause, reuse, failure, or completion, and it must not reduce events.
4. Replace every command-facing export with a facade operation. `commands.ts` currently imports `appendRunEvent`, `listRunStates`, `readEvents`, `readRunState`, `runPaths`, and the `RunState` type from this file; after the refactor it imports none of them. `readEventLog()` must report `{ exists, events }` so an existing empty file remains an error while a missing file selects projection fallback.
5. Preserve the current path behavior under `PI_CONFIG_STATE_DIR` and the default home-state directory, including the absolute paths stored in `sourceSnapshotPath` and returned artifact records.
6. Keep failure injection hooks only in the in-memory test adapter, not in the production file adapter. The file adapter must still expose projection failures naturally to the run's recovery path.

### Add `lib/workflow-run-state.ts`

1. Define the internal event builders and reducer without changing serialized event fields. Keep the raw read-event view separate from the append union.
2. Move `initialState`, `applyEvent`, and full-log rebuild logic behind the run facade.
3. Preserve progress truncation, usage accumulation, dependency projection, invalidation, status transitions, phase-current behavior, counter accumulation across retries, usage aliases, and token calculation.
4. Add explicit helpers for mapping both current agent result shapes to `WorkflowWorktreeView`. Require recorded worktree metadata, validate the worktree target and all artifact paths, and omit spoofed or escaping metadata.
5. Validate projection fallback enough to produce the same private state shape and reject malformed required data rather than handing arbitrary JSON to the formatter.
6. Ensure returned read models do not share mutable arrays or records with private state. Do not expose dependencies, logs, invalidation internals, raw child results, or reducer helpers merely because they exist in `RunState`.

### Refactor `lib/runner.ts`

Keep `runner.ts` as the preparation and composition adapter. It must not become a second lifecycle owner:

1. Keep approval, workflow source snapshots, registry lookup, project source loading, and `prepareStateEntry` here. Preserve the current distinction between bundled definitions and approved project snapshots, including the existing non-empty snapshot guard on resume.
2. Define `PreparedWorkflowRun` as `{ entry: RegistryEntry; handle: WorkflowRunHandle }`. It contains no `RunStore`, raw `RunState`, controller, persistence object, or host object.
3. Make `prepareNewWorkflowRun()` perform approval, snapshot, source import, and asynchronous handle creation before returning `{ entry, handle }`. It must not write `input.json` or `run_created` itself: `create()` owns both, under the initialization lease, so the run module stays the only persisted writer.
4. Make `prepareExistingWorkflowRun()` accept the validated run detail and selected entry, load the correct definition, construct an asynchronous resumed handle, and return the same narrow shape. The handle reloads current events under its coordinator before execute or restart so preparation cannot authorize a stale mutation.
5. Add the composition function that derives plain host values from `ExtensionContext`, captures the current session id once as the cache-affinity seed, passes `ctx.signal`, and wraps `ctx.ui.setStatus` in the run's best-effort status adapter. No `ExtensionAPI` or `ExtensionContext` enters the core. Capturing the seed once is a deliberate change: `runner.ts:273` calls `sessionManager.getSessionId()` per agent launch today, so a long background run that outlives a session change currently switches seeds mid-run and will now keep the seed it started with. Nothing else reads the seed, and the existing assertion that every launch carries the run's seed still holds.
6. Bind the registered Subagent execution module as the production callback. Pass its task, cwd, signal, options, cache seed, and awaited progress callback without changing the callback contract.
7. Construct `FileRunPersistence` for the validated run id and project cwd. The module, not commands, owns its coordinator key and event writes.
8. Keep workflow worktree preparation and artifact-view mapping private to the deep run implementation. Do not pass a public workflow worktree-policy callback or merge behavior with `tools-worktree`.
9. Delete `runPreparedWorkflow` after callers and tests use the handle. Remove its unused `pi` parameter rather than keeping a compatibility path. Remove the unused `pi` parameter from approval at the same time and update its internal callers.
10. Provide restart by returning a handle whose `restart(key)` performs invalidation and replay under one lease; do not expose a preparation helper or a public invalidation method that asks commands to invalidate and execute as two steps.
11. Drop the imports that this move strands: `parsePorcelainStatus` is already unused in `runner.ts`, and `initialState` becomes unused once `runPreparedWorkflow` is deleted.

### Refactor `lib/commands.ts`

Make this file a Pi command adapter and process-lifetime registry only. Give it one concrete injectable service so command tests do not need to reach into persistence or reducer internals:

```ts
interface WorkflowCommandService {
  prepareNew(ctx: ExtensionContext, entry: RegistryEntry, args: string): Promise<PreparedWorkflowRun>;
  prepareExisting(ctx: ExtensionContext, entry: RegistryEntry, detail: WorkflowRunDetail): Promise<PreparedWorkflowRun>;
  inspect(cwd: string, runId: string): Promise<WorkflowRunDetail>;
  list(cwd: string): Promise<readonly WorkflowRunSummary[]>;
  readEvents(cwd: string, runId: string): Promise<readonly WorkflowRunEventView[]>;
}

registerWorkflowCommands(pi: ExtensionAPI, service: WorkflowCommandService = productionWorkflowCommandService)
```

1. Keep command parsing, workflow selection, argument prompting, notifications, confirmation prompts, and active background-run bookkeeping. Inject the service above; the default is the real runner/facade composition.
2. Store a `WorkflowRunHandle` in `ActiveRun`, keyed by `workflowRunKey(ctx.cwd, runId)`, not by bare run id and not as a controller plus a separate mutable `WorkflowRunControl`. Every lookup uses the same key, so `handleStop` and `handlePause` must compose it from `ctx.cwd` rather than the bare id they receive; both keep their current `No active in-process workflow found for <run-id>` warnings on a miss.
3. `runAndReport` rejects an already-registered key, registers the prepared handle, starts either `handle.execute()` or `handle.restart(key)`, stores that exact promise, and sends the final transcript message only after it resolves. In `finally`, it removes the entry when the map still points to that handle.
   - There is no existing duplicate-active warning to reuse; add one. A rejected registration and a `RunAlreadyActiveError` from the handle both notify `Workflow ${name} (${runId}) is already running in this session.` at `warning`, and neither is reported as a run failure.
   - The three-way failure notification currently reads `control.pauseMode` and `controller.signal.aborted`, which no longer exist. Replace them with the handle's settled status: after the execution promise rejects, `await handle.inspect()` and branch on `status` — `paused` keeps `Workflow paused: <name>`, `stopped` keeps `Workflow stopped: <name>`, and anything else keeps `Workflow failed: <error message>` using the thrown error's message. If `inspect()` itself fails, fall back to the failure branch so a reporting error never masks the run outcome.
4. `handleStop` calls `requestStop("Workflow stopped by user")`; it never appends `run_stopped`.
5. `handlePause` calls `requestPause("after-current")` or `requestPause("now")`; it never mutates a control object directly and reports request errors separately from run errors.
6. `session_shutdown` requests `requestStop("Pi session shut down")` on every active handle and awaits all stored execution promises with `Promise.allSettled()`. It must not append events directly or return while a run can still write. It keeps the existing per-run `Stopped background workflow on shutdown: <run-id>` notification, still guarded so a failing notify cannot abort the loop. This is also why `runAndReport` must store the foreground promise too: today only background runs record one, so shutdown has nothing to wait on for a foreground run.
7. `handleResume` calls `service.inspect`, resolves the registry entry from the detail, calls `service.prepareExisting`, and executes the returned handle. It has no fallback path: every failure, not-found included, surfaces through the command handler's existing `Workflow command failed: <message>` catch. The point of the typed not-found error here is that malformed state, path, and projection failures keep their own messages instead of being flattened into "run not found".
8. `handleRestart` calls `service.inspect`, resolves the entry, prepares one resumed handle, and passes the invalidation key to `runAndReport` so that `handle.restart(key)` performs invalidation plus execution atomically. It keeps the current `Usage: /workflow restart <run-id> <durable-key>` guard for a missing key, and it no longer calls an invalidation function before resuming.
9. Delete `worktreeInfoFromState` and read typed `WorkflowWorktreeView` data from `inspect`. Remove the `any` cast and both result-shape lookups from commands.
10. Keep `git apply --check`, confirmation, and `git apply` in the command adapter. Use only the absolute, containment-checked `patchPath` returned in the read model; never reconstruct a path from a run id, agent result, or display string.
11. Cleanup iterates typed worktree views. It keeps the current behavior of preserving dirty worktrees and reporting cleaned and skipped entries, while refusing a view whose path fails validation.
12. `/workflows raw` reads events through the facade. A missing log now uses the existing `Run raw log not found: <run-id>` message instead of today's empty `info` notification; an existing empty log still renders as empty. `/workflows <run-id>` keeps `Run not found: <run-id>` and `/workflows` list uses read models. No command imports `RunState`, `RunStore`, `appendRunEvent`, `readRunState`, `listRunStates`, `readEvents`, `runPaths`, or a persistence adapter.
13. `handleSource` resolves a run through `service.inspect` and reads only the detail model's validated snapshot path. Falling back to the live registry entry is now reserved for a typed not-found error; a run that exists but whose snapshot is missing or unreadable reports that, instead of silently printing today's workflow source as if it were the run's.

### Refactor `lib/ui.ts`

1. Change `formatRunList` to accept `readonly WorkflowRunSummary[]`.
2. Change `formatRunDetail` to accept `WorkflowRunDetail`, including its validated event-log and source-snapshot paths; do not add a second raw-state/path argument.
3. Keep command output wording and field order stable. Read-model omissions are deliberate: do not reintroduce raw dependency, log, invalidation, or child-result fields merely to make the formatter generic.
4. Keep formatting in the adapter. The deep run module supplies facts, not prose.

### Keep `index.ts`, `definition.ts`, `scheduler.ts`, and existing deep modules stable

- `definition.ts` keeps the public `WorkflowContext` interface and workflow normalization behavior.
- `scheduler.ts` keeps abort and semaphore behavior. The run module uses it but owns admission ordering around it.
- `worktree-artifacts.ts` remains the deep artifact collector and keeps its existing tests.
- `_shared/git.ts` remains the Git executor.
- `approval.ts` keeps approval behavior and drops only its unused host-object parameter.
- The workflow result transcript renderer and status-line registry stay unchanged, with import path updates only.

### Documentation updates when implementation lands

1. Update `CONTEXT.md` with a `Workflow run lifecycle` entry describing the deep module, its command adapter seam, the canonical event-log/projection relationship, the in-process lease limitation, and the fact that workflow-specific worktree policy remains distinct from `tools-worktree`.
2. Update `.pi/extensions/workflows-engine/README.md` with the observable control/concurrency contract: a second active resume or restart is rejected, stop and pause requests are owned by the run handle, shutdown waits for active executions, and two Pi processes are not coordinated. Keep the command list and the run-directory contents unchanged, but correct the documented root while editing the file: the README's "Run Directory Layout" and "Trust Model" sections both claim `.pi/workflow-runs/<run-id>/`, and runs have never been written there. The real root is `projectStatePath(cwd, "workflow-runs", <run-id>)`, that is `$PI_CONFIG_STATE_DIR` or `~/.pi/state/pi-config`, then a per-project hash, then `workflow-runs/<run-id>/`. `tests/runtime.test.mjs:261-262` already asserts this, so the doc is the only thing that is wrong.
3. Do not document the internal persistence interface as a public workflow-authoring interface.

## Migration sequence

### Phase 0: characterize before moving code

1. Run the baseline typecheck and workflow test command recorded above.
2. Record the current 28 event names, event field shapes, input/snapshot ordering, empty-versus-missing event-log behavior, and the current JSONL timestamp behavior in tests rather than as untracked fixtures.
3. Add characterization coverage for the behavior that must survive the move: successful step/agent, pause and resume, authoritative failed child status, project source snapshot, editing agent with a patch, clean worktree summary, reuse status, 50-entry materialized progress retention, raw progress retention, missing dependencies/cycles, parallel stop-on-error modes, path traversal rejection, and the current token calculation.
4. Add target-regression tests for the known hazards before deleting their shallow paths: shared queue scope, serialized `maxAgents`, active lease rejection, command-owned pause/stop, shutdown waiting, normalized `.`/`..` and `.lock` rejection, and worktree/result/path spoofing. Pin the two read-path changes here as well, so the diff shows them moving from old behavior to new: `/workflows raw` on a missing log, and `/workflow source` on a run whose snapshot cannot be read.

### Phase 1: introduce the persistence seam

1. Add the internal `RunPersistence` type, `FileRunPersistence`, validated run-id helper, and `{ exists, events }` event-log result.
2. Use a short-lived delegating `RunStore` wrapper only while moving callers in this phase; schedule its deletion in Phase 5 and do not add new callers to it.
3. Add an in-memory persistence adapter in test support with event, artifact, and projection failure switches. Make its JSON/timestamp/missing-versus-empty behavior match the file adapter.
4. Add focused adapter tests for `input.json`, JSONL append order, malformed lines, atomic projection output, event-log precedence, projection fallback only for a missing log, existing-empty-log errors, artifact writes, and traversal protection.
5. Move reducer-free file operations behind the adapter and verify serialized event and state data before changing runner and command imports.

### Phase 2: move state and run behavior behind the facade

1. Add `workflow-run-state.ts` and move the reducer, event builders, projection validation, and read-model mapping behind it.
2. Move `WorkflowRun` to `workflow-run.ts` and make asynchronous creation perform initialization or resume loading before returning a handle.
3. Replace every direct `RunStore.append` call with the one private queued event-recording method. Test append failure and projection failure at this boundary.
4. Inject the Subagent runner, captured cache seed, best-effort status callback, persistence adapter, and private workflow worktree behavior.
5. Add the coordinator keyed by canonical run storage root, acquire/release the lease around execute and restart, and make execution and restart single-flight.
6. Move invalidation onto the handle as a private step and serialize the entire descendant walk. Implement `restart(key)` as invalidation plus replay while the same lease remains held, and delete the exported `invalidateKeyAndDependents`.
7. Fix agent admission so the scheduler slot, serialized `maxAgents` reservation, target preparation, and `agent_started` append cannot oversubscribe or race.
8. Migrate the run behavior tests to the handle and make the existing runtime behavior pass through the new facade before changing command control paths.

### Phase 3: move read access and controls to the command adapter

1. Add summary, detail, agent, and worktree read models with validated event-log, source-snapshot, worktree, and patch paths.
2. Update `runner.ts` preparation to return `{ entry, handle }` and stop returning raw state, store objects, controllers, or host objects to command code.
3. Update `ui.ts` to consume read models and preserve current output wording and order.
4. Add the concrete injectable `WorkflowCommandService`; update `commands.ts` to use handles for execution, pause, stop, shutdown, and atomic restart.
5. Replace raw worktree result traversal with the typed worktree view and make integrate use only its validated absolute patch path.
6. Add command-adapter tests with a fake service and fake UI host for active lookup, duplicate requests, resume, atomic restart, source display, raw/list/detail reads, integration path selection, cleanup of clean and dirty worktrees, shutdown stop/wait behavior, and the paused/stopped/failed notification chosen from the handle's settled status.
7. Remove all temporary compatibility functions after `rg` confirms no raw-store imports or direct lifecycle appends remain outside persistence tests and internal composition.

### Phase 4: harden failure, recovery, and path behavior

1. Test append failure. State and read models must not advance when the event was not appended.
2. Test projection-write failure. The append must remain in JSONL, the current handle must continue from its advanced private state, and a fresh inspect must rebuild the expected state from the event log.
3. Test concurrent progress callbacks, raw reads, and inspection against a running execution. The resulting event order must be deterministic under the coordinator queue, and a restart's descendant invalidation must not race with execution.
4. Test a second resume or restart for an active run. It must be rejected without duplicate lifecycle events; two different projects using the same run id must remain independent.
5. Test stop and pause requests with a child that delays settlement. No late event may be written after the run's terminal event, and shutdown must await the delayed execution.
6. Test `maxAgents` with more parallel callers than the limit. The event log must contain no more admitted launches than the configured maximum, including retries after invalidation.
7. Test a throwing status callback. The workflow must persist its normal completion and result, and the callback error must be isolated from execution failure.
8. Test missing and empty event logs, malformed projection data, absolute/relative traversal attempts, unsafe run ids, normalized `.`/`..` and `.lock` worktree ids, escaped snapshot/patch paths, and fabricated nested worktree results.

### Phase 5: remove shallow paths and document ownership

1. Delete direct command-level event writes and raw state reads.
2. Delete the old `WorkflowRun` implementation from `runner.ts` and delete `runPreparedWorkflow`.
3. Delete the temporary `RunStore` wrapper, the `RunStore` exports it leaves unused, and obsolete reducer tests that duplicate facade behavior. `AsyncQueue` is the one export to keep: it has no other caller today but the coordinator uses it, so move it rather than delete it. Retain lower-level file-format and adapter-failure tests.
4. Update `.pi/package.json` so `test:workflows` explicitly runs every workflow Vitest file, including `index.test.ts`, `lib/workflow-run.test.ts`, `lib/run-store.test.ts`, `lib/commands.test.ts`, and `lib/worktree-artifacts.test.ts`, followed by all `tests/*.test.mjs` files.
5. Update `CONTEXT.md` and README ownership/control notes.
6. Run the full typecheck, the updated focused workflow command, and the repository test suite.
7. Review the final diff for unrelated changes. Do not alter workflow definitions, `tools-worktree`, `_shared/git.ts`, Subagent execution, or status-registry behavior.

## Test plan

### Deep-interface tests

Create `lib/workflow-run.test.ts` around the public run handle and the in-memory persistence adapter. Assert observable results, event views, and read models rather than private state fields.

Cover:

- New creation ordering: source/input initialization before `run_created`, and no handle returned after a failed initialization append.
- Final result, JSON result cloning, status updates, and status-callback failure isolation.
- Phase start, complete, and failure ordering, including the original thrown error.
- Step result cloning, reuse without changing status from `completed`, dependency recording, missing dependencies, cycles, and counter preservation. Descendant invalidation is asserted through `restart()`, on the event log rather than on the final projection, because a replay re-completes the keys it invalidated.
- Agent admission, target-preparation failure before `agent_started`, progress mapping/retention, raw progress retention, authoritative failed status, usage, token calculation, and result cloning.
- JSON output parsing in direct, fenced, object-span, array-span, invalid, and empty-output cases.
- Parallel result ordering, empty blocks, concurrency cap, default fail-fast behavior, and `stopOnError: false` result objects.
- Artifact writing, `artifact_written` ordering, clean-worktree summaries, and safe relative paths.
- Pause after current and pause now, including a delayed child and a workflow that returns without another scheduling boundary.
- Stop classification, explicit stop reasons, parent shutdown abort, preservation of completed durable results, and no post-terminal event.
- Resume through a new handle with completed keys reused.
- Atomic restart through one handle with descendant invalidation followed by replay and no lease gap, plus the unchanged `Durable key not found in run <runId>: <key>` rejection, which must leave the event log untouched.
- Single-flight execution, same-handle repeated calls, canonical-root active-lease rejection, and same run id in two projects.
- Worktree target normalization, rejection of unsafe normalized ids, replay reuse, metadata, containment checks, and typed artifact views. Result-shape validation must include the two negative cases that motivate it: an agent that ran with no worktree but returned JSON containing a `worktree` object gets no view, and an agent that did run in a worktree but returned a mismatched summary is rejected rather than displayed.
- Budget enforcement, including serialized `maxAgents` admission and the existing post-usage `maxTokens` behavior.

### File adapter tests

Add focused adapter/path tests in `lib/run-store.test.ts`, using the facade only for the rebuild/fallback assertions:

- `input.json`, the `artifacts/` directory created at initialization, source snapshot paths, the external project-state root, and run-directory layout.
- Validated run ids, JSONL append order/timestamps, and malformed-line diagnostics.
- Atomic `state.json` projection.
- Event-log rebuild taking precedence over stale `state.json`.
- Projection fallback only when the event file does not exist; an existing empty event file is rejected.
- Artifact path traversal rejection and artifact writes.

Projection failure injection and recovery are tested through the in-memory adapter in `workflow-run.test.ts`, because the production adapter has no test-only failure hook.

### Command adapter tests

Add `lib/commands.test.ts`. Pass a fake `WorkflowCommandService` and fake UI host to `registerWorkflowCommands`; do not mock reducer or persistence internals. Assert that:

- Commands invoke the service/facade instead of appending events or reading raw state.
- A rejected execution notifies paused, stopped, or failed according to the handle's settled status, and a failing `inspect()` during that classification still produces the failure notification.
- Stop and pause requests reach the active handle with the exact modes/reasons.
- Restart passes one key to the same handle's `restart()`; no invalidation entry point is reachable from the command adapter.
- A duplicate canonical active run produces the already-running warning rather than a failure notification, while the same run id in another cwd is independent.
- Resume distinguishes not-found from malformed/path errors.
- Source and raw commands use only validated detail/event paths, `/workflows raw` reports a missing log as not-found, and `/workflow source` falls back to the registry only for a not-found run.
- Integration uses only the validated absolute patch path from the read model and still checks/ confirms/applies through Git.
- Cleanup skips dirty worktrees and reports both cleaned and skipped lists.
- Shutdown requests stop, awaits every execution promise, and does not write a second shutdown event.

### Existing integration tests

Migrate `tests/runtime.test.mjs` in place rather than deleting its end-to-end value. Keep the definition, registry, approval, bundled workflow, source snapshot, Git, and real filesystem coverage. Replace direct `RunStore` and raw `RunState` calls with the public facade; keep adapter-only assertions in `lib/run-store.test.ts`.

Keep `index.test.ts` and `lib/worktree-artifacts.test.ts` passing. Do not duplicate worktree artifact behavior in the run tests beyond verifying that the run module wires the collector and exposes its validated result.

### Verification commands

Update `.pi/package.json` so `test:workflows` runs exactly these workflow tests before the Node integration tests:

```bash
pnpm exec vitest run extensions/workflows-engine/index.test.ts extensions/workflows-engine/lib/commands.test.ts extensions/workflows-engine/lib/run-store.test.ts extensions/workflows-engine/lib/workflow-run.test.ts extensions/workflows-engine/lib/worktree-artifacts.test.ts && node --test extensions/workflows-engine/tests/*.test.mjs
```

Run these in order:

```bash
pnpm --dir .pi typecheck
pnpm --dir .pi test:workflows
pnpm --dir .pi test:features
pnpm --dir .pi test:safety
pnpm --dir .pi test:subagents
pnpm --dir .pi test:worktree
pnpm --dir .pi test
```

The focused command gives fast feedback on the changed seam. The full suite is required before the implementation is complete because workflow state, Subagent execution, Git, status output, and profile/session shutdown behavior share process-lifetime assumptions.

## Compatibility matrix

| Existing behavior | New owner | Required result |
| --- | --- | --- |
| `/workflow <name>` preparation | `runner.ts` adapter | Same approval, snapshot, import, input, and workflow loading order. |
| Foreground and background execution | `WorkflowRunHandle` plus command adapter | Same result message, status updates, background lifetime, and paused/stopped/failed notification wording; status callback failures are isolated. Foreground runs now record an execution promise too, so shutdown can wait for them. |
| `/workflow resume` | `runner.ts` plus run facade | Same source selection, snapshot guard, and completed-key reuse. A duplicate active operation is rejected. |
| `/workflow restart` | `WorkflowRunHandle.restart(key)` | Same descendant invalidation and replay, with no lease gap between them. |
| `/workflow stop` | Handle `requestStop` | Same stopped status and notification, with the explicit user reason persisted and no command-level event append. |
| `/workflow pause` and `pause-now` | Handle `requestPause` | Same pause states and replayability, with command requests now reaching the existing run control path. |
| Session shutdown | Command adapter plus handle stop/wait | Every active handle receives the shutdown stop request; shutdown waits for its execution promise and writes no direct event. |
| `/workflow source` | Source preparation and detail read model | Same snapshot/source text, using only a validated snapshot path. Changed: the registry fallback now fires only for a not-found run, where today an unreadable snapshot also falls through to it. |
| `/workflow integrate` | Command adapter plus typed worktree view | Same check, confirmation, and apply behavior, using only a validated artifact path. |
| `/workflow cleanup-worktrees` | Command adapter plus typed worktree view | Same clean removal and dirty preservation; unsafe persisted paths are rejected before cleanup. |
| `/workflows` list/detail/raw | Facade read queries plus `ui.ts` | Same useful fields, field order, 30-run list cap, drop-on-error listing, and raw event visibility, with reads serialized per run. Changed: `/workflows raw` on a missing log reports not-found where it currently notifies an empty string; an existing empty log still renders as empty. |
| `WorkflowContext` authoring surface | `definition.ts` | No public authoring changes. |
| Event names and fields | State/event implementation plus file adapter | All 28 existing event names and serialized fields remain readable and append-compatible. |
| Run-directory paths | File persistence adapter | Existing runs under `projectStatePath()` remain inspectable and replayable; unsafe new run ids cannot escape the root. |
| Workflow worktree policy | Private run implementation | Remains distinct from `tools-worktree`, while normalized path escapes are rejected. |
| Subagent cache affinity | Composition adapter | Changed: the session id is captured once at composition instead of read at each agent launch, so a run that outlives a session change keeps its original seed. |

## Risks and mitigations

### Projection failure after a durable append

Risk: an event may exist without a current `state.json`. Mitigation: keep JSONL as the commit point, rebuild from events on open/inspect, inject projection failures in the in-memory adapter, and never delete a durable event or append a compensating failure to repair a projection.

### Competing writers

Risk: two handles, separate `RunPersistence` instances, or command paths could append interleaved events or restart the same run. Mitigation: key one in-process coordinator by canonical storage root, acquire one lease before mutation, route every event-log/projection read and write through its queue, and keep cross-process locking explicitly out of scope.

### Admission oversubscription

Risk: parallel workflow workers can read the same `agentsStarted` count before waiting for a semaphore slot. Mitigation: perform slot admission, the serialized max-agent check, target preparation, and `agent_started` append as one coordinator-controlled operation; test the event count under contention.

### Late child progress

Risk: a delayed progress or completion callback could mutate a stopped run. This is reachable today: `parallel()` fail-fast leaves sibling workers running, and an unawaited `ctx.agent()` outlives `execute()`. Mitigation: retain the awaited Subagent callback contract, gate every queued write on the attempt that opened it, check the gate inside the queue, and add delayed-child tests.

### Unsafe command paths and spoofed artifacts

Risk: a run id, snapshot path, patch path, worktree path, or nested JSON result could escape its intended root or manufacture an integration artifact. Mitigation: validate ids before path composition, validate stored paths at read-model creation, require a recorded `agent_started.worktree`, require patches below `artifacts`, and use the validated absolute path for Git operations.

### Overgrown facade

Risk: moving every concern into one file produces a large implementation with a large interface. Mitigation: keep the external handle and command service small, put reduction and validation in the private state sibling, keep persistence/worktree helpers private, and expose no raw state or host context.

### Accidental worktree policy merge

Risk: a generic worktree abstraction could erase the documented difference between workflow and public tool behavior. Mitigation: retain the workflow-specific policy and its characterization tests; share only the Git executor and artifact collector already documented as shared deep modules.

### Replay semantics drift

Risk: moving preparation may make bundled workflows load snapshots or project workflows load live source. Mitigation: preserve the current `prepareStateEntry` and `prepareExistingWorkflowRun` selection rules and retain both source-snapshot tests.

### Test layering

Risk: old reducer tests and new facade tests both become maintenance work. Mitigation: migrate behavior assertions to the facade, keep file-format and adapter-failure assertions at lower seams, and delete only tests that duplicate those assertions.

## Definition of done

- `WorkflowRun` is the sole per-run lifecycle writer and owns event creation; no command path appends lifecycle events.
- No command code imports or mutates `RunState`, `RunStore`, a controller, or a persistence adapter.
- Commands receive typed run read models and no longer use `any` to find worktree data or reconstruct artifact paths. The `result.output.worktree` lookup is gone, not ported.
- `WorkflowContext` and all 28 persisted event names/fields remain compatible.
- `FileRunPersistence` and `InMemoryRunPersistence` pass the same observable behavior, including timestamp and missing-versus-empty semantics.
- `create()` is asynchronous; `execute()` is single-flight; atomic `restart()` holds the shared lease through invalidation and replay.
- Active resume and restart operations cannot create competing in-process writers, and same run ids in different canonical roots remain independent.
- `maxAgents` admission is serialized and tested without changing counter meaning.
- Projection-failure recovery, shutdown waiting, status-callback isolation, and late-callback ordering are tested.
- Worktree ids, source snapshots, artifact paths, and returned worktree metadata pass containment validation; workflow-specific policy remains separate from `tools-worktree`.
- `.pi/package.json` runs every workflow Vitest file and all workflow Node tests through `test:workflows`.
- Existing workflow, Subagent, Git, worktree, and status tests pass.
- `CONTEXT.md` and `.pi/extensions/workflows-engine/README.md` document the implemented Workflow run lifecycle and control contract, and the README names the real run-directory root instead of `.pi/workflow-runs/`.
- Every observable change ships as one of the seven listed in the decisions table; anything else found during implementation is a regression, not a scope extension.
- `pnpm --dir .pi typecheck` and the full `pnpm --dir .pi test` command pass.
