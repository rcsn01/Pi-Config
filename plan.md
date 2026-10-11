# Session-owned Subagent execution implementation plan

## Status and scope

This is the finalized design for architecture candidate 1, now implemented after separate user authorization. The user requested a prerequisite commit, implementation, and a second commit. The planning baseline is commit `48793cb`, including the earlier background-Subagent implementation. The baseline analysis and inventories below describe that commit, not the completed refactor. Implementation results appear at the end.

Use the recommended decisions recorded here. No clarification or design-confirmation round remains open.

The refactor moves Session and branch lifetime ownership out of the Pi extension entry point and into a Session-owned Subagent execution module. It preserves public tool schemas, the cross-extension interface, foreground execution, result semantics, Plan Mode restrictions, and the existing per-instance process budget. Readiness and inactive-control behavior intentionally tighten; the command diagnostic exception is specified below.

Do not combine this work with either of the other architecture candidates:

- Do not redesign child-process termination, stream draining, or process settlement.
- Do not build a shared result/report projection module or redesign output schemas.

Do not edit `.pi/pi-config.json`, `.pi/profiles/openai.json`, or live `.pi/settings.json`. Preserve all pre-existing source changes. Do not stage or commit anything unless separately requested.

## Why this seam needs to move

The existing run manager already owns substantial behavior. `subagent-runs.ts` holds records, immutable snapshots, per-run cancellation, waiting, validation, retention, and bounded disposal. `subagent-execution.ts` owns launch preparation and the aggregate scheduler. These are useful deep modules and should remain separate implementations.

The missing depth is above them. `tools-subagents/index.ts` currently owns generation, owner context, manager creation, notification gating, admission, a status timer, cleanup coalescing, branch replacement, and shared-interface registration. A caller must understand these variables together to change one lifetime rule safely.

Current evidence:

| File | Relevant behavior |
| --- | --- |
| `.pi/extensions/tools-subagents/index.ts` | `ensureManager`, `cleanup`, background routing, branch reset, and two shutdown handlers |
| `.pi/extensions/tools-subagents/subagent-runs.ts` | Whole-batch preflight, admission limits, retained records, wait/cancel, and six-second cleanup |
| `.pi/extensions/tools-subagents/subagent-execution.ts` | Awaited terminal execution and one aggregate FIFO scheduler per execution instance |
| `.pi/extensions/tools-subagents/background-notifications.ts` | Caller-supplied `isCurrent`, delivery suppression, and sent-ID tracking |
| `.pi/extensions/tools-subagents/run-tools.ts` | Control-tool handlers receive the full run manager |
| `.pi/extensions/tools-subagents/model-commands.ts` | `/subagents runs` and `/subagents cancel` obtain the full run manager |
| `.pi/extensions/_shared/session-profile-binding.ts` | Ordered initialization, reverse disposal, failure isolation, and `afterStop` fallback |
| `.pi/extensions/_shared/subagent-service.ts` | Shared registration with identity-safe removal |
| `.pi/extensions/workflows-plan/plan-lifecycle.ts` | Awaited background cancellation before Plan entry and capability checks during entry/active Plan |

The current extension test harness stores one handler per event in a `Map`. A second registration replaces the first. Its shutdown tests therefore do not exercise the real host's ordered dispatch of both handlers. Fix this harness before relying on it to establish lifecycle behavior. The shared binding wiring test also uses a single-handler map, but registers one handler per event in that fixture. It does not currently prove behavior with duplicate registrations; do not expand that fixture unless a new test actually needs multiple handlers.

The source establishes the stale-context hazard independently of historical reports: `index.ts` schedules a captured-context timer, installed `AgentSession.dispose()` invalidates runner contexts without emitting shutdown, and the integration teardown calls `dispose()` alone. Retain the safeguard against stale SDK getters and move the decision about effect eligibility inside the owning module.

### Independently checked baseline inventory

These inventories were derived with source reads, `rg`, and Vitest's expanded JSON test report, not copied from earlier plan counts. Paths below are relative to `.pi/extensions/` unless stated otherwise. Numbers describe the historical planning baseline at `48793cb` only.

| Production site and symbols | Count and behavior to preserve or move |
| --- | --- |
| `tools-subagents/index.ts`: `createSubagentsExtension`, `ensureManager`, `cleanup`, `service`, Profile adapter, `session_tree`, `model_select`, tool `execute`/`prepareArguments` | Seven lifetime variables: `generation`, `owner`, `manager`, `notifications`, `refreshTimer`, `stopping`, `admissionClosed`. Two facade registrations, at loading and initialization. Two shutdown registrations, wiring and standalone. Three owner-producing paths: public background submission, the run-tool manager factory, and tree replacement. One command manager accessor. One 150 ms status timer. Four tools, one command, one optional message renderer. Public export functions remain untouched. |
| `tools-subagents/subagent-runs.ts`: `createSubagentRunManager`, `SubagentRunSnapshot`, `SubagentRunStatus`, `isTerminalRun`, `immutable`, `getRecord`, `changed`, `evict` | Manager methods are `spawn`, `list`, `get`, `validateIds`, `wait`, `cancel`, `cancelAll`, `close`, `dispose`. Six statuses, three terminal. `spawn` checks closed, caller abort, task count, unfinished capacity, preparation, each task/cwd/tool diagnostic, caller abort again, then inserts records. Records have independent controllers. `wait` holds record references; disposal aborts subscriptions. Terminal eviction keeps 100 by timestamp and stable insertion tie order. `cancelAll` drains captured completions with one 6000 ms race. |
| `tools-subagents/subagent-execution.ts`: `SubagentExecution`, `RunSubagentBatchOptions`, `PreparedSubagentBatch`, `createSubagentExecution`, `runOrdered`, `executePreparedSubagent`, result/event clone helpers | Five execution methods: `prepareBatch`, `runPrepared`, `runSubagent`, `runBatch`, `runSubagentsParallel`. One aggregate scheduler per factory and a separate module-level compatibility factory. Config reloads update that instance's budget. Local batch scheduling can lower concurrency, not increase aggregate concurrency. Preserve awaited progress, synthetic-failure conditions, original rejection identity and ordered results. |
| `tools-subagents/execution-scheduler.ts`: `createSubagentExecutionScheduler`, `drain`, `setLimit`, `run`, queue `abort`/`start` | FIFO applies to requests actually enqueued in the aggregate scheduler. A locally queued batch sibling has not reached that queue yet. Lowering a limit leaves already-active children alone; raising it drains existing queued requests immediately. Running slots release in `finally`; queued abort removes a request before launch. |
| `tools-subagents/launch-preparation.ts`: `prepareSubagentLaunches`; `cache-affinity.ts`: `deriveSubagentSessionId`; `config.ts`: `SubagentConfigStore`, `createSubagentConfigStore`, `parseSubagentExtensionConfig`, `resolveLaunchBatch`, model/thinking resolution and assignment helpers | Agent lookup precedes whole-batch model resolution. Launch assignments and cache IDs are resolved before queueing, not re-read at launch. Empty preparation skips lookup/assignment, but execution still loads concurrency config. Cache namespace is owning Session plus resolved model, not branch/run ID. Cwd directory checks occur only in background manager preflight. Preserve configuration edit/picker behavior rather than moving it into lifetime ownership. |
| `tools-subagents/subagent-invocation.ts`: `createSubagentInvocationAdapter`, `isFailedSubagentResult`, `createCancellableThrottle` | Foreground adapts one-task/batch results and owns a separate 150 ms parallel-progress throttle. Only progress `failed` sets its failure flag. Its `finally` disables snapshots and clears throttled updates. The Session status timer move must not remove or alter this separate throttle. |
| `tools-subagents/background-notifications.ts`: `createSubagentBackgroundNotifications`, `disable`, `complete` | One production constructor call. Delivery checks enabled/current/Session/sent ID, records attempts before synchronous send, and contains send exceptions. Six expanded tests cover busy/idle request shape, failed/cancelled outcomes, stale/disabled suppression and send failure. Move these assertions, not a new delivery queue. |
| `tools-subagents/run-tools.ts`: `RunSnapshotSchema`, `RunDetailsSchema`, `formatRunReports`, `structuredRunDetails`, `runToolResult`, `registerStructuredTool`, `registerSubagentRunTools` | Three manager-factory call sites, one in each control tool. Status without a truthy `runId` lists summaries; empty string also lists. Status with ID retrieves; wait preserves ID order; cancel acknowledgement does not set `isError`. Text and structured output have distinct truncation paths; renderer details retain full snapshots. Keep all schema and formatting code. |
| `tools-subagents/model-commands.ts`: `ModelCommandDependencies`, `createSubagentsCommand` | Two `getRuns` calls, in `runs` and `cancel` branches. The optional factory distinguishes no manager from an empty manager, unlike a stable restricted object. Preserve other command paths: `statusLines`, `modelStatusLines`, `targetSelection`, `validateAvailableModel`, model/thinking edits, target/model/thinking selectors, catalogue lookup and `runInteractiveModelCommand`. |
| `tools-subagents/child-execution.ts`: `SubagentChildExecution`, `inspectTools`, `execute`, `resolveChildTools`, `formatChildToolDiagnostic`, `buildPiArgs`, `withTimeoutSignal`, `removeTempDirectory`; `child-event-ingestion.ts` and `_shared/child-process.ts` | Reuse diagnostic and process behavior. Tool diagnostics cover unmapped tools, missing mapped extensions and missing mandatory runtime extension. Repeated tool declarations retain diagnostic order while extension paths deduplicate; path-check exceptions propagate. Abort/timeout, partial output, process error, progress rejection, long-task temporary files and bounded kill/pipe drain are existing contracts, not new Session responsibilities. |
| `tools-subagents/progress-renderer.ts`: `renderAgentProgress`, `renderSubagentCall`, `renderSubagentResult`; `formatting.ts` and `subagent-timing.ts` | Preserve foreground/background details, run IDs, six manager statuses, authoritative child progress, collapsed/expanded presentation, width/output bounds and timing diagnostics. No shared report-projection refactor. |
| `_shared/subagent-service.ts`: `SubagentService`, `registerSubagentService`, `getSubagentService`, `requireSubagentService` | Same-ID registration replaces by object identity; different ID is rejected; returned unregister removes only that exact object. ID validation is lowercase alphanumeric plus hyphen with an alphanumeric first character. The new factory uses fixed `tools-subagents`; invalid-ID tests belong to the existing shared registry, not a nonexistent factory ID argument. |
| `_shared/session-profile-binding.ts`: `SESSION_PROFILE_ADAPTER_ORDER`, `registerSessionProfileBinding`, `wireSessionProfileBinding`, `runInitialization`, `beginInitialization`, `runCleanup`, `beginCleanup` | Seven ordered adapter names, verified at the seven adapter registrations. All paths apply before initialization. Path failure skips that adapter; initialization attempt is recorded before await. Binding resolution can reject before a run exists. Cleanup waits active initialization and disposes attempted adapters in reverse, isolating failures. Wiring always calls `afterStop`, then identity-safe Profile unregister, with nested-finally error precedence. |
| `workflows-plan/plan-lifecycle.ts`: `enterPlanModeInternal`, `runModeTransition`, `toolCall` dispatch; `workflows-plan/index.ts` Profile/tree wiring | One awaited optional shared background-cancellation call, before defaults capture. Capability guard applies while entering and active, independently of `background`. Seven exact allowed capability names. Registered empty-tool/nonstandard-name agents pass; `default`, unknown agents, empty task arrays and any disallowed capability fail. Two test declarations currently cover policy and cancellation; cancellation expands to success/failure cases. |
| Repository-pinned SDK 0.87.0 and installed CLI SDK 1.0.0 `dist/core/extensions/{loader,runner}.js`, `dist/core/agent-session.js`, extension/session declarations | `on` appends ordered handlers and returns unsubscribe; generic `emit` snapshots and awaits them, reports failures and continues. `onError` is public. `dispose` is synchronous context invalidation, not shutdown emission. `navigateTree` refuses streaming/compacting, returns early for same leaf, rejects missing target, honors before-tree cancellation, commits the branch and then awaits tree emission. Void `sendMessage` starts async message work with runner error reporting. These contracts were checked in both versions. CLI 1.0.0 `AgentSessionRuntime.teardownCurrent` awaits parent abort, emits shutdown, then disposes; its `dispose` emits shutdown before invalidating. Tests resolve the pinned 0.87.0 package, not this CLI installation. |
| `tools-subagents/test-harness.ts`, `background-test-harness.ts`, `index.test.ts` harness | Existing memory stores, registry, deferred gates, fake child processes and `runHarness` are reusable. The index harness has seven direct `handlers.get(...)` invocation sites. Five invoke start, one shutdown, one parameterized tree/shutdown. Its map drops the earlier shutdown handler. Real-host integration has one parameterized test declaration, two cases, and dispose-only teardown. |

Expanded test cases independently counted from the JSON report:

| Test file | Cases | Coverage disposition |
| --- | ---: | --- |
| `tools-subagents/index.test.ts` | 22 | Correct ordered dispatch/startup/teardown; keep exports, restrictions, config, foreground and background assertions |
| `tools-subagents/background-integration.test.ts` | 2 | Preserve actual RPC/TUI busy and idle behavior; extend lifecycle/navigation coverage |
| `tools-subagents/background-notifications.test.ts` | 6 | Migrate behavior then remove |
| `tools-subagents/run-tools.test.ts` | 4 | Adapt controls; preserve output/schema/flags |
| `tools-subagents/model-commands.test.ts` | 28 | Adapt dependency; preserve configuration/picker and existing-run behavior |
| `tools-subagents/subagent-runs.test.ts` | 9 | Keep record/preflight/abort/capacity/wait/retention/terminal/local-limit tests |
| `tools-subagents/subagent-execution.test.ts` | 21 | Keep config, ordering, callbacks, error identity and shared budget tests |
| `tools-subagents/execution-scheduler.test.ts` | 3 | Keep FIFO, abort/rejection release and dynamic-limit tests |
| `tools-subagents/launch-preparation.test.ts` | 5 | Keep whole-batch lookup/resolution, snapshots and empty preparation |
| `tools-subagents/subagent-invocation.test.ts` | 8 | Keep foreground adaptation, failure flags and throttle cleanup |
| `tools-subagents/child-execution.test.ts` | 31 | Keep admission, launch, abort/timeout, process settlement, output and temporary-resource tests |
| `tools-subagents/child-event-ingestion.test.ts` | 20 | Keep child outcome/stream observation contracts |
| `tools-subagents/progress-renderer.test.ts` | 14 | Keep foreground/manager status, width and timing presentation |
| `tools-subagents/config.test.ts` | 94 | Keep storage, assignment, model/thinking and migration contracts |
| `tools-subagents/agent-registry.test.ts` | 4 | Keep discovery/registration contracts |
| `tools-subagents/cache-affinity.test.ts` | 3 | Keep Session/model namespace and input validation |
| `tools-subagents/formatting.test.ts` | 5 | Keep display formatting |
| `tools-subagents/subagent-timing.test.ts` | 3 | Keep diagnostic aggregation |
| `tools-subagents/repo-query.test.ts` | 14 | Unchanged adjacent Subagent suite coverage |
| `_shared/session-profile-binding.test.ts` | 26 | Keep ordering/failure/replacement and wiring-finally tests |
| `_shared/subagent-service.test.ts` | 3 | Keep registration/replacement/competing runner tests; add invalid-ID boundary cases here, not to the fixed-ID factory |
| `workflows-plan/plan-lifecycle.test.ts` | 38 | Keep lifecycle/policy tests; add real-facade integration and missing policy boundaries |
| **Total, 22 current files** | **363** | **All passed in the audit run; no future `session-execution.test.ts` cases included** |

The 19 current Subagent files total 296 cases. The other three inventoried files add 67. These counts distinguish parameterized cases from declarations and do not claim new race tests already exist.

## Final decisions

| Question | Selected answer and reason |
| --- | --- |
| What owns background lifetime? | A Session-owned Subagent execution module, internally composed from the existing execution and run-record modules. It owns every transition that affects admission or delivery. |
| What remains in `index.ts`? | Pi event/tool/command registration, parameter normalization, public-agent restrictions, Profile configuration preparation, rendering, and concrete message/UI effects. |
| Does this replace terminal execution? | No. Keep `SubagentExecution`, its exported compatibility functions, and its existing awaited contracts. |
| Does the new module expose the manager? | No. Callers get a restricted run-control interface. They cannot close/dispose the registry, obtain controllers, or supply a currency predicate. |
| How does a branch become a new owner? | On receipt of the branch callback, revoke the old owner synchronously, await bounded disposal, then install a fresh owner with a lazy fresh registry, provided Session preparation succeeded. Session ID alone is insufficient because tree navigation keeps it unchanged. |
| What happens on cleanup timeout? | Propagate the failure. A failed branch replacement does not admit new work. Shutdown still clears local resources and unregisters its own shared facade. |
| Who owns Plan policy? | Plan Mode lifecycle. It retains its existing checks and calls `cancelBackgroundRuns` through the existing shared interface. |
| Does Plan cancellation destroy retained runs? | No. It temporarily gates new background admission while cancelling and draining current work. It retains the owner and records. |
| When is the shared facade available? | During extension loading, before `session_start`, as today. Agent registration must remain available to sibling extensions. |
| How many shutdown handlers does Subagent register? | One, through `wireSessionProfileBinding`. Adapter disposal and `afterStop` call the same idempotent shutdown operation. |
| Does cleanup continue if Profile initialization fails? | Yes. `afterStop` runs even when binding resolution or path application prevented adapter initialization/disposal. |
| Do shutdown reports wake the parent? | No. Eligible shutdown cancellation reports use `triggerTurn: false`. Ordinary terminal reports keep `triggerTurn: true`. |
| Is a new global scheduler required? | No. All foreground and background work for this extension instance continues to share its existing execution scheduler. |
| Are new dependencies required? | No. Use existing interfaces, native promises/abort signals/timers, and Vitest fake timers. |

Three interface shapes were considered:

1. A closeable background registry factory with Pi-owned generation and notifications. This changes file placement but leaves lifetime ordering with callers. Reject it.
2. A generic operation dispatcher covering execution, status, waiting, cancellation, configuration, and host effects. This needs many event variants and conditional return types. It obscures common callers without reducing their knowledge. Reject it.
3. A typed lifecycle interface, a background submission method, and a restricted run-control interface. Select this shape. It concentrates ownership while keeping each caller's operation explicit.

Use the existing domain term "Subagent execution module". The new Session-owned implementation is part of that module's composition, not a new domain concept requiring a glossary entry during planning. Update the existing `CONTEXT.md` definition during implementation to describe its added ownership. Do not claim the planned implementation already exists.

## Intended composition

```text
Pi extension adapter: index.ts
  | lifecycle events and concrete host effects
  | background submission and restricted run controls
  v
Session-owned execution: session-execution.ts
  | one current owner, retirement, admission, delivery, timers
  | identity-safe shared facade registration
  +--> subagent-runs.ts
  |      records, snapshots, wait/cancel, retention, bounded disposal
  |
  +--> subagent-execution.ts
         launch preparation, aggregate scheduling, terminal execution
           +--> child-execution.ts
                  existing process and stream implementation

Plan Mode lifecycle
  --> existing SubagentService.cancelBackgroundRuns
      --> Session-owned execution cancellation operation
```

Create `.pi/extensions/tools-subagents/session-execution.ts` with `createSubagentSessionExecution`. Keep it internal to the extension package. Do not re-export the new factory from the public extension entry point.

Construct exactly one existing `SubagentExecution` instance per extension instance. Use it for the invocation adapter, the registered awaited execution methods, and every background registry created across that instance's branches. Branch replacement must not create another aggregate scheduler. The module-level compatibility instance in `subagent-execution.ts` remains separate; direct exported helpers do not share the extension instance's budget. Do not document a global budget across those instances.

### Interface sketch

The following shapes specify the seam. They are not authorization to implement it now. Reuse existing imported types rather than copying their definitions.

```ts
interface SubagentSessionHost {
  readonly sessionId: string;
  getSessionId(): string;
  setStatus(status: string | undefined): void;
  publishCompletion(
    run: SubagentRunSnapshot,
    options: { triggerTurn: boolean },
  ): void;
}

type SubagentSessionEvent =
  | {
      type: "sessionStarted";
      host: SubagentSessionHost;
      prepare: () => void | Promise<void>;
    }
  | { type: "branchChanged"; host: SubagentSessionHost }
  | { type: "shutdown"; reason: string };

interface SubagentRunControl {
  list(): SubagentRunSnapshot[];
  get(runId: string): SubagentRunSnapshot;
  wait(
    runIds: readonly string[],
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<SubagentRunSnapshot[]>;
  cancel(
    runIds: readonly string[],
    reason?: string,
  ): SubagentRunSnapshot[];
}

interface SubagentSessionExecution {
  handle(event: SubagentSessionEvent): Promise<void>;
  spawn(
    tasks: readonly SubagentExecutionTask[],
    options: Pick<RunSubagentBatchOptions, "cwd" | "signal">,
  ): SubagentRunSnapshot[];
  readonly runs: SubagentRunControl;
}
```

Factory dependencies are the existing execution instance, the existing agent registry's register/unregister/load methods, and the existing child tool-inspection method. Keep these dependencies narrow with `Pick` where suitable. The factory uses the existing in-process shared registration functions directly. Tests can exercise the real shared registry with isolated setup and teardown; no new shared-registry abstraction is needed.

The module constructs the existing `SubagentService` facade internally. Its registry and awaited execution methods delegate to existing implementations. Its `cancelBackgroundRuns` delegates to the module's private cancellation operation. The facade stays reachable through the existing shared registry, not through another public accessor on the new interface.

`spawn` derives both `sessionId` and the cache-affinity seed from the current owner. Callers must not provide independently selected ownership IDs. Other launch semantics remain with existing preparation and execution.

The host adapter captures the Session ID when its lifecycle adapter callback is invoked, before calling `handle`, not necessarily at raw Pi event entry, and supplies a getter backed by `ctx.sessionManager.getSessionId()`. The module catches stale-getter exceptions and decides whether an effect is eligible. Do not accept `isCurrent` from callers.

Do not compare the Session's current leaf ID to a captured leaf ID. Normal messages and entries advance the leaf. Branch ownership changes only through the lifecycle event and private owner replacement, not through ordinary history growth.

Host effects have synchronous, void-returning contracts. `ctx.ui.setStatus` is synchronous; installed `pi.sendMessage` starts asynchronous `sendCustomMessage` work and routes later rejection to the runner's error listener. A synchronous return is not acknowledgement of delivery. Catch synchronous adapter failures locally, and use runner error reporting to test asynchronous host failures. Do not introduce an unbounded asynchronous effect queue or await message delivery as part of child execution. Tests should use synchronous recording adapters for these effects.

### Pi adapter example

```ts
const sessionExecution = createSubagentSessionExecution({
  execution,
  registry,
  childExecution,
});

const profileInitialization = registerSessionProfileBinding(
  { settingsPath },
  {
    name: "tools-subagents",
    applyPath: (binding) => configStore.setSettingsPath(binding.settingsPath),
    initialize: (_binding, _event, ctx) => {
      const mainModel = ctx.model;
      return sessionExecution.handle({
        type: "sessionStarted",
        host: sessionHost(ctx),
        prepare: async () => {
          configStore.rememberMainModel(mainModel);
          await configStore.migrateLegacy();
          configStore.load();
        },
      });
    },
    dispose: () => sessionExecution.handle({
      type: "shutdown",
      reason: "Session ended",
    }),
  },
);

wireSessionProfileBinding(pi, profileInitialization, {
  afterStop: () => sessionExecution.handle({
    type: "shutdown",
    reason: "Session ended",
  }),
});

pi.on("session_tree", (_event, ctx) => sessionExecution.handle({
  type: "branchChanged",
  host: sessionHost(ctx),
}));

registerSubagentRunTools(pi, sessionExecution.runs);
```

Keep `sessionHost` local to the Pi adapter. It formats a completion using the current `formatRunReports` implementation and sends the existing `subagent-completion` message shape with `deliverAs: "followUp"`. The module selects `triggerTurn`; the adapter does not choose whether an owner is current.

The `prepare` callback keeps Profile/configuration semantics with the existing adapter. The new module determines when to call it: after retiring an existing owner and before opening admission. A preparation failure leaves background admission closed and propagates through the Profile binding. Capture the main model when the Profile adapter's `initialize` callback is invoked, before passing `prepare`, rather than reading a possibly stale context after retirement awaits. This is not necessarily raw Pi event entry: shared Profile initialization can await earlier adapters first.

## Ownership and transitions

Use an explicit internal state representation. Do not reproduce the seven independent lifetime variables from `index.ts` as another loosely coupled group of flags.

The implementation needs to represent unbound/preparing, active, retiring, failed retirement, and stopped states. An active owner holds its host, optional lazy manager, sent-ID set, optional refresh timer, and optional cancellation drain. Owner object identity establishes callback currency; pending replacement requests have monotonically increasing revisions. Do not add a second numeric owner-generation counter for the same purpose. A retirement holds the detached old owner and its bounded disposal promise. Retain pending preparation separately until it settles so a branch request cannot bypass readiness or overlap configuration preparation.

These are implementation details. Tests assert admissions, results, effects, and settlement through the interface, not state tags, owner identities, or numeric revision values.

| Operation | Immediate action before any await | Awaited work | Successful outcome |
| --- | --- | --- | --- |
| Construction | Register the facade; do not start timers or children | None | Unbound and background admission closed |
| Session start | Claim a transition revision, close old admission, revoke old delivery | Retire an old owner if present; settle any earlier preparation; recheck currency before running Profile preparation | Active owner after successful current preparation |
| Background spawn | Check active/current owner and temporary admission gate | None for acknowledgement | Return immutable accepted handles |
| Ordinary completion | Check owner, facade identity, Session ID, and sent-ID set | None in notification path | One best-effort follow-up with `triggerTurn: true` |
| Branch change | Claim a replacement revision; close admission, revoke delivery and shutdown-report permission, clear timer, detach old owner | Dispose old registry within its existing bound; join pending preparation when necessary | Fresh owner with a lazy fresh registry on the destination branch, only after successful preparation |
| Plan cancellation | Temporarily gate background admission for the current owner | Cancel and drain current unfinished work | Same owner and retained results; release the temporary gate |
| Shutdown | Mark this instance permanently stopped, close admission, revoke delivery, clear timer | Join/start retirement, attempt eligible final reports | Clear eligible UI and unregister this exact facade in `finally` |

### Start and readiness

The facade is registered once during factory construction. Do not register it again from Profile initialization. Re-registering an older facade after a newer extension factory has registered its replacement can overwrite the replacement.

Background work requires successful Session preparation. Once `sessionStarted` reaches the module, configuration migration/loading must not use the previous Session's owner or partially initialized settings. Shared Profile binding applies all paths and can await earlier adapters before invoking Subagent initialization. A defensively repeated raw host start therefore has the same pre-callback admission interval as other ordered host events; this module cannot revoke an old owner before receiving its callback. Normal host replacement emits shutdown first. Foreground compatibility methods keep their existing contracts and are not newly gated by background readiness.

If Session start encounters an existing owner, retire it before preparing the new Session. This handles a repeated start defensively without silently dropping its registry. A preparation rejection leaves the instance unbound for background work and available for shutdown cleanup.

Before invoking `prepare` after any await, check stopped state, facade identity, and whether a newer Session-start superseded that preparation request. Installation revisions select the newest destination; a branch revision must not cancel the required Session preparation just because it changes that destination. Serialize preparation callbacks because they mutate the same config store. An already-running callback cannot be cancelled, but must settle before another preparation starts. A branch received while start is retiring or preparing joins that start's required preparation and may select the newest destination host only if the callback actually ran and succeeded. A resolved superseded `handle` is not proof of readiness. A branch received before any successful or pending preparation, or after preparation failure, rejects with the no-active-session error and does not activate an owner. Test a branch arriving both before `prepare` invocation and during its await. Superseding a start cannot substitute for its required preparation.

Shutdown is terminal for that extension instance. A late start, branch callback, or preparation completion must never reopen it. A new loaded extension instance supplies the replacement facade. Direct module shutdown does not await an arbitrary `prepare` callback; invalidate activation immediately and unregister through its bounded retirement path. Test a never-settling preparation as well as a late resolved/rejected one.

### Admission and retained records

Create the run manager lazily once an active owner first needs it. Listing an active owner with no manager returns an empty list without launching anything. Getting, waiting for, or cancelling an unknown ID must use the existing unavailable-ID error semantics.

Controls during retirement must not retrieve the detached manager. Already-started pending wait subscriptions stay attached to the old manager and are rejected by its disposal signal; waits already resolved or synchronous zero/terminal polls are not retroactively rejected. A new control call cannot reach records from a previous branch or runtime. Apply current-facade and usable-host checks to controls as well as spawn/effects. A replaced facade or stale getter cannot authorize access merely because the old module still has an active-owner slot; retain its manager privately for cleanup, not caller retrieval.

Listing in the initial unbound or preparing state returns an empty list for both human commands and the status tool. Run-requiring controls in those states reject with `No active background subagent session.`. During retirement, failed retirement, or shutdown, every control including list rejects with the cleanup admission-closed error. An active owner creates its lazy manager for get/wait/cancel, preserving manager validation and unavailable-ID errors. Do not add a lazy owner fallback to the Pi adapter.

Keep `createSubagentsCommand`'s controls dependency optional, but replace its manager factory with a direct `Pick<SubagentRunControl, "list" | "cancel">`. Without that dependency, `/subagents runs` still lists nothing and `/subagents cancel` still reports `No active background subagent runs.`. With the extension's stable controls supplied, cancellation uses the control's no-active/closed/unavailable error rather than preserving a separate diagnostic for 'active owner but manager never constructed'. This small intentional diagnostic change avoids exposing manager creation state or adding a second command-only control interface. All existing-run command behavior remains unchanged.

Keep current admission and retention limits:

- One through 32 background tasks per invocation.
- At most 64 unfinished background runs.
- At most 100 retained terminal records.
- Whole-batch preflight before any child or retained record from that invocation is admitted. `prepareBatch` updates the aggregate scheduler limit before cwd/tool inspection, so a rejected invocation can still release previously queued work. Do not claim preflight is side-effect-free for other invocations.
- One through 32 unique IDs for wait/cancel.
- Wait defaults to 30,000 ms; accepted range is zero through 300,000 ms.

Accepted runs use their own abort controllers. Aborting the submitting tool after acknowledgement does not cancel them. Aborting a wait cancels only that subscription. Preserve the second pre-admission abort check after tool inspection. Queued handles are captured before scheduled state updates, but children can already be running when `spawn` returns; acknowledgement does not defer launch.

For an active owner, delegate get/wait/cancel validation to the real lazy manager, creating it if needed, rather than substituting early unavailable-ID errors. `wait` validates ID count/uniqueness and availability before timeout, then caller abort, then disposal abort. Empty/33-ID/duplicate requests fail validation; an unavailable ID wins over an invalid timeout or pre-aborted wait. Zero and terminal-only waits still check both abort signals. Existing waits retain record references through eviction and return in requested order; only pending subscriptions are rejected by disposal. Completed waits cannot be retroactively rejected.

Preserve terminal precedence: manager-controller abort produces `cancelled`; otherwise a rejection, including `undefined`, or result progress `failed` produces `failed`; otherwise the run completes. Cancelling an already-terminal record is a no-op. Cancellation retains returned partial output, while execution rejection stores error text without inventing a result. These manager rules do not redefine the child progress status.

### Currency and host effects

Normal effect eligibility requires all of the following:

1. The owner is still the active owner of this module.
2. No retirement/shutdown has revoked that owner.
3. The currently registered shared facade is this module's exact facade object.
4. The host getter returns the captured Session ID without throwing.
5. A completion snapshot carries that same Session ID.

Checking facade identity also prevents an old extension instance from updating UI or delivering into a replacement runtime that has already registered a new facade. Identity-safe unregister remains mandatory.

Check eligibility immediately before every normal status update and completion effect. A delayed timer or child callback must close over its specific owner, not read whichever manager happens to be current later.

Catch stale SDK getter failures and effect failures locally. A failed notification or UI effect must not change a terminal result, delete a record, reject child execution, or create an unhandled rejection. Do not silently swallow disposal or preparation failures under this rule.

Retirement clears the timer synchronously. The existing 150 ms refresh delay remains unchanged. Count `running` and `cancelling` as running, and `queued` as queued. Keep the existing status text and the `subagents` status key.

Clear the old status after retirement only while its host remains usable and the facade has not been replaced. Clear before installing a replacement owner so old cleanup cannot erase its new status. Shutdown uses the same guarded, best-effort clearing rule.

Do not add a polling timer for stale contexts. The embedding SDK caller must emit shutdown before disposing its runtime. A currency check prevents stale effects; it is not a substitute for a lifecycle event that owns process cleanup.

### Retirement and races

Coalesce repeated retirement calls for the same owner onto one disposal promise. Admission closure and revocation happen before that promise's first asynchronous suspension.

Keep the six-second drain in the existing run manager. Do not add another sequential six-second timeout around it. Do not wait for a pending Plan cancellation to settle before beginning disposal; disposal must close the manager and abort wait subscriptions immediately.

Concurrent Plan cancellation and disposal may use the manager's existing independent waits over the same child completions. They must not launch another process, multiply cancellation controllers, or extend retirement by awaiting one drain and then starting another. A manager-wide cancellation-promise refactor is unnecessary for this candidate.

Specific race rules:

- If shutdown arrives during branch retirement, it upgrades the module's intent to stopped immediately. It joins the retirement, unregisters in `finally`, and prevents the branch callback from reopening admission.
- If another branch change arrives during retirement, only the newest replacement revision may install its owner. Superseded callbacks await the same retirement and return without installing theirs.
- If shutdown reaches the module during Session preparation, completion of `prepare` cannot activate an owner. Check preparation-request currency, facade identity, and stopped state before invocation, then the newest destination revision and stopped/facade currency after the await. The Profile wiring's host-level timing limitation is recorded below; do not describe direct interface race tests as proving immediate host shutdown during Profile initialization.
- If old child progress/completion arrives after revocation, the old manager may finish its own record, but no normal notification or status effect may escape.
- If old cleanup runs after a newer facade has registered, its unregister callback must leave the newer facade intact. It must not clear the newer facade's UI status.
- If disposal fails, propagate its error and keep background admission closed. Do not publish a fresh owner over a still-unsettled old registry.
- Before shutdown only, a later explicit Session-start or branch-change operation may retry a failed retirement through the same retained old-manager reference. It may install a replacement only after that retry succeeds and Session preparation requirements are met. Once stopped, no event retries retirement or reopens admission. Do not retry automatically or discard the reference on timeout.
- A first shutdown encountering an already failed retirement preserves that failure, performs its final resource/unregister cleanup, and does not automatically start another drain. Shutdown repeats do not retry or extend cleanup indefinitely. Repeated calls join the same settled shutdown operation and observe the same outcome.

Keep the retirement's old-manager reference private. Do not expose a recovery method, manual generation token, or caller-controlled reopen switch. The sent-ID set remains per-owner and can grow beyond the 100 retained results during a long branch lifetime, as today; clearing an owner drops it. Do not claim terminal retention also bounds deduplication memory or build persistent acknowledgement/recovery machinery for it.

### Completion and shutdown reporting

Move delivery ownership and the sent-ID set into `session-execution.ts`. A normal completion records its ID as attempted before calling the host. Preserve at-most-once attempts and retained results when delivery fails. Do not add automatic retry or acknowledgement tracking.

The existing `background-notifications.ts` helper becomes redundant once caller currency, enabled state, and deduplication move together. Remove it and migrate its behavioral coverage. This deletion follows ownership, not a file-count target. Keep current formatting in `run-tools.ts` and rendering in `progress-renderer.ts`.

For a normal shutdown:

1. Capture IDs of unfinished runs from the active owner before disposal.
2. Revoke normal delivery and start bounded disposal.
3. After successful disposal, use the terminal snapshots captured by the retiring owner's `onTerminal` callback for those IDs. Keep this shutdown-only capture bounded by the 64 unfinished-run limit. Do not rely on `manager.get(id)` after disposal: eviction sorts by `finishedAt` alone, so equal timestamps can evict an older-inserted shutdown run even though it just completed. Suppress host effects in that callback but retain the snapshot needed for final reporting.
4. Publish each eligible cancellation report using the existing message shape and `triggerTurn: false`.
5. Clear eligible status and unregister this facade in `finally`.

Final reporting has a deliberately narrower exception to normal active-owner checks. The owner has already been revoked, but the shutdown path may report to its still-valid captured host if its final-report permission has not been revoked by a branch callback, the same facade remains registered, the captured Session ID still matches, and the snapshot belongs to that Session. Catch stale getter and message errors. Share the sent-ID set so shutdown cannot duplicate an ordinary report.

If shutdown joins an already-started branch retirement, do not report that old branch's runs into the destination branch. Shutdown still stops the instance and unregisters it. If a branch callback arrives after shutdown began, revoke shutdown's final-report permission before returning from the stopped-state branch handler. The matching Session ID is insufficient: the host can already be on another branch. Do not preserve permission merely because shutdown originally initiated retirement.

If disposal fails, do not manufacture terminal cancellation reports for unfinished records. Preserve the cleanup error and still run the final resource/registration cleanup.

## Profile binding and shared-interface lifetime

Keep `Session profile binding` as the owner of Profile resolution, settings-path application, initialization coordination, and reverse disposal. Do not fork its logic into the Subagent module.

Its adapter order is:

```text
config-profiles
ui-clear
policy-permissions
tools-advisor
tools-subagents
ui-model-selector
workflows-plan
```

It applies paths before initialization and disposes attempted adapters in reverse order. Plan and model-selector cleanup therefore precede Subagent disposal. Preserve that ordering.

An adapter is marked attempted before awaiting initialization. Its initialization failure does not stop siblings, and its disposal still runs. If binding resolution fails or Subagent path application fails before initialization, there may be no attempted Subagent adapter to dispose. `afterStop` supplies the fallback in those cases.

Use existing `wireSessionProfileBinding` without changing its shared implementation. Its `stop` waits for `activeRun`, including pending initialization, before reverse disposal; `afterStop` follows that wait. Thus the adapter example does not deliver immediate module shutdown during a deferred Profile `prepare`, and the six-second manager bound does not bound the entire Profile shutdown wave. Retain reverse disposal order rather than starting Subagent disposal ahead of Plan/model-selector cleanup. Test this actual ordering separately from direct `handle({ type: "shutdown" })` races. Do not claim a never-settling Profile initializer is covered by bounded child cleanup.

The helper uses nested `finally` blocks without aggregation. If `stop` and `afterStop` both fail, the `afterStop` failure replaces the earlier one. Because the Subagent callbacks join the same shutdown operation, they observe the same Subagent cleanup failure; do not promise preservation of an unrelated sibling's earlier error.

The adapter wiring remains:

- Profile adapter `dispose` calls the idempotent module shutdown.
- `afterStop` calls the same shutdown.
- Remove the standalone Subagent `pi.on("session_shutdown", ...)` handler.
- Keep the helper's unconditional Profile registration removal in its final `finally`.

The module's shutdown operation must put facade unregister in its own `finally`. Do not rely solely on Profile adapter disposal for removing the facade. A failed drain must not leave shared registration active.

The existing `registerSubagentService` callback removes only its exact facade object. Reuse it. Do not introduce global clearing, a new Symbol key, or replacement by string ID. Keep the shared `SubagentService` type and optional `cancelBackgroundRuns` method unchanged.

## Plan Mode behavior

Do not move capability policy into the Session-owned module. The generic module does not know about Plan Mode.

Preserve these rules in `plan-lifecycle.ts`:

- Before defaults capture and Plan state commit, await `cancelBackgroundRuns("Entering Plan Mode")` when available.
- Cleanup failure prevents Plan entry and follows existing rollback/notification behavior.
- Apply capability checks both during `modeTransition === "entering"` and active Plan Mode.
- Permit known non-`default` agents only when every tool is in `read`, `grep`, `find`, `ls`, `repo_query`, `ddg_search`, or `ddg_fetch`. Empty tool lists pass this universal check. Any registered name can pass, not just `explorer`/`researcher`; the public worker/judge prohibition is separate.
- Block the legacy default agent even if registered with only allowed or no tools, unknown agents, empty task arrays, and mixed requests containing a disallowed agent. Preserve legacy single-agent input handling; an array-valued `tasks` takes precedence, including an empty array. Capability names match exactly; `safe_bash`, `bash`, unknown names, and differently cased names are disallowed.
- Apply the same policy to foreground and background requests.

The private cancellation operation temporarily gates new background admission while its current-owner drain is pending. Coalesce repeated calls for that owner. Keep status/get/wait/cancel usable for retained runs and keep ordinary cancellation notifications enabled.

Release this temporary gate in `finally` only if the same owner is still active. A rejected Plan cancellation leaves the owner and records available in Normal Mode; it does not perform branch retirement. A later normal submission may proceed under the unchanged unfinished-run and scheduler limits. Branch retirement or shutdown takes precedence and must never be undone by this `finally`.

If Plan cancellation is requested while retirement is already underway, join the retirement's promise instead of declaring cleanup complete because the active-owner slot is empty. A retained failed retirement must reject the request. If no owner or retirement has ever existed, cancellation is a no-op.

## Compatibility requirements

Preserve all of the following:

- Tool names and parameter/output schemas for `subagent`, `subagent_status`, `subagent_wait`, and `subagent_cancel`.
- Legacy argument normalization and structured result/detail shapes.
- TUI/RPC background default; print/JSON foreground default and explicit-background rejection.
- Public prohibition on `worker` and `judge`; workflow access remains through the existing shared facade.
- Explicit `background: false` in long-lived modes.
- Ordered foreground results and awaited progress consumers.
- Authoritative `AgentProgress.status` for child outcome; separate manager cancellation status.
- Preserved execution/progress rejection identity.
- Aggregate FIFO scheduling for requests actually enqueued at the aggregate scheduler, and existing per-batch concurrency. Locally queued siblings reach the aggregate queue only after a local slot opens; do not promise global FIFO by original task submission order. Lowering the limit does not terminate active children; raising it drains the queue.
- Frozen launch/model/thinking/cache assignment while a task is queued.
- Existing cache-affinity namespace derived from the owning Session ID.
- Output byte/line limits, failure flags, renderers, command configuration, and picker behavior.
- Existing direct `runSubagent` and `runSubagentsParallel` exports and their separate module-level compatibility instance. They are not in the extension instance's aggregate scheduler.
- Existing shared registration/loading methods usable during extension loading.
- Existing child-process termination and diagnostic behavior.

Do not start awaiting background results in the public `subagent` handler. After successful preflight, it returns accepted snapshots immediately. Control and command adapters must not introduce waits that change this path.

## File changes

| File | Planned change |
| --- | --- |
| `tools-subagents/session-execution.ts` | New internal owner of lifecycle, background admission, current manager, delivery, status timer, and facade registration |
| `tools-subagents/session-execution.test.ts` | New behavior tests across the lifecycle interface using the real execution/run modules |
| `tools-subagents/index.ts` | Compose the module; replace inline lifetime state with event/effect adaptation; retain public schemas and foreground path |
| `tools-subagents/index.test.ts` | Ordered handler dispatch; proper startup/shutdown; adapter and registration assertions |
| `tools-subagents/run-tools.ts` | Accept the restricted run-control interface instead of a manager factory |
| `tools-subagents/run-tools.test.ts` | Supply restricted controls; preserve schema and output assertions |
| `tools-subagents/model-commands.ts` | Replace raw manager dependency with `Pick<SubagentRunControl, "list" | "cancel">`; preserve other command dependencies |
| `tools-subagents/model-commands.test.ts` | Adapt command fixtures; pin unchanged existing-run behavior and the explicit inactive/unconstructed-manager diagnostic exception |
| `tools-subagents/background-notifications.ts` | Remove after delivery ownership moves |
| `tools-subagents/background-notifications.test.ts` | Migrate relevant behavior assertions, then remove obsolete tests |
| `tools-subagents/background-integration.test.ts` | Preserve TUI/RPC flow; add actual shutdown, branch, and stale-runtime scenarios |
| `tools-subagents/background-test-harness.ts` | Reuse its execution/child stand-ins as needed; add a focused Session recording adapter only if shared by multiple tests |
| `tools-subagents/README.md` | Document ownership, lifecycle, per-instance scheduling, readiness/control diagnostics, and preserved tool schemas/invocation behavior |
| `CONTEXT.md` | Amend the existing Subagent execution module definition after implementation |
| `workflows-plan/plan-lifecycle.test.ts` or a focused adjacent integration test | Add real-facade cancellation coverage while preserving existing Plan policy tests |
| `_shared/subagent-service.test.ts` | Pin existing ID validation: accept one lowercase letter/digit and trailing hyphen; reject empty, leading hyphen, uppercase, underscore, punctuation and whitespace; keep identity-safe replacement tests |

Paths in this table are relative to `.pi/extensions/` except `CONTEXT.md`, which is at repository root.

No production change is expected in shared Profile binding, shared registration, Plan lifecycle, run-record logic, scheduling, or process modules. Change one of those only if a failing integration test proves it is required for this design. Keep any such change limited to candidate 1 and record the evidence in the implementation summary.

## Implementation sequence

### 1. Establish honest lifecycle tests

- Snapshot worktree status and preserve current implementation/configuration edits.
- Convert `index.test.ts` handler storage to ordered arrays.
- Implement an awaited dispatch helper that invokes every registered handler in order.
- Distinguish direct handler failure assertions from SDK-style dispatch, which catches handler errors, reports them, and continues. Do not silently discard rejections in a fake helper.
- Return an unsubscribe callback from fake `pi.on`, matching the installed host contract.
- Update all existing `handlers.get(event)(...)` callers to the helper.
- Start background-routing fixtures with a real `session_start` event before submitting work. Do not depend on the old lazy owner creation without initialization.
- Ensure every successfully constructed extension fixture emits awaited shutdown in teardown, including unbound fixtures, failed initialization and foreground-only tests. Construction already registers the facade and Profile adapter even without an owner; do not leave those globals installed between tests. Complete or abort controlled children before awaiting teardown; assert cleanup errors rather than discarding them.
- Add failing assertions for one registered shutdown handler, cleanup when initialization fails, and shutdown during pending branch retirement.

Run the narrow extension test file. Existing tests may need their setup corrected, but do not weaken behavioral expectations to fit a new implementation.

### 2. Build the ownership module against real internal implementations

- Add `session-execution.ts` and the interface types from this plan.
- Reuse the existing execution instance and run-manager constructor.
- Register the shared facade at construction and retain its identity-safe unregister callback. Pin existing shared ID-validation boundaries in `_shared/subagent-service.test.ts`; do not invent an ID option on the new fixed-ID factory.
- Implement readiness/preparation ordering, serialized preparation, distinct preparation-request currency versus installation revisions, branch-before/during/after-preparation rules, owner capture, lazy manager creation, and module-derived ownership/cache IDs.
- Implement restricted run controls, preserved active-manager validation/error order, stale-runtime rejection, and the explicit inactive-control/command diagnostic rules.
- Implement synchronous retirement, revisions, bounded disposal, failed-retirement retention, and terminal shutdown.
- Implement temporary Plan cancellation admission gating without closing the manager permanently.
- Implement per-owner sent-ID tracking, bounded shutdown-terminal snapshot capture, branch revocation of final-report permission, and current-owner status timers.
- Make every late callback refer to its captured owner.

Tests use memory configuration/agent registries and controlled child execution. Test through `handle`, `spawn`, `runs`, and the real registered facade. Avoid injecting a fake run manager, which would omit the behavior this seam is meant to own. Await module shutdown in every test teardown, including factories never started and rejected starts, so the real global shared registry cannot leak across cases. Attach rejection assertions before aborting waits or rejecting controlled promises to avoid test-created unhandled rejections.

### 3. Wire the Pi adapter and shared facade

- Keep the existing execution and invocation-adapter composition.
- Replace inline manager/generation/notification/timer/admission/cleanup state with the new module.
- Add the small concrete Session host adapter.
- Route Profile initialization through `sessionStarted` and its preparation callback.
- Route tree changes through `branchChanged`.
- Use `dispose` plus `afterStop` for the same shutdown operation.
- Delete the standalone shutdown handler and repeated facade registration in initialization.
- Route the background tool through `spawn`; retain the foreground invocation path.
- Keep tool/message renderers, model-select handling, public-agent checks, and schemas unchanged.

### 4. Narrow controls and human command dependencies

- Give control tools the stable restricted run-control object directly.
- Remove manager-factory/context ownership from `run-tools.ts`.
- Give `/subagents runs` and `/subagents cancel` only list/cancel methods.
- Retain empty-list behavior and the optional-dependency no-active-run fallback. Use the stable control's errors when supplied, including the deliberate unconstructed-manager diagnostic simplification described under admission.
- Keep existing formatting, truncation, `isError`, and output schema tests.
- Verify that neither consumer can call `close`, `dispose`, or `cancelAll`.

### 5. Migrate delivery tests and remove the redundant helper

- Move currency, suppression, and at-most-once assertions to the Session interface tests.
- Move Pi message-shape assertions to adapter/integration tests.
- Remove `background-notifications.ts` and its now-obsolete test file.
- Keep run-manager tests for preflight, retention, waits, cancellation, immutable records, and terminal semantics.
- Keep execution/scheduler/child tests. These modules remain useful and retain independent contracts.
- Delete only tests that assert removed duplicate ownership or exact private flag mechanics.

### 6. Exercise real SDK host and Plan integration

- Keep the existing offline TUI/RPC busy-parent and idle-parent completion flow.
- Add actual runner shutdown before `session.dispose()` in teardown.
- Add actual branch navigation while a child is pending, then run fresh work on the destination branch.
- Exercise facade replacement and stale host getters.
- Add a Plan integration case using the registered facade from the real Session-owned module, with a controlled child that observes abort.
- Prove that Plan commit waits for drain and that cleanup rejection prevents commit.
- Retain existing direct Plan capability-policy tests rather than moving them into the generic module.

### 7. Update documentation and run verification

- Update the extension README's lifetime description, readiness/control diagnostics and per-instance budget qualification without changing public tool schemas or invocation instructions.
- Amend the existing `CONTEXT.md` Subagent execution entry to include Session ownership and the private composition. Replace its stale concurrency descriptions, do not merely append: current `runSubagent` and every `prepareBatch`, including empty batches and caller overrides, load and validate config and set the shared instance limit. `prepareSubagentLaunches([])` itself still reads neither registry nor assignments. The current entry incorrectly says direct one-task calls make no concurrency load and a non-nullish batch override skips that load.
- Document shutdown event requirements for SDK callers and the unchanged bounded cleanup behavior.
- Run the targeted and broader checks below.
- Review the full diff against the initial worktree snapshot. Check specifically that live settings/Profile files remain untouched.

## Test matrix

| Area | Required observable assertions |
| --- | --- |
| Factory/loading | Fixed-ID facade exists before startup; sibling agent registration works; no timer/child starts; existing shared-registry invalid-ID and competing-owner validation is preserved and tested at that registry |
| Session preparation | Background rejects during deferred preparation; preparation failure propagates; facade can still be cleaned up; old owner retires before preparation; branches before startup/after failed preparation cannot activate; branches during preparation wait for its success; overlapping starts serialize callbacks and skip superseded callbacks before invocation |
| Foreground | Same terminal results, ordered batches, progress/error identity, workflow worker/judge access, explicit foreground in TUI/RPC |
| Background acceptance | Preflight completes before acknowledgement; returns queued immutable handles without waiting for children; queued launch settings remain frozen |
| Limits | Existing task/run/retention/wait limits remain; queued and foreground work share the aggregate budget |
| Controls | Schemas, active-manager validation, caller ordering, error precedence, and eviction-safe waits unchanged; status `runId: ""` continues to list while direct `get("")` is unavailable; all IDs validated before mutation; wait abort does not cancel children; unbound list is empty; inactive/retiring controls cannot retrieve old records; command diagnostic exception is pinned |
| Delivery | One ordinary attempt per run; busy follow-up queue and idle continuation work; synchronous send failure leaves retrieval intact; later asynchronous send failure reaches runner error reporting without changing records |
| Status | One 150 ms scheduled refresh per owner; correct counts; pending refresh cannot access stale host or another manager |
| Branch | Revocation is immediate on callback receipt; queued/running children cancel; replacement waits; old IDs become unavailable; prepared new branch can admit work; actual navigation's earlier-handler interval is documented separately |
| Overlapping branches | Newest destination alone installs an owner; superseded callbacks produce no destination effects |
| Shutdown | One Pi handler; awaited cleanup; cancellation reports do not wake parent; equal-timestamp retention eviction cannot lose final snapshots; a later branch callback removes final-report permission; status clear and exact-object unregister happen on success/failure |
| Shutdown during branch | No reopen; no old-branch report after branch callback receipt; facade removed even though retirement began for another reason |
| Shutdown during preparation | Direct module shutdown cannot be reopened by late preparation completion and does not wait for never-settling preparation; repeated shutdown coalesces; actual Profile-wired shutdown waits for initialization first and is not manager-deadline-bounded |
| Initialization failure | Cleanup works after failed preparation, failed binding resolution, and path-application failure that skipped adapter initialization |
| Cleanup timeout | Caller receives failure; no replacement admission; stale callbacks produce no effects; explicit later start/branch before shutdown can retry retained retirement; first/repeated shutdown after failure does not retry |
| Plan cancellation | Temporarily gates background admission; retains records; releases only for the still-active owner; never undoes concurrent retirement |
| Plan entry | Uses real registered facade; no commit before child drain; drain failure prevents entry; active and entering states use the same capability matrix, including empty tool lists, arbitrary registered names, default regardless of tools, exact capability spelling, empty task arrays, legacy input and array precedence, both execution modes |
| Replacement identity | Older cleanup cannot unregister or update status/messages for the newer registered facade; stale module spawn/controls cannot use its still-retained owner |
| Stale SDK context | Getter throws without escaping timer/notification callbacks; no effect occurs after runtime replacement |
| Resource cleanup | No remaining owner status timers, manager wait subscriptions, shared registration or unhandled promise rejections after successful module shutdown; an already-running preparation may still settle but cannot activate; foreground execution/throttle lifetime remains unchanged |

Use fake timers for 150 ms refresh and six-second failure cases. Use controllable promises for cancellation races and child completion. Do not use arbitrary sleeps as proof of ordering.

## SDK and installed-host verification details

The repository pins `@earendil-works/pi-coding-agent` 0.87.0 in `.pi/package.json`; `.pi/node_modules` resolves that version. The installed CLI at `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent` is 1.0.0. The existing background integration executes the real pinned 0.87.0 SDK with `fauxProvider`, in-memory credentials/settings, and injected child events. Keep it offline. Preserve both `rpc` and `tui` cases. Its 'installed-host' test title does not establish CLI 1.0.0 or interactive-terminal coverage. No dependency upgrade belongs in this ownership refactor.

Both checked SDK versions expose `session.extensionRunner` and its awaited generic `emit` method. Shutdown is a supported generic event. Use:

```ts
await session.extensionRunner.emit({
  type: "session_shutdown",
  reason: "quit",
});
session.dispose();
```

`session.dispose()` is synchronous and invalidates contexts. It does not prove that shutdown handlers ran. Do not use it alone as a cleanup assertion.

In both checked versions, `emitSessionShutdownEvent` exists in the internal runner but is not exported by the package's top-level interface. Do not add a dependency on its private file path.

Both checked runners await handlers in registration order and catch their failures into extension error reporting. Subscribe with its error listener when verifying failure cases. The absence of a rejected `emit` promise does not mean disposal succeeded.

Use `session.agent.peekQueuedMessages()` for busy-parent custom completion messages. `getFollowUpMessages()` only describes user follow-ups and does not measure this queue correctly.

For branch integration, use the pinned SDK's public `await session.navigateTree(targetId, { summarize: false })` method with an in-memory Session containing distinct branch destinations. Wait for the parent to be idle; both checked versions reject during streaming or compaction. Use a target distinct from the current leaf, since same-leaf navigation is a no-op with no tree dispatch. Cover missing-target rejection and before-tree cancellation separately: neither produces `session_tree` and neither should retire this module's owner. Seed nodes through `SessionManager.appendMessage` or `appendCustomEntry`, and use `branch` only to construct the fixture before binding the host. Assert the returned `cancelled` flag is false and await the method's real `session_tree` dispatch. Disabling summarization keeps the test offline. A direct `extensionRunner.emit` is appropriate for event-adapter coverage, but must not be described as testing actual navigation. No private runner fields or casts are required.

Exercise two cases beyond happy-path completion:

1. A child remains active during branch navigation. After the Subagent branch callback begins, the old controller aborts before replacement work starts; no later old completion reaches the destination; fresh work does. In a separate case, delay an earlier tree handler and resolve a child during that delay to establish the host-wide pre-callback interval described under risks. Do not label it a protected interval.
2. A child and status refresh remain pending during shutdown/reload. Emit shutdown while the context is valid, then dispose/replace it. Resolve late child callbacks and advance timers. No stale-context exception or extra parent turn occurs.

When an interactive TUI is available, also perform a live smoke test against the installed CLI, recording its version, after reloading the extension: submit background work, continue unrelated work, receive completion while busy and idle, switch branches with work pending, and enter Plan Mode with background work pending. Record observations. An offline `tui` mode test is not a claim that the terminal UI itself was exercised.

## Verification commands

Start with focused checks after each coherent edit batch:

```bash
cd .pi
pnpm exec vitest run extensions/tools-subagents/session-execution.test.ts
pnpm exec vitest run extensions/tools-subagents/index.test.ts extensions/tools-subagents/run-tools.test.ts extensions/tools-subagents/model-commands.test.ts
pnpm exec vitest run extensions/tools-subagents/background-integration.test.ts
```

Once lifecycle and adapter tests pass, run the impacted suites:

```bash
cd .pi
pnpm test:subagents
pnpm test:shared
pnpm test:plan
pnpm test:workflows
pnpm typecheck
```

Add any new adjacent Plan integration test to the appropriate existing suite. Run tests with injected memory stores or isolated temporary settings/Profile paths. Do not let default production stores write repository settings during tests.

The planning audit ran the baseline later committed as `48793cb`: `pnpm test:subagents` passed 19 files/296 cases; `pnpm test:shared` passed 41 files/502 cases; `pnpm test:plan` passed 13 files/188 cases, with one file/two cases skipped. A separate JSON-reported run of the 22 files inventoried above passed all 363 cases. These verify the prerequisite implementation, not the completed refactor, races specified here, or an interactive terminal workflow. Report new results after implementation rather than reusing these counts.

## Risks and limits

- A timer can pass a weak Session-ID check on the wrong branch because branches share IDs. Captured owner identity, transition revocation, and facade identity establish currency after this module receives a lifecycle callback. A redundant numeric owner-generation counter adds no protection.
- Callback closures that read a global/current manager can update a replacement registry. Capture the owning record in each callback.
- Cleanup failure can leave a child unsettled. This candidate prevents reopening the same instance over it, but does not repair process termination. Do not claim a six-second timeout proves the OS process is gone.
- The host may proceed with runtime replacement after reporting a shutdown handler error. Process budgets remain per execution instance. A global cross-runtime guarantee after failed termination would require separate work and is outside this plan.
- A shared facade registered during loading has no ready background owner. Agent registration and existing terminal methods remain available; background submission rejects until successful Session preparation. It does not wait or enqueue behind preparation.
- A stopped instance must not re-register itself after a newer instance loads. Register once, remove by object identity, and check identity before effects.
- Both checked SDK hosts commit the destination leaf before dispatching `session_tree`, and await earlier handlers in registration order. The module can revoke synchronously when its handler is invoked, not before the host mutation or an earlier handler's await. Likewise shared Profile shutdown waits for initialization and earlier reverse disposals. This candidate does not provide a host-wide navigation barrier or a deadline for arbitrary sibling initialization/disposal. Test an earlier delayed tree handler and record this interval explicitly; do not claim facade identity or Session-ID checks distinguish branches before the module receives its callback. Completion isolation assertions apply after that callback begins. Closing this host-wide interval requires a separate before-navigation protocol, including cancelled navigation, and is outside this ownership move.
- The two cleanup callers, adapter disposal and `afterStop`, are intentional. They provide failure-path coverage through one coalesced operation, not two competing lifetimes.
- Changing configuration ownership alongside lifetime would widen the refactor. Keep concrete path selection and configuration preparation in the existing Profile adapter.
- An SDK embedder that disposes without emitting shutdown can bypass process cleanup. Stale-effect suppression still protects host access, but proper shutdown dispatch remains an embedder requirement.

No dependency installation, persistent run recovery, publication, deployment, new tool, durable notification queue, cross-process registry, scheduler redesign, or child-process refactor is part of this work.

## Acceptance criteria

The implementation is complete when:

1. `index.ts` has no run-manager reference, owner generation, admission flag, refresh timer, notification enable flag, or cleanup promise.
2. One Session-owned interface controls start, branch replacement, shutdown, background submission, and restricted run controls.
3. The shared facade remains available during loading and unregisters by exact object identity on every shutdown path.
4. Subagent registers one shutdown handler, and both normal Profile disposal and failed initialization reach the same awaited cleanup.
5. Receipt of branch change revokes immediately, drains the old manager within its existing bound, and exposes a fresh lazy registry only after successful cleanup and successful Session preparation.
6. Once module shutdown is invoked, it prevents replacement activation, including direct preparation and branch races. The actual Profile-wired shutdown's wait for initialization is tested and documented separately.
7. Plan entry keeps its existing policy, awaits real background cancellation, retains terminal records, and refuses entry on cleanup failure.
8. Normal delivery remains at-most-once attempted and can wake an idle parent; shutdown delivery cannot trigger a turn, reach a replaced facade/runtime, or follow a branch callback received by this module. The host-wide interval before branch callback receipt remains an explicit limit, not a tested isolation guarantee.
9. Foreground tools, direct exports, workflows, schemas, output limits, result status, and aggregate scheduling remain compatible. Background readiness and inactive control/command diagnostics match the deliberate changes specified under admission.
10. The test matrix passes with real pinned-SDK 0.87.0 TUI/RPC completion and shutdown coverage, plus real branch navigation coverage. Report installed CLI 1.0.0 smoke coverage separately; offline pinned-SDK tests are not evidence of an interactive CLI run.
11. Documentation describes the implemented ownership, and no live settings/Profile or unrelated user changes were altered.
12. The implementation report lists exact verification commands/results and states whether an interactive terminal smoke test was available.

## Implementation results

Implemented `session-execution.ts` and wired the Pi adapter, control tools and
human commands to its restricted interface. Removed the standalone notification
helper and duplicate shutdown registration. Existing execution, scheduler,
retained-record, child-process, Profile-binding and Plan-policy production
implementations remain unchanged from `48793cb`.

Coverage includes 29 Session ownership cases, 11 real pinned-SDK cases, and four
real-facade Plan integration cases. The ordered adapter harness awaits teardown
for every fixture. Tests cover failed preparation, replacement races, cancellation
and retirement timeouts, stale effects, message failures, shutdown snapshot
retention and foreground budget compatibility.

The independent review reported a missing temporary admission gate when a ready
owner had not created its lazy manager. A new regression failed before the fix.
Cancellation now gates and coalesces even in that case, without constructing a
manager or scheduling a timer. The review provider stream ended before a terminal
response event, so the independent review did not complete. The main agent
checked the final source and test diff after the correction.

Final verification, run from `.pi` unless stated otherwise:

| Command | Result |
| --- | --- |
| `pnpm exec vitest run extensions/tools-subagents/session-execution.test.ts extensions/workflows-plan/subagent-integration.test.ts` | 2 files, 33 passed |
| `pnpm test:subagents` | 19 files, 336 passed |
| `pnpm test:shared` | 41 files, 512 passed |
| `pnpm test:plan` | 14 passed files, 1 skipped file; 192 passed, 2 skipped |
| `pnpm test:workflows` | 9 Vitest files, 127 passed; 21 Node tests passed |
| `pnpm typecheck` | Passed |
| `git diff --check`, from repository root | Passed |

The broader suites total 1,188 passed tests and two skipped tests. The focused
33-test run overlaps those suites and is not added to that total. Configuration
hash checks confirm `.pi/pi-config.json` and `.pi/profiles/openai.json` retain the
user's pre-existing edits. They are excluded from both requested commits. No
live Settings edit or dependency change is part of the implementation.

No interactive terminal smoke test was available or run. SDK `tui` tests exercise
lifecycle and message behavior without a terminal, using pinned SDK 0.87.0. They
do not verify the installed CLI 1.0.0's interactive workflow. The documented
pre-callback navigation interval and unbounded sibling/Profile initialization
remain host limitations, not guarantees supplied by this refactor.
