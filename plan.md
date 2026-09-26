# Deepen extension-toggle transitions

## Outcome

Create one deep extension-toggle module behind which the `/features` picker and the `enable`, `disable`, and `reset` commands share the same state transition policy. The module will discover the Extension set, validate the requested selection, order directory moves against catalog requirements and conflicts, and return per-Extension outcomes.

Keep Pi command parsing, picker interaction, status/list text, and notifications in `config-feature-flag/index.ts`. Keep catalog parsing and static graph checks in `catalog.ts`. Do not add a dependency or a generic filesystem layer.

The selection-policy change is that the picker can apply a valid batch that disables both a dependent Extension and its requirement. The transition disables the dependent first. A single request to disable a requirement while leaving its dependent enabled remains blocked. The plan also corrects failure reporting: partial or total picker move failures must not appear as success or `No changes needed.`, and filesystem failures must be reported by Extension and direction instead of relying on raw `console.error` output. Successful, no-op, and policy-blocked command messages stay unchanged.

## Evidence and current friction

- `index.ts:41-83` discovers active and disabled Extension directories and constructs the display state.
- `index.ts:87-115` owns the directory move helpers. They return only a boolean and log raw filesystem errors.
- `index.ts:119-178` builds the picker selection, validates it, loops through the Extensions in alphabetical order, and reports only a move count. If every requested move fails, it says `No changes needed.`
- `index.ts:253-314` separately builds and validates the desired state for `enable`, `disable`, and `reset`, calls a move helper, and chooses a target-specific notification.
- `catalog.ts:83-104` rejects removing a requirement whenever a dependent is currently enabled, even when the same picker selection also removes that dependent. `catalog.test.ts:73-85` pins this earlier-change policy.
- `catalog.ts:106-132` checks final selections for missing requirements and conflicts. The catalog parser already rejects unknown references and requirement cycles.
- `index.test.ts` has five cases for protected Extension handling, one-at-a-time prerequisite removal, and a successful picker save. It does not cover dependency-ordered batches, picker cancellation, a partial batch failure, or the false `No changes needed.` result.
- `catalog.test.ts:116-130` names invalid default closure in the test title but asserts only an unknown-reference error. `parseExtensionCatalog` checks default closure at `catalog.ts:70-78`, but no test currently asserts that rejection.
- The checked-in tree currently has both `workflows-goal` and `workflows-plan` enabled, while `catalog-graph.test.ts:74-77` declares their conflict in both directions. Per-move checks must allow a batch to repair a pre-existing invalid live set.
- Baseline check passed from `.pi/`: `pnpm exec vitest run extensions/config-feature-flag` (4 files, 30 tests).

The friction is in the transition, not the catalog parser. The two caller paths choose different failure policies, and the interactive path cannot apply a dependency-closed selection in one save even though it exposes a multi-select picker.

## Decisions adopted using the recommended answers

1. **Scope both mutation paths.** The picker and all three commands use the same transition module. `list` and `status` keep their current presentation behavior but read Extension state through that module.
2. **Keep one owner for transitions.** The new module owns Extension discovery, protected-state checks, validation orchestration, move order, filesystem changes, and structured outcomes. `catalog.ts` keeps the pure selection rules. `index.ts` remains the Pi adapter for input and output.
3. **Treat a picker save as a desired state.** Validate the final enabled set. If the selection disables a dependent and its requirement together, allow it and disable dependents before requirements. If the desired set leaves a dependent enabled without its requirement, reject it before moving anything.
4. **Keep individual command semantics.** `/features disable core` remains blocked while an enabled Extension still requires `core`. The command's desired set still contains that dependent, so the existing safety message remains accurate.
5. **Preflight before side effects.** Validate protected Extensions, requirements, and conflicts before starting any move. A rejected target selection changes no directories.
6. **Use best-effort per-Extension moves.** Treat each directory rename as one operation; the set of renames is not transactional. Do not promise or attempt rollback. Continue unrelated moves after one failure, but skip a dependent enable if a requirement failed, skip a requirement disable if a dependent failed, and skip an enable when a conflicting Extension could not be disabled.
7. **Order deterministically.** Disable selected Extensions in reverse requirement order, then enable selected Extensions in requirement order. This also removes old conflicting Extensions before enabling replacements. Use Extension name as the stable tie-breaker for unrelated entries.
8. **Protect the infrastructure Extensions in the module.** `_shared` and `config-feature-flag` cannot be disabled, even if a caller bypasses the picker or command checks. Keep the current user-facing protection messages in the adapter.
9. **Keep uncataloged Extensions usable.** A discovered Extension without catalog metadata remains visible and can be enabled or disabled. It has no inferred requirements or conflicts.
10. **Use the existing local filesystem.** Keep `node:fs` operations inside the module. Tests use temporary project directories, as the current Extension tests already do. No filesystem port, in-memory filesystem package, lock, or new dependency is justified for this change.
11. **No automatic reload.** Preserve the existing instruction to run `/reload`; this module only changes directory state.
12. **No ADR.** This is a local, reversible Extension-selection policy change. The updated tests and glossary entry record the intended behavior.

## Target module and interface

Add `.pi/extensions/config-feature-flag/extension-toggle.ts`.

The module presents one short-lived session for one command or picker interaction. Its interface is a factory plus the current Extension list and one apply operation:

```ts
interface ExtensionToggleSession {
  readonly extensions: readonly ExtensionInfo[];
  apply(desiredEnabled: ReadonlySet<string>): ExtensionToggleResult;
}

function createExtensionToggleSession(
  cwd: string,
  catalog: ExtensionCatalog,
): ExtensionToggleSession;
```

`ExtensionInfo` moves out of `index.ts` and keeps the current fields: `name`, `enabled`, `protected`, and optional catalog metadata. Constructing a session scans the enabled and disabled directories once and captures the Extension names and states shown to the user. Callers create a fresh session for each command and invoke `apply` once for a picker save. Treat that as caller discipline; do not add a one-shot guard or extra session state.

`apply` only changes names present in that session's snapshot. It re-reads both possible directory paths for those names before applying the target. A name is in a valid live state only when exactly one root contains a real Extension directory with `index.ts`. If that directory is already in the requested root, the operation is a no-op. If it is in the opposite root and the destination is absent, move it. If a requested Extension is missing from both roots, both roots contain it, or either path is a non-directory or symlink, return a per-Extension failure. Check for any destination entry before renaming, including an empty directory. Newly discovered Extensions stay untouched, but any newly discovered enabled Extensions remain part of final-set validation.

The result is data, not a notification or thrown error for an expected directory-move failure. It distinguishes:

- a rejected desired selection with validation issues and no moves;
- an unchanged selection;
- successful moves;
- failed moves, with the Extension name and requested direction;
- moves skipped because applying them would leave a requirement or conflict invalid.

Keep the result small. The adapter needs enough information to distinguish full success, no change, partial success, and total failure, and to name affected Extensions. Do not expose raw absolute filesystem paths in user-facing failure text.

### Transition invariants

- `desiredEnabled` refers to discovered Extension names from the session. An unknown name is rejected.
- Protected Extensions remain enabled. A requested selection that disables one is rejected before any move.
- The requested final enabled set satisfies every catalog `requires` relationship and has no enabled conflict pair. Check each proposed move against the complete catalog rules, including conflicts declared by an already-enabled Extension. The live set may already contain violations; allow moves that add no new requirement or conflict violation so a batch can repair them.
- A requested removal of a requirement is valid when every current dependent is also removed in the same desired set. Leaving any dependent enabled is invalid.
- Catalog requirements are acyclic, as enforced by `parseExtensionCatalog`.
- The module completes all validation before the first move.
- Each successful rename updates the module's working enabled set before the next operation.
- Before treating an operation as a no-op or moving it, the module checks both roots. Exactly one real Extension directory with `index.ts` must exist. A target-only directory is a no-op; a source-only directory can move if the destination has no entry. Missing requested Extensions, duplicate paths, non-directories, symlinks, and any occupied destination are failures. Never rely on `renameSync` to reject an occupied destination: on the current platform it replaces an empty destination directory.
- A failed move does not undo successful independent moves. A dependent move that would violate `requires` or `conflicts` after an earlier failure is skipped.
- A batch is not atomic. There is no cross-process lock; checks only catch conflicting state present when each operation is re-read. Another process can still race between that check and `renameSync`, so this plan does not claim serialization or race-free no-overwrite behavior.

### Ownership split

`extension-toggle.ts` owns:

- `ExtensionInfo` and snapshot construction;
- enabled/disabled directory discovery currently in `scanExtensions` and `listExtensionDirs`;
- the protected Extension set;
- protected-state validation and orchestration of final-set checks through `catalog.ts`;
- dependency-aware ordering;
- directory creation and rename operations;
- per-Extension success, failure, and skipped outcomes.

`catalog.ts` continues to own catalog parsing, catalog schema validation, unknown-reference and cycle checks, and pure selection validation. Update `validateExtensionDisablements` so a prerequisite removal is rejected only when a dependent remains in the desired enabled set. Keep `validateExtensionSelection` as the final requirement/conflict check.

`index.ts` continues to own command parsing, picker construction, selection-to-desired-state mapping, output formatting, and Pi notifications. Remove its private scanning and moving policy so a caller cannot bypass transition checks.

## Adapter behavior

### Interactive picker

- Open one session before building the options so the list and selected state come from the same snapshot.
- Continue to omit protected Extensions from picker choices.
- Convert selected option values to a desired enabled set, then add every protected name from the session list because the picker omits those names. Call `apply` once. Do not separately validate, re-order, or rename directories in the adapter.
- Preserve the current success message when all requested moves succeed: `N extension(s) moved. Run /reload to apply.`
- Show `No changes needed.` only when the result is genuinely unchanged.
- On partial success, identify moved and failed/skipped Extensions and say that successful moves need `/reload`. Use warning severity.
- If nothing moved and at least one move failed, report failure, not `No changes needed.` Use error severity.
- For preflight issues, keep the current `Extension changes blocked` heading and issue wording where the same rule still applies.
- Preserve picker cancellation as `Changes discarded.`

### `enable`, `disable`, and `reset`

- Use the session's Extension list for unknown-name, current-state, protected, and default-state decisions.
- Express the command as a one-Extension desired-state change while preserving every other Extension in the snapshot.
- Delegate validation and filesystem changes to `apply`.
- Keep existing successful and already-enabled/already-disabled/reset notifications.
- Keep the current single-command dependency rejection message. A `disable` command does not silently disable dependent Extensions.
- Render move failure with the target Extension and direction. Do not rely on `console.error` as the only explanation.

### `list` and `status`

Keep text and metadata formatting in `index.ts`. Read the list through the new session. For `/features list` and the non-UI fallback, pass the existing session's `extensions` to `featuresListText`; do not scan again inside the formatter or create an unused session before routing the command. Use the same command session for `status`. Preserve uncataloged Extension display, catalog descriptions, protected labels, and the current non-UI fallback.

## Implementation steps

### 1. Add the transition contract tests

Create `extension-toggle.test.ts` using the existing temporary-directory pattern. Test through `createExtensionToggleSession`, not private helpers.

Cover:

- discovery of enabled and disabled directories, stable name ordering, ignoring directories without `index.ts`, and missing Extension directories;
- preservation of metadata and the `protected` flag;
- unchanged selection with no directory writes;
- rejection of unknown requested names and protected disables before any move;
- rejection of a target set with missing requirements or conflicts before any move;
- acceptance of disabling a requirement and its dependent in one valid picker batch;
- continued rejection of disabling only the requirement while its dependent stays enabled;
- dependent-first disable order and requirement-first enable order;
- removal-before-enable when replacing one conflicting Extension with another, including one-sided conflict declarations in both directions so an already-enabled Extension's declaration is checked;
- repair of a pre-existing invalid live set: start with both members of a declared conflict enabled, disable one in the desired set, and verify the removal is not skipped because the live set began invalid;
- a failed prerequisite enable preventing dependent enable, while unrelated moves still proceed;
- a failed dependent disable preventing requirement disable;
- a failed conflict removal preventing conflicting enable;
- a mid-batch failure returning per-Extension outcomes and preserving already completed independent moves;
- stale snapshot handling: a valid directory already in the requested root is a no-op; a valid directory in the opposite root is moved; a requested Extension missing from both roots, present in both roots, or replaced by a non-directory or symlink fails;
- an empty destination directory created after the snapshot is reported as a failure and remains in place, proving the implementation checks before `renameSync` can replace it;
- newly discovered enabled and disabled Extensions remain untouched; a newly discovered enabled Extension still participates in final requirement/conflict validation;
- enabling and disabling an uncataloged Extension without inventing catalog rules.

Use real temporary directories to induce stale and conflicting-path failures. Keep assertions on resulting directory state and returned outcomes. Do not assert private helper calls or internal arrays.

### 2. Update catalog policy tests

In `catalog.test.ts`, replace the current all-or-nothing `earlier change` expectation with the selected contract:

- current `{core, worker}` to desired `{}` makes `validateExtensionDisablements` return no issue because the final set removes both;
- current `{core, worker}` to desired `{worker}` remains blocked by `validateExtensionDisablements` with the existing targeted `Cannot disable "core"...` message; assert separately that `validateExtensionSelection(catalog, {worker})` reports that `worker` requires `core`;
- preserve conflict validation, cycle detection, duplicate/reference validation, and catalog parsing tests;
- add a real invalid-default-closure assertion, for example a default-enabled `worker` requiring a default-disabled `core`, and verify `parseExtensionCatalog` rejects it. The existing test title mentions this case, but its assertion currently covers only an unknown reference.

Keep the targeted dependency-removal message for the one-Extension command case. The transition module must still validate the complete desired set before applying moves.

### 3. Move discovery and transition ownership

In `extension-toggle.ts`, move the current directory scanning and `ExtensionInfo` shape from `index.ts`. Keep filesystem paths and rename code private to this module.

Build the final set from the current filesystem state, the session's known Extension names, and the requested enabled set. Preserve new Extensions outside the session snapshot. Validate protected state and the final catalog constraints before changing directories.

Plan operations in deterministic order. Disable all requested removals in reverse requirement order, then enable additions in requirement order. During execution, maintain a working enabled set. Before each rename, re-check source and destination state. For each proposed move, validate the complete prospective enabled set against the working set and allow it only if it introduces no new missing-requirement or conflict violation. Do not require the live set to be valid before a repair move; the checked-in `workflows-goal`/`workflows-plan` state is already conflicting. If an operation fails or would add a violation, record it and evaluate whether each remaining operation is still safe against the working set. Continue only with independent operations that add no new violations.

Do not roll back successful moves. Return a result that makes the resulting state and failures explicit.

### 4. Route the Pi adapter through the module

Update `index.ts`:

- remove `scanExtensions`, `listExtensionDirs`, `enableExtension`, `disableExtension`, `setExtensionEnabled`, `enabledExtensionNames`, and `notifySelectionIssues` after their responsibilities move;
- use one transition session for picker options and apply;
- route `enable`, `disable`, and `reset` through the same apply operation;
- keep `featuresListText`, status formatting, command argument handling, prompt behavior, and notification wording at the Pi seam;
- map structured outcomes to messages without duplicating transition rules.

Do not change `loadExtensionCatalog`, catalog file format, Extension dependency source scanning, or `/reload` behavior.

### 5. Keep adapter tests focused on visible behavior

Update `index.test.ts` to preserve command and picker behavior through the extension entrypoint. Keep the existing assertions for protected Extensions, status/list output, and requirement rejection for a single `disable` command. Add an explicit picker-cancellation assertion for `Changes discarded.` and no directory changes; the current suite has no cancellation assertion.

Add adapter cases for:

- a valid picker batch that disables a dependent and its requirement;
- partial picker success that names failed Extensions and does not say `No changes needed.`;
- all moves failing, which reports failure;
- `enable`, `disable`, and `reset` command success and already-at-target notifications, plus validation rejection and a filesystem move failure with the target name and direction. Preserve the existing per-command wording where possible.

Keep transition-order and failure-propagation detail in `extension-toggle.test.ts`; do not duplicate those internal policy assertions in `index.test.ts`.

### 6. Keep the domain term current

The `Extension toggle` term has been added to the `Extension toggles` section of `CONTEXT.md`. Preserve the existing uncommitted `Guardian fallback` entry in that file. The glossary definition stays domain-level and does not describe the TypeScript implementation.

## Expected files

Implementation changes:

- `.pi/extensions/config-feature-flag/extension-toggle.ts` (new)
- `.pi/extensions/config-feature-flag/extension-toggle.test.ts` (new)
- `.pi/extensions/config-feature-flag/index.ts`
- `.pi/extensions/config-feature-flag/index.test.ts`
- `.pi/extensions/config-feature-flag/catalog.ts`
- `.pi/extensions/config-feature-flag/catalog.test.ts`
- `CONTEXT.md` (the domain term is already present from planning)

No changes are expected to `.pi/package.json`, dependencies, `catalog.json`, other Extension modules, or Git configuration.

## Verification sequence

Run from `.pi/`:

1. `pnpm exec vitest run extensions/config-feature-flag`
2. `pnpm test:features`
3. `pnpm typecheck`

The focused baseline currently passes 4 test files and 30 tests. After implementation, run the focused suite first. Then run `test:features` to catch nearby catalog consumers and `typecheck` for the new module contract.

## Completion criteria

- The picker and `enable`, `disable`, and `reset` commands use the same transition module.
- Valid dependency-closed picker batches can disable a dependent and its requirement in safe order. A single command still refuses to remove a requirement that an enabled dependent needs.
- Requirements are enabled before dependents; dependents are disabled before requirements. Conflicts are resolved by applying removals before additions.
- Preflight rejection causes no filesystem changes.
- An individual move failure is visible by Extension name. Independent moves can succeed; dependent or conflicting moves are skipped when prerequisites fail. Successful moves are not rolled back.
- A failed batch can never produce the picker message `No changes needed.`
- Protected Extensions and uncataloged Extension behavior remain covered.
- Tests exercise the transition through its interface and preserve command/picker integration coverage.
- Focused tests, `pnpm test:features`, and `pnpm typecheck` pass.

## Worktree note

The previous uncommitted `plan.md` was copied to `/var/folders/th/_8dpnzf515n6h74y89jpky5h0000gn/T/plan.md.before-extension-toggles-20260925-165350.bak` before it was deleted, as requested. Other pre-existing edits remain untouched.
