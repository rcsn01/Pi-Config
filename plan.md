# Implementation plan: extract Workflow run control

## Status and verified baseline

Ready for implementation against checkout `e6ef6ef4af521aef973df2a799568b1bbccde6ab`.

I checked the inventories and commands below against the checkout rather than carrying forward the previous plan's counts.

### Source inventory

The current command-layer active-run behavior is confined to `.pi/extensions/workflows-engine/lib/commands.ts`:

| Site | Current responsibility |
|---|---|
| lines 35-44 | `ActiveRun` and the file-global `activeRuns` map |
| lines 69-108 | `runAndReport`: canonical key derivation, command-layer duplicate admission, start notice, execute/restart dispatch, terminal classification, Pi result publication, terminal notice, and cleanup |
| lines 110-116 | restart preparation and dispatch |
| lines 118-128 | stop lookup and signaling |
| lines 130-143 | pause lookup, signaling, and pause-specific error rendering |
| lines 201-215 | new foreground/background preparation and dispatch |
| lines 218-229 | shutdown stop traversal, notices, and draining |
| lines 246-250 | resume preparation and dispatch |
| lines 252-258 | restart, stop/cancel, pause-now, and pause command parsing |

Related symbols and callers:

- `.pi/extensions/workflows-engine/index.ts:3,40` is the only production importer/caller of `registerWorkflowCommands`.
- `.pi/extensions/workflows-engine/lib/commands.test.ts:2` imports `registerWorkflowCommands` and `WorkflowCommandService`.
- No repository file imports `runAndReport`; only `commands.ts` calls it at lines 116, 215, and 250.
- `PreparedWorkflowRun` is declared in `runner.ts:17-20` as an entry plus `WorkflowRunHandle`.
- `WorkflowRunHandle` is declared in `workflow-run.ts:56-63`; its interface has `execute`, `restart`, `requestPause`, `requestStop`, and `inspect`.
- `workflowRunKey` is declared in `workflow-run.ts:129-131` and delegates to `runPaths`, which validates the run id and derives the canonical project-state run root.
- `RunAlreadyActiveError` is declared in `workflow-run.ts:88-94` with stable code `WORKFLOW_RUN_ALREADY_ACTIVE`.
- The lower coordinator and operation lease remain in `workflow-run.ts`. The relevant duplicate checks are at lines 284-305, 340-342, and 670-676.

No file outside the following scope needs implementation changes:

- change `.pi/extensions/workflows-engine/lib/commands.ts`;
- add `.pi/extensions/workflows-engine/lib/workflow-run-control.ts`;
- add `.pi/extensions/workflows-engine/lib/workflow-run-control.test.ts`;
- refactor `.pi/extensions/workflows-engine/lib/commands.test.ts`;
- add the new test file to `.pi/package.json`;
- update the `Workflow runs` section in root `CONTEXT.md`.

Do not change `runner.ts`, `workflow-run.ts`, `workflow-run-state.ts`, `run-store.ts`, worktree code, or `.pi/extensions/workflows-engine/README.md`. The documented command behavior and process-local limitation remain unchanged.

### Test inventory and baseline

`test:workflows` currently names six test files with 41 tests:

| File | Tests | Relevance |
|---|---:|---|
| `index.test.ts` | 4 | workflow status and `workflow-result` card rendering |
| `commands.test.ts` | 4 | run control/shutdown, restart, source snapshot failure, and raw-log failure |
| `run-store.test.ts` | 4 | persistence layout and path safety |
| `workflow-run.test.ts` | 9 | durable lifecycle, lease, pause, write ordering, and agent admission |
| `worktree-artifacts.test.ts` | 3 | Git artifact collection |
| `tests/runtime.test.mjs` | 17 | definitions, registry, replay, abort, subagents, bundled workflows, and worktrees |
| Total | 41 | 24 Vitest tests followed by 17 Node tests |

Verified commands on this checkout:

- `pnpm --dir .pi typecheck` passes.
- `pnpm --dir .pi exec vitest run extensions/workflows-engine/lib/commands.test.ts extensions/workflows-engine/lib/workflow-run.test.ts` passes 2 files and 13 tests.
- `pnpm --dir .pi test:workflows` runs the 24 Vitest tests first. It reaches 23 passes and one failure, then the shell's `&&` prevents the 17 Node tests from running. The existing Windows-only failure is the assertion at `run-store.test.ts:52`: `writeArtifact` returns `artifacts\diffs\change.patch`, while the test expects `artifacts/diffs/change.patch`.
- Running the otherwise-skipped Node tests directly reaches 16 passes and one existing Windows newline failure at `tests/runtime.test.mjs:743`: Git reads `base\r\n`, while the test expects `base\n`.
- The full repository command stops earlier in `test:shared` on this Windows host. It reaches 433 passes and 13 unrelated failures across POSIX process-group assumptions, symlink permissions, slash/newline expectations, and Git fixture behavior.

Do not fix or hide these unrelated Windows baseline failures in this work.

## Ground-truth behavior to preserve

Treat this section as the compatibility contract. It is more precise than saying only that foreground and background behavior stays the same.

### Admission and operation taxonomy

1. `runAndReport` returns without an effect when preparation returns `undefined`.
2. It computes the active key with `workflowRunKey(ctx.cwd, prepared.handle.runId)`. Invalid run ids therefore fail through the outer `/workflow` catch before a start notice.
3. The command-layer map rejects a second prepared handle for the same canonical key. This applies to new, background, resume, and restart dispatch, not just the resume/restart cases mentioned in the README.
4. The map entry is inserted and the start notice is emitted before `execute()` or `restart()` is invoked.
5. An admitted operation invokes exactly one method: `execute()` when there is no restart key, or `restart(exactKey)` when there is one.
6. Foreground waits for the whole current `runAndReport` pipeline. Background returns after dispatch and keeps the pipeline promise in the active record.
7. Cleanup occurs after success or failure. A key cannot be readmitted before that cleanup, so a separate record-identity replacement protocol is unnecessary. The current handle comparison is defensive but no reachable current path can replace the entry while its operation is pending.

There are two duplicate depths, and both remain:

- Command control rejects any second admission for the same canonical key before invoking the second handle.
- `workflow-run.ts` owns the durable-run lease. The same handle reuses its promise for repeated execute calls and repeated restart calls of the same operation kind. Execute/restart conflicts, competing handles, initialization conflicts, and creation conflicts can produce `RunAlreadyActiveError` below command control.

Preparation can also fail before run control receives a handle. In particular, `createWorkflowRun` can reject during initialization or creation. Those errors continue to reach the outer command catch.

### Settlement taxonomy

For an admitted operation:

- fulfillment serializes and publishes the returned value, then emits the completion notice;
- `RunAlreadyActiveError` or any non-null object whose `code` is exactly `WORKFLOW_RUN_ALREADY_ACTIVE` emits the already-active warning without calling `inspect()`;
- every other rejection calls `handle.inspect()` once;
- inspected status `paused` emits the paused warning;
- inspected status `stopped` emits the stopped warning;
- statuses `created`, `running`, `pausing`, `completed`, and `failed` emit the failure notice with the original operation error;
- an inspection rejection is ignored and the original operation error is used for the failure notice.

The operation error, not the inspection error, is authoritative.

The current `try` also encloses successful result serialization, `sendMessage`, and the completion notice. A throw from any of those presentation steps enters the same inspection path. The start notice is outside that `try`; if it throws, the map entry remains without dispatch. A terminal notice can itself throw, and a background pipeline can therefore reject without a handler. These broken-adapter cases are hazards, not desirable command semantics. The extracted adapter keeps the same normal notices, adds a terminal background rejection handler, and does not preserve map leakage or status inspection for a presentation failure.

### Pause, stop, and shutdown boundaries

- Pause and stop only find handles admitted into the command-layer map. They do not reconstruct persisted runs.
- `pause` routes `after-current`; `pause-now` routes `now`.
- A missing pause target has a shorter message than a missing stop target.
- A `requestPause` rejection is converted to the pause-specific error notice. The run remains active.
- A synchronous `requestStop` throw is not caught by `handleStop`; the outer `/workflow` catch renders it as `Workflow command failed: <error>`. The run remains active.
- Invalid ids can make `workflowRunKey` throw. For pause and stop this happens before active lookup and must continue to reach the outer command catch, not a pause-specific or inactive result.
- Shutdown traverses every active command-layer entry, including foreground entries, calls `requestStop("Pi session shut down")`, emits the existing text `Stopped background workflow on shutdown: <runId>` for each traversed entry, and awaits all retained operation pipelines with `Promise.allSettled`.
- Shutdown notices are best effort. A notice throw is swallowed.
- A synchronous shutdown `requestStop` throw currently aborts traversal before the drain. Warnings for entries stopped earlier in the traversal have already been emitted because the current loop alternates stop and notify. The conforming production handle does not throw, so this is only a defensive adapter boundary.
- Shutdown does not close later admission, does not coalesce calls, and is not a new lifecycle state. Commands issued after a shutdown callback can still be admitted today.
- The active map is file-global today. Separate calls to `registerWorkflowCommands` share duplicate detection, pause/stop lookup, and shutdown ownership. Production registers once, but replacing the default with one controller per registration would still be an observable behavior change in tests or another caller.

### Exact Pi effects

Keep these strings and severities:

- admitted foreground start: `Started workflow <name> (<runId>)`, `info`;
- admitted background start: `Started background workflow <name> (<runId>)`, `info`;
- completion: `Workflow completed: <name>`, `info`;
- duplicate: `Workflow <name> (<runId>) is already running in this session.`, `warning`;
- paused settlement: `Workflow paused: <name>`, `warning`;
- stopped settlement: `Workflow stopped: <name>`, `warning`;
- failed settlement: `Workflow failed: <error>`, `error`;
- pause accepted: `Pause requested for <runId> (<mode>)`, `warning`;
- pause inactive: `No active in-process workflow found for <runId>.`, `warning`;
- pause rejected: `Unable to request pause for <runId>: <error>`, `error`;
- stop accepted: `Stop signal sent to workflow <runId>`, `warning`;
- stop inactive: `No active in-process workflow found for <runId>. Resume/replay remains available for persisted runs.`, `warning`;
- shutdown: `Stopped background workflow on shutdown: <runId>`, `warning`;
- outer command failure: `Workflow command failed: <error>`, `error`.

Keep result serialization exactly:

```ts
const text = typeof result === "string"
	? result
	: JSON.stringify(result, null, 2) ?? "undefined";
```

Strings, including the empty string, pass through unchanged. JSON-serializable values use two-space indentation. `undefined`, functions, and symbols fall back to the literal text `undefined` when `JSON.stringify` returns `undefined`. Circular objects, `BigInt`, and throwing `toJSON` methods make serialization throw; the adapter must attempt the failure notice rather than publish a result.

Keep the message shape exactly:

```ts
{
	customType: "workflow-result",
	content: text,
	display: true,
	details: { workflow: workflowName, runId, background },
}
```

Preserve `stop` and undocumented alias `cancel`, plus `pause` and `pause-now`. Leave command names, completions, list/inspect/source/raw formatting, discovery, prompts, patch integration, and worktree cleanup alone.

## Architecture decision

Extract run control, but use a smaller interface than the previous plan proposed.

The extraction is justified because four command paths mutate or traverse one active-run registry: start, pause, stop, and shutdown. Settlement classification and cleanup are part of the same lifetime. Moving those rules gives them one testable owner and removes direct map access from `commands.ts`.

The previous proposal went too far in five places:

1. A discriminated `control` request combined pause and stop even though they have different async and error behavior. The adapter already knows which command it is handling. Use explicit `pause` and `stop` methods.
2. `workflowName` and `background` were copied into run-control results and active records even though control does not use them. The command adapter already owns that presentation metadata.
3. Closed admission, `unavailable`, shutdown idempotence, and coalesced drain solved a hypothetical post-shutdown caller. There is no current consumer or requirement for a new shutdown state.
4. Per-registration controllers changed the current file-global sharing contract. Use one production singleton while retaining a factory for isolated direct tests.
5. Identity-safe replacement logic and a stale-completion test protected an impossible replacement. Admission cannot replace an occupied key, and cleanup is the only normal deletion path.

This leaves a useful module rather than a second command framework. `commands.ts` remains the Pi adapter. It owns preparation, names and background flags, notifications, serialization, and `sendMessage`. The new module must not import Pi types.

## Exact module interface

Add `.pi/extensions/workflows-engine/lib/workflow-run-control.ts` with this interface. These names are settled for implementation; do not defer interface design to migration time.

```ts
import type { PreparedWorkflowRun } from "./runner.ts";
import type { WorkflowPauseMode } from "./workflow-run.ts";

export type WorkflowRunOperation =
	| { readonly type: "execute" }
	| { readonly type: "restart"; readonly durableKey: string };

export type WorkflowRunSettlement =
	| { readonly status: "completed"; readonly result: unknown }
	| { readonly status: "already-active" }
	| { readonly status: "paused" }
	| { readonly status: "stopped" }
	| { readonly status: "failed"; readonly error: unknown };

export type WorkflowRunStartResult =
	| { readonly status: "already-active" }
	| {
		readonly status: "started";
		readonly completion: Promise<WorkflowRunSettlement>;
	};

export interface WorkflowRunShutdownResult {
	readonly runIds: readonly string[];
	readonly completion: Promise<void>;
}

export interface WorkflowRunControl {
	start(request: {
		readonly cwd: string;
		readonly prepared: PreparedWorkflowRun;
		readonly operation: WorkflowRunOperation;
	}): WorkflowRunStartResult;
	pause(request: {
		readonly cwd: string;
		readonly runId: string;
		readonly mode: WorkflowPauseMode;
	}): Promise<void> | undefined;
	stop(request: {
		readonly cwd: string;
		readonly runId: string;
		readonly reason?: string;
	}): boolean;
	shutdown(reason?: string): WorkflowRunShutdownResult;
}

export function createWorkflowRunControl(): WorkflowRunControl;
export const productionWorkflowRunControl: WorkflowRunControl;
```

Interface semantics:

- `start` derives the canonical key. It may throw synchronously if key derivation rejects the run id.
- `already-active` is command-layer admission rejection. `already-active` on `WorkflowRunSettlement` is a lower operation rejection after admission.
- An admitted `completion` always resolves to one settlement. It never rejects for an operation or inspection error.
- `pause` deliberately returns `undefined` for no active target. Key derivation can throw synchronously. After lookup, wrap both a synchronous `requestPause` throw and a returned rejection as a rejected promise, so the adapter retains the current distinction between key/lookup errors and request failure.
- `stop` returns `false` for no target and `true` after a successful signal. Key derivation and `requestStop` throws propagate synchronously.
- `shutdown` stops the active entries present during that call and returns their run ids plus a drain promise. It does not close admission or cache its result. A stop throw propagates. Because notification stays outside the module, a later stop throw prevents the adapter from receiving metadata and therefore suppresses notices for earlier successful stops. This is an accepted fake-only difference from the interleaved old loop; preserving partial notices would require a Pi callback in run control or moving traversal back into `commands.ts`.
- The production singleton preserves sharing across `registerWorkflowCommands` calls. The factory exists for direct module tests, not as a new production ownership policy.

## Module implementation

Keep only the data control uses:

```ts
interface ActiveRun {
	readonly handle: PreparedWorkflowRun["handle"];
	completion: Promise<WorkflowRunSettlement>;
}
```

Implement these rules:

1. Derive all start, pause, and stop keys with `workflowRunKey(cwd, runId)`. Do not duplicate path normalization in callers or tests.
2. Reject a second start while the key is present. Do not invoke the second handle.
3. Insert the active record before handle invocation. Schedule invocation in a promise continuation so synchronous handle throws become settlements and a reentrant handle hook can observe its own admission.
4. Invoke exactly one operation with the exact durable key.
5. Classify fulfillment and every rejection by the settlement taxonomy above.
6. Check both `instanceof RunAlreadyActiveError` and exact stable code `WORKFLOW_RUN_ALREADY_ACTIVE`.
7. Inspect only non-duplicate operation failures. Never replace the original operation error with an inspection error.
8. Delete the key in the completion pipeline after classification. Since no occupied key can be replaced, ordinary key deletion is sufficient.
9. Pause and stop use only active handles in this module instance. They do not inspect persistence or create a handle. Derive the pause key before creating its request promise, then convert a synchronous `requestPause` throw into a rejected promise.
10. Shutdown iterates a snapshot of current active records, signals each in iteration order, and then creates a drain with `Promise.allSettled` over their settlement promises. Return run ids in the same order.
11. Keep the map private. Do not export reset, query, active-record, or handle access.
12. Do not import `ExtensionAPI`, `ExtensionContext`, UI types, registry entries, or persistence modules.

Scheduling operation invocation by one promise continuation is an intentional internal timing change. It preserves the externally relevant order: admission first, the adapter's synchronous start notice second, handle invocation third. It also catches a JavaScript adapter that throws instead of returning a promise. Do not add more scheduling layers.

The other intentional lifetime change is that the active entry ends after operation classification, before the adapter renders the settlement. Today `runAndReport` removes it after synchronous Pi rendering. Keeping presentation inside the active lifetime would require a release token or callback and would make the new interface shallower. Pi rendering has no asynchronous step, and no current caller re-enters control from `sendMessage` or a terminal notification. Do not add a release protocol for that hypothetical re-entrant adapter.

The lower `workflow-run.ts` coordinator remains authoritative for a durable run's lease, writes, reducer, replay, worktrees, and agent admission. Do not copy those policies upward.

## Adapter changes in `commands.ts`

Change registration to inject run control while defaulting to the shared production singleton:

```ts
export function registerWorkflowCommands(
	pi: ExtensionAPI,
	service: WorkflowCommandService = productionWorkflowCommandService,
	runControl: WorkflowRunControl = productionWorkflowRunControl,
): void;
```

Keep `WorkflowCommandService` unchanged. It handles preparation and persisted read models, which are separate from active command control.

Replace exported `runAndReport` with a private adapter helper that:

1. returns for `undefined` preparation;
2. calls `runControl.start` with `execute` or the exact restart key;
3. renders admission `already-active` with the current warning and returns;
4. emits the current foreground/background start notice;
5. maps the eventual settlement to the exact effects above;
6. awaits settlement rendering for foreground;
7. attaches settlement rendering for background and returns without waiting.

Render a `completed` settlement inside a presentation `try/catch`. If result publication or the completion notice throws, attempt the current fallback `Workflow failed: <error>` notice. This preserves the normal result of the old broad `runAndReport` catch without moving Pi effects into run control. Attach a terminal rejection handler to every background rendering promise. Run-control completion cannot reject, but `pi.sendMessage` or `ctx.ui.notify` is external adapter code and can throw. The terminal handler consumes a presentation failure after the fallback attempt; it must not emit another notice that could recurse through the same failing UI adapter.

The scheduled invocation means the adapter emits the start notice before the handle runs. Add an order assertion for this. The exceptional case where the start notification itself throws is not a supported Pi command result; the queued operation may still begin. Do not add an admit/begin handshake solely to reproduce the old broken-adapter behavior.

Rewrite pause as follows:

- call `runControl.pause` outside the request-rejection `try/catch`, so synchronous key derivation errors retain the outer command message;
- render the inactive warning for `undefined`;
- await the returned promise and render the success warning;
- render a request rejection with the current pause-specific error.

Rewrite stop as follows:

- call `runControl.stop({ cwd, runId, reason: "Workflow stopped by user" })`;
- render the inactive warning for `false`;
- render the current success warning for `true`;
- do not catch throws, so the outer command handler keeps its current error message.

Rewrite shutdown as follows:

1. call `runControl.shutdown("Pi session shut down")`;
2. emit the current best-effort warning once per returned run id;
3. await `completion`.

Remove `ActiveRun`, `activeRuns`, direct handle lookup, command-side failure inspection, and the `RunAlreadyActiveError` and `workflowRunKey` imports from `commands.ts`.

Leave these functions unchanged except for mechanical parameter threading:

- `findEntryForDetail`;
- `chooseWorkflow`;
- `promptForArgs`;
- `handleSource`;
- `handleIntegrate`;
- `handleCleanupWorktrees`;
- workflow discovery and prompting in `runNamed`;
- list, inspect, and raw-event formatting.

## Direct module tests

Add `.pi/extensions/workflows-engine/lib/workflow-run-control.test.ts`. Use recording `WorkflowRunHandle` fakes and deferred promises. Test only through `WorkflowRunControl`; do not register Pi commands here.

Cover the following cases. Table-driven assertions may combine cases when the failure location stays clear.

### Start, dispatch, and cleanup

1. Execute calls `execute` once and not `restart`; restart passes the exact durable key and does not call `execute`.
2. The active entry exists before invocation. From an invocation hook, issue pause or stop and observe the call on the same handle.
3. A second start for the same canonical key is rejected without invoking its handle. Use a real temporary directory and platform-neutral `.`/`..` spellings to prove equivalent cwd spellings collide; `normalizeProjectPath` uses `realpathSync.native` only for existing paths and lowercases only on Windows. Distinct run ids or project roots do not collide.
4. A synchronous throw and an immediately rejected promise both resolve to `failed` and release admission.
5. A pending operation keeps completion pending. After settlement cleanup, the same key can be admitted again.
6. Fulfilled string, object, `null`, and `undefined` values are returned unchanged in `completed` settlements.

### Rejection classification

7. Test both duplicate forms: `RunAlreadyActiveError` and a plain object with exact stable code.
8. Test inspected `paused` and `stopped` statuses.
9. Test each non-terminal or non-control status class as failure: `created`, `running`, `pausing`, `completed`, and `failed`. Assert identity of the original operation error.
10. An inspection rejection still returns `failed` with the original operation error.
11. Duplicate classification does not inspect.

### Pause, stop, and shutdown

12. Pause routes both modes, returns `undefined` when inactive, and exposes both a synchronous handle throw and an asynchronous handle rejection as promise rejection without removing the active run.
13. Stop passes the exact reason, returns `false` when inactive, and propagates a synchronous handle throw without removing the run.
14. Invalid ids throw during pause and stop key derivation rather than looking inactive.
15. Shutdown calls stop on every captured conforming handle before waiting, returns run ids in map order, and stays pending until all captured operations settle.
16. A failed operation does not reject the shutdown drain or prevent another captured operation from draining.
17. Empty shutdown resolves immediately. A later start remains admissible, and a second shutdown observes the then-current set rather than returning cached metadata.
18. A synchronous stop throw during shutdown propagates. With a successful first handle and throwing second handle, assert that no metadata is returned; the adapter cannot emit the old first-handle notice. Record this accepted fake-only difference rather than adding result variants, a Pi callback, or partial-success semantics.

The earlier proposal's separate tests for background metadata, closed admission, concurrent shutdown coalescing, identity-safe replacement, and unavailable admission are deleted because the reduced module has no such behavior.

## Pi adapter tests

Refactor `.pi/extensions/workflows-engine/lib/commands.test.ts` around an injected fake `WorkflowRunControl`. Do not rebuild an active map or real handle lifecycle in these tests. Keep one narrow integration case with the production singleton to pin shared ownership and start-notice ordering across registrations.

Keep the two unrelated existing cases:

- an unreadable persisted source snapshot does not fall back to live source;
- a missing raw log reports `Run raw log not found: <runId>`.

Replace the two broad lifetime/restart cases with focused coverage:

1. Background start passes `background` only in adapter-owned presentation metadata, passes an `execute` operation to run control, emits the start notice before fake completion, returns before deferred completion, then publishes and notifies.
2. Foreground start does not resolve its handler until settlement rendering finishes.
3. Restart parsing passes the exact durable key and still prepares through `prepareExisting`.
4. Command-layer admission rejection and lower settlement duplicate both render the same exact warning.
5. Completed string, object, `null`, and `undefined` results preserve serialization and full message details. Include the `undefined` fallback. An unserializable result attempts the `Workflow failed` fallback and does not publish `workflow-result`.
6. Paused, stopped, and failed settlements render exact strings and severities. Non-`Error` failures use `String(error)`.
7. `pause`, `pause-now`, `stop`, and `cancel` send the exact calls. Cover pause inactive/rejected and stop inactive/thrown message differences.
8. Invalid pause/stop ids from a throwing fake reach the outer command failure message.
9. Shutdown passes the exact reason, emits one current warning per returned run id, swallows a notification throw, and waits for the drain. A throwing fake shutdown reaches the event listener as a rejection and emits no metadata-driven notice, including for any stop completed before the throw.
10. A background presentation throw is consumed by the attached terminal handler rather than becoming an unhandled rejection.
11. Two default registrations share the production controller: the first start notice precedes handle invocation, and the second registration receives command-layer duplicate rejection without invoking its handle.

Keep `.pi/extensions/workflows-engine/index.test.ts` unchanged. Its four tests already pin status and transcript-card rendering, including background metadata.

## Test registration and documentation

Add `extensions/workflows-engine/lib/workflow-run-control.test.ts` to the explicit Vitest list in `.pi/package.json`'s `test:workflows` script. Do not change the command's `&&` structure or the unrelated run-store expectation.

Update root `CONTEXT.md` under `Workflow runs`:

> **Workflow run control module** - `workflows-engine/lib/workflow-run-control.ts` owns the session-local active-run registry, execute/restart dispatch, pause/stop lookup, operation settlement classification, cleanup, and shutdown stop-and-drain behind `WorkflowRunControl`. The production singleton preserves one process-local command-control registry. `commands.ts` prepares runs and owns Pi notifications and result messages. The lower Workflow run lifecycle remains authoritative for durable execution, replay, persistence ordering, and its process-local lease.

Adjust the existing lifecycle entry only enough to distinguish durable-run behavior from command control. Retain the persistence and worktree entries. No ADR or README change is needed because this plan adds no command or user-facing behavior.

## Implementation sequence

1. Add the exact run-control types, factory, and production singleton.
2. Implement canonical admission, scheduled execute/restart dispatch, settlement classification, cleanup, explicit pause/stop methods, and non-closing shutdown drain.
3. Add the direct module tests and run them.
4. Inject `WorkflowRunControl` into command registration with the production singleton default.
5. Replace `runAndReport`, pause, stop, and shutdown map access with adapter calls.
6. Remove command-side active state and classification imports.
7. Refactor command tests around a fake run-control adapter while retaining source and raw-log cases.
8. Register the new test file in `.pi/package.json`.
9. Update `CONTEXT.md` after implementation names match this plan.
10. Review the diff for leaked Pi types, copied presentation metadata, duplicate settlement policy, changed strings, and unrelated edits.

Do not leave a compatibility wrapper beside the new module. Move the behavior and remove the old state in the same change.

## Verification ladder

Run from the repository root. In this checkout's Bash environment, `pnpm` cannot locate Node, so use Windows `cmd.exe` or another shell with Node on `PATH`.

1. `pnpm --dir .pi exec vitest run extensions/workflows-engine/lib/workflow-run-control.test.ts`
2. `pnpm --dir .pi exec vitest run extensions/workflows-engine/lib/workflow-run-control.test.ts extensions/workflows-engine/lib/commands.test.ts`
3. `pnpm --dir .pi exec vitest run extensions/workflows-engine/lib/workflow-run.test.ts`
4. `pnpm --dir .pi typecheck`
5. `pnpm --dir .pi test:workflows`
6. `pnpm --dir .pi test`

The new module, adapter, lifecycle, and typecheck steps must pass. If `test:workflows` still stops at the known `run-store.test.ts:52` separator failure, report it as pre-existing. When the Node tests run directly, the known `tests/runtime.test.mjs:743` CRLF failure is also permitted. Any other workflow failure blocks completion. On this Windows host the full repository suite stops earlier in `test:shared` on the verified unrelated platform failures; report the actual stopping point rather than claiming later suites ran.

## Risks and controls

- The command-layer and durable-run duplicate checks remain separate. Direct tests cover both admission rejection and lower duplicate settlement.
- Operation invocation moves to the next promise continuation. Adapter and module tests pin admission and start notice before invocation.
- Active lookup ends at operation classification rather than after synchronous Pi rendering. This avoids a release-token protocol for a re-entrant adapter with no current consumer; the plan records the timing change instead of falsely calling it exact preservation.
- Background settlement rendering is detached from the command handler. Attach an explicit terminal rejection handler for presentation failures.
- Failure inspection can mask the operation error if implemented carelessly. Assert original error identity for every non-duplicate failure class and inspection rejection.
- Shutdown can return before operations settle if it tracks the wrong promise. Drain the captured settlement promises and test two independently deferred operations. A later synchronous stop throw also loses notices for earlier stops under the reduced interface; this accepted fake-only difference is pinned rather than hidden.
- A per-registration default would silently change cross-registration behavior. Default to `productionWorkflowRunControl`, not `createWorkflowRunControl()`.
- Combining pause and stop would erase their current error differences. Keep separate methods and adapter branches.
- Adding a shutdown state would create behavior with no caller. Do not add closed admission, unavailable results, or drain coalescing.
- Pi metadata does not belong in active state. Keep workflow name and background mode in `commands.ts`.
- Worktree and persistence changes are out of scope. The final diff must not touch those files.

## Definition of done

- `workflow-run-control.ts` owns the active map, execute/restart dispatch, pause/stop lookup, operation classification, cleanup, and shutdown drain.
- Its interface is exactly `start`, `pause`, `stop`, and `shutdown`; it exposes no active handle or query.
- `commands.ts` owns Pi effects and contains no active map or operation-failure inspection.
- Production registrations share `productionWorkflowRunControl`; direct tests use fresh factories.
- All current command strings, severities, aliases, serialization, result details, and foreground/background waiting behavior remain unchanged.
- No closed-admission or unavailable behavior is added.
- Direct tests cover the complete admission, status, control, error, and shutdown taxonomies listed above.
- Adapter tests cover parsing, waiting, exact rendering, shutdown adaptation, and detached presentation failures without recreating run-control state.
- `test:workflows` explicitly names the new test.
- `CONTEXT.md` distinguishes command control from durable lifecycle.
- Focused tests and typecheck pass.
- The two verified Windows-only separator/newline failures are the only permitted Workflow test failures if they remain unchanged.
