# Deepen the Editor slot handler lifetime

## Goal

Make the shared Editor slot module own the lifetime of every Session-scoped Editor slot registration, not only custom Editor contributions. A single registration will be able to provide any combination of:

- a custom Editor contribution;
- the silent `/model` command handler;
- the streaming input-interception handler.

Every new registration will be tied to the exact `SessionStartEvent` object, cleaned up automatically on `session_shutdown`, and disposed safely when a Profile transition replaces the current Session state. Older extension copies remain a compatibility exception during an in-flight reload.

The user-visible behavior must remain unchanged:

- `ui-message-history` remains the priority-20 Editor winner.
- `ui-model-selector` remains the priority-10 Editor contributor.
- standalone `/model` submissions still route silently to model selection.
- streaming Tab input still queues follow-up work without replacing the mounted Editor.
- the input handler remains a single replaceable handler; this plan does not introduce handler composition or handler priority.
- the thinking-level border is still reapplied after Pi mounts a custom Editor.
- Plan Review's synchronous temporary Editor swap remains outside the Session registration machinery.
- persisted message history and model-selection lifecycle behavior do not change.

## Current baseline

The repository was clean before this plan was written, and `plan.md` was absent, so there was no pre-existing plan to remove.

The focused baseline passed:

```text
pnpm exec vitest run extensions/_shared/editor-slot.test.ts extensions/ui-model-selector/index.test.ts extensions/ui-steer-input/index.test.ts extensions/ui-message-history/steer-recall.test.ts
4 test files passed
70 tests passed
```

The typecheck also passed:

```text
cd .pi && pnpm typecheck
```

All commands in this plan that use package scripts run from `.pi`, because the package manifest lives there.

## Why this change

The Editor slot module uses a `Symbol.for("pi-config.editor-slot.v1")` registry on `globalThis` because the extension loader gives each extension its own copy of shared modules. That shared registry is the correct seam for the single Pi Editor slot and its related handlers.

The module already owns custom Editor contribution lifetimes through `createSessionEditorLifetime()`. The two handler registries are shallower:

- `registerModelCommandHandler()` stores a process-global function and returns a caller-owned unregister callback.
- `registerEditorInputHandler()` does the same for the streaming input handler.
- `ui-model-selector/index.ts` keeps `uninstallModelCommandHandler` beside its Profile lifecycle and must remember every replacement and disposal path.
- `ui-steer-input/index.ts` keeps `unregisterInputHandler` beside its Session handlers and must clean it on every shutdown path.
- `ui-model-selector/index.test.ts` and `ui-steer-input/index.test.ts` directly mutate the shared registry to reset test state.
- `ui-message-history/steer-recall.test.ts` asserts that the global input handler has been cleaned, showing that cleanup is an externally visible invariant rather than a local implementation detail.

The deletion test is clear: delete the caller-owned unregister calls and stale `/model` or Tab behavior survives a Session replacement. Delete the raw registration functions and replace them with the lifetime seam; the complexity remains in the Editor slot module because the registry still must coordinate ownership, replacement, exact Session tokens, and stale cleanup. The module earns depth by concentrating that complexity once rather than deleting useful behavior.

## Dependency category and seam

This is an **in-process** deepening:

- the registry is in-memory;
- the handlers are callbacks supplied by Pi-facing adapters;
- the Editor slot module does not need a remote port or a new external adapter;
- tests can exercise the complete behavior through the lifetime interface with in-memory callback and TUI doubles.

The new ownership seam is the Editor slot module's lifetime interface. Its implementation keeps handler and Editor registries, Session-token ownership, winner selection, deferred flush, and teardown details private while the existing dispatch getters remain public.

The interface is the test surface. Adapter tests should verify observable routing and cleanup through that interface rather than importing a low-level registry mutation function.

## Resolved design decisions

The clarification frontier was resolved with the recommended answers below. No design question remains open for implementation.

### 1. Deepen both handler registries

Own both the `/model` handler and the input-interception handler in the same Editor slot lifetime. Do not limit the change to Tab input.

Both registries have the same ownership problem, both live in the same `Symbol.for` registry, and two production adapters already exercise the seam:

- `ui-model-selector` supplies the `/model` handler;
- `ui-steer-input` supplies the input handler.

The two handlers remain separate slots. The registration does not combine them and does not change their dispatch order.

### 2. Extend the existing lifetime instead of adding a second lifetime module

Extend `SessionEditorLifetime` and `createSessionEditorLifetime()` with one registration description that can contain an optional Editor contribution, an optional model handler, and an optional input handler.

Do not add a parallel `SessionHandlerLifetime`. A second lifetime abstraction would duplicate Session-token and stale-owner logic and make callers learn two seams for one Editor slot module. One lifetime gives the Editor slot module more depth and gives all three adapters one ownership rule.

### 3. Use the exact `SessionStartEvent` object as the Session token

Every new registration receives the `SessionStartEvent` object already supplied to its `session_start` callback. The registry compares token identity, not `cwd`, a Session id string, a Profile name, or a numeric generation.

This matches the existing Editor contribution lifetime and the Session profile binding machinery. The installed Pi 0.84.4 runner passes the same event object to every handler in one `emit` call. Its reload and Session-replacement paths await the old `session_shutdown` before constructing and emitting the next `session_start`, so the production registrations in this plan arrive in start order. Reload, new, resume, and fork starts receive distinct objects even when a Session id or working directory is reused.

The object is a wave identity, not a general ordering signal. Treat the first installation of a different token as the next wave under Pi's verified lifecycle ordering. Do not claim to support an arbitrary caller that delivers an older `SessionStartEvent` after a newer one. Callers pass the event they already have; they do not store or compare it themselves.

### 4. One registration may own several related slots

Use a registration shape equivalent to:

```ts
export interface SessionEditorContribution {
	id: string;
	editor?: {
		priority: number;
		createEditor: EditorFactory;
	};
	modelCommandHandler?: ModelCommandHandler;
	editorInputHandler?: EditorInputHandler;
}
```

The existing `SessionEditorLifetime` remains:

```ts
export interface SessionEditorLifetime {
	install(
		event: SessionStartEvent,
		ctx: ExtensionContext,
		contribution: SessionEditorContribution,
	): void;
	dispose(): void;
}
```

The registration invariant is that at least one of `editor`, `modelCommandHandler`, or `editorInputHandler` is present. Enforce this before changing the lifetime or global registry: `install()` must throw for an all-empty description and leave the previous registration untouched. A fresh handler-only registration and its disposal do not mount or clear an Editor. If installation replaces an Editor-bearing registration, the replacement path must still reconcile the removed Editor, by remounting another active winner or restoring Pi's built-in Editor when no winner remains. An Editor registration retains the existing priority and latest-registration tie rule.

Use the nested `editor` shape at the registration seam shown above. Keep the existing internal `ContributionEntry` shape nested as `{ contribution: { id, priority, createEditor }, ctx, sessionToken, order }` so the global v1 registry remains readable by an older extension copy during reload. The exported type name is not a second seam: it describes one registration, not an Editor-only map entry.

### 5. Preserve one current handler per handler kind

The model handler and input handler keep their current replacement semantics:

- a later model-handler registration replaces the active model handler;
- a later input-handler registration replaces the active input handler;
- an old lifetime can remove only its exact entry;
- no handler list, priority, fan-out, or composition is introduced.

The existing `getModelCommandHandler()` and `getEditorInputHandler()` getters remain available. `ModelCommandRoutingEditor` reads the input-handler getter; `ui-message-history` reads the model-handler getter when its factory creates an editor; and `ui-steer-input` reads the model-handler getter while classifying a queued slash command. The getters continue returning handler functions, not registry entries.

### 6. Remove new callers' raw registration escape hatch

Stop exporting the direct `registerModelCommandHandler()` and `registerEditorInputHandler()` functions from the new Editor slot module implementation. Migrate all production and test callers to `SessionEditorLifetime.install()`.

The getters remain. The new public seam is ownership-aware installation and disposal, not a raw global setter with a cleanup callback.

During an in-flight reload, already-loaded extension instances retain the old function exports in their own module copies. The shared registry representation must therefore tolerate the old raw handler fields during that transition, as described below. This is compatibility for the extension loader, not a reason to retain the shallow new source interface.

### 7. Keep the global registry key and make its fields reload-tolerant

Keep `Symbol.for("pi-config.editor-slot.v1")`. Do not create a second key or strand old extension copies in a second registry.

Keep the existing raw handler fields as the values returned by the getters, and add private owner-entry fields beside them. This lets old code that still reads a raw function continue to work while the new lifetime code tracks exact ownership.

Conceptually:

```ts
interface EditorSlotRegistry {
	modelCommandHandler?: ModelCommandHandler;
	modelCommandHandlerEntry?: HandlerEntry<ModelCommandHandler>;
	editorInputHandler?: EditorInputHandler;
	editorInputHandlerEntry?: HandlerEntry<EditorInputHandler>;
	contributions: Map<string, ContributionEntry>;
	nextOrder: number;
	flushTimer?: ReturnType<typeof setTimeout>;
	activeSessionToken?: SessionStartEvent;
}
```

The optional owner fields are absent in an old global object and must be initialized lazily. A new Session wave clears both raw fields and owner fields before accepting new registrations. New lifetime disposal clears a raw handler only when the corresponding owner field is the exact entry being disposed and the raw field still equals that entry's handler. If an older raw registration overwrote the function field without updating the new owner field, disposal clears only the owner marker and leaves the legacy raw function untouched when the legacy function is a different object. A legacy overwrite that reuses the exact same function object is indistinguishable from the new owner still being current; do not promise to preserve that impossible-to-distinguish case without adding a separate write-observation mechanism.

The existing `contributions` map should continue to contain normalized Editor contribution entries rather than handler-only entries. That preserves the current map shape for a briefly live older extension copy while handler ownership is held in separate private entry fields.

### 8. New-wave invalidation is centralized

The first registration for a token different from `activeSessionToken` establishes a new wave:

1. invalidate prior Editor contribution entries;
2. clear prior handler values and handler owner entries;
3. cancel and clear the prior deferred Editor flush;
4. set the new active token;
5. install the new registration;
6. schedule a flush only when the registration contains an Editor.

Do not restore the built-in Editor merely because a new wave was established. The new Session's Editor contributor will replace the old visible Editor through its deferred flush. This preserves the current no-flash behavior.

A stale lifetime from an older extension runtime that later receives `session_shutdown` must see that its exact entry is no longer current and become a no-op. It must not clear a replacement handler or remount an older Editor. This relies on the verified Pi ordering above for a lifetime reused by one runtime; the registry does not pretend that a shutdown event carries the earlier start token.

### 9. Preserve the existing Editor behavior

Keep these rules unchanged:

- priority wins over registration order;
- latest registration wins equal-priority ties;
- a higher-priority late registration schedules one remount;
- removing any active Editor contribution remounts the remaining winner;
- removing the last active Editor contribution restores Pi's built-in Editor best-effort;
- deferred flushes verify both timer handle and Session token;
- the thinking border is reapplied;
- TUI installation remains best-effort when Pi is tearing down.

A fresh handler-only installation must not schedule an Editor flush. Disposing a registration that never owned an Editor must not call `setEditorComponent(undefined)`. If a handler-only replacement removes an Editor owned by the replaced registration, reconciliation is required for that removed Editor and is not an unnecessary handler-only effect.

### 10. Keep adjacent responsibilities outside this change

Do not change:

- `/model` parsing;
- model selection lifecycle or Profile persistence;
- steering queue semantics, including history recording before clearing the Editor;
- persisted message history;
- Plan Review's synchronous temporary Editor swap;
- the Editor's dynamic input dispatch order;
- the number of handler slots.

## Detailed implementation plan

### Step 1: Add shared-module tests at the new lifetime seam

Modify `.pi/extensions/_shared/editor-slot.test.ts` before changing production code so the ownership contract is explicit.

Keep the existing fake-timer setup and global cleanup, but replace direct calls to the raw registration functions with lifetime installations. Add a small registration helper that can install:

- an Editor-only contribution;
- a model-handler-only registration;
- an input-handler-only registration;
- one combined Editor plus model-handler registration.

The test Pi harness must retain multiple listeners per event and invoke them in registration order. It must pass one shared `SessionStartEvent` object to every handler in a start wave. This is important because the implementation relies on object identity, and a `Map<string, handler>` test harness would silently discard one of the lifetime's automatic shutdown listeners.

Add or adapt these cases:

#### Model-handler lifetime ownership

1. Create a lifetime and a Session start event.
2. Install a model-handler-only registration.
3. Assert `getModelCommandHandler()` returns the handler.
4. Dispose the lifetime.
5. Assert the getter is undefined.
6. Dispose again and assert the second call is a no-op.

#### Input-handler lifetime ownership

Repeat the same sequence for `getEditorInputHandler()` and an input handler.

#### Automatic shutdown cleanup

1. Create a lifetime through a Pi harness.
2. Install a model handler and an input handler in separate lifetimes for the same event.
3. Fire `session_shutdown` without calling either lifetime's public `dispose()`.
4. Assert both getters are undefined.
5. Fire shutdown again and assert no new side effect occurs.

This proves the lifetime, rather than an adapter, owns ordinary shutdown cleanup.

#### Combined registration cleanup

1. Install one registration containing an Editor contribution and a model handler.
2. Flush the deferred Editor mount.
3. Assert the Editor factory mounted and the model getter is active.
4. Dispose the lifetime.
5. Assert the built-in Editor was restored and the model getter was cleared.

#### Invalid registration is rejected atomically

Call `install()` with no `editor`, `modelCommandHandler`, or `editorInputHandler`. Assert it throws before changing the current registration, observable handler, mounted Editor, or pending timer. This enforces the valid-combination invariant instead of allowing a silent no-op that first discards an active registration.

#### Handler-only registration does not touch the Editor

Install and dispose a fresh input-only registration. Assert `setEditorComponent` was never called and no Editor timer was scheduled. Also replace an Editor-bearing registration with a handler-only registration in the same active Session. Assert the removed Editor is reconciled by the remaining winner or built-in restoration, while the handler-only part does not create an additional Editor effect.

#### Same-slot replacement is exact-entry safe

For the model handler and input handler independently:

1. Install handler A through lifetime A.
2. Install handler B through lifetime B for the same Session token.
3. Assert the getter returns B.
4. Dispose lifetime A.
5. Assert B remains active.
6. Dispose lifetime B.
7. Assert the getter becomes undefined.

Repeat each handler case with the same function object used for A and B. Disposal must compare the owner entry, not only the callback identity, so disposing A cannot clear B when both registrations happen to supply the same function.

Also cover the reload boundary: after a lifetime-owned handler is installed, use a registry compatibility fixture to overwrite only the corresponding legacy raw field with a distinct legacy function, with no owner-entry update. Dispose the lifetime and assert that the legacy raw function remains available; the exact owner marker is still cleared. Do not claim the same-function legacy overwrite case is distinguishable, and do not add a write-observation mechanism solely for it. This fixture must not call a raw registration setter.

For Editor contributions, install A and then a same-id replacement B, dispose B, and then dispose stale A. Assert the stale disposal produces no additional Editor restoration or remount beyond B's disposal.

This is the deletion-test regression for caller-owned stale cleanup.

#### New Session replacement is exact-token safe

1. Through lifetime A, install handlers and an Editor contribution for token A.
2. Through lifetime B, install replacement handlers and an Editor contribution for token B.
3. Assert the getters expose only token B's handlers and the deferred flush mounts token B's Editor.
4. Dispose lifetime A after token B is active.
5. Assert token B's handlers and Editor remain active.
6. Dispose lifetime B and assert ordinary cleanup.

#### Same-wave registration does not invalidate other adapters

Install the priority-10 model-selector registration, the priority-20 history registration, and the input-only steering registration with the same event object. Assert:

- the history Editor wins;
- the model handler is available;
- the input handler is available;
- no same-wave registration clears another slot.

#### Existing Editor characterization cases

Continue covering:

- deferred installation;
- same-tick flush coalescing;
- priority winner selection;
- latest-registration tie breaking;
- late higher-priority remount;
- winner disposal and remaining-winner remount;
- non-winner disposal remounting the remaining winner;
- shutdown before deferred flush;
- old timer invalidation;
- restoration failure after TUI teardown;
- thinking-border reapplication;
- the existing `ModelCommandRoutingEditor` order and the `PreviousMessageEditor` delegation boundary, where Up, Down, history bindings, and Ctrl+C are handled before the shared input hook;
- repeated disposal.

Delete tests whose only purpose is the old direct register/unregister return value. Retain ownership behavior through the new lifetime interface instead.

### Step 2: Deepen `.pi/extensions/_shared/editor-slot.ts`

#### Define the registration and ownership entries

Preserve `EditorFactory`, `ModelCommandHandler`, and `EditorInputHandler`.

Refine the exported `SessionEditorContribution` so it describes one registration with optional Editor, model-handler, and input-handler contributions. Keep the public `SessionEditorLifetime.install(event, ctx, contribution)` and `.dispose()` shape small. Validate that at least one optional contribution is present before clearing the lifetime's current state or touching the global registry; throw a `TypeError` for an empty description.

Add private ownership entries that capture:

- the exact handler or Editor factory;
- the registration id;
- the exact `SessionStartEvent` token;
- the normalized Editor contribution entry where applicable;
- the registration order for Editor winner selection.

Do not expose owner entries through the getters.

#### Normalize Editor contributions

When `install()` receives an `editor` field, normalize it to the existing internal `ContributionEntry` shape with nested `contribution: { id, priority, createEditor }`, plus `ctx`, `sessionToken`, and `order`. Store only these normalized Editor entries in the existing `contributions` map.

When a registration is handler-only, do not add it to the Editor winner map. It still belongs to the lifetime and still participates in Session-token invalidation through its handler owner entry.

#### Add exact-owner handler fields

Keep `modelCommandHandler` and `editorInputHandler` as raw function fields for getter and reload compatibility. Add owner-entry fields that identify which lifetime registration currently owns each raw function.

Add private helpers with single responsibilities:

- establish or reuse the active Session wave;
- detach a model-handler entry only if it is the current owner;
- detach an input-handler entry only if it is the current owner;
- detach an Editor contribution only if the map still points to the exact entry;
- remove a whole registration without intermediate UI effects while it is being replaced;
- reconcile an Editor removed by a handler-only replacement;
- dispose a whole registration with the correct Editor remount or built-in restoration behavior.

The helpers must distinguish replacement from disposal. Replacing an Editor with another Editor in the same lifetime must not briefly restore the built-in Editor before scheduling the replacement. A fresh handler-only registration must not schedule a flush, but replacing an active Editor with handler-only must not leave the old Editor mounted.

#### Establish a new Session wave

Centralize the new-token transition in the existing wave-coordination area:

- compare token identity with `activeSessionToken`;
- cancel a pending timer from the prior token;
- clear prior Editor contribution entries;
- clear raw handler fields and owner fields;
- store the new active token;
- leave the visible Editor alone until a new Editor winner flushes.

If an old global object has no owner fields, treat those fields as empty. If an old raw handler is present when the first new wave starts, clear it before installing the new registration.

Treat a different token as the next wave only under the Pi event ordering verified above. An arbitrary late installation for an older token is outside this interface and must not be described as safe. Do not introduce a second numeric generation beside the event token. Within the supported lifecycle, the event object is the generation token and avoids two pieces of state that can disagree.

#### Install one registration atomically

`install(event, ctx, contribution)` should:

1. validate that the description contains at least one contribution before mutating anything;
2. capture and clear the lifetime's previous owned registration;
3. establish the event's active Session wave;
4. remove the previous registration and any same-id registration from the Editor and handler slots without an intermediate UI restoration, using exact owner-entry checks and raw-function identity checks for handlers;
5. normalize and store the optional Editor entry;
6. replace the model-handler slot if supplied, recording the exact owner entry;
7. replace the input-handler slot if supplied, recording the exact owner entry;
8. retain the exact entries in the lifetime's private current state;
9. schedule one Editor flush when the new registration contains an Editor;
10. if no Editor is supplied but an active Editor entry was removed in the same Session wave, reconcile that removal by flushing the remaining winner or restoring Pi's built-in Editor when no winner remains.

A fresh handler-only registration must not call `setEditorComponent` or schedule an Editor timer. The reconciliation in step 10 is required only because that operation removed an Editor; it is not a handler-only side effect. If the removed Editor belonged to the prior token and a new wave was just established, leave the visible Editor alone until a new Editor contributor arrives, preserving no-flash wave replacement.

If a new registration replaces a same-id Editor contribution owned by another lifetime, the old lifetime's later disposal must be a no-op. If a new handler replaces an old handler in the same slot, the old lifetime's later disposal must not clear the new raw function, even when both registrations use the same function object.

#### Dispose one registration

`dispose()` and the lifetime's automatic `session_shutdown` callback must use the same idempotent operation:

1. capture the current owned entries;
2. clear the lifetime's current reference before doing any work;
3. for each handler whose owner field is the exact entry, clear the owner field; clear the raw handler field only when it still equals that entry's handler;
4. detach the Editor only when the contribution map still points to the exact Editor entry, and record whether this exact entry was actually removed;
5. stop Editor processing when that exact entry was not removed or its Session token is inactive;
6. if the exact active Editor entry was removed and another Editor contribution remains, schedule one flush for the active token;
7. if no active Editor contribution remains, cancel the timer and restore the built-in Editor with a catch around `setEditorComponent(undefined)`;
8. tolerate repeated calls and stale owners.

A handler-only registration stops after step 3. It must not trigger Editor restoration.

#### Preserve the dispatch getters

Keep `getModelCommandHandler()` and `getEditorInputHandler()` returning the raw handler functions. `ModelCommandRoutingEditor.handleInput()` must retain its current order:

1. consult the current input handler;
2. route standalone `/model` if its captured model handler is present;
3. delegate to Pi's normal Editor behavior.

The input hook still sees only keys that a subclass delegates to this base method. `PreviousMessageEditor` handles Up, Down, its dedicated history bindings, and Ctrl+C before it calls `super.handleInput()`. Do not move the hook into that subclass or turn it into a universal preprocessor. Do not use this change to make the model handler dynamically looked up on every keypress. `ui-message-history` intentionally captures the model getter when its Editor factory runs, while `ui-steer-input` intentionally reads the getter when it classifies a queued slash command. Those are existing, different dispatch points.

#### Remove raw new-source registration exports

Remove new-source imports and exports for `registerModelCommandHandler()` and `registerEditorInputHandler()`. The old functions remain reachable only from an already-loaded older extension module during reload; the new source must not use them.

Update the module header comment to document that the Editor slot module owns:

- the Editor winner registry;
- the model-handler slot;
- the input-handler slot;
- exact Session-token ownership;
- automatic shutdown cleanup;
- ownership-safe early disposal;
- token- and timer-handle-guarded deferred flushing.

### Step 3: Move `ui-model-selector` onto the combined lifetime registration

Modify `.pi/extensions/ui-model-selector/index.ts`.

Create one `const editorLifetime = createSessionEditorLifetime(pi)` as the existing Editor lifetime, and remove the `uninstallModelCommandHandler` variable and direct registration import.

In the Profile binding `initialize(binding, event, ctx)`, preserve this ordering:

1. dispose the previous combined Editor/model-handler registration immediately;
2. capture and clear `activeLifecycle`;
3. await the prior lifecycle's disposal;
4. construct Profile-aware persistence;
5. if the new context is non-TUI, return without installing a registration;
6. construct and store the new model-selection lifecycle;
7. create the `/model` handler closure exactly as today;
8. install one registration containing:
   - id `ui-model-selector`;
   - Editor priority 10 and the existing `ModelCommandRoutingEditor` factory;
   - the model command handler;
9. continue with conversation-history detection and lifecycle initialization.

The combined install must happen before awaiting `initializeSession()`, as today, so the routing Editor participates in the same Session start wave. When this combined contribution is later disposed while the priority-20 history contribution remains, the slot lifetime must re-flush the history winner so its factory captures the current model-handler getter.

In the Profile binding `dispose()` callback:

1. dispose the combined Editor/model-handler registration before awaiting longer lifecycle cleanup;
2. capture and clear `activeLifecycle`;
3. await its disposal;
4. leave no direct registry cleanup in the adapter.

The automatic `session_shutdown` callback installed by `createSessionEditorLifetime()` and the Profile binding cleanup both call disposal. That is intentional; disposal must be idempotent. The existing model-selector harness already preserves both listeners in registration-order arrays; retain that behavior while adding real shutdown cleanup.

Keep all model-selection lifecycle errors, notices, persistence ordering, and non-TUI behavior unchanged.

### Step 4: Move `ui-steer-input` onto the input-handler lifetime

Modify `.pi/extensions/ui-steer-input/index.ts`.

Create `const editorLifetime = createSessionEditorLifetime(pi)` near the extension's local state. Use the existing Editor slot lifetime implementation even though this adapter contributes only a handler.

Change the `session_start` handler to receive the event object:

1. call `editorLifetime.dispose()` first so a prior registration cannot survive a repeated initialization without a preceding shutdown;
2. if the context is not TUI, return without installing the input handler;
3. preserve `sessionCtx`, widget, and queue state behavior;
4. install one handler-only registration with id `ui-steer-input` and `editorInputHandler: handleSteerInput`.

Remove `unregisterInputHandler` and its direct registration call.

Keep the local `session_shutdown` handler responsible for:

- setting `agentActive` false;
- clearing queued slash commands and the Session context;
- clearing the steering widget.

The lifetime's automatically registered shutdown listener owns the global input-handler cleanup. The local handler must not call `editorLifetime.dispose()` or reimplement registry ownership. Test both listeners rather than duplicating cleanup.

Do not change Tab queueing, `/model` recognition, Enter steering, FIFO drain order, or history recording.

### Step 5: Move `ui-message-history` to the normalized Editor contribution shape

Modify `.pi/extensions/ui-message-history/index.ts` only as needed for the new registration description.

Keep:

- the priority-20 Editor contribution;
- the Session-local `cwd` capture;
- `store.load()` on Session start;
- the independent `store.flush()` shutdown handler;
- `getModelCommandHandler()` lookup when the Editor factory is created.

Wrap the existing Editor factory data in the new `editor` field. Do not give this registration a model or input handler.

The history module should continue to rely on the Editor slot lifetime for Editor restoration and on its own shutdown handler for history persistence. These are separate responsibilities.

### Step 6: Update shared and adapter tests without low-level registry cleanup

#### `.pi/extensions/_shared/editor-slot.test.ts`

Use the real lifetime interface for every handler installation. Remove imports and helpers for the raw register functions. Add the exact-owner and new-wave cases from Step 1.

Ensure fake timers are drained before global cleanup. Dispose all created lifetimes in reverse order so a stale cleanup cannot hide an ownership bug.

#### `.pi/extensions/ui-model-selector/index.test.ts`

Remove the `afterEach` raw-handler reset and direct `registerModelCommandHandler` import.

Retain the harness's existing array-backed event storage and shared `SessionStartEvent` per start wave. It must invoke both the lifetime's automatic shutdown callback and the Profile binding's shutdown callback in registration order. Do not regress this existing harness correction.

Make harness cleanup call the real Session shutdown path for every created harness, including tests that already shut down explicitly; repeated shutdown must be harmless. Keep the current assertions for:

- no selector registration in print, JSON, or RPC modes;
- model handler and routing Editor installation;
- replacement on reload;
- waiting for an in-flight lifecycle disposal;
- old handler rejection after replacement;
- TUI-to-non-TUI cleanup;
- exactly one visible built-in Editor restoration.

Do not mock `createSessionEditorLifetime()`. These tests should cross the real seam.

#### `.pi/extensions/ui-steer-input/index.test.ts`

Remove direct register imports and the `handlerUnregisters` cleanup list.

Update the harness to retain multiple listeners, expose its shared Session start event, and fire the real shutdown sequence. For tests that need a model handler while testing queued `/model`, install a model-handler-only registration through a test lifetime using the same Session start token as the steering handler. Let the lifetime shutdown callback clean it up.

Keep the existing behavior assertions for:

- TUI versus non-TUI registration;
- automatic shutdown cleanup;
- replacement where an old Session shutdown cannot remove a newer handler;
- empty and whitespace Tab consumption;
- follow-up queueing and history recording;
- slash-command FIFO drain and re-entrancy;
- `/model` dispatch;
- normal Enter submission;
- steering notifications.

#### `.pi/extensions/ui-message-history/steer-recall.test.ts`

No edit is required in this file. Its current harness already stores listener arrays, passes one event object to every listener, fires the real Session shutdown sequence, and contains no low-level removal import or direct registry reset. Retain the existing assertion that the input handler is undefined after Session cleanup. If the production migration makes that assertion fail, fix the lifetime wiring rather than adding test-only registry cleanup.

### Step 7: Preserve Plan Review isolation

Inspect and run the Plan Review tests that cover the synchronous temporary Editor swap in `.pi/extensions/workflows-plan/plan-review.test.ts`.

Do not change Plan Review production code. Its bridge:

1. captures the current Editor factory;
2. installs a temporary command-submit Editor;
3. obtains the synchronous submit callback;
4. restores the exact prior factory in `finally`.

It has no `await`, timer, or callback yield inside the swap, does not compete by Editor priority, and is not a Session contribution. Moving it into the lifetime registration would reduce locality by mixing two different lifetimes.

Extend the existing Plan Review failure characterization in `.pi/extensions/workflows-plan/plan-review.test.ts`: for the fresh-prompt failure case, seed the harness with a distinct existing Editor factory, capture `const previousFactory = harness.getEditorComponent()` before `agent_settled`, assert the command submission still rejects, then assert `harness.getEditorComponent()` is `previousFactory` and `harness.setEditorComponent` was last called with `previousFactory`. This verifies restoration of a non-default factory in `finally` when submission fails, without changing Plan Review production code.

### Step 8: Update `CONTEXT.md` and module comments

Modify the existing **TUI editor slot** entry in `CONTEXT.md` after implementation. Do not invent a separate domain concept. Sharpen the existing Editor slot module definition to say that:

- the model-handler and input-handler registries are Session-owned registrations;
- each registration is associated with the exact `SessionStartEvent` token;
- automatic shutdown and ownership-safe early disposal are inside the module;
- a registration can provide an Editor, a model handler, an input handler, or a valid combination;
- replacement and stale cleanup are identity-safe;
- history and model selection remain adapters at the Editor slot seam;
- the streaming input handler remains a separate single slot;
- Plan Review remains the only external synchronous Editor swap.

Update the header comment in `.pi/extensions/_shared/editor-slot.ts` to match the final invariants without adding implementation detail that belongs in tests.

There are no ADR files under `docs/adr`, so no decision conflict needs to be reopened.

## Test strategy

### Shared module checks

Run from `.pi`:

```bash
pnpm exec vitest run extensions/_shared/editor-slot.test.ts
```

The shared suite must prove:

- handler-only registration and disposal;
- rejection of an all-empty registration before state changes;
- combined registration cleanup;
- combined-to-handler-only replacement reconciliation;
- automatic shutdown cleanup;
- exact-owner stale cleanup safety, including two registrations that use the same function object;
- distinct-function legacy raw overwrite compatibility during extension reload;
- new Session-token invalidation under Pi's serialized Session ordering;
- same-wave coexistence of Editor, model, and input registrations;
- no Editor effect or timer for a fresh handler-only registration;
- deferred flush cancellation;
- old timer rejection;
- priority and tie behavior;
- late higher-priority remount;
- remaining-winner remount;
- built-in Editor restoration;
- restoration-error containment;
- thinking-border reapplication;
- idempotent repeated disposal.

### Adapter checks

Run:

```bash
pnpm exec vitest run \
  extensions/ui-model-selector/index.test.ts \
  extensions/ui-steer-input \
  extensions/ui-message-history/steer-recall.test.ts
```

These tests must use the real lifetime seam. No test should call a raw global handler setter or an old removal escape hatch.

### Plan Review regression check

Run:

```bash
pnpm exec vitest run extensions/workflows-plan/plan-review.test.ts
```

Confirm that the synchronous temporary Editor swap still restores the prior factory even when command submission reports an error, using the explicit assertion added to `plan-review.test.ts`.

### Typecheck and focused package scripts

Run:

```bash
pnpm typecheck
pnpm test:message-history
pnpm test:steer
pnpm test:features
pnpm test:plan
```

`test:features` covers the Model selector tests through the repository's existing package script. Do not add a new test script for this refactor.

### Full repository verification

Run:

```bash
pnpm test
git diff --check
git status --short
```

The final status should show only the intended implementation files and documentation changes, plus the untracked `plan.md` if it remains as the working plan. Do not stage, commit, or discard changes.

## Manual TUI verification

Automated tests cover the ownership seam but not the visible Pi TUI. If an interactive Pi session is available after implementation:

1. start a TUI Session with `ui-message-history`, `ui-model-selector`, and `ui-steer-input` enabled;
2. submit a normal prompt;
3. press Up in an empty Editor and confirm the previous prompt returns;
4. submit `/model` and confirm it routes silently rather than becoming a normal prompt;
5. start an agent response, type a follow-up, and press Tab;
6. confirm the follow-up is queued, recorded in history, and the mounted history Editor remains active;
7. run `/reload` during normal use and repeat the `/model`, Up, and Tab checks;
8. exercise `/new`, `/resume`, and `/fork` once each, checking that no old handler or Editor reappears;
9. switch to a non-TUI Session if supported and confirm the model and input getters no longer dispatch the prior TUI handlers;
10. quit and confirm TUI teardown does not report an Editor restoration error.

If an interactive TUI is unavailable, report that limitation separately. Passing typecheck and focused tests is not evidence that the visible workflow was manually exercised.

## Edge cases and invariants checklist

Implementation is complete only when all of these hold:

- [ ] the Editor slot module owns both handler lifetimes;
- [ ] every new production handler registration carries the exact `SessionStartEvent` token;
- [ ] one registration may contain an Editor, model handler, input handler, or a valid combination;
- [ ] fresh handler-only registrations never mount or clear an Editor;
- [ ] replacing an Editor-bearing registration with handler-only reconciles the removed Editor without an extra handler-only mount;
- [ ] an all-empty registration is rejected before it can discard an active registration;
- [ ] the model handler remains a single replaceable slot;
- [ ] the input handler remains a single replaceable slot;
- [ ] under Pi's serialized Session lifecycle, a new Session token invalidates all old Editor and handler entries;
- [ ] same-wave registrations do not invalidate one another;
- [ ] the plan does not claim arbitrary out-of-order old-token installations are supported;
- [ ] an old lifetime cannot clear a newer handler with the same slot;
- [ ] an old lifetime cannot delete a newer Editor contribution with the same id;
- [ ] lifetime disposal is idempotent;
- [ ] automatic shutdown cleanup is idempotent;
- [ ] shutdown before the deferred flush prevents a disposed Editor factory from mounting;
- [ ] a timer from an old Session cannot mount into a new Session;
- [ ] removing any active Editor contribution remounts the current winner without a built-in-Editor flash;
- [ ] removing the final active Editor contribution restores the built-in Editor best-effort;
- [ ] a torn-down TUI cannot turn handler or Editor cleanup into a Session failure;
- [ ] getter behavior remains compatible with `ModelCommandRoutingEditor` and `ui-message-history`;
- [ ] the model selector disposes its combined registration before its lifecycle wait;
- [ ] steering local queue and widget cleanup remain separate from global handler ownership;
- [ ] non-TUI Sessions never install TUI handlers or Editor contributions;
- [ ] the `Symbol.for` registry key remains unchanged;
- [ ] legacy raw handler fields are tolerated during extension reload;
- [ ] a legacy raw overwrite using a different function cannot be cleared by disposing an unrelated new owner;
- [ ] the legacy compatibility guarantee does not claim to distinguish an identical-function overwrite;
- [ ] no new production or test source caller uses a raw registration setter;
- [ ] Plan Review remains outside the Session lifetime;
- [ ] `CONTEXT.md` accurately describes the final Editor slot module.

## Expected files changed

Production:

- `.pi/extensions/_shared/editor-slot.ts`
- `.pi/extensions/ui-model-selector/index.ts`
- `.pi/extensions/ui-steer-input/index.ts`
- `.pi/extensions/ui-message-history/index.ts`
- `CONTEXT.md`

Tests:

- `.pi/extensions/_shared/editor-slot.test.ts`
- `.pi/extensions/ui-model-selector/index.test.ts`
- `.pi/extensions/ui-steer-input/index.test.ts`
- `.pi/extensions/workflows-plan/plan-review.test.ts`

Do not change:

- `.pi/extensions/_shared/editor-border.ts`;
- `.pi/extensions/ui-message-history/history-store.ts`;
- model-selection lifecycle implementation;
- Plan Review production code;
- Pi itself;
- unrelated files or existing user changes.

## Completion criteria

The implementation is finished when:

1. `SessionEditorLifetime.install()` is the only new production seam for Editor, model-handler, and input-handler ownership.
2. all new handler registrations are tied to exact Session tokens and cleaned automatically on shutdown.
3. `ui-model-selector` uses one combined registration and no longer owns an unregister callback.
4. `ui-steer-input` uses a handler-only registration and no longer owns an unregister callback.
5. `ui-message-history` remains an Editor-only registration and continues to flush history independently.
6. stale Session cleanup cannot remove a current handler or Editor.
7. the raw registration functions are gone from new production and test source.
8. the global `Symbol.for` registry remains compatible with older extension copies during the supported reload transition.
9. focused tests, typecheck, package scripts, and the full suite pass.
10. the manual TUI flow is exercised or explicitly reported as unavailable.
11. `CONTEXT.md` documents the final deep Editor slot module accurately.
