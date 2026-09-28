# Implementation plan: batch-consistent Subagent launch assignments

**Status:** Implemented and verified. Focused tests pass (112/112), the full Subagent suite passes (246 tests across 14 files), and `pnpm typecheck` passes.

## Goal

Resolve each configured model, thinking-level, and context-window assignment in one non-empty `prepareSubagentLaunches()` request set from one effective configuration view and one captured Main-model value. Preserve Settings-versus-legacy selection, the active Profile Settings path, per-request overrides, assignment precedence, current validation/error ordering, prepared-request fields, and the guarantee that no child starts until the whole request set is prepared. `RunSubagentOptions` has no explicit context-window override today; do not add one.

`prepareSubagentLaunches()` is synchronous and currently reads and parses assignment settings once per request. A mixed assignment view therefore requires the active Settings or legacy file to change between those reads, for example through another process. No reproduced user-facing failure is established by the source or tests reviewed here. The proposal gives one request set a defined assignment view and avoids repeating the same read and parse for every item.

## Decisions

1. **Consistency scope:** Use one effective assignment-configuration view and one captured Main-model value per non-empty call to `prepareSubagentLaunches()`. A single Subagent launch is a one-item set. A file change after the batch view is read applies to the next preparation call, not later items in the current call. An empty call to `prepareSubagentLaunches()` remains a no-op with no registry load or batch assignment resolution. This does not change `SubagentExecution.runBatch()`'s separate concurrency-config load for an empty task list.
2. **Source and precedence:** Read the current `settingsPath`, which Pi updates to the active Profile path. A missing Settings file acts as an empty Settings document. If the Settings document has its own `subagents` key, that namespace wins, including an empty object. A present non-object namespace throws and does not fall back. Only an absent key uses the legacy document. A missing, malformed, or non-object legacy document acts as no legacy config; an object with invalid assignment values still fails model-configuration parsing. Invalid Settings JSON or a non-object Settings root keeps its current read error and does not fall back to legacy. Preserve the current model order: explicit model, per-Agent model, global model, Agent frontmatter, then Main. Thinking remains ordered as explicit thinking; then a recognized suffix only when an explicit model was supplied; then per-Agent thinking; then a suffix on the selected configured/frontmatter model; then global thinking. Reuse the current resolver so recognized suffixes are extracted while colon-bearing model IDs with non-thinking suffixes remain intact. Context metadata remains per-Agent over global, with no invocation-level context override.
3. **Seam placement:** Replace the single-launch operation with one ordered batch operation on the existing `SubagentConfigStore` interface. It owns the effective namespace read and shared interpretation; launch preparation sends the full ordered input only after resolving all named Agents. Do not expose a raw Settings snapshot to launch preparation.
4. **Main model:** Capture the store's current, possibly undefined Main-model value once at the start of batch resolution and pass that same value to every item. Do not resolve or require Main eagerly. The existing missing-Main error occurs only when an item's effective model selects `main`. Keep current normalization and error text.
5. **Concurrency:** Keep `maxConcurrency` policy and the exact `config.load()` behavior in `SubagentExecution`. `runBatch()` currently evaluates `options.maxConcurrency ?? config.load().maxConcurrency ?? DEFAULT_MAX_CONCURRENCY` before launch preparation. An explicit caller override skips `load()`; otherwise `load()` reads and validates model settings and `maxConcurrency`, even for an empty task list. Preserve that order and error behavior. Do not use `load()` to obtain the batch assignment view, because its additional `maxConcurrency` validation would change paths that currently resolve assignments without it. Assignment settings and concurrency are not promised to come from the same physical read.
6. **Failure and ordering:** Inside `prepareSubagentLaunches()`, resolve every string Agent name against one registry snapshot before calling the batch assignment resolver. Direct `AgentConfig` request values continue to pass through as they do now. In `runBatch()`, the earlier `config.load()` can still fail before Agent validation when no caller concurrency override is supplied. If name validation or batch assignment resolution fails, preparation throws with no returned partial list; child execution starts only after preparation succeeds.
7. **Dependencies:** Keep the existing Settings-document seam and test adapters. Production uses the active Settings/legacy files; tests use the in-memory store and temporary-file harness. Do not add another port, adapter, dependency, module, or persisted setting.
8. **Domain documentation:** Update the Subagent entries in `CONTEXT.md` to distinguish batch orchestration in launch preparation from one-view assignment resolution in the config store.

## Baseline evidence before implementation

- `tools-subagents/launch-preparation.ts:14–24` returns early on empty input, loads the Agent registry once, resolves all string Agent names, then calls `resolveLaunch()` once per request. Direct `AgentConfig` values bypass roster lookup.
- `tools-subagents/config.ts:602–609, 632–633` shows the repeated work: `resolveLaunch()` delegates to `resolveAssignment()`, which reads the effective namespace and parses model configuration for each item. `readSettingsNamespace()` reads the active Settings document first, then uses the legacy document only when the Settings document lacks its own `subagents` key.
- `tools-subagents/config.ts:211–271, 596–606` distinguishes source selection and parsing. `parseModelConfiguration()` validates model, thinking, and context assignments; `parseSubagentExtensionConfig()` adds `maxConcurrency` validation. A present malformed Settings namespace throws before fallback. Batch resolution must reuse the former parser, not broaden its errors with `load()`.
- `tools-subagents/subagent-execution.ts:49–52, 165–183` types the config dependency and shows that `runBatch()` reads `config.load()` for concurrency before it prepares launches, unless an explicit concurrency override short-circuits the load. This load can validate model settings and `maxConcurrency` before named-Agent validation; preserve that existing order.
- `tools-subagents/launch-preparation.test.ts:7–39` verifies one registry load but expects two per-request `resolveLaunch()` calls. Lines 64–97 cover name validation before the launch resolver, resolver failure, and empty preparation. They do not prove that `runBatch()` avoids its earlier concurrency `config.load()`.
- `tools-subagents/subagent-execution.test.ts:145–176` verifies that Agent validation and launch resolution errors prevent child execution. The current launch-resolution failure case mocks the second single-item call.
- `CONTEXT.md:390–413` describes assignment resolution and launch preparation as separate modules. Keep that ownership split; clarify that assignment resolution will read one effective configuration view per preparation batch.

## Chosen interface and ownership

Add `resolveLaunchBatch()` to `SubagentConfigStore` with one ordered input list and one ordered result list. Use a named input type with this shape:

```ts
interface ResolveLaunchBatchRequest {
  readonly agent: AgentConfig;
  readonly explicitModel?: string;
  readonly explicitThinkingLevel?: SubagentThinkingLevel;
}

resolveLaunchBatch(
  requests: readonly ResolveLaunchBatchRequest[],
): readonly ResolvedLaunchConfiguration[];
```

It returns exactly one launch result per input, in the same order. The operation is synchronous and does not expose the Settings document or its parsed representation. Its caller passes a non-empty list; `prepareSubagentLaunches()` already owns the empty-set fast path, so do not add a separate low-level empty-input contract.

Inside `createSubagentConfigStore()`:

1. Capture `activeMainModel` once, preserving `undefined` without eagerly requiring Main.
2. Call `readSettingsNamespace()` once. This preserves the active Profile path, source-selection rules, namespace validation, Settings read errors, and legacy fallback.
3. Call `parseModelConfiguration()` once on that effective namespace. Do not call `parseSubagentExtensionConfig()`, so assignment resolution does not gain `maxConcurrency` validation.
4. Resolve every input in order through `resolveParsedSubagentAssignment()`, passing the same parsed configuration and captured Main-model value. Return each existing `assignment.launch` object without rebuilding or stripping fields. That preserves the current launch own-key shape, including `contextWindow: undefined` when no context window is configured.
5. If source parsing or any item's assignment fails, throw the existing error. Do not return a partial array. Only an item whose selected model is `main` should trigger the existing missing-Main error.

Replace `resolveLaunch()` with `resolveLaunchBatch()`. Repository search confirms that the only production call to `resolveLaunch()` is in launch preparation. Other references are the interface and store implementation, the in-memory test adapter, and tests in `config.test.ts`, `launch-preparation.test.ts`, and `subagent-execution.test.ts`. Migrate those exact sites. Keep `resolveAssignment()` and `resolveAssignmentSelection()` unchanged because the model command and assignment preview still use them.

`prepareSubagentLaunches()` keeps request-set orchestration: its empty fast path, one registry snapshot, resolution of all string Agent names before assignment resolution, task/prompt normalization, cache-affinity derivation, callback and timeout propagation, and result order. Build the ordered batch inputs from the resolved Agents and each request's existing model and thinking overrides. Call `resolveLaunchBatch()` once, then combine results with the original request fields by index. Do not read Settings or reproduce assignment precedence here. Preserve `task ?? prompt ?? ""`; an empty string is not a reason to fall back. Derive cache affinity only for a truthy seed and use the resolved launch model. Keep the current prepared-request fields and omit raw `model`, `thinkingLevel`, `prompt`, and `cacheAffinitySeed` fields.

`SubagentExecution` continues to own scheduling and child lifetime. Change its config dependency type to require `resolveLaunchBatch` instead of `resolveLaunch`. Do not move or change the existing `config.load()` concurrency read, `runOrdered()`, concurrency choice, progress publication, terminal status, or child admission. `runSubagent()` and `runBatch()` both pass through launch preparation, so singleton and parallel work share the assignment batch path. A non-empty `runBatch()` may still perform one earlier `config.load()` read for concurrency, as described above.

This reuses the existing config-store interface and its file-backed and in-memory implementations. The batch method replaces the single-item launch method; it does not add another seam or duplicate assignment precedence.

## Implementation sequence

### 1. Characterize the batch contract in tests

Update `tools-subagents/launch-preparation.test.ts` first:

- The normal multi-request case expects one `resolveLaunchBatch()` call with both resolved Agents, per-request model and thinking values in the correct positions, and the same result order as the input.
- Assert the prepared requests retain `task ?? prompt ?? ""` semantics, including an empty `task` winning over a non-empty `prompt`; cache affinity uses the resolved model and is omitted for an absent or empty seed. Also assert `cwd`, signal, timeout, output limit, callbacks, and omission of raw-only request fields.
- Keep the unknown-name case and assert the batch resolver is never called. This proves name validation precedes assignment resolution inside `prepareSubagentLaunches()`, not that `runBatch()` skipped its earlier concurrency `config.load()`.
- Keep the resolution-failure case, adapted to one batch resolver call that throws. Assert no prepared list is returned.
- Keep the empty-preparation case; neither registry nor batch resolver is called. Do not use this test to claim that `SubagentExecution.runBatch([])` skips its separate concurrency load.

Update `tools-subagents/config.test.ts` to exercise the production store through `SubagentConfigStore`:

- Resolve one-item and multi-item batches with representative cases for Main/default, per-Agent settings, frontmatter fallback, per-request model and thinking overrides, a valid model-thinking suffix, and per-Agent-over-global plus global-fallback context metadata. Assert order and the current launch object shape. Existing pure resolver tests already cover the full precedence and suffix matrix; do not duplicate that matrix at the store layer.
- Add a store-level consistency regression for a multi-item batch. Instrument the existing `readSettingsDocument` helper in the test to return different namespaced Settings documents on successive calls. Assert the batch reads it once and both items use the first view. Do not add a production read-injection dependency. This is required because a one-call assertion on the launch-preparation mock alone would not catch repeated file reads inside the store implementation.
- Verify a concrete effective model succeeds with no Main model, while an item that resolves to `main` preserves the current missing-Main error. Do not eagerly validate Main when no item selects it.
- Using the temp-file harness, verify active Settings beats legacy, including an explicitly empty `subagents` object; absent `subagents` or a missing Settings file uses valid legacy values; malformed Settings JSON, a non-object Settings root, or a present non-object `subagents` namespace throws instead of falling back; missing, malformed, or non-object legacy documents behave as absent; invalid legacy assignment values still throw. Repoint the store with `setSettingsPath()` and prove batch resolution reads the selected Profile file, not the project Settings file. Do not use live project Settings or Profiles.
- Keep configuration validation eager: malformed model settings still fail even if an explicit request override would otherwise choose another model. The existing pure-resolver tests remain the authority for the full precedence and suffix cases.
- Verify a batch assignment ignores invalid `maxConcurrency` while `load()` continues to reject it. Also verify model-configuration errors and their existing messages still propagate. Include a multi-item case where a later invalid override throws and no result array escapes.
- Replace all three `resolveLaunch()` assertions with one-item batch assertions. Preserve the `resolveAssignment(..., { snapshot })` preview tests.

Adapt the `tools-subagents/subagent-execution.test.ts` whole-batch-before-child case to make the single batch resolver call reject and assert `childExecution.execute` is not called. Keep the concurrency and caller-override tests unchanged. Preserve the current fact that `runBatch()` may load configuration before Agent validation when no explicit concurrency override is given.

### 2. Implement the batch resolution seam

In `tools-subagents/config.ts`:

- Add a typed batch input shape near the existing launch types and replace the `resolveLaunch()` member of `SubagentConfigStore` with `resolveLaunchBatch()`.
- Implement the batch method with one `readSettingsNamespace()` result, one `parseModelConfiguration()` result, and one captured possibly-undefined Main model. Reuse `resolveParsedSubagentAssignment()` for each item, returning each existing `launch` object unchanged.
- Remove `resolveLaunch()` from the interface and production object. The repository search above found no other production call sites. Do not change `resolveAssignment()`, `resolveAssignmentSelection()`, or pure precedence rules.
- Preserve existing source and assignment errors. A thrown parse or item resolution returns no partial result.

In `tools-subagents/launch-preparation.ts`:

- Change the config dependency to `resolveLaunchBatch`.
- Resolve all named Agent strings before calling assignment resolution. Do not claim this precedes `SubagentExecution`'s separate `config.load()` call.
- Build one ordered input list and make exactly one batch call for non-empty input.
- Pair launch results with requests by index and preserve current prepared-request fields, task fallback, cache-affinity behavior, and output order.

In `tools-subagents/subagent-execution.ts` and `tools-subagents/test-harness.ts`:

- Update the execution dependency type and in-memory store implementation to the batch method.
- Keep `load()` for `maxConcurrency` with its current order and caller-override short-circuit. Do not couple scheduling to the batch assignment result.
- Search `.pi/extensions` for the exact old `resolveLaunch` member and migrate every remaining reference. The current references are in `config.ts`, `launch-preparation.ts`, `subagent-execution.ts`, `test-harness.ts`, and the three tests named above. `resolveLaunchBatch` is the replacement name, not a remaining old-method reference.

### 3. Update the domain record

Amend the Subagent entries in root `CONTEXT.md`:

- State that the assignment resolution module resolves an ordered launch batch from one effective Settings/legacy namespace read and one captured, possibly undefined Main-model value. It still uses model-configuration parsing only; `maxConcurrency` validation stays in the full config load.
- State that launch preparation resolves all named Agent strings before its single batch assignment call, then preserves current task normalization and cache-affinity identity. Clarify that `runBatch()` may load configuration for concurrency before launch preparation.
- State that a change to the assignment files after the batch view is read affects the next preparation call. Do not claim an issue was reproduced.

## Acceptance criteria

- Every non-empty `prepareSubagentLaunches()` call makes one ordered batch assignment call, regardless of request count. Empty preparation skips registry and assignment resolution; the batch resolver's caller contract is non-empty input.
- Every request in a non-empty preparation call uses one effective assignment configuration and one captured possibly-undefined Main-model value. Explicit model and thinking overrides remain scoped to their request; context-window data remains config metadata only.
- Active Profile path selection and Settings/legacy behavior remain intact, including empty active namespaces winning, invalid present namespaces and invalid Settings roots throwing without fallback, and malformed or absent legacy files behaving as absent.
- `maxConcurrency` validation, `runBatch()` config-load order, caller override short-circuit, and empty-task behavior remain unchanged. Assignment resolution does not gain `maxConcurrency` validation.
- Named Agent strings are all resolved before the batch assignment call. With default concurrency, `runBatch()`'s existing earlier `config.load()` may fail first. Any preparation failure prevents a partial launch list and all child execution.
- Prepared request fields and ordering remain unchanged. Preserve `task ?? prompt ?? ""`, omit cache affinity for absent/empty seeds, derive it from the resolved model, and return the current launch object shape including `contextWindow: undefined` when unset.
- No new dependency, persisted setting, cross-extension interface, or adapter is introduced. The batch method replaces the old single-item method at the existing config-store interface.
- `CONTEXT.md` describes the final ownership split accurately.

## Verification plan

Run from `.pi/`:

1. Focused tests: `pnpm exec vitest run extensions/tools-subagents/config.test.ts extensions/tools-subagents/launch-preparation.test.ts extensions/tools-subagents/subagent-execution.test.ts`
2. Full Subagent suite: `pnpm test:subagents`
3. Typecheck: `pnpm typecheck`

The focused tests prove the batch contract through `SubagentConfigStore`, launch preparation, and child-admission behavior. The full Subagent suite checks nearby assignment editing, execution, progress, and invocation behavior. Typechecking catches every store adapter and dependency type that must move to the batch method. Do not modify or use live `.pi/settings.json` or Profile files as test inputs; the temporary-file harness is the correct test seam.

## Risks and non-goals

- A separate process can change Settings between the current per-request reads. One batch read removes that inter-item inconsistency, but it does not lock files or make the active Settings and legacy fallback a cross-process transaction. `runBatch()`'s separate concurrency load can also observe a different file state from batch assignment resolution.
- Do not rewrite persistence. Active Profile path binding, legacy migration, Settings-document mutation, and Profile semantics remain unchanged.
- Do not broaden the refactor. Scheduling, child lifetime, catalogue access, and command behavior remain outside launch preparation and assignment resolution.
