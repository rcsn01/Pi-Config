# Plan: Route the Settings document path through the Session profile binding

**Status:** Advisor-reviewed and revised; implementation has not started.

## Goal

Make the Settings document path an explicit dependency at each extension's
entry-point seam. The Session profile binding remains the deep module that
resolves the Profile-aware path and applies it before adapter initialization.
Remove eager module-level path-bound state and dead path re-exports without
breaking custom profile directories or standalone subagent helper interfaces.

## Decisions

1. Add `settingsPath?: string` to the dependency objects of:
   - `tools-subagents`
   - `ui-model-selector`
   - `workflows-plan`
   - `config-profiles`

   `tools-advisor` and `policy-permissions` already use this pattern. Each
   extension resolves its path at the entry point. If no injected path-bearing
   store supplies a path, the fallback is `PROJECT_SETTINGS_PATH`.

2. Keep `SessionProfileBindingOptions` as a two-path interface, but make the
   directory optional:

   ```ts
   { settingsPath: string; profilesDirectory?: string }
   ```

   `session-profile-binding.ts` uses the supplied custom directory or derives
   `profilesDirectoryFor(settingsPath)` when it is omitted. The runtime
   `SessionProfileBinding` shape remains unchanged:
   `{ profileName, settingsPath }`.

   This keeps ordinary extension callers shallow while preserving injected
   `ProfileStore` implementations whose profiles directory is intentionally
   independent from the Settings document directory.

3. Add one named derivation rule to `_shared/profile-document.ts`:
   `profilesDirectoryFor(settingsPath: string): string`.
   It returns `join(dirname(settingsPath), "profiles")` and is used by the
   binding module, `config-profiles`, and tests whenever the default directory
   is wanted. Remove the canonical `PI_DIRECTORY` and `PROFILES_DIRECTORY`
   constants; explicit custom directories remain supported.

4. Remove hidden Settings document defaults from these leaf interfaces:
   - `createProjectSettingsStore(path: string)`
   - `createSubagentsSettingsStore(path: string)`
   - `createPlanModeProfileStore(path: string)`
   - `loadAdvisorSettings(path: string)`
   - `createProfileStore({ settingsPath, profilesDirectory? })`

   `settingsPath` is required at each leaf factory. `createProfileStore`
   accepts an optional custom `profilesDirectory`; when omitted, it derives
   the directory with `profilesDirectoryFor`. The returned `ProfileStore`
   continues exposing both paths as readonly fields. The higher-level
   `createSubagentConfigStore` compatibility helper may keep optional options,
   but it resolves `PROJECT_SETTINGS_PATH` before calling the required
   `createSubagentsSettingsStore(path)`.

5. Change `ui-model-selector` from a positional store argument to a
   dependency object containing optional `settingsPath` and `settingsStore`.
   When no store is injected, create it with the resolved path. Its binding
   path is authoritative for the injected store and `applyPath` repoints that
   store before its first load or save; `ProjectSettingsStore` does not expose
   an independently readable path to validate.

6. Remove the eager module-load-time `subagentConfig` instance from
   `tools-subagents/config.ts`, but preserve existing standalone helper
   interfaces. Add a lazy default accessor (for example,
   `getDefaultSubagentConfig`) that creates or caches the canonical fallback
   with an explicit `settingsPath: PROJECT_SETTINGS_PATH` only when a
   standalone helper is called without an injected configuration. The command,
   runner, and parallel-batch dependency fields remain optional
   so exported helpers do not acquire new required arguments.

   `createSubagentsExtension` is the composition root: it resolves the
   extension path, creates an extension-scoped configuration store with that
   path and the legacy config path when none is injected, and always passes
   that store to the command, runner, and parallel-batch implementations. A
   caller-provided `runSingle` remains authoritative. The extension must not
   fall back to the standalone runner when it can construct its scoped runner.

   Keep `defaultParallelBatch = createParallelSubagentBatch()` import-safe:
   creating the batch must not resolve the lazy fallback. Resolve that fallback
   when a batch executes (or make the exported wrapper lazy), so importing
   `parallel-batch.ts` never creates a Settings-backed store.

7. Define path precedence and validation:
   - With no injected path-bearing store, use explicit `dependencies.settingsPath`
     or `PROJECT_SETTINGS_PATH`.
   - For `config-profiles`, an injected `ProfileStore` is authoritative for
     both `settingsPath` and `profilesDirectory`. If an explicit
     `dependencies.settingsPath` is also supplied, compare normalized paths
     and fail fast on a mismatch. Register the binding with both paths from
     the store so custom directories are preserved. Without an injected
     store, create `createProfileStore({ settingsPath })` and let its optional
     directory default derive from the path.
   - For `tools-subagents`, an injected `SubagentConfigStore` is authoritative
     for its current `configPath`. If `dependencies.settingsPath` is also
     supplied, compare normalized paths and fail fast on a mismatch. Without
     an explicit path, use the injected configuration path; without either,
     use the canonical default. The Profile binding still calls
     `setSettingsPath` for the active Profile path.
   - For `ui-model-selector`, the supplied `settingsPath` is the binding path;
     the injected store is repointed through its existing `setPath` seam before
     use. Do not inspect private store state or add a path requirement solely
     for this compatibility seam.
   - An injected `runSingle` is caller-owned and is not replaced or inspected;
     the extension-scoped configuration governs the built-in runner and batch.

8. Remove only dead path-constant re-exports. Preserve consumed non-path
   exports, especially `validateProfileName` from
   `config-profiles/profile-store.ts` (and `CONFIG_PROFILES_KEY` while it
   remains part of that module's consumed profile-document vocabulary).
   Remove path re-exports from:
   - `config-profiles/profile-store.ts`
   - `tools-subagents/settings-store.ts`
   - `tools-advisor/index.ts`
   - `_shared/model-selection-store.ts`
   - `_shared/profile-document.ts`

   Update `tools-subagents/index.ts` to import
   `PROJECT_SETTINGS_PATH` directly from `_shared/settings-document.ts` before
   removing the local re-export.

## Target shape

```text
extension dependencies.settingsPath
          + injected path-bearing store/config
                         │
                         ▼
                extension entry point
                  ├── resolves and validates precedence
                  ├── creates stores with an explicit path
                  └── registerSessionProfileBinding({
                        settingsPath,
                        profilesDirectory? // custom only
                      })
                                      │
                                      ▼
                       Session profile binding seam
                       ├── derives a default profiles directory
                       ├── resolves the active Profile path
                       └── calls adapter.applyPath(binding)
                                      │
                                      ▼
                     stores repointed before initialize
```

The production default remains `PROJECT_SETTINGS_PATH`, but it is composed at
an extension entry point or lazy standalone compatibility accessor rather than
being eagerly bound by every leaf module. The default export of each extension
continues to use production defaults. Injected test paths enter through the
same dependency interfaces as production paths.

## Implementation sequence

1. Add `profilesDirectoryFor` and update the binding to accept an optional
   custom directory with a derived fallback. Update the Profile-store factory
   to require `settingsPath` while retaining its optional directory.
2. Remove default path parameters from the leaf stores and
   `loadAdvisorSettings`; update every direct caller to pass an explicit path.
3. Add `settingsPath` to the four remaining extension dependency objects and
   implement the precedence/validation rules, including the injected
   `ProfileStore` path pair.
4. Convert `ui-model-selector` to its dependency-object interface while
   preserving the injected `ProjectSettingsStore` seam.
5. Inventory all direct callers of the exported subagent helpers. Remove the
   eager `subagentConfig`, add the lazy standalone fallback, and make the
   extension entry point inject its scoped configuration into the command,
   runner, and batch.
6. Remove dead path re-exports and unused imports, preserving consumed
   non-path exports.
7. Replace the `tools-subagents` `vi.mock` path override with an explicit
   `settingsPath` dependency and fixture directory. Align the memory config
   store's path before exercising the extension so conflict validation is
   meaningful.
8. Add custom-directory and conflicting-path tests, then update `CONTEXT.md`:
   the Settings document entry records dependency injection and the canonical
   default; the Session profile binding entry records optional custom
   directory support and derived default behavior.
9. Run the affected test suites and typechecking, review the diff, then make
   one refactor commit. Keep this `plan.md` as the agreed plan record.

## Tests

Tests remain at module interfaces and seams rather than reaching into
implementations. The main test changes are:

- `_shared/session-profile-binding.test.ts`: cover the derived directory and
  an explicitly supplied custom directory; verify canonical path behavior.
- `config-profiles/profile-store.test.ts`: retain a custom-directory case and
  add a derived-directory case with only `settingsPath`.
- `config-profiles/index.test.ts`: inject a `ProfileStore` with an independent
  custom directory and verify the binding receives that directory; add a
  conflicting `settingsPath` case that fails fast.
- `tools-subagents/index.test.ts`: remove the module mock, pass the fixture
  path through `createSubagentsExtension`, and align the injected memory
  configuration path; add a conflicting path case.
- `tools-subagents/config.test.ts`, `model-commands.test.ts`,
  `subagent-runner.test.ts`, and `parallel-batch.test.ts`: preserve explicit
  injected configuration coverage and add focused compatibility checks for the
  lazy standalone fallback and for the import-safe `defaultParallelBatch`
  construction.
- `ui-model-selector` lifecycle tests: use the dependency object while
  preserving injected stores and verifying `setPath` is the synchronization
  seam.
- Existing explicit-path tests for advisor and Plan Mode remain the test
  surface for their document stores.
- Add or retain a focused test for `profilesDirectoryFor` so its derivation
  rule has one independent source of truth.

Verification commands:

```sh
cd .pi
pnpm test:shared
pnpm test:profiles
pnpm test:features
pnpm test:plan
pnpm test:subagents
pnpm test:advisor
pnpm test:safety
pnpm typecheck
```

Also run the repository's full `pnpm test` before the commit if the affected
suite remains green and the runtime is acceptable.

## Behavior invariants

- Production still starts from the same canonical `.pi/settings.json` path.
- A Profile still repoints every registered store before its `initialize`
  callback runs.
- Profiles still default to `dirname(settingsPath)/profiles`, while an
  explicitly supplied custom directory remains exact and authoritative.
- Settings reads, mutations, profile transitions, and legacy subagent
  migration keep their current ordering and data shapes.
- Standalone exported subagent helpers retain their existing optional
  configuration interfaces and do not read the Settings document at module
  import time.
- Tests redirect the path through extension dependency interfaces, never by
  mocking a constant after module load.
- No change is made to `tools-worktree`'s host `pi.exec` adapter or the
  Repository store's specialized bounded remote-fetch implementation.

## Risks and controls

- **Custom profile directory loss** could make an injected store read one
  directory while the binding resolves another. Pass the injected store's
  `profilesDirectory` into the binding and cover it with a real-file test.
- **Injected path mismatch** could register one path and write another.
  Normalize and compare explicit paths against injected `ProfileStore` and
  `SubagentConfigStore` paths, failing before registration on conflict.
- **A missed subagent fallback** could read the real Settings document. Remove
  the eager `subagentConfig` instance, ensure the extension always injects its
  scoped store, and search for every remaining standalone fallback deliberately.
  Inspect `defaultParallelBatch` separately so its construction remains lazy.
- **Standalone helper breakage** could affect external callers. Preserve
  optional configuration fields, inventory direct callers before editing, and
  use typechecking to catch accidental interface changes.
- **Interface drift** could leave extensions on the old composition idiom.
  Search for all `PROJECT_SETTINGS_PATH`, `PROFILES_DIRECTORY`, and
  `registerSessionProfileBinding` references after the edits.
- **Accidental behavior change** is controlled by the existing real-file tests
  and by running the affected suites after each migration group.
