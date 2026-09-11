# Plan — Deepen the stored→runtime model-selection mapping

Architecture-review candidate 1 (Strong), selected 2026-09-11. Design decisions finalized in a
grilling loop with recommended answers adopted; interface explored design-it-twice with three
parallel designs (minimize-interface / maximize-flexibility / optimize-most-common-caller) and a
hybrid chosen. Vocabulary per `codebase-design`: module, interface, implementation, depth, seam,
adapter, leverage, locality.

## Problem

Two production copies of the stored→runtime model-selection contract:

1. `_shared/model-selection.ts` — `applyModelSelection` (resolves sentinels, looks up the
   catalogue when the model switches) + private `applyResolvedModelSelection` (the commit).
2. `ui-model-selector/model-selection-lifecycle.ts` — `synchronizeContext`
   (`model-selection-lifecycle.ts:229-271`), re-encoding the same rules for the sync path.

Rules duplicated across the 12-method lifecycle adapter seam:

- **Context rule.** A stored numeric `contextWindow` is an explicit user choice, applied
  verbatim; pi's 128K undeclared-context sentinel (`resolveContextWindow` 128K→256K) is
  normalized only on catalogue-resolved models in the apply path and on the current model in the
  sync path — never on a stored numeric window, and never on the current model in the apply path
  (invariant 1). Comment copy-pasted at `model-selection.ts:404-405` and
  `model-selection-lifecycle.ts:240-242`.
- **Thinking rule.** After `setModel`, the caller's thinking level must be re-applied because
  pi's `setModel` imperatively applies per-model overrides or the global default
  (`model-selection.ts:339-367`, `model-selection-lifecycle.ts:248-269`).
- **Auth error mode.** `"No configured authentication for ${provider}/${modelId}"` thrown from
  both — but the two strings already diverge by a trailing period: the apply path appends one
  (`model-selection.ts:350`), the sync path does not (`model-selection-lifecycle.ts:263`). Only
  the period-ful spelling is actually pinned: `model-selection.test.ts:550,746`,
  `ui-model-selector/index.test.ts:242` and `config-profiles/index.test.ts:481` assert it with
  the period, while `model-selection-lifecycle.test.ts:331` and
  `workflows-plan/model-profile.test.ts:358` use `toThrow(<string>)` — a *substring* match that
  would also pass against a period-ful message. Both spellings must still survive the move
  (invariant 5), and the new tests must assert them exactly (test plan item 7).

The lifecycle tests fake the adapter, so the two copies can diverge unnoticed. Additionally
`_shared/model-selection.ts` is a 22-export grab-bag: persisted-format parsing, validation,
merging, sentinel resolution, runtime commits, and mode detection in one file.

## Goal

One deep **Model-selection runtime module** owns stored→runtime resolution and runtime commits;
both the apply path and the sync path consume it. The lifecycle adapter shrinks to the facts and
policies that actually vary. Tests assert the contract once, at the module's interface.

## Verified call-site census

Runtime-commit consumers (today):

| Caller | Function | Path |
|---|---|---|
| `ui-model-selector/index.ts:101` (adapter) | `applyModelSelection` | startup profile apply |
| `ui-model-selector/index.ts:102` (adapter) | `applyPickedModelSelection` | interactive pick |
| `workflows-plan/plan-profile-transition.ts:86` | `applyModelSelection` | Plan profile transition apply |
| `config-profiles/index.ts:151` | `applySelectionFromDocument` | Profile switch model apply |
| `model-selection-lifecycle.ts:229-271` | inline copy | sync path |

Pure-normalizer consumers (`resolveModelContext`, stays put): `model-picker.ts:140`,
`tools-advisor/runner.ts:73`, `tools-advisor/index.ts:316`, `policy-permissions/index.ts:235`,
`model-selection-lifecycle.ts:236`.

Format/persistence consumers: `model-selection-persistence.ts` (parse/merge/validate),
`workflows-plan/model-profile.ts` (`ConcreteModelSelection`), `plan-lifecycle.ts:417`
(`validateConcreteModelSelection`), `plan-profile-transition.ts` (`usesDefaultSentinel`).

## Design decision tree (settled)

Each decision below was the recommended answer in its grilling round; alternatives were
considered via the design-it-twice sub-agents and are recorded where rejected.

1. **Scope** — Deduplicate the two rules by splitting runtime commits out of
   `_shared/model-selection.ts`; leave the stored-format half (parsing, validation, merging,
   sentinels, `resolveModelContext`, `applyFamilyThinkingLevel`, mode detection) where it is.
   Do *not* move `selectionModeFromEntries`/`currentSelectionMode` (no current pain; YAGNI), do
   *not* touch the picker's value/label encoding or `targetSelection` (separate candidate).
2. **Sync path delegates; not pure-functions-only** — Extracting pure rule functions while each
   path keeps its own commit would leave the "thinking survives `setModel`" copy in the
   lifecycle. The commit itself moves behind one implementation.
3. **New file** — `_shared/model-selection-runtime.ts`; `_shared/model-selection.ts` remains the
   stored-format module. The runtime module imports format types from it. Splitting along the
   persisted-format vs runtime-commit seam matches the file's own split-brain header comment.
4. **Port shape** — A narrow injected port `ModelRuntimeFacts` (4 methods: `currentModel`,
   `currentThinkingLevel`, `setModel`, `setThinkingLevel`) plus an injected `catalogue` typed as
   the Model reference module's existing `RefreshableModelLookup` (`{ modelRegistry: { find,
   refresh? }, scopedModels? }`), which the module hands to `resolveModelReference`.
   Rejected: passing raw `pi`/`ctx` everywhere (the lifecycle could not use it without growing
   its adapter — the pass-through shape this deepening removes); passing the whole 12-method
   lifecycle adapter (couples the module to session policy it does not own); a bespoke
   `lookup(reference, { label, refresh })` function port — it re-declares part of an interface
   the Model reference module already owns, and faking *resolution* instead of the *registry*
   would drop today's real `resolveModelReference` coverage for scope enforcement, refresh-abort,
   and refresh-cause rethrow (`model-selection.test.ts:385,396,406`). `ExtensionContext`
   satisfies `RefreshableModelLookup` structurally and the existing harness's `ctx` fake already
   supplies `modelRegistry` + `scopedModels`, so those three tests migrate verbatim.
5. **Lifecycle adapter shrinks 12 → 8** — drop `setModel`, `setThinkingLevel`,
   `applyStoredSelection`, `applyPickedSelection`; the lifecycle receives the runtime module as a
   separate constructor dependency. Kept: `loadSelection`, `getRuntimeState` (usage tokens),
   `pick`, `confirmContextReduction`, `isIdle`, `requestCompaction`, `reportNotice`,
   `reportOutcome` — all real facts or policies.
6. **Outcome semantics stay in the lifecycle** — outcome kinds
   (`unchanged`/`context-synchronized`/…) and compaction policy are lifecycle decisions. The
   runtime module returns plain results (`{kind: "unchanged"}` /
   `{kind: "synchronized", model}` — the model object in effect after the sync, which the
   lifecycle reports as `context-synchronized`'s `model`; per invariant 4, that is the derived
   target object with no post-`setModel` read-back); the lifecycle maps them.
7. **Persistence timing unchanged** — picked path persists after the live commit with no
   rollback, surfacing `ModelSelectionNotSavedError`; the saver is injected at construction.
   Plan transition and Profile switch keep persisting outside the module (via
   `plan-profile-transition`'s own persistence and the Settings document respectively).
8. **Naming** — keep the public function names `applyModelSelection`,
   `applyPickedModelSelection`, `applySelectionFromDocument` (only the import path changes), add
   the `ModelSelectionRuntime.synchronize` method. Module term for CONTEXT.md: **Model-selection
   runtime**. Design-it-twice rejected: `ModelSelectionMapper` (jargon), pipeline stages (below).
9. **Rollout** — three commits, each leaving `pnpm typecheck` and the affected suites green:
   (a) extract the runtime module + move its tests, (b) rewire the ui-model-selector lifecycle +
   shrink the adapter + replace duplicated tests, (c) CONTEXT.md entry — followed by Step 4's
   full-suite verification pass, which changes no files.
10. **Behavior is byte-identical** — same error strings, ordering, fast paths, `typeof
    pi.getThinkingLevel` guards, `ModelReferenceError("refresh")` cause rethrow. Existing tests
    are the characterization; they migrate, not rewrite-from-scratch.

### Design-it-twice comparison (why this hybrid)

- **Design 1 — `ModelSelectionMapper` with a runtime port, 3 entry points** (adopted core):
  narrow port + 3 entry points (`applyStored`, `applyPicked`, `synchronize`); two adapters
  (Pi binding + test fakes) make the seam real. Highest depth per entry point.
- **Design 2 — staged resolution pipeline** (`pipe(resolveSentinels(), materialize({source}),
  commit({persist}))` + named presets): rejected. Its adopters are hypothetical (subagent target
  screens); the stage vocabulary is a second interface that costs locality, and
  `materialize({source: "verbatim"})` weakens the `Model`-typed guarantee of the picked path.
  One-adapter seams (subagent dry-run preview) don't justify the machinery yet.
- **Design 3 — rename-in-place keeping raw `(pi, ctx)`** (partially adopted): rejected as the
  whole design because the lifecycle would need a 13th pass-through adapter method to reach the
  sync function without breaking its pi-free tests — the exact shallow-adapter shape this
  deepening removes; and the format/runtime grab-bag would remain. Adopted from it: keep today's
  export names and outcome-mapping discipline in the lifecycle.
- **Hybrid**: D1's port + entry points; D3's name stability and call-site census; pi-bound
  convenience wrappers (thin binding glue, not shallow modules) for the two external
  `(pi, ctx)` call sites so `plan-profile-transition` and `config-profiles` stay one-line
  changes.

## The deepened module

New file `extensions/_shared/model-selection-runtime.ts`:

```ts
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
// types + pure normalizers stay in model-selection.ts (stored-format module)
import {
  type ModelSelectionMode,
  type ModelSelectionSettings,
  type StoredModelSelectionSettings,
  resolveModelContext,
  selectionModeFromEntries,
  parseProjectModelPreferences,
} from "./model-selection.ts";
import { DEFAULT_SENTINEL, readPiNativeDefaults, type PiNativeDefaults } from "./pi-defaults.ts";
import { MODEL_THINKING_LEVELS, type SupportedModelThinkingLevel } from "./model-thinking.ts";
import {
  resolveModelReference,
  ModelReferenceError,
  type RefreshableModelLookup,
} from "./model-reference.ts";

type StoredThinkingLevel = SupportedModelThinkingLevel;

/** Narrow port for the runtime facts the mapping commits to. */
export interface ModelRuntimeFacts {
  currentModel(): Model<Api> | undefined;
  currentThinkingLevel(): StoredThinkingLevel | undefined;
  /** false = no configured authentication for that model. */
  setModel(model: Model<Api>): Promise<boolean>;
  setThinkingLevel(level: StoredThinkingLevel): void;
}

/** The deep module: one instance per Session, constructed by the Pi adapter. */
export interface ModelSelectionRuntime {
  /** Stored → runtime. Resolves sentinels, may switch models via the catalogue.
   *  `label` is required: it prefixes resolution error messages, as today. */
  applyStored(
    stored: StoredModelSelectionSettings,
    options: { label: string; nativeDefaults?: PiNativeDefaults },
  ): Promise<ModelSelectionSettings>;
  /** Picked → commit → persist effective selection. Throws ModelSelectionNotSavedError. */
  applyPicked(model: Model<Api>, thinkingLevel: StoredThinkingLevel, options: { mode: ModelSelectionMode }): Promise<ModelSelectionSettings>;
  /** Sync path: reconcile the given current model with a stored profile. The derived target
   *  always shares provider/modelId with `currentModel` (setModel still runs whenever the
   *  derived target object differs), never queries the catalogue, and treats absent or sentinel
   *  profile fields as "keep current". The current model is a parameter, not a port read: the
   *  lifecycle has already read it for its `no-current-model` guard, and reusing that snapshot
   *  keeps today's single read — taken *before* the profile load — and leaves the no-model case
   *  with the caller, where it lives today. */
  synchronize(currentModel: Model<Api>, stored: StoredModelSelectionSettings | undefined): Promise<
    | { kind: "unchanged" }
    | { kind: "synchronized"; model: Model<Api> }
  >;
}

export function createModelSelectionRuntime(deps: {
  facts: ModelRuntimeFacts;
  catalogue: RefreshableModelLookup;
  /** Consumed by `applyPicked` only; omitting it and calling `applyPicked` throws rather than
   *  silently skipping persistence (invariant 6). */
  saver?: ModelSelectionSaver;
}): ModelSelectionRuntime;

/** Pi binding for external (pi, ctx) callers; passes `ctx` itself as the catalogue. */
export function createPiModelRuntime(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  deps?: { saver?: ModelSelectionSaver },
): ModelSelectionRuntime;

/** Pi-bound convenience for plan-profile-transition (same shape as today). */
export function applyModelSelection(
  pi: ExtensionAPI, ctx: ExtensionContext, stored: StoredModelSelectionSettings,
  options: { label: string; nativeDefaults?: PiNativeDefaults },
): Promise<ModelSelectionSettings>;

/** Pi-bound convenience for config-profiles (unchanged signature, new home). */
export function applySelectionFromDocument(
  pi: ExtensionAPI, ctx: ExtensionContext, document: Record<string, unknown>,
  nativeDefaults?: PiNativeDefaults,
): Promise<ModelSelectionSettings | undefined>;

/** `ModelSelectionSaver` moves here verbatim but becomes exported: it now also appears in the
 *  `createModelSelectionRuntime`/`createPiModelRuntime` deps, not only in `applyPicked`.
 *  `ModelSelectionPersistence` still satisfies it structurally. */
export interface ModelSelectionSaver {
  save(mode: ModelSelectionMode, selection: ModelSelectionSettings): Promise<void>;
}

export class ModelSelectionNotSavedError extends Error { /* unchanged, moves here */ }
```

Invariants owned by the implementation (stated once):

1. A stored numeric `contextWindow` commits verbatim. In the apply path `resolveContextWindow`
   (128K→256K) runs **only** on a catalogue-resolved model (`model-selection.ts:425`) and never
   on the current model — the `sameModel` fast path hands `ctx.model` through untouched
   (`model-selection.ts:399-409`). Consequence to preserve: a current model at 128K plus a
   legacy-missing or verbatim-128K stored window stays at 128K and triggers no `setModel`. (The
   sync path *does* normalize the current model — invariant 4.) A `default` sentinel resolves
   through the catalogue; a missing (legacy) window inherits the current model's window when the
   model already matches.
2. Sentinel provider/modelId/thinkingLevel resolve through injected `nativeDefaults`, else
   `readPiNativeDefaults()` (which throws on missing/invalid global settings); sentinel thinking
   falls back to the current runtime level, then `"medium"`; a resolved defaultThinkingLevel
   outside the closed vocabulary throws `Pi's native defaultThinkingLevel is not supported:
   ${level}.` (the trailing period is part of the message — verified against the source, which
   renders `${String(thinkingLevel)}`). The `needsNativeDefaults` check includes a sentinel thinkingLevel alone.
3. Commit ordering: resolve target → `setModel` iff provider/id/contextWindow differ →
   re-apply thinking when pi's effective level differs → read back the effective level
   (post-clamp) → return the effective `ModelSelectionSettings`.
4. `synchronize` derives its target from its `currentModel` argument via `resolveModelContext`
   and uses the stored profile's numeric `contextWindow` only when the profile's provider/modelId
   match that model (applied verbatim, even 128K); an absent profile, or sentinel or
   legacy-missing profile fields, mean keep the current model's derived context. The target
   always shares provider/modelId with the current model, but `setModel` still runs whenever the
   derived target object differs — the comparison is object identity (`targetModel ===
   currentModel`, `model-selection-lifecycle.ts:254`), so a context-window override, a
   family-thinking copy, or a 128K→256K normalization each force it. A concrete
   profile thinking level survives the model sync and is applied only when the runtime level is
   known (`currentThinkingLevel() !== undefined`) and differs — checked against the pre-read
   level when the target already matches (no read-back in that branch), and re-read after
   `setModel` otherwise; sentinel thinking keeps the runtime level; the catalogue is never
   queried. The thinking check has no provider/modelId-match condition: a mismatched profile's
   concrete thinking level still applies to the current model. The result's `model` is the
   derived target object — the object passed to `setModel`, or the current model when it already
   matched — with no post-`setModel` `ctx.model` read-back (today's sync outcome,
   `model-selection-lifecycle.ts:254-270`). `unchanged` is returned exactly when the target is
   identical to the current model *and* no thinking re-application was needed.
5. Auth failure: `setModel` returning false throws `No configured authentication for
   ${provider}/${modelId}` — but the two legacy strings differ by a trailing period and are
   preserved per path: the apply commit (moved `applyResolvedModelSelection`) throws with the
   period, the `synchronize` commit throws the period-less legacy string. These are two commit
   sites, not one: `synchronize`'s thinking semantics differ from the apply commit's (invariant
   4), so it cannot reuse the apply commit; whether the message comes from one parameterized
   template or two literals is an implementation detail. The period-less spelling is *not* pinned
   by today's tests (see the Problem section), so it is preserved on the behavior-identical rule
   and the new tests pin it exactly (test plan item 7).
6. Persistence runs strictly after the live commit; failure surfaces as
   `ModelSelectionNotSavedError` with the applied selection attached; no rollback. `applyPicked`
   requires the injected saver: with none it throws, and must not `saver?.save(…)` its way to a
   silent no-op persist.
7. Catalogue errors: `ModelReferenceError` with reason `"refresh"` rethrows its raw `cause` (the
   `cause instanceof Error` guard moves verbatim; `resolveModelReference` populates that cause
   from a `ReadonlyMap<string, Error>` (`model-reference.ts:217-225`), so the guard is
   statically always true and its fall-through `throw error` is unreachable in production). All
   other `resolveModelReference` errors — `"invalid"`, `"unavailable"`, `"out-of-scope"`,
   `"aborted"`, `"no-provider"` — propagate unchanged.

Seams and adapters:

- `ModelRuntimeFacts` + `catalogue`: in-process, injected. Production adapter:
  `createPiModelRuntime` (binds `ctx.model`, `pi.getThinkingLevel`/`setThinkingLevel`,
  `pi.setModel`, and `ctx` itself as the `RefreshableModelLookup`). Test adapter: facts fakes in
  `model-selection-runtime.test.ts` (catalogue = the migrated harness's `ctx` fake) and the
  lifecycle tests' runtime fake. Two adapters ⇒ real seam.
- Saver: the existing `ModelSelectionPersistence` satisfies it structurally (one production
  adapter, test fakes) — an existing seam, left as-is.
- Settings document stays behind `model-selection-persistence.ts` (local-substitutable),
  untouched.

### File moves

From `_shared/model-selection.ts` → `_shared/model-selection-runtime.ts`:
`applyModelSelection`, `applyPickedModelSelection`, `applySelectionFromDocument`, private
`resolveStoredSelection`, private `applyResolvedModelSelection`, the `ResolvedModelSelection` /
`ResolvedContextWindow` types, the `ModelSelectionSaver` type, `ModelSelectionNotSavedError`, and
the new `synchronize` (extracted from `synchronizeContext`) + port/factory declarations.

Stays in `_shared/model-selection.ts` (stored-format module): parsing, validation, merging
(`parseProjectModelPreferences`, `mergeProjectModelSelection`, `validateStoredModelSelection`,
`validateConcreteModelSelection`, `usesDefaultSentinel`), the value types
(`ModelSelectionSettings`, `StoredModelSelectionSettings`, `ConcreteModelSelection`,
`ModelSelectionMode`, `ProjectModelPreferences`, `ModelChoiceLike`),
`DEFAULT_CONTEXT_WINDOW`/`PI_DEFAULT_CONTEXT_WINDOW`/`resolveContextWindow`,
`applyFamilyThinkingLevel`/`resolveModelContext`, and `selectionModeFromEntries`/
`currentSelectionMode`. `ModelSelectionSaver` (`model-selection.ts:57`) moves instead — verified
referenced only by `applyPickedModelSelection`'s options today. The private `StoredThinkingLevel`
alias stays in the stored-format module; the runtime module re-derives it locally as
`type StoredThinkingLevel = SupportedModelThinkingLevel` from `model-thinking.ts`.

## Implementation steps

### Step 0 — Baseline

- `pnpm typecheck`, `pnpm test:shared`, `pnpm test:plan`, `pnpm test:profiles`, `pnpm
  test:features` green before any change. (Verified from `package.json`: the ui-model-selector
  suites run under `test:features`; workflows-plan runs under `test:plan` — `test:workflows`
  covers workflows-engine only and is irrelevant to this change.) Baseline confirmed green on
  2026-09-11: `tsc --noEmit` clean; `model-selection`, `model-families` and `ui-model-selector`
  120/120; `workflows-plan` + `config-profiles` 275 passed, 2 skipped.

### Step 1 — Extract the runtime module (no behavior change)

1. Create `_shared/model-selection-runtime.ts` with the interface above; move the three
   functions + private helpers verbatim (the auth-error message is the one non-verbatim line,
   parameterized per path per invariant 5); add the `ModelRuntimeFacts` port, the `catalogue`
   (`RefreshableModelLookup`) injection, `createModelSelectionRuntime`, `createPiModelRuntime`,
   and `synchronize` extracted from `synchronizeContext`'s rule block (target computation +
   commit), with the sync invariants documented.
2. `_shared/model-selection.ts` drops the moved exports and re-exports nothing new; its header
   comment rewritten to "stored format + normalization".
3. Re-point every importer of the moved symbols — `pnpm typecheck` includes the test files
   (`tsconfig.json` has `extensions/**/*.ts` in `include`), so this must be complete before Step
   1 can go green: `ui-model-selector/index.ts` (`applyModelSelection`,
   `applyPickedModelSelection`), `workflows-plan/plan-profile-transition.ts`
   (`applyModelSelection`), `config-profiles/index.ts` (`applySelectionFromDocument`),
   `ui-model-selector/model-selection-lifecycle.ts` (`ModelSelectionNotSavedError`),
   `ui-model-selector/model-selection-lifecycle.test.ts` (`ModelSelectionNotSavedError`), and
   `workflows-plan/plan-profile-transition.test.ts` (`applyModelSelection` import plus its
   `vi.mock("../_shared/model-selection.ts", …)` target, which becomes the runtime module).
   `model-selection-persistence.ts`, `model-picker.ts`, `tools-advisor/*`,
   `policy-permissions/index.ts`, `workflows-plan/model-profile.ts`, `plan-lifecycle.ts` (+
   `plan-lifecycle.test.ts`), `profile-transition-lifecycle.ts` (+ its test), and
   `model-families.test.ts` are untouched (types + pure normalizers did not move).
   `ui-model-selector/index.test.ts` needs no edit either — it drives the real extension through
   `pi`/`ctx` fakes instead of importing the moved symbols, which makes it the end-to-end guard
   for Step 2's rewiring.
4. Move the runtime-commit describe blocks from `_shared/model-selection.test.ts` to
   `_shared/model-selection-runtime.test.ts` — `applyModelSelection` (lines 288-445, 11 tests),
   `applyPickedModelSelection` (447-639, 9 tests), `applySelectionFromDocument` (641-748,
   7 tests) — retargeted at `createModelSelectionRuntime` with a facts-port fake built from the
   existing harness pieces (`setModel`, `setThinkingLevel`, `ctx.model`) and the harness `ctx`
   itself as the injected `catalogue` (it already carries `modelRegistry` + `scopedModels`); keep
   every scenario assertion. The `applySelectionFromDocument` describe block moves to the new
   test file too (test-plan item 11 lives there) but keeps exercising the Pi-bound convenience —
   its mode detection is binding glue, not port-testable — so `_shared/model-selection.test.ts`
   retains no imports of moved symbols and needs no entry in the re-point list above.
   Fixture split, verified by usage: `NORMAL_SELECTION` (18-23), `PLAN_SELECTION` (25-30), the
   `CatalogueModel` type and `createHarness` (236-286) are referenced only by the moving blocks
   and move with them; `planModel` and `profileFor` (32-42) are used by the staying "selection
   validators" block and must stay. The staying blocks use no `vi.*`, so drop the now-unused `vi`
   import. Add the `synchronize` tests migrated from the lifecycle (below).
5. Verify: `pnpm typecheck` + `pnpm test:shared` + `pnpm test:plan` + `pnpm test:profiles` +
   `pnpm test:features`.

### Step 2 — Rewire the lifecycle, shrink the adapter

1. `ui-model-selector/index.ts`: construct `createPiModelRuntime(pi, ctx, { saver: persistence })`
   once per Session init (beside the adapter, `index.ts:155-157`); drop `setModel`,
   `setThinkingLevel`, `applyStoredSelection`, `applyPickedSelection` from the lifecycle adapter
   (12 → 8 methods); pass the runtime to `createModelSelectionLifecycle({ adapter, runtime })`.
   That turns the exported factory's positional `adapter` parameter into one object, so both
   construction sites move: `index.ts:155` and `createHarness` at
   `model-selection-lifecycle.test.ts:113` (the suite's only construction site).
2. `model-selection-lifecycle.ts`: delete `synchronizeContext`'s rule block — that is line 236
   (`resolveModelContext`) and lines 238-270, **not** 237. Lines 232-234 (the
   `adapter.getRuntimeState()` read and the `no-current-model` guard) and line 237
   (`adapter.loadSelection(input.mode)`, deliberately *not* wrapped in try/catch, so a load
   failure still rejects the operation, unlike the picker path) stay. Then call
   `runtime.synchronize(currentModel, profile)` and map the result to lifecycle outcomes:
   `unchanged` → `{kind: "unchanged", reason: "context-current"}` (the only unchanged reason the
   runtime's result maps to; `no-current-model` still comes from the lifecycle's own guard,
   before the profile load — `model-selection-lifecycle.test.ts:321-326` pins that `loadSelection`
   is never reached); `synchronized` → `{kind: "context-synchronized", model: result.model}`.
   Startup path → `runtime.applyStored(normalProfile, { label: "Normal profile" })`. Picked path
   → `runtime.applyPicked(picked.model, picked.thinkingLevel, { mode: input.mode })` — today's
   adapter already discards `picked.contextWindow`, which is redundant with
   `picked.model.contextWindow` (`model-picker.ts:285-289`), so this is shape-preserving — keeping
   the `ModelSelectionNotSavedError` catch and compaction policy. `resolveModelContext` becomes
   unused in the lifecycle (its only call site was line 236): drop that import, leaving
   `DEFAULT_SENTINEL` (still used by `pickerPreviousSelection`) and `ModelSelectionNotSavedError`
   (now imported from the runtime module). Lifecycle keeps: session initialization decisions,
   picker flow, reduction confirmation, compaction, outcomes, disposal draining.
3. Replace, don't layer, in tests:
   - `model-selection-lifecycle.test.ts`: seven sync rule tests move to
     `model-selection-runtime.test.ts` — lines 226-320 (verbatim 128K; sentinel→256K
     normalization; thinking survives `setModel`; thinking re-applied when the model already
     matches; sentinel thinking keeps the runtime level; mismatched-profile context ignored) plus
     327-334 (the auth message). Lines 321-326 ("returns no-current-model without loading
     preferences") must **stay** — that guard stays lifecycle-side. The lifecycle keeps delegation
     + outcome-mapping tests; the duplicated rule assertions are deleted (DEEPENING.md: old tests
     on shallow copies become waste once interface tests exist). Migration total: 27 tests out of
     `_shared/model-selection.test.ts` + 7 out of the lifecycle suite = 34.
   - The lifecycle runtime fake implements the narrow `ModelSelectionRuntime` (3 methods) —
     simpler than today's choreography fakes.
4. Verify: `pnpm typecheck` + `pnpm test:features` + `pnpm test:plan` + `pnpm test:profiles`.

### Step 3 — CONTEXT.md entry

Add under Settings & profiles, after the "Model-selection persistence" entry (CONTEXT.md:223-225,
 i.e. insert at line 226) — which keeps the section's alphabetical ordering:

> - **Model-selection runtime** — the deep in-process module in
>   `_shared/model-selection-runtime.ts` that owns the stored→runtime mapping: sentinel
>   resolution against Pi native defaults, the Model reference lookup, the verbatim
>   context-window contract (stored numeric windows commit verbatim; 128K→256K normalization
>   reaches only catalogue-resolved models on the apply path and the current model on the sync
>   path), thinking survival across `setModel`, the commit ordering and its read-back, the sync
>   path (reconcile the current model with a stored profile without changing provider/modelId or
>   touching the catalogue), and the no-auth error mode. Model-selection lifecycle decides when
>   to apply or synchronize and owns outcome semantics; Model-selection persistence stays the
>   Settings document seam.

The "Model-selection lifecycle" entry (CONTEXT.md:218-222) describes policy only — operation
admission, disposal draining, initialization decisions, picker ordering, persistence outcomes,
compaction — and names none of the moved sync rules, so it stays unchanged (verified 2026-09).

### Step 4 — Full verification

- `pnpm typecheck`
- `pnpm test` (full suite)
- Manual smoke (optional): `/model` picker apply, startup profile apply, `/plan` enter/exit
  model application, profile switch apply.

## Test plan (new surface)

`_shared/model-selection-runtime.test.ts` — facts-port fake plus the migrated harness `ctx` fake
as the injected `catalogue`, so `resolveModelReference` runs for real; scenarios:

1. applyStored: same-model fast path (no `setModel`, no catalogue refresh).
2. applyStored: verbatim stored window, including a 128K stored window (not rewritten).
3. applyStored: `default` sentinel context resolves through the catalogue (256K normalization).
4. applyStored: legacy missing window inherits the current model's window.
5. applyStored: different model → catalogue lookup with refresh; `ModelReferenceError("refresh")`
   rethrows its raw cause; every other `resolveModelReference` failure propagates unchanged —
   migrate both existing cases (out-of-scope, `model-selection.test.ts:385`; refresh aborted,
   `:396`), not only the rethrow.
6. applyStored: sentinel fields resolve through injected `nativeDefaults`, else
   `readPiNativeDefaults`; sentinel thinking falls back to the current runtime level, then
   `"medium"`; an out-of-vocabulary defaultThinkingLevel throws.
7. commit: `setModel` false → the path's auth message (apply path with trailing period;
   `synchronize` without — invariant 5). Assert the **exact** message — compare
   `(error as Error).message` with `toBe`, or pass an `Error`/anchored regex to `toThrow`:
   `toThrow("…/model")` is a substring match and cannot distinguish the two spellings, which is
   why the period-less one is unpinned today.
8. commit: thinking re-applied when pi's effective level differs after `setModel`; read-back
   level returned.
9. applyPicked: persists after commit; save failure → `ModelSelectionNotSavedError` with
   applied selection; no rollback.
10. synchronize: verbatim explicit window; sentinel window → normalized current window;
    concrete thinking survives; sentinel thinking = keep runtime level; profile for another
    model → the current model kept; with matching or sentinel thinking the outcome is
    `unchanged` (the migrated test's case — lifecycle maps to `context-current`), while a
    differing concrete profile thinking level still applies and a 128K current model still
    normalizes via `setModel` (invariant 4); `setModel` false → the period-less
    auth message; unknown runtime level → profile thinking not applied; never queries the
    catalogue.
11. applySelectionFromDocument, all seven migrated cases, exercised through the Pi-bound
    convenience: normal selection applied and returned; plan selection applied when plan mode is
    active (mode detection from branch entries); an all-sentinel selection resolved through
    injected native defaults; no selection for the mode → `undefined` with no apply; same model
    but a differing window still applies; unavailable model → `"Profile"`-labeled error; no
    configured authentication → the period-ful auth message.

`model-selection-lifecycle.test.ts` (shrunk): session policy only — startup selector decision,
bypass reasons, picker flow sequencing, reduction confirmation, compaction policy, disposal
draining, SessionClosed. Its remaining sync tests assert delegation and outcome mapping plus the
two policy facts that never moved: which session reasons trigger a sync at all (lines 167-183)
and the `no-current-model` short-circuit that skips the profile load (321-326).

## Risks and edge cases

- **Byte-identical behavior**: same error strings (both legacy auth spellings preserved per
  path — invariant 5), same ordering (notice-after-apply in profile transitions is unaffected —
  that ordering lives in `profile-transition-lifecycle.ts`, untouched), same fast paths, same
  `typeof pi.getThinkingLevel` guards — they move into the port's Pi binding, which must return
  `undefined` when the function is absent. That `undefined` is load-bearing twice: it makes
  `currentThinkingLevel() !== requested` true (so `setThinkingLevel` still fires) and makes the
  post-commit read-back fall back to the requested level. Existing fakes omit `getThinkingLevel`
  (`model-selection.test.ts:274`), so a binding written as
  `currentThinkingLevel: () => pi.getThinkingLevel()` would crash them.
- **`synchronize` subtleties preserved**: it never changes provider/modelId (derived target
  shares both with the current model) but does call `setModel` whenever the derived target
  object differs by identity (context-window override, family-thinking copy, or 128K→256K
  normalization), never queries the catalogue, and treats absent or sentinel profile fields as
  "keep current"; thinking is applied only when the runtime level is known — the module
  documents this; no behavior change. Taking `currentModel` as a parameter rather than re-reading
  it through the port is what keeps that exact: the single read stays where it is today, before
  the profile load, so a model change across that await cannot make the runtime reconcile a
  different object than the one the lifecycle guarded.
- **Extension loader module copies**: each extension loads its own copy of `_shared` modules
  (CONTEXT.md:60); the runtime module holds no global state (pure functions over injected facts),
  so per-copy instances are safe. No `globalThis` registry is added — unlike `editor-slot.ts:76`,
  nothing here needs cross-copy identity.
- **Test churn is deliberate**: migrating rule tests out of the lifecycle suite is the
  replace-don't-layer payoff; the lifecycle suite shrinks to policy and sequencing.
- **Rollback plan**: each commit is independently green; Step 1 and Step 2 revert separately.

## Explicitly out of scope

- `tools-subagents` `targetSelection` per-screen resolution and the picker's decorated-string
  value/label encoding (review candidates 6).
- Profile-apply suppression seam (candidate 2), Mode vocabulary derivation (candidate 3),
  Profile transition pass-through collapse (candidate 4).
- Moving `selectionModeFromEntries`/`currentSelectionMode` out of the stored-format module.
- Any behavior change: new features, new error modes, changed notices.
