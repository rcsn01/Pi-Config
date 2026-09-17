# Deepen the Editor slot contribution lifetime

## Goal

Make the shared Editor slot module own a Session editor contribution from installation through shutdown. Remove caller-owned removal by public contributor id, prevent stale Session cleanup from deleting a newer contribution, and make pending Editor flushes safe across reload and Session replacement.

The user-visible behavior must remain the same:

- `ui-message-history` remains the winning Session editor at priority 20.
- Up and Down continue to navigate persisted prompt history.
- standalone `/model` submissions continue to route through the Model selector without entering the transcript.
- the streaming Tab handler continues to intercept input without swapping the mounted Editor.
- the thinking-level border continues to be reapplied after Pi mounts a custom Editor.
- Plan Review keeps its synchronous temporary Editor swap outside the shared Session contribution machinery.

## Why this change

The Editor slot registry is global because Pi loads each extension with its own copy of shared modules. The `Symbol.for("pi-config.editor-slot.v1")` key lets those copies coordinate one TUI Editor slot.

The registry currently owns winner selection and installation, but not the full contribution lifetime:

- `ui-message-history` calls `installSessionEditor()` on `session_start` and never removes its contribution on `session_shutdown`.
- `ui-model-selector` removes its contribution from its Profile adapter's `dispose()` callback.
- `ui-message-history/steer-recall.test.ts` compensates by importing `removeSessionEditor()` and manually removing the history contribution after firing shutdown.
- `removeSessionEditor(ctx, id)` deletes by public id. A stale Session cleanup can therefore delete a newer Session's replacement with the same id.
- a pending zero-delay flush remains scheduled when the last contribution is removed. It is a no-op if the map stays empty; if a new contribution arrives first, the old callback mounts from the new map. Timer ownership and Session currency are not explicit.

The deletion test confirms the module is not deep enough: deleting the integration test's manual cleanup leaves global contribution state behind. Correct cleanup knowledge has leaked into a caller and a test.

## Scope

### In scope

- Session editor contribution registration.
- Session identity for contribution waves.
- automatic contribution cleanup on `session_shutdown`.
- ownership-safe early disposal for the Model selector's Profile lifecycle.
- deferred flush cancellation and stale-callback rejection.
- remounting the next priority winner after early disposal.
- restoring Pi's built-in Editor when the current Session has no contributions.
- focused unit, adapter, and cross-extension integration tests.
- `CONTEXT.md` and module comments that describe the final interface and invariants.

### Out of scope

- changing Editor priority values.
- changing prompt-history behavior or persistence format.
- changing `/model` parsing or selection behavior.
- changing the single streaming input-handler registry.
- supporting multiple simultaneous input handlers.
- moving Plan Review's synchronous command-submit bridge into the Session contribution registry.
- introducing a port or filesystem adapter. The dependency category is in-process; Pi's TUI calls are already supplied by `ExtensionContext`.
- changing Pi itself.

## Recommended decisions

The repository evidence below resolves the design decisions. Implement them as written.

### 1. Identify a Session contribution wave with the exact `SessionStartEvent` object

Use the `session_start` event object as the in-process Session token.

Reasons:

- Pi's extension runner emits one event object to every extension handler in the wave.
- the token is naturally unique across startup, reload, new, resume, and fork starts.
- `cwd` is not unique enough.
- `ctx.sessionManager.getSessionId()` can remain the same across reload and therefore does not identify an extension-runtime lifetime.
- public contributor ids identify adapters, not Session ownership.

The token is internal to the module. Callers pass the event they already receive and never compare or store it themselves.

### 2. Expose one lifetime object per contributing adapter

Replace the shallow install/remove pair with this conceptual interface:

```ts
export interface SessionEditorLifetime {
	install(
		event: SessionStartEvent,
		ctx: ExtensionContext,
		contribution: SessionEditorContribution,
	): void;
	dispose(): void;
}

export function createSessionEditorLifetime(
	pi: Pick<ExtensionAPI, "on">,
): SessionEditorLifetime;
```

Use these names and this responsibility split.

`createSessionEditorLifetime(pi)` registers the adapter's shutdown hook inside the Editor slot module. `install()` contributes an Editor for one Session wave and atomically replaces that lifetime's prior entry without restoring the built-in Editor between entries. `dispose()` supports early Profile disposal. It is idempotent and removes only the exact entry the lifetime currently owns.

Do not expose a separate lease object. There are exactly two production contributors, each owns at most one current contribution, and only the Model selector needs early disposal. A public lease would duplicate the lifetime's private current-entry state without serving a consumer. Do not keep `removeSessionEditor(ctx, id)` either. Deleting by id is the source of the stale-owner bug.

### 3. Keep the global registry key compatible

Keep `Symbol.for("pi-config.editor-slot.v1")`. Extend the existing object with the optional `activeSessionToken` field rather than replacing it.

This matters during `/reload`: old extension code and new extension code can briefly reference the same global registry. A compatible extension lets a pending old callback safely observe the new contribution map.

Use this registry shape:

```ts
interface EditorSlotRegistry {
	modelCommandHandler?: ModelCommandHandler;
	editorInputHandler?: EditorInputHandler;
	contributions: Map<string, ContributionEntry>;
	nextOrder: number;
	flushTimer?: ReturnType<typeof setTimeout>;
	activeSessionToken?: object;
}
```

Use these registry fields. Keep `contribution`, `ctx`, and `order` on each entry so a callback created by the currently installed v1 code can still read an entry during `/reload`.

### 4. Make contribution ownership object-based

Each registry entry must have a unique internal identity:

```ts
interface ContributionEntry {
	contribution: SessionEditorContribution;
	ctx: ExtensionContext;
	sessionToken: object;
	order: number;
}
```

A lifetime captures the exact `ContributionEntry`. Disposal succeeds only when:

```ts
registry.contributions.get(entry.contribution.id) === entry
```

If a newer Session or a newer registration replaced the id, cleanup from the old lifetime becomes an idempotent no-op.

This matches the ownership-safe behavior already used by `registerModelCommandHandler()` and `registerEditorInputHandler()`.

### 5. Treat a new Session token as a new contribution wave

On the first installation for a token different from `registry.activeSessionToken`:

1. set the new active token;
2. invalidate all prior Session contribution entries;
3. cancel and clear any prior deferred flush handle;
4. add the new entry;
5. schedule one deferred flush for the new token.

Do not call `setEditorComponent(undefined)` between clearing the old wave and scheduling the new wave. The new winner will replace the old Editor on the deferred flush, avoiding unnecessary visible churn.

A late cleanup from the old lifetime must not clear or remount anything after the token changes. Do not add a numeric generation. The start-event object is already a unique generation token; carrying both duplicates state and creates synchronization cases with no additional protection.

### 6. Preserve the existing winner rule

Within the active Session wave:

1. highest `priority` wins;
2. latest registration order wins a priority tie.

Do not add automatic priority allocation or a public winner query.

### 7. Make deferred flushes token-aware

A scheduled callback must capture both its timer handle and the active Session token. Before mounting, it must verify that:

- its handle is still `registry.flushTimer`;
- its token is still `registry.activeSessionToken`;
- the active wave still has a winner for that token.

When the last active contribution is disposed before the flush:

- cancel the timer with `clearTimeout()`;
- set `flushTimer` to `undefined` immediately;
- restore the built-in Editor once;
- ensure a later callback cannot mount the disposed factory.

When one contribution is disposed and another remains:

- keep or schedule one flush;
- mount the remaining winner after the deferred wave;
- do not restore the built-in Editor first.

### 8. Make teardown best-effort after TUI destruction

Add a catch around the cleanup call to `ctx.ui.setEditorComponent(undefined)`. The current module catches only the deferred installation call; `removeSessionEditor()` currently lets restoration errors escape. Pi may already be tearing down the TUI, so automatic shutdown cleanup must not fail the Session for this reason.

Keep the existing broad catch around deferred installation unchanged. Pi 0.84.4 constructs the factory synchronously inside `setEditorComponent(factory)`, so that catch currently contains both torn-down-TUI failures and contribution construction failures. Separating those error classes would change existing behavior and is outside this lifetime fix. Do not add validation or fallback behavior.

### 9. Keep history persistence outside the Editor slot module

The Editor slot module owns Editor contribution lifetime, not history-file persistence.

`ui-message-history` must retain its `session_shutdown` handler that calls `store.flush()`. The new automatic Editor cleanup and the existing store flush are separate responsibilities.

### 10. Keep Plan Review outside

`workflows-plan/plan-review.ts` temporarily installs a command-submit bridge, obtains Pi's synchronous submit callback, and restores the previous Editor factory in `finally`.

Do not convert this bridge into a Session contribution. It has a shorter synchronous lifetime, does not compete by priority, and already restores the exact prior factory.

## Detailed implementation plan

### Step 1: Lock the current failure down at the shared module interface

Modify `.pi/extensions/_shared/editor-slot.test.ts` before changing the implementation.

Add a Pi event harness that:

- records multiple handlers for `session_start` and `session_shutdown`;
- fires one shared `SessionStartEvent` object to all start handlers;
- fires shutdown after start;
- supplies separate `ExtensionContext` test doubles for replacement-runtime scenarios;
- continues using fake timers so the zero-delay flush is deterministic.

Add failing tests for the new lifetime interface.

#### Automatic shutdown after mount

1. create a lifetime;
2. install one contribution for a start event;
3. flush timers and assert its factory mounted;
4. fire `session_shutdown`;
5. assert `setEditorComponent(undefined)` restored the built-in Editor;
6. call shutdown again and assert cleanup is idempotent.

#### Shutdown before deferred flush

1. install one contribution;
2. fire shutdown before timers run;
3. drain timers;
4. assert the contribution's factory never ran;
5. assert the built-in Editor was restored once;
6. assert no stale callback remains scheduled.

#### Stale lifetime cannot delete a newer same-id entry

1. create lifetime A and lifetime B;
2. install id `history` through lifetime A for Session token A;
3. install id `history` through lifetime B for Session token B;
4. dispose lifetime A;
5. flush timers;
6. assert Session B's factory mounts;
7. dispose lifetime B and assert the built-in Editor is restored.

#### Re-registration within one Session is ownership-safe

1. create lifetime A and lifetime B;
2. install id `selector` through both lifetimes for the same Session token;
3. dispose lifetime A;
4. assert lifetime B's replacement remains the winner;
5. reinstall through lifetime B before the pending flush and assert no intermediate `setEditorComponent(undefined)` call occurs;
6. flush and assert only the latest factory mounts;
7. dispose lifetime B and assert cleanup occurs.

#### Old timer cannot mount into a newer wave

1. install a contribution for token A without flushing and capture its timer count;
2. install a contribution for token B;
3. assert only one timer remains pending;
4. drain all timers;
5. assert only B's factory is mounted;
6. assert A's factory was never invoked.

#### Early winner disposal remounts the remaining adapter

1. create two lifetimes to model two extension adapters;
2. install priority 10 Model selector and priority 20 history for the same token;
3. flush and assert history wins;
4. dispose history early and flush;
5. assert Model selector mounts;
6. dispose Model selector and assert the built-in Editor returns.

#### TUI restoration failure is contained

1. install and flush one contribution;
2. make `setEditorComponent(undefined)` throw;
3. dispose its lifetime and assert disposal does not throw;
4. fire shutdown again and assert repeated cleanup remains a no-op.

Also preserve characterization tests for:

- same-tick flush coalescing;
- higher-priority late registration;
- latest-registration tie breaking;
- thinking-border reapplication.

Rewrite those tests through `SessionEditorLifetime.install()` instead of calling a lower-level install function. The interface is the test surface.

Delete tests whose only purpose is the old public `removeSessionEditor(ctx, id)` interface.

### Step 2: Deepen `_shared/editor-slot.ts`

Modify `.pi/extensions/_shared/editor-slot.ts`.

#### Add the lifetime type

Import the Pi event types needed by the interface:

```ts
import type {
	ExtensionAPI,
	ExtensionContext,
	SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
```

Type the factory parameter as `Pick<ExtensionAPI, "on">`, as shown in the interface above. Import `ExtensionAPI` only for that type.

Export:

- `SessionEditorLifetime`;
- `createSessionEditorLifetime()`;
- the existing `SessionEditorContribution`.

Stop exporting:

- `installSessionEditor()`;
- `removeSessionEditor()`.

The raw registry mutation functions should become private implementation details.

#### Add Session token state

Extend each contribution entry with the exact start-event token. The entry object itself is its unique ownership identity.

Extend the registry with the active token. Initialize the missing field lazily so the existing v1 global object remains usable during hot reload. On the first installation after migration, an undefined active token counts as a different wave: clear legacy entries and cancel the legacy pending timer before adding the new entry.

#### Implement active-wave transition

Create one private function that establishes the active Session wave. It must:

- do nothing when the token is already active;
- invalidate prior contribution entries when the token changes;
- cancel and clear a pending flush from the prior token;
- preserve model-command and input-handler registries;
- preserve monotonic registration order;
- avoid clearing the visible Editor before the new winner flushes.

Keep all wave-transition rules in this function for locality.

#### Implement exact-entry disposal

Create a private `disposeContribution(entry)` function.

Required ordering:

1. return if the current map entry for the id is not the exact entry;
2. delete the entry;
3. return without UI effects if the entry's token is no longer active;
4. if no active entries remain, cancel the pending flush and restore the built-in Editor best-effort;
5. otherwise schedule one flush so the next winner remounts.

The lifetime closes over this function and its current entry. It needs no public id or context parameters.

#### Implement the lifetime

`createSessionEditorLifetime(pi)` keeps only the adapter's current entry in its closure.

Its `install(event, ctx, contribution)` method:

1. capture and clear the lifetime's prior entry;
2. establish the active Session wave from `event`;
3. if the prior entry is still the exact current map entry, delete it without triggering restoration or a remount;
4. create and add the replacement contribution entry;
5. store that exact entry;
6. schedule the deferred flush.

Do not implement replacement by calling public `dispose()`. If the lifetime is the only contributor, that would restore the built-in Editor before immediately scheduling its replacement. It would also break the existing same-tick re-registration behavior by adding an observable `undefined` slot write.

Its public `dispose()` method and internally registered `session_shutdown` handler use the same private closure operation:

1. capture the current entry;
2. clear the closure's reference before disposal;
3. dispose the captured exact entry if one exists;
4. tolerate repeated calls.

The hook must not delete by id and must not inspect mutable global winner state to infer ownership.

#### Make scheduling explicit

Refactor `scheduleFlush()` so a callback captures its timer handle and Session token, then verifies both before calling `flushSessionEditor(token)`.

Refactor `flushSessionEditor(token)` to mount only a winner whose entry token equals both the captured token and the registry's active token.

Add a private cancellation function that always both clears the timer and resets the registry field.

Preserve the existing broad try/catch around deferred TUI installation and the existing thinking-border behavior. Add a separate best-effort catch around restoration with `undefined`.

### Step 3: Move `ui-message-history` onto the lifetime interface

Modify `.pi/extensions/ui-message-history/index.ts`.

At extension construction:

```ts
const editorLifetime = createSessionEditorLifetime(pi);
```

In `session_start`:

- keep the TUI guard;
- call `store.load()` as today;
- capture `const cwd = ctx.cwd` locally;
- call `editorLifetime.install(event, ctx, contribution)`;
- do not call `dispose()` from this adapter because ordinary shutdown is automatic.

Remove the mutable `currentCwd` variable. The Editor factory and record callback should close over the Session's local `cwd`:

```ts
const cwd = ctx.cwd;

createEditor: (...) => {
	const editor = new PreviousMessageEditor(...);
	editor.attach(
		store.listFor(cwd),
		(text) => store.record(cwd, text),
		getModelCommandHandler(),
	);
	return editor;
}
```

This prevents a deferred factory from reading a cwd changed by a later Session start.

Keep the existing independent shutdown handler:

```ts
pi.on("session_shutdown", () => store.flush());
```

Do not call the lifetime's manual `dispose()` from this adapter. Automatic shutdown is the point of the deepened interface.

Update the file's design comment to say the Editor slot module owns Session registration, wave selection, and teardown.

### Step 4: Move `ui-model-selector` onto the lifetime interface

Modify `.pi/extensions/ui-model-selector/index.ts`.

Replace imports of `installSessionEditor` and `removeSessionEditor` with `createSessionEditorLifetime`.

Create one lifetime inside the extension factory before registering the Profile binding:

```ts
const editorLifetime = createSessionEditorLifetime(pi);
```

In the Profile adapter's `initialize(binding, event, ctx)`, preserve all old-state cleanup before the non-TUI return. Use this exact order:

1. call `editorLifetime.dispose()` so a prior routing Editor cannot remain mounted while lifecycle cleanup waits;
2. unregister and clear the prior Model command handler;
3. capture, clear, and await the prior `activeLifecycle`;
4. construct Session persistence as today;
5. return if the new Session is non-TUI;
6. construct and store the new selection lifecycle and `/model` handler;
7. register the Model command handler;
8. install the priority 10 Editor through `editorLifetime.install(event, ctx, ...)`;
9. continue with conversation-history detection and lifecycle initialization.

Steps 1 through 3 must run even for a non-TUI replacement. Otherwise a TUI Session followed by a print, JSON, or RPC Session would leave old routing state active. Install before awaiting `lifecycle.initializeSession()`, preserving the current ordering and avoiding an unnecessary delay before the routing Editor can participate in the start wave.

In Profile adapter `dispose(binding, ctx)`:

1. call `editorLifetime.dispose()` before awaiting longer lifecycle cleanup;
2. capture and clear `activeLifecycle`;
3. await lifecycle disposal;
4. unregister and clear the Model command handler;
5. remove the old `removeSessionEditor(ctx, "ui-model-selector")` call and the now-unused `ctx` parameter name.

Exact-entry disposal ensures an old Profile cleanup cannot remove a newer selector entry. Clearing `activeLifecycle` before awaiting prevents re-entrant cleanup from targeting a replacement.

Because `createSessionEditorLifetime(pi)` runs before `wireSessionProfileBinding(pi, ...)`, Pi invokes the lifetime's automatic shutdown handler before the Profile binding's shutdown handler in this adapter. The second `editorLifetime.dispose()` is therefore an idempotent no-op on ordinary shutdown. Tests must also cover Profile disposal directly through replacement initialization, where it runs before Session shutdown.

Do not add a `try/finally` for lifecycle rejection. `ModelSelectionLifecycle.dispose()` uses `Promise.allSettled([...operations]).then(...)` and cannot reject through an operation failure. Preserve the existing command-handler cleanup order; only Editor disposal moves before the await.

### Step 5: Remove manual cleanup from the cross-extension integration test

Modify `.pi/extensions/ui-message-history/steer-recall.test.ts`.

Remove:

```ts
import { removeSessionEditor } from "../_shared/editor-slot.ts";
```

Change `disposeSession()` to fire only the real shutdown event:

```ts
async function disposeSession(session: SessionHarness): Promise<void> {
	await session.pi.fire("session_shutdown");
}
```

Strengthen the harness so shutdown behavior is observable:

- create one default event object per `fire()` call before iterating listeners, so every handler receives the same object exactly as Pi's runner does;
- retain access to `ctx.ui.setEditorComponent`;
- after shutdown, assert its last call restores the built-in Editor with `undefined`;
- continue asserting `getEditorInputHandler()` is undefined after every test;
- continue verifying the history store flushes to the temporary file.

This is the deletion-test proof: the integration test must clean up through the production interface with no test-only registry call.

Add or adapt a reload test that uses two complete Session harness instances:

1. start and mount the first Session;
2. fire first shutdown with reason `reload`;
3. start and mount the second Session;
4. assert the second Editor recalls history and handles streaming Tab;
5. assert the first Session's later repeated cleanup cannot clear the second Editor.

The existing harness can keep both runtime closures alive because each `createSession()` call owns its listener map while the registries are global. Implement the supported shutdown-then-start order above and fire the first harness's shutdown a second time after Session 2 mounts. Cover the harder start-new-before-old-cleanup race with two lifetimes in `_shared/editor-slot.test.ts`.

### Step 6: Update Model selector adapter tests

Modify `.pi/extensions/ui-model-selector/index.test.ts`.

Preserve the existing tests for:

- no Editor in print, JSON, or RPC modes;
- command handler and routing Editor installation;
- command ownership replacement on reload;
- waiting for in-flight lifecycle disposal;
- rejecting a captured old handler after Session replacement;
- command and Editor cleanup on shutdown.

The current harness stores one handler per event in a `Map`, but the new lifetime and `wireSessionProfileBinding()` each register their own `session_shutdown` handler. Change it to arrays, invoke every handler in registration order, and pass one shared event object and context to all handlers. Without this change, the later Profile wiring silently overwrites the lifetime cleanup hook and the adapter tests exercise the wrong runtime behavior.

Change assertions to observe behavior through the lifetime interface:

- after startup, wait for a function factory to be installed;
- after shutdown, assert the built-in Editor is restored exactly once even though both shutdown handlers call the idempotent lifetime cleanup path;
- on a TUI-to-non-TUI replacement start, assert the old Editor and command handler are removed;
- after reload, assert the newer routing factory remains; simulate stale old-lifetime disposal in the shared module suite, where two independent lifetimes can be retained accurately.

Do not mock the lifetime module. The test should cross the real shared seam.

### Step 7: Confirm `ui-steer-input` needs no implementation change

Do not modify `.pi/extensions/ui-steer-input/index.ts`.

It uses the separate ownership-safe `registerEditorInputHandler()` interface and already unregisters on shutdown. It does not contribute an Editor and must not acquire a `SessionEditorLifetime`.

Run its tests because Editor lifetime changes can affect the mounted routing Editor.

### Step 8: Confirm Plan Review remains isolated

Run the Plan Review tests that cover `submitEditorCommand()` in `.pi/extensions/workflows-plan/plan-review.test.ts`.

The temporary bridge must still:

- capture the current factory;
- install its bridge synchronously;
- obtain the submit callback;
- restore the exact previous factory in `finally`.

Do not edit Plan Review production code. The swap and restoration contain no `await`, timer, or callback yield, so Session cleanup cannot interleave with the temporary bridge on JavaScript's event loop. Do not introduce an Editor stack.

### Step 9: Update domain and module documentation

Modify `CONTEXT.md` under **TUI editor slot**.

Update the Editor slot module definition to include:

- Session-event-token ownership;
- automatic shutdown cleanup;
- ownership-safe lifetime disposal;
- token- and timer-handle-guarded deferred flushes;
- history and Model selector as adapters;
- streaming input interception as a separate registry;
- Plan Review as the only external synchronous swap.

Update the header comment in `_shared/editor-slot.ts` to state the same invariants concisely.

Do not add a new domain term. The implementation uses only the existing **Editor slot module** and Session vocabulary.

## Test strategy

### Shared module tests

Run:

```bash
cd .pi
pnpm exec vitest run extensions/_shared/editor-slot.test.ts
```

The suite must prove:

- same-wave coalescing;
- priority and tie behavior;
- late higher-priority remount;
- exact-entry lifetime ownership;
- atomic same-lifetime replacement without an `undefined` slot write;
- automatic shutdown cleanup;
- shutdown-before-flush cancellation;
- old-wave timer invalidation;
- stale lifetime safety;
- remaining-winner remount;
- built-in Editor restoration;
- containment of restoration errors after TUI teardown;
- thinking-border reapplication;
- `/model` and input handler registries remain unchanged.

### Adapter tests

Run:

```bash
cd .pi
pnpm exec vitest run \
  extensions/ui-message-history \
  extensions/ui-model-selector/index.test.ts \
  extensions/ui-steer-input
```

These tests must exercise the real shared interface rather than mocked removal.

### Plan Review regression tests

Run the narrow Plan Review suite:

```bash
cd .pi
pnpm exec vitest run extensions/workflows-plan/plan-review.test.ts
```

### Repository checks

Run:

```bash
cd .pi
pnpm typecheck
pnpm test:message-history
pnpm test:steer
pnpm test:features
pnpm test:plan
```

`test:features` includes the Model selector tests in this repository's scripts.

Then run the full suite:

```bash
cd .pi
pnpm test
```

Finally run:

```bash
git diff --check
git status --short
```

Do not alter, stage, or discard unrelated user changes.

## Manual TUI verification

Automated tests do not prove the visible TUI flow. In an interactive Pi session with `ui-message-history`, `ui-model-selector`, and `ui-steer-input` enabled:

1. submit a normal prompt;
2. press Up in an empty Editor and confirm the prompt returns;
3. run `/model`, select or cancel, and confirm the command does not enter normal transcript submission;
4. start an agent response, type a follow-up, press Tab, and confirm the mounted history Editor remains active;
5. run `/reload` immediately after startup and again after normal use;
6. confirm the Editor still supports history, `/model`, and streaming Tab after each reload;
7. use `/new`, `/resume`, and `/fork` once each and confirm no old Editor reappears;
8. quit and confirm no teardown error is printed.

If an interactive TUI is unavailable in the implementation environment, state that limitation in the final result rather than treating tests as equivalent.

## Edge cases and invariants checklist

Implementation is complete only when all of these hold:

- [ ] a contribution is associated with exactly one `SessionStartEvent` token;
- [ ] the first contribution for a new token invalidates the prior wave;
- [ ] all adapters in one start wave share the same active token;
- [ ] an old lifetime cannot remove a replacement with the same public id;
- [ ] lifetime disposal is idempotent;
- [ ] automatic shutdown disposal is idempotent;
- [ ] shutdown before the zero-delay flush prevents the removed factory from mounting;
- [ ] a timer from an old Session token cannot mount into a new Session wave;
- [ ] removing the winner remounts the next winner without a built-in-Editor flash;
- [ ] removing the last active contribution restores the built-in Editor;
- [ ] a torn-down TUI does not turn cleanup into a Session shutdown failure;
- [ ] history captures the Session-local cwd, not a mutable cross-Session variable;
- [ ] history persistence still flushes independently on shutdown;
- [ ] the Model selector can dispose its contribution before Session shutdown;
- [ ] Model command and streaming input-handler ownership remain safe;
- [ ] Plan Review remains outside the contribution registry;
- [ ] non-TUI modes never install a Session Editor;
- [ ] no test imports a low-level removal escape hatch.

## Expected files changed

Production:

- `.pi/extensions/_shared/editor-slot.ts`
- `.pi/extensions/ui-message-history/index.ts`
- `.pi/extensions/ui-model-selector/index.ts`
- `CONTEXT.md`

Tests:

- `.pi/extensions/_shared/editor-slot.test.ts`
- `.pi/extensions/ui-message-history/steer-recall.test.ts`
- `.pi/extensions/ui-model-selector/index.test.ts`

Do not change `ui-steer-input`, `history-store`, Plan Review production code, or nearby files.

## Completion criteria

The refactor is finished when:

1. `removeSessionEditor(ctx, id)` no longer exists as a public interface.
2. both Session Editor adapters use the lifetime interface.
3. history teardown happens through the module's automatic shutdown wiring.
4. Model selector early disposal uses its exact-entry lifetime.
5. no stale lifetime or old flush can mutate the current Session Editor.
6. the integration test no longer performs manual registry cleanup.
7. focused tests, typecheck, and the relevant repository suites pass.
8. the manual TUI flow is exercised or explicitly reported as unavailable.
9. `CONTEXT.md` describes the final deepened module accurately.
