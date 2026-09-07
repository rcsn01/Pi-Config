# plan.md — Deepen the model-reference seam

Architecture-review candidate **#1** (Strong), finalized 2026-09-07. The user
opted to have every grilling question answered with the recommended default;
those decisions are recorded in §2 and are binding for the implementation.

---

## 1. Problem (from the architecture review)

"Resolve a model reference" is one concept with **six resolution sites and
four parsing vocabularies**:

| Site | Input shape | Registry face | Scope check | Refresh |
|---|---|---|---|---|
| `_shared/model-selection.ts` `resolveProfileModel` (:341) | structured `{provider, modelId}` | `ctx.modelRegistry` | ✅ enforce | ✅ `allowNetwork:false, [provider]` |
| `tools-advisor/runner.ts` `resolveConfiguredModel` (:106) | flat `"provider/model"` | `ctx.modelRegistry` | ✅ enforce | ❌ |
| `tools-advisor/index.ts` `resolveOptionalModel` (:305) + `splitModel` (:128) | flat string | `ctx.modelRegistry` | ❌ silently skipped | ❌ |
| `policy-permissions/guardian-runner.ts` `resolveGuardianModel` (:244) | guardian.md spec, bare-id fallback | isolated `ModelRuntime.getModel` | ❌ n/a | ❌ |
| `tools-subagents/model-commands.ts` `findCatalogueModel` (:382) | setting string (`main` → observed main model) | `ctx.modelRegistry` | ❌ silently skipped | ❌ |
| `policy-permissions/index.ts` (~:229, `/guardian` picker seeding) | structured settings | `ctx.modelRegistry` | ❌ silently skipped | ❌ |

Secondary duplication:

- **Pi-native defaults access, 3 implementations.** `_shared/pi-defaults.ts`
  owns the read; `workflows-plan/model-profile.ts` `createNormalDefaultsStore`
  re-issues `SettingsManager` for capture *and* hand-rolls the write
  (`setDefaultModelAndProvider` + `setDefaultThinkingLevel` + `flush` +
  `drainErrors`); `guardian-runner.ts` re-derives the default provider.
- **Thinking-level validation: 4 hand-rolled user-input membership checks** of
  `MODEL_THINKING_LEVELS` with divergent error text: advisor
  (`optionalThinkingLevel`), guardian-settings, subagents
  (`normalizeThinkingLevel`), model-selection (`validateStoredThinkingLevel`).
  Two further membership guards inside model-selection
  (`mergeProjectModelSelection`'s write guard and `resolveStoredSelection`'s
  Pi-native-defaults check) validate already-typed values with
  selection-specific text; they are internal type guards, not user-input
  validation, and stay in the selection domain.
- **Context-window validation, 2 hand-rolled duplicates** (`model-selection.ts`
  private `validateContextWindow`, `tools-subagents/config.ts`
  `validateContextWindow`); three further inline positive-integer guards
  (`mergeProjectModelSelection`, `model-selection-persistence.ts`,
  `guardian-settings.ts`) are merge/persistence/domain assertions and stay.
- **Model-reference parsing, 4 vocabularies**: picker `findExactModel`
  (list match), advisor slash-split, subagents
  `normalizeModelSetting`/`splitModelThinkingSetting` (strict, `main` symbolic,
  `:thinking` suffix), guardian slash-split + bare-id fallback.

The scoped-models invariant is enforced at only 2 of the 5 ctx-backed
resolution sites (model-selection, advisor runner) and **silently skipped by
the other 3**; the picker reads `ctx.scopedModels` too, but as its catalogue
source, not as a check — a latent inconsistency, not just style.

## 2. Grilling record — decisions (recommended answers, binding)

1. **Where does the seam go?** → New deep module
   `_shared/model-reference.ts`. `_shared/model-selection.ts` stays the
   *selection* domain (stored selections, sentinels, apply/commit,
   persistence); it delegates reference parse/resolve. Rationale: selection
   meaning and reference resolution are different concepts; growing
   model-selection.ts toward a god module would trade one locality problem for
   another.
2. **What sits behind the seam?** → Reference parsing vocabulary, resolution
   against a model lookup (with refresh/scope policies), typed resolution
   errors, and shared context-window validation. Plus two sibling
   consolidations with existing homes: thinking-level validation moves into
   `model-thinking.ts` (it already owns the closed vocabulary);
   Pi-native-defaults **write** and provider-only **read** move into
   `pi-defaults.ts` (it already owns the read).
3. **What stays outside?** → Per-domain settings documents (advisor, guardian,
   subagent namespaces keep owning their settings meaning and error text), the
   Subagent assignment resolution module (owns `main` symbolism, precedence,
   legacy migration), Model-selection lifecycle and persistence, the picker
   TUI flow, and Plan's `NormalDefaultsStore` capture policy (partial-read
   fallback semantics are plan-specific). `findExactModel` in model-picker.ts
   stays — it is list-matching, not string parsing.
4. **Dependency category?** → In-process. Registry access is injected as a
   structural `RefreshableModelLookup`; `ctx` satisfies it directly, guardian
   adapts its `ModelRuntime` with a 2-line adapter. Two adapters exist ⇒ real
   seam. Pi settings access stays behind `pi-defaults.ts` (agentDir injectable
   — already an internal seam for tests).
5. **Error mode?** → `resolveModelReference` throws one typed
   `ModelReferenceError` (`reason: "invalid" | "unavailable" | "out-of-scope" |
   "aborted" | "refresh" | "no-provider"`). Adapters catch and render their own
   user-facing text (the advisor-outcome pattern). `optional: true` resolves
   `"unavailable"`/`"out-of-scope"` to `undefined` for best-effort callers;
   `"invalid"`, `"no-provider"`, `"aborted"`, and `"refresh"` always throw,
   even under `optional` (no current optional caller can produce them, but the
   rule is pinned). Refresh abort/errors always throw regardless.
6. **Scope policy?** → Default `"enforce"`. Explicit `"ignore"` at exactly
   three call sites, each with a comment stating why: advisor picker-seeding
   (marks a stored previous choice that may be out of current scope), subagents
   catalogue fallback (the child Pi process enforces scope/auth at launch), and
   `/guardian` picker-seeding (same as advisor). The invariant becomes
   *declared once and explicitly waived where legitimate* instead of silently
   divergent. No current behavior changes.
7. **Do we unify the two "inherit" vocabularies** (subagents `main` vs
   selection `default` sentinel)? → **No.** They resolve against genuinely
   different sources (observed live Main model vs Pi native defaults); each
   domain keeps its symbolic handling. YAGNI.
8. **Error-text unification?** → Shared parse/validation errors get one
   message form (`${label} must be "provider/model[:thinking]".` /
   thinking-level list form). Domain-specific texts survive where the domain
   re-renders (subagents config catches typed errors and re-throws its own
   text; advisor/guardian catch and render). Direct assertions in
   `config.test.ts` and the guardian tests stay green — the texts are
   re-rendered or re-thrown, not unified; only new pinning tests are added
   (§6).
9. **Interface explored three ways (design-it-twice):**
   - *A. Single `resolveModelRef(ctx, ref, opts)`* — max leverage per entry
     point, but parsing/defaults don't need a registry; forces a wide options
     object and fake `ctx` into pure-parse tests. Rejected.
   - *B. Three-function reference module + extended defaults module* —
     **chosen**: `parseModelReference` (pure), `resolveModelReference(lookup,
     ref, opts)`, `validateContextWindow`; thinking validation in
     `model-thinking.ts`; defaults read+write in `pi-defaults.ts`. Interface ≈
     4 exports + 2 extended seams.
   - *C. One selection-store facade object* — overlaps Model-selection
     persistence, Model-selection lifecycle, and the Subagent assignment store;
     wide shallow interface (that is candidate #2's territory). Rejected.

## 3. The interface

```ts
// _shared/model-reference.ts — the deep module (new)

import type { Model } from "@earendil-works/pi-ai";
import type { SupportedModelThinkingLevel } from "./model-thinking.ts";

/** One parsed model reference. Symbolic vocabularies ("main", "default")
 *  stay domain-owned; callers resolve them before or after parsing. */
export type ParsedModelReference =
  | { kind: "qualified"; provider: string; modelId: string;
      thinkingLevel?: SupportedModelThinkingLevel }
  | { kind: "bare-id"; modelId: string };

/** Structural registry face: ExtensionContext satisfies it directly, because
 *  `find`/`refresh` are nested under `modelRegistry` here (not flat), matching
 *  ExtensionContext's actual shape — it has no top-level `find`/`refresh` of
 *  its own, only `ctx.modelRegistry.find`/`.refresh`, while `scopedModels` is
 *  flat on ctx. A flat `find`/`refresh` here would make `ctx` fail structural
 *  assignment, and the obvious compile-driven fix (passing `ctx.modelRegistry`
 *  instead of `ctx`) would silently drop `scopedModels` and disable scope
 *  enforcement — the exact invariant this module exists to make consistent.
 *  Guardian adapts ModelRuntime to it inline (find only; no refresh, no
 *  scopedModels — ModelRuntime has neither concept). */
export interface RefreshableModelLookup {
  modelRegistry: {
    find(provider: string, modelId: string): Model<any> | undefined;
    refresh?(options: { allowNetwork: false; providers: [string] }): Promise<{
      aborted: boolean; errors: ReadonlyMap<string, Error>;
    }>;
    // ReadonlyMap, not Map: ModelRegistry.refresh returns ModelsRefreshResult
    // whose errors is a ReadonlyMap; declaring Map fails structural assignment.
  };
  /** Present-but-empty means "no scoping configured" and must NOT enforce —
   *  ExtensionContext.scopedModels is always a defined array, empty when the
   *  session has no `--models`/`enabledModels` restriction. Enforcement keys
   *  on non-empty, exactly like today's `ctx.scopedModels.length > 0 &&
   *  !ctx.scopedModels.some(...)` at every existing site (model-selection.ts
   *  resolveProfileModel, advisor runner.ts resolveConfiguredModel). Treating
   *  "declares scopedModels" as merely non-undefined would make every
   *  ctx-backed resolveModelReference call enforce scope unconditionally,
   *  and an empty array would then fail `.some(...)` for every model —
   *  breaking model resolution for any user without scoping configured. */
  readonly scopedModels?: readonly { model: { provider: string; id: string } }[];
}

export class ModelReferenceError extends Error {
  readonly reason: "invalid" | "unavailable" | "out-of-scope"
    | "aborted" | "refresh" | "no-provider";
  readonly label?: string;
  readonly provider?: string;
  readonly modelId?: string;
  readonly cause?: unknown;
}

export interface ModelReferenceOptions {
  /** Error-message prefix, e.g. "Advisor model", "Plan Mode profile". */
  label?: string;
  /** Accept "provider/model:thinking". Default false. */
  allowThinkingSuffix?: boolean;
  /** Accept a bare id (resolution needs bareIdFallback). Default false. */
  allowBareId?: boolean;
  /** Default "enforce" when the lookup's scopedModels is present AND
   *  non-empty (see RefreshableModelLookup.scopedModels); present-but-empty
   *  never enforces. */
  scope?: "enforce" | "ignore";
  /** Refresh the provider before lookup. Default false. */
  refresh?: boolean;
  /** For bare ids: supply a provider, or undefined to fail "no-provider".
   *  Sync or async — guardian's readDefaultProvider() is synchronous; the
   *  caller `await`s the result either way. */
  bareIdFallback?: (modelId: string) => string | undefined | Promise<string | undefined>;
  /** Resolve "unavailable"/"out-of-scope" to undefined. Default false. */
  optional?: boolean;
}

/** Parse-relevant subset of ModelReferenceOptions. */
export interface ModelReferenceParseOptions {
  label?: string;
  allowThinkingSuffix?: boolean;
  allowBareId?: boolean;
}

/** Parse a qualified or bare-id reference; throws ModelReferenceError("invalid"). */
export function parseModelReference(
  value: string, options?: ModelReferenceParseOptions,
): ParsedModelReference;

/** Parse (when string) and resolve against the lookup. */
export async function resolveModelReference(
  lookup: RefreshableModelLookup,
  reference: string | { provider: string; modelId: string },
  options?: ModelReferenceOptions,
): Promise<Model<any> | undefined>;

/** Shared positive-integer context-window validation. */
export function validateContextWindow(value: unknown, label?: string): number;
```

```ts
// _shared/model-thinking.ts — +1 export
export function normalizeThinkingLevel(
  value: unknown, options: { label: string },
): ModelThinkingLevel;   // trims, lowercases, membership; throws
// `${label} must be one of: off, minimal, low, medium, high, xhigh, max.`
```

```ts
// _shared/pi-defaults.ts — +2 exports
export function readDefaultProvider(agentDir?: string): string | undefined;
export async function writePiNativeDefaults(
  agentDir: string | undefined,
  defaults: { provider: string; modelId: string; thinkingLevel?: string },
): Promise<void>;   // setDefaultModelAndProvider + setDefaultThinkingLevel
                    // + flush + drainErrors → throws the joined drainErrors
                    // message on error; the caller rewraps with its own prefix
                    // (global-scope write, cwd-independent — hence no cwd
                    // parameter; SettingsManager.create(process.cwd(), …))
```

Parsing semantics (lift verbatim where noted):
- First `/` splits provider/modelId (modelId may contain further `/`); leading
  or trailing `/`, whitespace, or empty segments are invalid.
- Colons: lift `tools-subagents/config.ts` `THINKING_SUFFIX_PATTERN` verbatim
  (including its `i` flag; an extracted level is lowercased). A suffix is
  recognized **only** when the segment after the last `:` is a valid
  `MODEL_THINKING_LEVELS` member. Any other colon is part of the model id —
  pi-ai models may carry colon-suffixed ids (e.g. OpenRouter's
  `deepseek-r1:free`), and today's advisor runner, guardian, and
  catalogue-fallback sites pass those ids to the registry untouched. With
  `allowThinkingSuffix: false` a *matched* suffix is not extracted either: the
  whole `model:level` stays the model id, reproducing today's raw pass-through
  at those sites.
- Bare id only when `allowBareId`; whitespace still rejected.
- Deliberate behavior change: guardian's current lenient `"/id"` (empty
  provider) now parses as invalid instead of silently falling back to the
  default provider.
- **Not tightened** (checked and rejected as a false lead): subagents'
  `normalizeModelSetting` currently accepts `provider/model:turbo` (an invalid
  suffix level) by silently keeping it in the model id — garbage that only
  fails later at the child launch. It is tempting to call this a second
  tightening symmetric with guardian's `"/id"` case, but the Colons rule above
  already forecloses it: `THINKING_SUFFIX_PATTERN` does not distinguish "an
  attempted but misspelled level" from "a legitimately non-level colon
  suffix" — `provider/model:turbo` and `openrouter/deepseek-r1:free` both fail
  the level-alternation match identically (verified: neither matches the
  lifted regex), so both stay in the model id whether or not
  `allowThinkingSuffix` is set. The delegation therefore reproduces today's
  pass-through unchanged; there is no config-parse-time rejection to pin.
  Phase 4's pinning test asserts the pass-through, not a rejection.

## 4. Caller migration table (file → disposition)

| File | Current | After |
|---|---|---|
| `_shared/model-selection.ts` | private `resolveProfileModel` | deleted; `applyModelSelection` calls `resolveModelReference(ctx, {provider, modelId}, {label, refresh: true})`; refresh-abort/error text preserved |
| `_shared/model-selection.ts` | private `validateContextWindow` | deleted; delegates to `model-reference.ts` |
| `_shared/model-selection.ts` | `validateStoredThinkingLevel`, `mergeProjectModelSelection` write-guard, `resolveStoredSelection` native-defaults check | **stay**: sentinel-aware / typed-internal with selection-specific text (`thinkingLevel is not supported.`, pinned by model-selection.test.ts); `model-thinking` owns user-input validation only |
| `tools-advisor/runner.ts` | `resolveConfiguredModel` | deleted; `execute` calls `resolveModelReference(ctx, settings.model, {label: "Advisor model"})`, catches → `advisorFailure("Configured advisor model … is unavailable.")` (text unchanged) |
| `tools-advisor/index.ts` | `splitModel`, `resolveOptionalModel` | deleted; picker seeding uses `parseModelReference`/`resolveModelReference(..., {optional: true, scope: "ignore"})` + `resolveModelContext` |
| `tools-advisor/index.ts` | `optionalThinkingLevel` | body delegates to `normalizeThinkingLevel`, catch → re-throw the advisor sentence (text unchanged; no test pins it) |
| `tools-advisor/index.ts` | `formatAdvisorStatus` `indexOf("/")` | **unchanged** — display-only shortening of an already-stored reference for the status line, not parsing; carving it out keeps the §8 grep honest (it renders the full string when there is no slash; a parse-based rewrite would change that) |
| `policy-permissions/index.ts` | raw `find` for `/guardian` picker seeding | `resolveModelReference(..., {optional: true, scope: "ignore"})`; the surrounding `resolveModelContext` wrap stays |
| `policy-permissions/guardian-runner.ts` | `resolveGuardianModel` | rewritten as a small adapter: runtime lookup adapter `{modelRegistry: {find: (p, id) => runtime.getModel(p, id)}}` (nested under `modelRegistry` per the `RefreshableModelLookup` shape — `ModelRuntime` has no refresh or scopedModels, both stay absent, so scope stays n/a), `allowBareId: true`, `bareIdFallback: () => readDefaultProvider(...)`, catch renders three guardian texts by `reason`: `unavailable` and `no-provider` keep their existing sentences; `invalid` is new (see Phase 3) and gets its own sentence since there is no prior text to preserve |
| `policy-permissions/guardian-settings.ts` | inline thinking check | `normalizeThinkingLevel(value, {label: "guardian.thinkingLevel"})`, catch → re-throw the guardian sentence (test asserts `/thinkingLevel/`, stays green either way; re-throw keeps the user-facing text) |
| `tools-subagents/config.ts` | `normalizeModelSetting` qualified branch; `splitModelThinkingSetting`; `normalizeThinkingLevel` body; `validateContextWindow` | keep exports + domain error text (catch typed error → re-throw subagent text); bodies delegate to `parseModelReference` (`allowThinkingSuffix: true` — stored settings may legitimately carry the suffix; without it the pinned `openai/explicit:high` cases would newly throw) / `normalizeThinkingLevel` / `validateContextWindow` (shared throws `` `${label} must be a positive integer.` ``; pass the `Subagent ${label}` prefix so config.test.ts stays green); the `normalizeModelSetting` delegation reconstructs `provider/model` + `:level` so the returned setting keeps its suffix (pinned by the `openai/global:high` edit test); `THINKING_SUFFIX_PATTERN` moves into `model-reference.ts` |
| `tools-subagents/model-commands.ts` | `findCatalogueModel` slash fallback | list-match stays; fallback becomes `resolveModelReference(ctx, target, {optional: true, scope: "ignore"})` after `main` resolution (unchanged) |
| `workflows-plan/model-profile.ts` | `createNormalDefaultsStore().restore` hand-rolls write | body becomes `writePiNativeDefaults(agentDir, …)`; restore catches the shared error and rewraps `Could not restore Pi's normal defaults: …` (text unchanged); `capture` stays (plan-specific partial-read fallback) |
| `_shared/model-picker.ts` | `findExactModel`, `listSelectableModels` | **unchanged** (list-matching is picker concern) |
| `_shared/model-thinking.ts` | vocabulary only | + `normalizeThinkingLevel` |
| `_shared/pi-defaults.ts` | read only | + `readDefaultProvider`, `writePiNativeDefaults` |

Not touched (explicitly out of scope): the SubagentConfigStore interface shape
(candidate #2), `selectionModeFromEntries`, `applyModelSelection` commit
semantics, `ModelSelectionPersistence`, the model-picker TUI, Plan Mode
lifecycle seams (candidate #3), Profile deletion routing (candidate #4).

## 5. Phases (each ends green: `pnpm typecheck` + targeted suites)

**Phase 0 — CONTEXT.md.** Add under *Settings & profiles* (before
"Model-selection lifecycle"):

> **Model reference** — one designation of a model in qualified (`provider/model`),
> bare-id, or `provider/model:thinking` shape. The Model reference module in
> `_shared/model-reference.ts` owns parsing, resolution against a model lookup
> with refresh and the scoped-models invariant (default enforce, explicitly
> waivable), typed resolution errors, and shared context-window validation;
> adapters render their own error text. Symbolic vocabularies (`main`,
> `default` sentinels) stay domain-owned. Pi-native-defaults read/write live in
> `pi-defaults.ts`.

Amend the *Settings & profiles* intro sentence for model-thinking/pi-defaults
ownership only if the wording above conflicts. No other CONTEXT.md changes.

**Phase 1 — introduce the module (no callers).**
- Write `_shared/model-reference.ts` per §3 (lift `THINKING_SUFFIX_PATTERN`
  from `tools-subagents/config.ts`).
- Write `_shared/model-reference.test.ts`: parse matrix (qualified, bare-id,
  `:thinking` suffix, non-level colon ids like `deepseek-r1:free` staying in
  the model id, matched-suffix extraction only under `allowThinkingSuffix`,
  whitespace, empty/leading/trailing segment, invalid suffix level, labels in
  errors) and resolve matrix (scope enforce/ignore ×
  scopedModels absent / present-and-empty / present-and-non-empty — the
  present-and-empty case must NOT enforce, matching today's
  `ctx.scopedModels.length > 0` guard; this is the case the default test
  harness hits since `createHarness`'s `scopedModels` defaults to `[]` — a
  naive "enforce whenever declared" reading would fail nearly every existing
  `applyModelSelection` test), refresh success/abort/error propagation,
  `optional`, `bareIdFallback` hit/miss → "no-provider", structured input,
  error `reason`/fields). Reuse the fake-ctx pattern from
  `model-selection.test.ts` `createHarness` (:220).
- Extend `model-thinking.ts` with `normalizeThinkingLevel` +
  tests in `model-thinking.test.ts`.
- Extend `pi-defaults.ts` with `readDefaultProvider`, `writePiNativeDefaults`
  + tests (temp agentDir, following existing `pi-defaults.test.ts` injection).
- Verify: `cd .pi && pnpm typecheck && pnpm test:shared`.

**Phase 2 — `_shared/model-selection.ts` delegates (deep core first).**
- `resolveProfileModel` body → `resolveModelReference(ctx, {provider, modelId},
  {label, refresh: true})`; delete the private function; keep error text
  (`${label} model ${p}/${m} is unavailable.` /
  `… is outside this session's model scope.` / `Refreshing ${p} was aborted.`)
  by constructing it from `reason` — no adapter-visible change. For the
  `"refresh"` reason, re-throw the `cause` so the raw provider error (message
  and identity) survives exactly as today's raw re-throw.
- Swap private `validateContextWindow` for the shared one.
- `model-selection.test.ts` survives unchanged (interface-level tests);
  out-of-scope is already asserted; add a refresh-abort assertion (missing).
- Verify: `pnpm test:shared && pnpm test:profiles && pnpm test:plan && pnpm
  test:features` (config-profiles, plan, ui-model-selector consume it).

**Phase 3 — advisor + policy-permissions migrate.**
- `tools-advisor/runner.ts`: delete `resolveConfiguredModel`; call the module;
  catch → `advisorFailure` with the existing sentence. Runner tests: the
  out-of-scope case already exists (`does not run when disabled, unavailable,
  unauthenticated, or outside scope`) and stays green; keep unavailable case.
- `tools-advisor/index.ts`: delete `splitModel`/`resolveOptionalModel`; picker
  seeding via `parseModelReference` in try/catch (garbage → no previous
  selection, preserving `{}` semantics) and `resolveModelReference(...,
  {optional: true, scope: "ignore"})`.
- `policy-permissions/index.ts` `/guardian` seeding: same optional pattern.
- `guardian-settings.ts`: thinking check → `normalizeThinkingLevel`, catch →
  re-throw the guardian sentence (per §4).
- `guardian-runner.ts`: rewrite `resolveGuardianModel` over the module (lookup
  adapter + `readDefaultProvider` fallback); map `reason` → three guardian
  sentences. `"unavailable"` and `"no-provider"` keep their existing texts
  (the `"unavailable"` text needs the resolved provider, which the error's
  `provider`/`modelId` fields carry). `"invalid"` is newly reachable — the
  `"/id"` tightening below turns what was a silent fallback into a parse
  failure — and has no prior text to preserve, so render a third sentence in
  the same style: `` guardian model "${spec}" is not a valid model
  reference. `` (the adapter still has `spec` in closure; it does not need to
  come off the error). Add a new pinning test for the `"/id"` tightening
  asserting exactly that text — no existing test covers `resolveGuardianModel`'s
  lenient empty-provider fallback, so this is an addition, not an edit.
- Verify: `pnpm test:advisor && pnpm test:safety`.

**Phase 4 — tools-subagents migrate.**
- `config.ts`: `normalizeModelSetting` (main/legacy branch stays) delegates the
  qualified branch to `parseModelReference` with `allowThinkingSuffix: true`,
  reconstructing `provider/model` + `:level` so the returned setting keeps its
  suffix, catching `ModelReferenceError` and re-throwing the subagent text —
  **config.test.ts assertions unchanged** (the pinned `openai/explicit:high`
  cases prove the suffix path). Add one pinning test proving
  `provider/model:turbo` still passes through unchanged (not a tightening —
  see §3) and one for a colon id (`openrouter/deepseek-r1:free`) still parsing
  as a plain model; both exercise the same unmatched-colon-stays-in-the-id
  path and are expected to have identical (non-throwing) outcomes.
  `splitModelThinkingSetting` delegates (suffix regex now imported);
  `normalizeThinkingLevel` delegates to `model-thinking` (text: keep subagent
  wording by re-throwing, or accept unified text — decision: re-throw with
  `modelLabel(label)` text so its tests stay green); `validateContextWindow`
  delegates.
- `model-commands.ts`: `findCatalogueModel` fallback → shared resolve
  (`optional`, `scope: "ignore"`, comment: child enforces scope at launch).
- Delete `THINKING_SUFFIX_PATTERN` from config.ts (moved).
- Verify: `pnpm test:subagents`.

**Phase 5 — workflows-plan defaults write delegates.**
- `model-profile.ts` `restore` → `writePiNativeDefaults`; keep
  `NormalDefaultsStore` seam and capture policy untouched.
- Verify: `pnpm test:plan`.

**Phase 6 — sweep & delete.**
- Grep for dead locals: `rg -n "resolveConfiguredModel|splitModel\(|resolveOptionalModel|findCatalogueModel|THINKING_SUFFIX_PATTERN" .pi/extensions --glob '!**/update-skill/**'`.
- Delete duplicated helper tests that asserted removed locals *only if* the
  behavior is now covered at the new interface (per DEEPENING.md
  replace-don't-layer); keep every behavior-level test.
- Full gate: `cd .pi && pnpm typecheck && pnpm test` (the complete script).

## 6. Test plan

**New:** `_shared/model-reference.test.ts` (parse + resolve matrices, error
reasons/fields), additions to `model-thinking.test.ts` and
`pi-defaults.test.ts`.

**Survives unchanged:** `model-selection.test.ts` (interface unchanged; only
the Phase-2 refresh-abort assertion is added — out-of-scope is already
covered), `config.test.ts` (subagent text preserved via catch-and-re-throw),
advisor runner/index behavior tests (out-of-scope case already exists),
guardian tests (the two guardian sentences are re-rendered by the adapter, so
no text edits), `model-picker.test.ts`.

**Deliberate test edits:** a new guardian `"/id"` pinning test (replaces no
existing case — none exists today) and the two new subagent pinning tests from
Phase 4; any subagent assertions that bypassed to deleted helpers
(`rg -n "THINKING_SUFFIX_PATTERN" extensions/tools-subagents/*.test.ts` —
currently none; the sweep is precautionary). Guardian-settings and advisor
thinking-level texts survive via catch-and-re-throw, so no test edits there.

## 7. Risks & rollback

- **Error-text drift breaking tests**: mitigated by catch-and-re-throw at
  domain edges; unified text only appears in the new module's own tests.
- **`"/id"` guardian tightening** (the only deliberate parsing behavior change
  in this pass — the subagent `:turbo` case is not tightened; see §3): pinned
  with a new test; if it surfaces in practice, revert to permissive by
  allowing empty provider + fallback (one flag). Its new `"invalid"`-reason
  guardian sentence is also pinned (§4/Phase 3).
- **Scope-policy mistakes**: the only allowed `"ignore"` sites are listed in
  §2.6; a reviewer can grep `scope: "ignore"` and find exactly three.
- **ModelRuntime adaptation**: if `getModel`'s return type differs structurally
  from `Model<any>`, widen `RefreshableModelLookup.modelRegistry.find`'s
  return to the guardian's model type via a minimal local alias rather than
  changing Pi types.
- Each phase is independently revertible (one module + per-domain edits); no
  persisted-format changes anywhere (settings documents, session entries, and
  profiles are untouched).

## 8. Definition of done

- Exactly one home for: qualified-reference parsing, registry resolution with
  refresh/scope policy, user-input thinking-level validation
  (`model-thinking.normalizeThinkingLevel`), the two migrated context-window
  validators, and Pi-native-defaults read/write. Selection-internal guards
  (`validateStoredThinkingLevel`, `mergeProjectModelSelection`,
  `resolveStoredSelection`), the selection-persistence and guardian-settings
  inline checks, and domain re-renders stay at their edges by design.
- `rg "indexOf(\"/\")" .pi/extensions --glob '!**/update-skill/**'` returns only
  the display-only shortening in `tools-advisor/index.ts` `formatAdvisorStatus`
  (documented out of scope in §4); no reference *parsing* site remains outside
  `_shared/model-reference.ts`.
- `scope: "ignore"` appears at exactly the three documented call sites.
- Full `pnpm typecheck && pnpm test` green; CONTEXT.md updated (Phase 0).