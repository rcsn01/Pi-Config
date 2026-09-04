# Deepen Subagent assignment resolution

## Goal

Make one in-process module authoritative for the effective model, thinking level, and configured context-window metadata of a Subagent. Subagent launch preparation and the `/subagents` command adapter must cross the same seam, so status text and picker previews cannot drift from launch preparation. The context value remains descriptive: Pi has no per-launch context-window override, and the child still derives its actual window from the selected model's catalogue entry.

The refactor is complete when `model-commands.ts` no longer implements assignment precedence and the same resolver result drives both display values and `ResolvedLaunchConfiguration`.

## Current friction

Assignment meaning currently spans two places:

- `.pi/extensions/tools-subagents/config.ts` resolves actual child launches through `resolveLaunchConfiguration()` and `SubagentConfigStore.resolveLaunch()`.
- `.pi/extensions/tools-subagents/model-commands.ts` reconstructs effective values through `selectedModelSettingForAgent()`, `effectiveModelForAgent()`, `effectiveThinkingForAgent()`, and `effectiveContextWindowForAgent()`.

The command adapter calls shared parsing helpers, but it still knows the ordering rules. It must combine the selected model, the legacy model suffix, per-agent thinking, global thinking, per-agent context, global context, and the current Main model. This makes the module shallow at the assignment seam: callers must know almost as much as the implementation.

The duplication has two test surfaces:

- `config.test.ts` checks launch precedence.
- `model-commands.test.ts` separately checks rendered effective assignments.

Deleting the command-side helpers should concentrate assignment meaning in `config.ts`. If their logic merely moved to another presentation helper, the deletion test would fail.

## Settled decisions

These decisions use the recommended branch at every point in the design tree.

1. **Scope:** deepen assignment resolution only. Do not include child-tool capability policy, command parsing, model catalogue lookup, persistence mutations, process launching, or Plan Mode work.
2. **Compatibility:** preserve Settings shape, accepted legacy values, precedence, error text, command text, and child launch values. No migration is required.
3. **Seam:** keep the module in `.pi/extensions/tools-subagents/config.ts`. Its parsers, normalizers, mutation functions, and config store already own assignment meaning. A new file would split tightly coupled rules and reduce locality.
4. **Interface shape:** add one authoritative resolver that returns display information and a nested launch result. Do not add source-attribution metadata because no current caller uses it.
5. **Preview strategy:** picker previews build hypothetical in-memory configuration with existing mutation functions, then call the same resolver. The command adapter may know which setting the user is changing, but it must not know assignment precedence.
6. **Launch compatibility:** retain `SubagentConfigStore.resolveLaunch()` as the narrow interface used by Subagent launch preparation. Its implementation delegates to the authoritative resolver and returns only the nested launch result.
7. **Snapshot policy:** do not add a cached resolver or a new long-lived snapshot abstraction. Commands already load once per screen or operation, and launches must continue reading current Settings. This avoids stale configuration and keeps the interface small.
8. **Testing:** replace low-level precedence tests with table-driven tests at the new resolver interface. Keep adapter tests for rendering, whole-request validation, and narrow launch handoff.
9. **Documentation:** preserve user-facing README wording because behavior does not change. `CONTEXT.md` now names the Subagent assignment resolution module and its seam.
10. **Delivery:** one coherent refactor with no compatibility shim left behind for internal helpers that have no production callers.

## Chosen interface

Add these types and the resolver near the existing resolution types in `.pi/extensions/tools-subagents/config.ts`:

```ts
export interface ResolvedSubagentAssignment {
  /** Canonical selected setting before `main` becomes a concrete model. */
  modelSetting: string;
  /** Resolved launch fields; contextWindow remains descriptive metadata. */
  launch: ResolvedLaunchConfiguration;
}

export function resolveSubagentAssignment(
  options: ResolveLaunchOptions,
): ResolvedSubagentAssignment;
```

The interface is intentionally small. One call handles a current assignment, an invocation override, or a hypothetical configuration prepared by the command adapter.

Example for status rendering:

```ts
const assignment = resolveSubagentAssignment({
  agentName: agent.name,
  config,
  frontmatterModel: agent.model,
  mainModel: configStore.getMainModel(),
});

modelDisplay(assignment.modelSetting, assignment.launch.model);
thinkingDisplay(assignment.launch.thinkingLevel);
contextDisplay(assignment.launch.contextWindow);
```

Example for the existing launch adapter:

```ts
resolveLaunch(agent, explicitModel, explicitThinkingLevel) {
  return resolveSubagentAssignment({
    agentName: agent.name,
    config: readDocument(),
    explicitModel,
    explicitThinkingLevel,
    frontmatterModel: agent.model,
    mainModel: activeMainModel,
  }).launch;
}
```

`modelSetting` must be the canonical model value after removal of a legacy `:thinking` suffix but before resolving `main`. For example:

| Selected value | `modelSetting` | `launch.model` |
|---|---|---|
| `main` | `main` | current `provider/model` |
| `default` | `main` | current `provider/model` |
| `openai/gpt-5.4` | `openai/gpt-5.4` | `openai/gpt-5.4` |
| `openai/gpt-5.4:high` | `openai/gpt-5.4` | `openai/gpt-5.4` |

Nesting the launch result prevents display-only `modelSetting` data from leaking into `SubagentChildExecutionRequest.launch`.

## Required behavior

The resolver must preserve these rules exactly.

### Model precedence

1. Explicit invocation model.
2. `agentModels[agentName]`.
3. `defaultModel`.
4. Agent Markdown frontmatter model.
5. `main`.

After selection, normalize legacy `default` to `main`, split any legacy thinking suffix, and resolve `main` against the current Main model only for `launch.model`.

### Thinking precedence

1. Explicit invocation thinking level.
2. Thinking suffix on the explicit invocation model.
3. `agentThinkingLevels[agentName]`.
4. Thinking suffix on the selected configured model.
5. `defaultThinkingLevel`.
6. Pi default, represented by `undefined`.

The phrase "selected configured model" includes per-agent, global, frontmatter, or fallback selection. An explicit thinking value must beat every suffix.

### Context metadata precedence

`ResolveLaunchOptions` already supports an explicit context value even though current `RunSubagentOptions` callers do not expose one. Preserve that existing interface and precedence; do not add a new invocation option as part of this refactor:

1. Explicit resolver context window.
2. `agentContextWindows[agentName]`.
3. `defaultContextWindow`.
4. Pi or model default, represented by `undefined`.

This value is displayed by the command adapter and passes through the existing `ResolvedLaunchConfiguration` shape. Child execution ignores it. It does not override the child's actual model context window.

### Errors and normalization

Preserve existing synchronous errors for:

- malformed Settings documents;
- empty or noncanonical model settings;
- an unresolved `main` model;
- unsupported thinking levels;
- nonpositive or noninteger context windows.

Do not catch or rewrite these errors inside the resolver. Existing adapters remain responsible for user notification.

## File-by-file implementation

### 1. `.pi/extensions/tools-subagents/config.ts`

1. Add `ResolvedSubagentAssignment` beside `ResolvedLaunchConfiguration`.
2. Replace `resolveLaunchConfiguration()` with `resolveSubagentAssignment()` as the public assignment interface.
3. Parse the model configuration once at the start of the resolver. Do not call `parseModelConfiguration()` independently for model, thinking, and context.
4. Select the raw model according to the preserved model precedence.
5. Split the selected model once to obtain `modelSetting` and its optional legacy thinking suffix. If the selected source was the explicit invocation model, use that same suffix at the explicit-suffix precedence position; do not parse the explicit model a second time.
6. Resolve `modelSetting === "main"` through `canonicalMainModel()` for `launch.model`; otherwise use the canonical setting directly.
7. Resolve thinking and context from the same parsed configuration.
8. Return `{ modelSetting, launch: { model, thinkingLevel, contextWindow } }`.
9. Update `createSubagentConfigStore().resolveLaunch()` to delegate to `resolveSubagentAssignment(...).launch`.
10. Make `selectModelSetting()`, `resolveModelAssignment()`, `selectThinkingLevelSetting()`, and `selectContextWindowSetting()` private implementation helpers or remove them if the consolidated resolver makes them unnecessary.
11. Remove `resolveLaunchConfiguration()` after all repository callers migrate. Do not retain an alias solely for the old tests.
12. Keep `splitModelThinkingSetting()` exported. The command adapter still needs it for configured-value and model-catalogue presentation that is not effective assignment resolution.
13. Keep all persistence mutation functions and `parseModelConfiguration()` behavior unchanged.
14. Keep `ResolvedLaunchConfiguration` unchanged because launch preparation and child-request structures already depend on its shape, even though child execution ignores `contextWindow`.

### 2. `.pi/extensions/tools-subagents/model-commands.ts`

1. Import `resolveSubagentAssignment()` and stop importing `canonicalMainModel()` or `selectModelSetting()` for effective assignment calculation where the resolver can supply the result.
2. Replace these four local helpers with one thin call adapter:
   - `selectedModelSettingForAgent()`;
   - `effectiveModelForAgent()`;
   - `effectiveThinkingForAgent()`;
   - `effectiveContextWindowForAgent()`.
3. The thin helper may bind `configStore.getMainModel()` and agent frontmatter, but it must contain no precedence branches.
4. Update `statusLines()` to use one resolver result per agent for model, thinking, and context.
5. Update `modelStatusLines()` to use the same result. Keep global and individual raw-setting lists based on `configStore.load()` because they display persisted configuration rather than effective assignment.
6. Update each individual-agent description in `selectSubagentTarget()` to use the resolver result. Keep the **All subagents** row based on raw global settings because it has no `AgentConfig` and describes the value that an all-target mutation would replace.
7. Replace individual model inheritance preview logic with this sequence:
   - apply `removeAgentModelAssignment()` to the in-memory configuration;
   - resolve the resulting hypothetical configuration;
   - display `modelSetting` and `launch.model` from that result;
   - do not persist the hypothetical configuration.
8. Replace pending individual model-choice calculation with this sequence:
   - apply `setAgentModelAssignment()` or `removeAgentModelAssignment()` to an in-memory configuration;
   - resolve the hypothetical assignment;
   - use its `modelSetting` for catalogue and thinking-level lookup.
9. Replace thinking inheritance preview logic with this sequence:
   - start from the hypothetical configuration containing the pending model choice;
   - apply `removeAgentThinkingAssignment()` in memory;
   - resolve once;
   - use `launch.thinkingLevel` for the inherited description.
10. Preserve the thinking picker's current-selection marker with presentation-only checks on raw configuration:
    - keep `Object.hasOwn(config.agentThinkingLevels, target)` to distinguish an explicit per-agent value from `inherit`;
    - keep the current-versus-pending base-model comparison so a legacy suffix is marked current only when the pending model has the same base model;
    - use the resolver for the effective thinking value, but do not infer whether the marker should say `inherit` from that value because the resolver intentionally omits source metadata.
11. Keep the `all` target's raw pending model path direct. It is a prospective global setting, not an agent assignment, and no `AgentConfig` exists for that row.
12. Keep `splitModelThinkingSetting()` only where the command adapter is inspecting a raw configured choice, comparing current and pending base models, or resolving a catalogue reference. Do not use it to reconstruct effective precedence.
13. Preserve every command string, notification, menu label, current-selection marker, sort order, and cancellation path.

### 3. `.pi/extensions/tools-subagents/test-harness.ts`

1. Replace the `resolveLaunchConfiguration()` import with `resolveSubagentAssignment()`.
2. Make `memoryConfigStore.resolveLaunch()` delegate to `.launch`, matching the production store.
3. Do not add a second fake precedence implementation.

### 4. `.pi/extensions/tools-subagents/config.test.ts`

Refactor the `subagent model resolution` tests around `resolveSubagentAssignment()`.

Create a table that covers at least:

1. Missing configuration falls back to `main`.
2. Legacy `default` normalizes to `modelSetting: "main"`.
3. A concrete model has identical selected and resolved values.
4. Per-agent model beats global and frontmatter.
5. Global model beats frontmatter.
6. Frontmatter beats `main` when central settings are absent.
7. Explicit invocation model beats every configured source.
8. `main` resolves against the current Main model while retaining `modelSetting: "main"`.
9. Explicit thinking beats an explicit-model suffix.
10. Explicit-model suffix beats per-agent thinking.
11. Per-agent thinking beats a configured-model suffix.
12. A per-agent model suffix beats global thinking when no per-agent thinking override exists.
13. A global model suffix beats global thinking when no per-agent overrides exist.
14. A frontmatter model suffix beats global thinking when central model settings are absent.
15. Global thinking beats Pi default.
16. Explicit resolver context beats per-agent context.
17. Per-agent context beats global context.
18. Missing context produces `undefined`.
19. Legacy `default` thinking and context values produce Pi-default `undefined` values.
20. A representative malformed setting error propagates unchanged through the resolver.
21. Missing Main model retains its current error message.

Delete direct tests of private selection helpers once the resolver table covers their behavior. Keep the existing parsing tests as the detailed error-validation surface rather than repeating every malformed input through the resolver. Keep mutation, migration, store, and child-argument tests intact.

Update the config-store test so changes to the remembered Main model still change later `resolveLaunch()` results. Add an assertion that the store returns only the nested launch values and does not expose `modelSetting` to child execution.

### 5. `.pi/extensions/tools-subagents/model-commands.test.ts`

Keep the existing adapter tests. The current suite already covers `main → provider/model` status rendering and verifies that cancelling the interactive flow performs no Settings update, so do not add duplicate cases for those behaviors. Add focused drift guards for the command paths whose assignment logic changes:

1. `/subagents models` renders model, thinking, and context from one matching assignment fixture.
2. A configured model suffix appears as the base model while its thinking level appears separately, including the case where per-agent thinking beats a global-model suffix.
3. Individual model inheritance previews cover the global, frontmatter, and Main fallbacks. A table or one scripted picker flow may cover all three without separate end-to-end command tests.
4. Individual thinking inheritance preview reflects the pending model choice and the inherited global or suffix value.

Assertions should remain on rendered command output and persisted documents. Do not expose command internals for tests. Reuse the existing cancellation assertion unless a changed preview path introduces a distinct write-before-confirmation risk.

### 6. `.pi/extensions/tools-subagents/launch-preparation.test.ts`

Keep the existing tests because they cover the correct adapter seam:

- one registry load;
- whole-request-set agent validation before resolution;
- one resolution per launch;
- no partial result on a later failure;
- empty input avoids dependency reads;
- only normalized launch fields reach child execution.

Adjust mocks only if the `SubagentConfigStore` type changes during cleanup. No new assignment-precedence cases belong here because `config.test.ts` owns that behavior.

### 7. `.pi/extensions/tools-subagents/README.md`

No content change is expected. After implementation, compare the resolver table against the documented model and thinking precedence. Edit the README only if the implementation exposes an existing documentation error. Do not announce this internal refactor as a user-facing feature.

### 8. `CONTEXT.md`

The domain glossary has already been updated with **Subagent assignment resolution module**, but its current wording calls context a concrete value used for a child launch. Update that entry to distinguish the configured context metadata from the actual context window derived from the model catalogue. Verify that the final interface otherwise matches the definition.

## Implementation order

1. Add the new result type and resolver tests in `config.test.ts`.
2. Implement `resolveSubagentAssignment()` until the precedence and error table passes.
3. Delegate the production and in-memory stores' `resolveLaunch()` implementations to the new resolver.
4. Replace command status and effective-assignment helpers.
5. Replace picker inheritance and pending-choice previews with hypothetical in-memory configuration plus the resolver.
6. Remove obsolete resolution exports and their direct tests after `rg` confirms there are no callers.
7. Run focused tests and typechecking.
8. Review the diff for accidental text, Settings, or child-request changes.

This order keeps a working launch adapter while the command adapter migrates. The old and new rules coexist only inside the implementation branch, not in the final diff.

## Verification commands

Run from `.pi/`:

```bash
pnpm exec vitest run extensions/tools-subagents/config.test.ts
pnpm exec vitest run extensions/tools-subagents/model-commands.test.ts
pnpm exec vitest run extensions/tools-subagents/launch-preparation.test.ts
pnpm test:subagents
pnpm typecheck
```

Then check for leftovers from the shallow interface:

```bash
rg -n "selectedModelSettingForAgent|effectiveModelForAgent|effectiveThinkingForAgent|effectiveContextWindowForAgent|resolveLaunchConfiguration|resolveModelAssignment|selectModelSetting|selectContextWindowSetting|selectThinkingLevelSetting" extensions/tools-subagents
```

Expected result: no production references. Test names may mention old behavior in prose only if useful.

## Acceptance criteria

- `resolveSubagentAssignment()` is the only implementation of model, thinking, and context precedence.
- The resolver returns the canonical selected `modelSetting` and a nested `ResolvedLaunchConfiguration`.
- `SubagentConfigStore.resolveLaunch()` delegates to the resolver.
- The command adapter has no precedence branches for effective assignments.
- Status, model summaries, target descriptions, inheritance previews, and pending picker previews all use the resolver.
- Hypothetical previews never write Settings.
- Child execution receives no `modelSetting` display field; the existing descriptive `contextWindow` field is unchanged.
- Settings schema and migration behavior do not change.
- Existing command text and picker flow do not change.
- Resolver tests cover every precedence edge listed above.
- Existing Subagent tests and TypeScript checks pass.
- No obsolete internal compatibility interface remains.

## Risks and controls

### Legacy model suffix precedence

The command adapter and launch path can diverge if a suffix is split at different times. Control this by splitting the selected model once inside the resolver and testing explicit, per-agent, global, and frontmatter cases.

### Pending picker previews

A pending model is a prospective configuration change, not always an invocation override. Treating it as an invocation would give its thinking suffix the wrong precedence over per-agent thinking. Control this by applying the same in-memory mutation that persistence would apply, then resolving with no invocation override.

### Main model freshness

A cached resolver could retain an old Main model after `/model`. Do not cache it across command operations or launches. Pass `configStore.getMainModel()` into each resolver call as planned.

### Display data leaking into execution

Returning `modelSetting` beside launch fields could accidentally pass it to child execution. Keep launch values nested and have `resolveLaunch()` return `.launch` only.

### Over-testing internals

Keeping tests for every private selector would preserve the shallow design. Replace them with resolver-interface tests and retain adapter tests only for observable rendering and launch handoff.

## Rollback point

This refactor has no data migration and no persisted-state change. If verification finds a behavior mismatch, revert the command adapter to `SubagentConfigStore.resolveLaunch()` behavior first, keep the new resolver tests as characterization, and postpone picker-preview migration. No Settings repair or user action would be required.
