# Implementation plan: one configuration view per Subagent batch

**Status:** Implemented.

## Goal

When `runBatch()` or `runSubagentsParallel()` has no non-nullish caller concurrency override, call `load()` once and use its parsed `ExtensionConfig` for concurrency selection and every launch assignment. If the loaded `maxConcurrency` is absent, concurrency still falls back to `DEFAULT_MAX_CONCURRENCY` while assignments use that same snapshot. Today execution reads Settings once for concurrency and launch preparation reads again for assignments. A direct edit between those reads can give one batch a concurrency limit from one revision and model, thinking, or context assignments from another.

Reuse the full-config snapshot already returned by `SubagentConfigStore.load()`. Carry it through launch preparation into `resolveLaunchBatch()`. Assignment resolution remains the only owner of assignment precedence, and execution remains the only owner of concurrency choice and ordered scheduling.

If the caller supplies a non-nullish `maxConcurrency`, `executeBatch()` preserves the current behavior: it skips that invocation's `load()` and `maxConcurrency` validation. Assignment resolution still reads its effective Settings/legacy namespace once. The `runSubagent()` method itself resolves its one assignment through one read without its own concurrency load. Neither behavior bypasses the separate full-config load during extension session initialization.

This provides a per-run view. It does not add a filesystem lock or make Settings and a legacy file a cross-process transaction.

## Current behavior and evidence

- `.pi/extensions/tools-subagents/subagent-execution.ts:180-219` obtains the config store, evaluates `options.maxConcurrency ?? config.load().maxConcurrency ?? DEFAULT_MAX_CONCURRENCY`, builds requests, then calls launch preparation. The `load()` call happens before registry loading and Agent-name validation. An explicit non-nullish caller override skips it.
- `.pi/extensions/tools-subagents/launch-preparation.ts:14-26` returns early for an empty request list. Otherwise it loads the registry once, resolves every named Agent, and calls `resolveLaunchBatch()` once.
- `.pi/extensions/tools-subagents/config.ts:608-610` implements `load()` as an effective Settings/legacy read followed by full config parsing, including `maxConcurrency` validation.
- `.pi/extensions/tools-subagents/config.ts:624-636` implements `resolveLaunchBatch()` as another effective Settings/legacy read followed by model-only parsing. It captures `activeMainModel` once for all assignments.
- `CONTEXT.md:390-408` says assignment resolution owns batch assignment resolution and that only full config loads validate `maxConcurrency`. `CONTEXT.md:446-456` records the separate concurrency load in `runBatch()`.
- `.pi/extensions/tools-subagents/config.test.ts:858-891` verifies one Settings and Main-model view within `resolveLaunchBatch()`. It does not cover reuse of the preceding concurrency load.
- `.pi/extensions/tools-subagents/index.ts:103-113` repoints the store to the active Profile, migrates legacy config, then calls `configStore.load()` during session initialization, independently of `executeBatch()`. `session-profile-binding.ts:453-457` propagates an initialization failure, and `index.test.ts:269-292` pins path-before-migration-before-load order. A caller override skips only `executeBatch()`'s load; it cannot bypass that earlier session-initialization validation.
- `.pi/extensions/tools-subagents/index.test.ts:306-345` verifies that the active Profile's concurrency change takes effect on the next tool invocation.

This is a narrow consistency gap, not evidence that a user-facing failure has already occurred. The operations are synchronous, so the views can diverge only if the effective files change between reads, such as through a direct edit or another process. Avoid describing it as a general race or adding locking as part of this change.

## Design decisions

1. **Consistency scope.** For `runBatch()` and `runSubagentsParallel()`, call `load()` and reuse its full parsed snapshot whenever the caller's `maxConcurrency` is nullish. Do this even when the loaded `maxConcurrency` is absent and concurrency falls back to `DEFAULT_MAX_CONCURRENCY`. This applies to every launch in that invocation, including one-task `runBatch()`. The `runSubagent()` method has no concurrency decision to share and continues to resolve assignments through one assignment-only read; extension session initialization still performs its separate full-config load.
2. **Snapshot ownership.** Keep the existing `SubagentConfigStore` and its responsibilities. `load()` continues to read the active Settings/legacy source and validate full config. `resolveLaunchBatch()` continues to own assignment resolution and captures Main once. Add an optional parsed `ExtensionConfig` snapshot to `resolveLaunchBatch()`; when supplied, use its model configuration directly and do not reread or reparse Settings. When it is `undefined`, retain the current one-read, model-only path.
3. **Snapshot flow.** `SubagentExecution` retains the `ExtensionConfig` returned by `load()` and passes it through `prepareSubagentLaunches()`. Launch preparation forwards that optional value to the existing assignment resolution seam, including `undefined` when no snapshot exists. The resolver's undefined path performs its existing Settings read. Do not expose raw Settings documents, add a second module, or move `runOrdered()` into the config store.
4. **Caller concurrency override.** A non-nullish `options.maxConcurrency` continues to skip `executeBatch()`'s `load()`. In that case, assignment resolution reads and parses model configuration once, and invalid stored `maxConcurrency` does not block that execution path. This does not bypass the separate session-initialization load in `index.ts`. Preserve the current `Math.max(1, ...)` behavior for the caller value. `undefined` and runtime `null` continue to take the configured path through the existing nullish semantics.
5. **Validation and errors.** With Settings-derived concurrency, full config validation still happens before Agent lookup because `load()` remains at the start of `executeBatch()`. With a caller override, `executeBatch()` skips its full validation and preserves the existing Agent-name-before-assignment-validation order. Model configuration remains validated even when an explicit launch model is supplied. No child starts unless the complete launch list resolves.
6. **Main model.** Keep Main-model capture inside `resolveLaunchBatch()`. It captures the current possibly-undefined Main model once per batch and uses it for every request. Do not eagerly require Main when no effective assignment selects `main`.
7. **Empty inputs.** Preserve existing behavior. With omitted or runtime-null `maxConcurrency`, `runBatch([])` still calls `config.load()` before launch preparation returns an empty list. A load error still rejects the call. With a non-nullish caller override, it skips `load()` and empty launch preparation reads neither registry nor assignment Settings, so stored assignment and concurrency errors are not evaluated. Do not add an early return to `resolveLaunchBatch()`: an empty call without a snapshot still captures Main, reads and parses the effective namespace, and returns an empty list or the existing parse error; with a snapshot it uses that snapshot without rereading Settings and returns an empty list.
8. **Persistence and adapters.** Keep the active Profile path selection, Settings document seam, legacy fallback, migration, and in-memory test store. Add no new adapter, dependency, persisted key, cross-extension interface, or lock.
9. **Domain record.** Update the Subagent entries in `CONTEXT.md` when implementing this plan. State how the full snapshot flows from Settings-derived concurrency through launch preparation to assignment resolution, and how an explicit concurrency override preserves the assignment-only read and skips `maxConcurrency` validation.

## Proposed internal change

Extend the existing config-store operation without changing its assignment request or result shapes:

```ts
resolveLaunchBatch(
  requests: readonly ResolveLaunchBatchRequest[],
  snapshot?: ExtensionConfig,
): readonly ResolvedLaunchConfiguration[];
```

The optional value must be a parsed config returned by that store's `load()`. It is an internal, trusted snapshot, not raw input. `resolveLaunchBatch()` should capture `activeMainModel` at the start as it does now. It should use the supplied snapshot as its `ModelConfiguration` without reading `readSettingsNamespace()` or reparsing it. Without a snapshot, it should keep the existing `parseModelConfiguration(readSettingsNamespace())` path. Both paths resolve the ordered requests through `resolveParsedSubagentAssignment()` and return the existing `launch` values without mutation.

`prepareSubagentLaunches()` gains an optional `configSnapshot` dependency of type `ExtensionConfig`. For non-empty requests, it keeps its current order of work: load the registry once, resolve all string Agent names, build the ordered assignment requests, call `resolveLaunchBatch()` once, and combine each result with its original task fields by index. It forwards the optional value; `undefined` selects the resolver's existing read path. It does not read Settings or implement assignment precedence. Extend the private `prepare` helper in `SubagentExecution` with an optional third `ExtensionConfig` parameter and forward it as `configSnapshot`; leave the existing config-store default intact for `runSubagent()`.

`SubagentExecution.executeBatch()` captures the snapshot only on the configured-concurrency path. In pseudocode:

```ts
const config = getConfig();
const configSnapshot = options.maxConcurrency === undefined || options.maxConcurrency === null
  ? config.load()
  : undefined;
const concurrency = Math.max(
  1,
  options.maxConcurrency ?? configSnapshot?.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY,
);
// Keep request mapping and progress callbacks unchanged.
const preparedRequests = prepare(requests, config, configSnapshot);
return runOrdered(preparedRequests, concurrency, executePrepared);
```

The explicit `undefined` and `null` checks preserve the current `??` evaluation: a non-nullish caller value skips `load()`, while `undefined` or runtime `null` loads config. Keep this check at the existing concurrency decision point; do not duplicate the Settings read in an intermediate helper.

`runSubagent()` continues to call preparation without a snapshot or an `executeBatch()` concurrency load. `runBatch()` and `runSubagentsParallel()` share the snapshot path through `executeBatch()`. Execution keeps ownership of the concurrency default, clamping, ordered results, progress snapshots, and child lifetime. Extension session initialization retains its separate full-config load.

## Implementation sequence

### 1. Add failing tests for snapshot reuse

In `.pi/extensions/tools-subagents/config.test.ts`:

- Load a snapshot from a temporary Settings file whose `subagents` namespace contains `maxConcurrency` and a known assignment. Construct the store without a legacy path so the Settings-read count is unambiguous.
- Change the file after `load()` returns.
- Resolve a multi-Agent launch batch with the saved snapshot and assert every assignment comes from the saved view. Assert the Settings reader was called once total for the load plus supplied-snapshot resolution.
- Resolve another batch without a snapshot and assert it reads the changed Settings and sees the new assignment. This proves next-call refresh.
- Keep the existing test that changes Settings and Main while `resolveLaunchBatch()` itself is reading. It continues to prove one Settings/Main view inside assignment resolution.
- Assert the supplied parsed snapshot is not mutated.
- Preserve existing coverage that `load()` rejects invalid `maxConcurrency` while assignment-only resolution ignores it.

In `.pi/extensions/tools-subagents/launch-preparation.test.ts`:

- Add a case with `configSnapshot` and assert it reaches the single `resolveLaunchBatch()` call alongside the ordered requests.
- Keep the no-snapshot case and verify it resolves from the current store with the same ordered requests. Do not make whether `undefined` is passed positionally part of the contract.
- Retain the empty-input assertions: no registry load and no assignment resolution.
- Retain validation-before-resolution and no-partial-result cases. Named Agent validation remains inside preparation and occurs before its assignment call.

In `.pi/extensions/tools-subagents/subagent-execution.test.ts`:

- Add an invocation-level regression using the in-memory config store. Start with `maxConcurrency: 1` and an old default model. Arrange for `load()` to return that parsed snapshot and then change the store's current document to `maxConcurrency: 3` and a new default model before preparation. This checks the configured concurrency branch; the implementation must also reuse the snapshot when `maxConcurrency` is absent and concurrency falls back to the default.
- Run enough blocked child executions to measure peak concurrency. Assert the first invocation uses concurrency 1 and the old model for every child. If launch preparation drops the snapshot, the test sees the new model and fails.
- Release the children, then invoke the batch again. Assert the next invocation uses concurrency 3 and the new model. This pins the refresh point to the next invocation.
- Add or extend a direct `createSubagentExecution()` caller-override test to prove `executeBatch()` does not call `load()`, the assignment resolver receives `undefined`, the configured assignment is still used, and an invalid stored `maxConcurrency` does not block a non-empty run in this execution-level test. Do not imply that this bypasses the separate session-initialization load in `index.ts`.
- In the existing direct-request test, assert that `runSubagent()` calls assignment resolution without calling `load()`.
- Add explicit empty-execution tests. With `maxConcurrency` omitted, `runBatch([])` calls `load()` once, then returns an empty result without registry lookup, assignment resolution, or child execution. Also cover runtime `null` as the configured path. With a non-nullish caller override, it skips `load()` and returns empty without touching registry, assignment resolution, or child execution.
- Pin failure order with call recording. Without an override, make `load()` throw and provide an unknown Agent; assert the config error wins and registry lookup does not run. With an override, assert `load()` is skipped, Agent-name validation runs before assignment resolution, and no child starts.
- Keep the existing whole-batch-before-child test, progress and callback tests, and configured concurrency tests. The error path must still prevent every child execution.

In `.pi/extensions/tools-subagents/index.test.ts`, retain the active-Profile-path and next-invocation concurrency tests; add no new assertion or production integration test. `index.ts` passes the same `configStore` to execution and repoints that store to the active Profile. The config-store test covers snapshot reuse with the real store, the execution test covers forwarding through preparation, and the existing Profile test covers which file supplies concurrency. An additional extension-level test would repeat those contracts without covering a changed `index.ts` path.

### 2. Thread the snapshot through the existing seam

In `.pi/extensions/tools-subagents/config.ts`:

- Add the optional snapshot parameter to the `SubagentConfigStore.resolveLaunchBatch()` declaration and implementation.
- Use the supplied `ExtensionConfig` as the already-parsed model configuration. Do not call `readSettingsNamespace()` or `parseModelConfiguration()` again on that path.
- Leave the no-snapshot path unchanged. It reads the effective namespace once and uses model-only parsing, so caller concurrency overrides do not start validating `maxConcurrency`.
- Keep Main capture before mapping requests and preserve lazy missing-Main errors, output order, object fields, and the existing thrown errors.
- Do not alter `load()`, `parseSubagentExtensionConfig()`, `parseModelConfiguration()`, or pure precedence functions.

In `.pi/extensions/tools-subagents/launch-preparation.ts`:

- Add the optional typed snapshot to its dependency data.
- Keep empty-input return before registry access.
- Resolve all named Agents before assignment resolution.
- Forward the optional snapshot value to `resolveLaunchBatch()`, including `undefined`; do not load config in this module.
- Leave task fallback, cwd selection, cache-affinity derivation, callbacks, timeouts, output limits, and prepared-request fields unchanged.

In `.pi/extensions/tools-subagents/subagent-execution.ts`:

- Retain the config snapshot whenever a nullish caller override requires `load()`, including when the loaded `maxConcurrency` is absent and the default concurrency is used.
- Derive concurrency from the same snapshot, preserving `??` and `Math.max(1, ...)` behavior.
- Pass that snapshot through the existing `prepare` helper to launch preparation.
- Leave the explicit override path without a full config load or snapshot.
- Leave standalone `runSubagent()` without a concurrency load. Keep execution, event publication, scheduling, and child calls unchanged.

In `.pi/extensions/tools-subagents/test-harness.ts`:

- Update the in-memory `resolveLaunchBatch()` adapter to accept the optional snapshot.
- Resolve against a clone of the supplied snapshot when present, otherwise the current test document. Keep Main capture once per batch.
- Do not let tests pass accidentally by reading current mutable store state when a snapshot was supplied.

### 3. Update the domain record

Update the Subagent glossary entries in root `CONTEXT.md`:

- Assignment resolution continues to own assignment precedence and a single Main-model capture. Its batch resolver can use the full parsed `ExtensionConfig` snapshot supplied by execution, or read one assignment-only Settings/legacy view when no snapshot is supplied.
- Launch preparation continues to own one registry snapshot, whole-request validation, ordered assignment dispatch, and prepared-request construction. It forwards the optional parsed config snapshot without interpreting it.
- Subagent execution continues to own configured or caller-selected concurrency and scheduling. Whenever the caller override is nullish, `executeBatch()` loads full config once and reuses that exact parsed view for all launch assignments, including when missing `maxConcurrency` makes concurrency fall back to the default. A non-nullish caller override skips `executeBatch()`'s full config load and `maxConcurrency` validation; non-empty launch assignment resolution then reads one effective assignment view. The separate full-config load during `index.ts` session initialization remains unchanged. Preserve the existing empty-batch and failure ordering. State that this is an in-process snapshot, not a filesystem lock or cross-process transaction.

Do not update the domain glossary as if the planned behavior has already shipped. Make this edit as part of the implementation, with the code change.

## Acceptance criteria

- Whenever `runBatch()` or `runSubagentsParallel()` has a nullish caller override, it calls `config.load()` once and uses that parsed snapshot for concurrency selection and every launch assignment. This includes the default-concurrency fallback when `maxConcurrency` is absent. No second Settings/legacy read occurs for those assignments.
- Every request in that batch uses the same assignment config and the same Main-model value. Input and result order are unchanged.
- A Settings change after `load()` cannot affect later assignments in the current batch. A subsequent invocation sees the changed Settings.
- A non-nullish caller concurrency override skips `executeBatch()`'s `config.load()` and full `maxConcurrency` validation. For non-empty requests, assignment resolution still reads the effective assignment namespace once and validates model/thinking/context settings, even when an explicit launch model is present. Runtime `null`, like `undefined`, takes the configured path. The separate `index.ts` session-initialization load remains unchanged and may reject invalid config before a tool invocation.
- The `runSubagent()` method continues to resolve assignments without its own concurrency load. The extension's separate session-initialization load remains unchanged.
- Existing validation and error order remain intact: config-derived full-load errors precede Agent validation; with an override, the full load is skipped; launch preparation validates all Agent names before resolving the assignment batch; no child begins on a preparation error.
- `runBatch([])` preserves its current `executeBatch()` behavior: with a nullish override it performs full config loading and can reject on load errors before the launch-preparation empty return; with a non-nullish override it skips that method's config reads and returns empty. The extension's separate session-initialization load is unchanged. The launch-preparation empty fast path remains unchanged. A direct empty `resolveLaunchBatch()` call without a snapshot still reads/parses config; do not add an early return there.
- Active Profile path selection, Settings-over-legacy rules, empty active namespace behavior, invalid Settings failures, legacy migration, launch precedence, suffix handling, context-window metadata, cache affinity, progress ordering, and callback behavior remain unchanged.
- No new module, dependency, persisted setting, adapter, file lock, or cross-process consistency promise is added.
- `CONTEXT.md` describes the implemented ownership and snapshot flow accurately.

## Verification plan

Run from `.pi/`:

1. Focused tests for the changed seam:
   ```sh
   pnpm exec vitest run \
     extensions/tools-subagents/config.test.ts \
     extensions/tools-subagents/launch-preparation.test.ts \
     extensions/tools-subagents/subagent-execution.test.ts \
     extensions/tools-subagents/index.test.ts
   ```
2. Full Subagent suite:
   ```sh
   pnpm test:subagents
   ```
3. Typecheck:
   ```sh
   pnpm typecheck
   ```

Tests must use the temporary-file harness or in-memory config store. Do not read or write live `.pi/settings.json` or Profile files. The focused checks cross the config store, launch-preparation module, execution module, and extension's active-Profile path. The full Subagent suite guards adjacent configuration commands, invocation, progress, and child execution behavior. Typechecking covers all `SubagentConfigStore` implementations and call sites.

## Risks and non-goals

- The snapshot covers the effective view produced by one in-process `load()` call. It does not lock Settings or legacy files or make their reads a cross-process transaction. State this limitation explicitly in the `CONTEXT.md` update.
- Passing `ExtensionConfig` is safe only as an internal parsed snapshot from the same store's `load()`. Do not accept raw JSON or reparse the snapshot in assignment resolution. Keep it unmodified through resolution.
- The caller override path intentionally skips persisted `maxConcurrency` validation inside `executeBatch()`. Do not call `load()` there unconditionally to simplify plumbing. `index.ts` still validates full config during session initialization; this plan does not change that behavior.
- This plan does not change configuration persistence, Profile binding, legacy migration, the model/thinking/context precedence rules, registry ownership, child scheduling, or external tool behavior.
- The repository has no tracked ADRs relevant to this candidate. `CONTEXT.md` is the domain record to update with the implementation.
