# Implementation plan: consolidate Extension dependency rules

## Purpose

Deepen the existing Extension Catalog module so it owns the pure rules for Extension requirements. Catalog validation, selection checks, disablement checks, and requirement-safe ordering will live together in `config-feature-flag/catalog.ts`. Ordering keeps the existing `localeCompare()` tie-break. The Extension toggle module will continue to own filesystem inspection, directory moves, and partial outcomes.

This is a focused in-process refactor. It adds no new file, dependency, catalog field, migration, or user-facing command behavior.

## Expected architectural gain

- **Locality.** Changes to graph interpretation and pure selection rules stay in the Catalog module instead of spreading between catalog validation and toggle sequencing.
- **Leverage.** One Catalog interface gives the Extension toggle module and graph tests the same dependency rules.
- **Testability.** The interface is the test surface: graph order can be verified without setting up filesystem paths, while toggle tests continue to verify observable move outcomes.
- **Depth.** Catalog already owns most graph behavior. Adding requirement-safe ordering puts the remaining ordering logic behind its existing small interface without moving filesystem complexity into it.

## Current friction

`catalog.ts` already validates requirement cycles, default selections, and requested selections, and rejects disabling a requirement while an enabled dependent remains. `extension-toggle.ts` separately implements `orderByRequirements()` to order the same graph before applying directory moves. The toggle module then checks each prospective move with `validateExtensionSelection()` so a failed earlier move cannot make a later move introduce a new selection violation. It compares the prospective selection's validation issues with those already present, allowing moves that preserve or remove pre-existing issues.

Current coverage is indirect. `catalog.test.ts` covers parsing and selection rules; `extension-toggle.test.ts` observes ordering through filesystem moves; and `index.test.ts` checks picker and command behavior, including a batch that disables a dependent and its requirement. `catalog-graph.test.ts` and `dependency-audit.test.ts` protect checked-in relationships and source-audit rules, not ordering. None tests graph ordering through a pure Catalog interface. The integration coverage remains valuable, but a change to the ordering algorithm currently has to be inferred through filesystem outcomes.

Relevant code:

- `.pi/extensions/config-feature-flag/catalog.ts`: catalog parsing and validation, including `validateExtensionDisablements()` and `validateExtensionSelection()`.
- `.pi/extensions/config-feature-flag/extension-toggle.ts`: preflight validation, move sequencing, per-move validation, and filesystem effects. The private `orderByRequirements()` is near the end of the file.
- `.pi/extensions/config-feature-flag/catalog.test.ts`: parser and selection-rule checks.
- `.pi/extensions/config-feature-flag/catalog-graph.test.ts` and `dependency-audit.test.ts`: checked-in relationship and source-audit checks, not ordering tests.
- `.pi/extensions/config-feature-flag/extension-toggle.test.ts`: current filesystem outcomes and ordering coverage.
- `.pi/extensions/config-feature-flag/index.test.ts`: command and picker integration, including dependency-ordered batch behavior.

## Decisions settled with the recommended defaults

1. **Scope.** Consolidate dependency graph meaning and ordering only. Keep catalog loading and filesystem effects where they are. Do not add automatic requirement installation or dependent removal.
2. **Placement.** Deepen `catalog.ts` rather than add an `extension-dependencies.ts` module. The catalog already owns graph validation and is the natural place for the pure ordering operation. A new seam would add indirection without a second distinct implementation.
3. **Behavior.** Preserve the current order, tie-breaking, diagnostics, preflight rejection, per-move safety check, and partial-result behavior. This plan does not change extension toggle policy.
4. **Tests.** Test graph ordering through the Catalog module's interface, then retain filesystem tests through the Extension toggle interface to verify that the ordering is applied correctly.
5. **Domain language.** Add the Extension dependency rules term to `CONTEXT.md` and keep it aligned with the selected module responsibilities.

## Target module responsibilities

### Catalog module

`catalog.ts` will own:

- Catalog file loading and schema validation, unchanged.
- Relationship validation, including unknown relationship references, self-references, duplicate relationships, and requirement cycles, unchanged.
- Default-selection validation, unchanged.
- `validateExtensionSelection()` and `validateExtensionDisablements()`, unchanged.
- Requirement-safe ordering of requested Extensions by their declared requirements, moved here from `extension-toggle.ts`, with the existing `localeCompare()` tie-break.

The new ordering operation remains pure. It accepts the requested Extension names, the parsed `ExtensionCatalog`, and an enable/disable direction, then returns the same ordered name list as the current implementation. It does not read directories, move files, invent prerequisites, or resolve conflicts by itself.

### Extension toggle module

`extension-toggle.ts` will continue to own:

- Snapshotting enabled and disabled Extension directories.
- Rejecting unknown requested names and protected Extension disablement.
- Preflight selection and disablement checks.
- Re-reading enabled names at apply time and inspecting each requested path before its move, applying the existing no-op, move, and failure behavior for stale paths.
- Ordering disable moves before enable moves, using the Catalog module's ordering operation for each direction.
- Rechecking the working selection before each move, performing the rename, and reporting `moved`, `failed`, and `skipped` outcomes.

The per-move check is not duplicate graph interpretation. It protects the working selection after a prior move fails, allowing independent safe moves while preventing later moves from adding validation issues. It should keep calling `validateExtensionSelection()`. Path rechecks remain best-effort; they do not serialize or fully detect concurrent filesystem changes.

## Proposed interface change

Add one exported operation to `catalog.ts`:

```ts
export function orderExtensionsByRequirements(
  names: readonly string[],
  catalog: ExtensionCatalog,
  direction: ExtensionToggleDirection,
): string[]
```

Move `ExtensionToggleDirection` to `catalog.ts` beside the ordering operation, and import that type in `extension-toggle.ts` for its outcome and operation declarations. A repository-wide search found no imports of the existing type from `extension-toggle.ts`, so do not retain a type-only compatibility re-export.

The function should retain the existing implementation's behavior:

- For `enable`, an Extension waits until its requested requirements have been ordered first.
- For `disable`, an Extension waits until its requested dependents have been ordered first.
- Among currently eligible names, choose the first according to the existing `localeCompare()` sort, which uses the runtime's default locale. Repeat after each choice, so a newly eligible name can precede names that were already eligible. Do not replace this comparator as part of the move.
- Only order the names passed by the caller. Do not add a prerequisite or dependent that is absent from the requested names; the ordering function does not inspect current enabled state.
- Treat an Extension absent from the catalog as having no graph edges, matching the current optional `catalogEntry()` lookup behavior.
- Preserve the current Set-based deduplication of repeated input names.
- Preserve the exact defensive cycle error, `Extension requirements contain a cycle.`, when the requested names include a cycle in a malformed catalog. Construct that test catalog directly rather than passing it through `parseExtensionCatalog()`, which rejects cycles in normal use.

Do not move `introducesValidationIssues()` to `catalog.ts`. It compares successive in-memory selections during filesystem application, so it belongs with the toggle transaction. Do not move the second `catalogEntry()` helper solely to remove a few lines of code. In `extension-toggle.ts` it also supplies display metadata while building the Extension snapshot.

## Implementation sequence

### 1. Move and expose requirement ordering

Edit `.pi/extensions/config-feature-flag/catalog.ts`:

- Define and export `ExtensionToggleDirection` as the existing `"enable" | "disable"` union.
- Add `orderExtensionsByRequirements()` beside the selection and disablement validation functions.
- Move the current ordering loop without changing its eligible-name scan, `localeCompare()` tie-break, repeated selection behavior, or cycle failure.
- Keep graph lookup private to this module. Reuse `catalogEntry()` already present in `catalog.ts`.

This step gives callers a small interface for a coherent graph operation. The implementation can change later without callers reproducing requirement semantics.

### 2. Make Extension toggle a caller of the Catalog module

Edit `.pi/extensions/config-feature-flag/extension-toggle.ts`:

- Import `orderExtensionsByRequirements` and `type ExtensionToggleDirection` from `catalog.ts`.
- Remove the local `ExtensionToggleDirection` declaration. Do not add a compatibility re-export because no in-repository caller imports the type from `extension-toggle.ts`.
- Remove the private `orderByRequirements()` implementation.
- Replace both calls in `orderedNames` with the Catalog operation, retaining the existing order of phases: disable names first, then enable names.
- Leave preflight validation, the working enabled set, per-move validation, path checks, rename handling, and result classification unchanged.

No changes are needed in the command adapter in `index.ts`. It continues to consume `ExtensionToggleSession` and render the existing result messages.

### 3. Add direct ordering tests

Edit `.pi/extensions/config-feature-flag/catalog.test.ts` to exercise the new operation through the Catalog module's interface. Cover the rules that matter to callers:

- Enabling a requirement chain orders each requirement before its dependent.
- Disabling the same chain orders dependents before their requirements.
- A dependency diamond orders the shared prerequisite first and uses the existing `localeCompare()` tie-break among branches. Use entries where `a` requires `b` and `c`, both `b` and `c` require `root`, and `z` is unrelated. For input `["z", "c", "root", "a", "b"]`, assert enable order `["root", "b", "c", "a", "z"]` and disable order `["a", "b", "c", "root", "z"]`. These exact results prove that a newly eligible name can move ahead of an already-eligible `z`.
- Unrelated requested names are ordered by the same `localeCompare()` comparator.
- With `worker` requiring `core` and input `["worker"]`, assert the enable result is `["worker"]`; with input `["core"]`, assert the disable result is `["core"]` and does not add the unrequested dependent.
- With no `constructor` catalog entry, input `["constructor"]` remains orderable as `["constructor"]` without graph edges, preserving the own-property catalog lookup.
- Repeated input names appear once in the result.
- Empty input returns an empty list.
- A malformed cyclic catalog still produces the existing defensive error when the requested names include the cycle.

Prefer a small number of readable graph fixtures over one test per implementation detail. Assert exact ordered results and the cycle error, not internal iteration state.

### 4. Preserve toggle outcome coverage

Keep the existing tests in `.pi/extensions/config-feature-flag/extension-toggle.test.ts` that prove the filesystem operation applies the ordering and preserves failure behavior. In particular, retain coverage for:

- Disabling dependents before requirements.
- Enabling requirements before dependents.
- Existing `localeCompare()` ordering for unrelated moves.
- Replacing conflicting Extensions by disabling before enabling.
- Skipping a dependent enable when its prerequisite move fails.
- Skipping a requirement disable when its dependent cannot be moved.
- Partial success when unrelated requested moves remain possible.
- A directory already moved while the picker was open.

These tests cross the Extension toggle interface and protect behavior that the pure Catalog tests cannot establish. Keep `index.test.ts` unchanged as command and picker integration coverage, including its dependency-closed batch test. Do not replace either layer with ordering-only assertions.

### 5. Keep the domain glossary current

`CONTEXT.md` has been updated with the Extension dependency rules term. Keep its ownership statement in sync with the implementation: Catalog graph meaning and ordering in `catalog.ts`; directory inspection, moves, and partial outcomes in `extension-toggle.ts`; no implicit requirement addition or dependent removal.

## Verification plan

Run checks from `.pi/`:

1. Focused tests for the changed module and its filesystem caller:

   ```sh
   pnpm exec vitest run extensions/config-feature-flag/catalog.test.ts extensions/config-feature-flag/extension-toggle.test.ts
   ```

2. The full feature-flag directory suite, including command and catalog graph tests:

   ```sh
   pnpm exec vitest run extensions/config-feature-flag
   ```

3. Typecheck the extension workspace:

   ```sh
   pnpm typecheck
   ```

4. Review the diff and confirm the implementation changes only `catalog.ts`, `extension-toggle.ts`, their relevant tests, and `CONTEXT.md`. This root `plan.md` is the plan record. No catalog data or command text should change.

The first test command checks the narrow seam and filesystem integration. The directory suite catches nearby feature-flag regressions. Typechecking confirms that the moved direction type and new Catalog export have no stale imports.

## Acceptance criteria

- `catalog.ts` is the only implementation of Extension requirement-based ordering.
- The new ordering operation is directly testable without creating directories or moving files.
- `extension-toggle.ts` no longer contains graph-ordering code but still owns the full filesystem transition and partial-outcome policy.
- Exact enable and disable ordering matches the current behavior, including its `localeCompare()` tie-break under the runtime's default locale.
- Existing validation messages and order remain unchanged.
- Catalog cycle rejection remains intact, and the ordering function keeps its defensive malformed-catalog failure.
- Existing toggle tests continue to verify that filesystem failures do not leave a newly invalid selection.
- The focused tests, feature-flag suite, and typecheck pass.

## Risks and safeguards

- **Ordering drift.** Moving the loop can change which eligible name is selected after each iteration or replace the existing locale-sensitive `localeCompare()` tie-break. Use exact-result tests for a chain, the diamond case that promotes a newly eligible name ahead of `z`, and unrelated names; keep the toggle integration assertions.
- **Changed failure behavior.** A malformed catalog could reach the function without `parseExtensionCatalog()`. Preserve the exact current cycle error rather than assuming every caller validated its input.
- **Partial filesystem state.** Moving ordering must not make the whole toggle batch atomic or alter skip behavior. Keep the working selection and per-move validation in `extension-toggle.ts`.
- **Scope creep into dependency policy.** Do not auto-enable requirements, auto-disable dependents, alter conflict policy, or rewrite user diagnostics as part of this refactor.
- **A shallow new seam.** Do not add a separate dependency module or adapter. After consolidation, the Catalog module owns the graph implementation, and the direct function test makes its rules testable.

## Explicitly out of scope

- Changing `.pi/extensions/catalog.json` or its version.
- Changing `/features` parsing, UI, notifications, or status text.
- Automatically expanding a requested selection to include requirements.
- Automatically removing dependents when a requirement is disabled.
- Altering filesystem path safety, symlink handling, directory race handling, or rename semantics.
- Reworking dependency source audits in `dependency-audit.ts`.
- Refactoring the broader Extension toggle session or introducing a second Catalog adapter.
