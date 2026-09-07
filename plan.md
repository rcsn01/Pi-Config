# plan.md — One registry for the permission modes

Candidate 1 of the second architecture review of 2026-09-07
(`/tmp/architecture-review-20260907-191059.html`), worked through the grilling loop with
**recommended answers adopted for every decision** and the interface settled with the
design-it-twice parallel pattern (three designs compared, hybrid recommended).
Domain vocabulary lives in `CONTEXT.md` (new term: **Permission-mode registry**, added
under "## Safety").

---

## 1. Problem

The permission-mode vocabulary is re-derived in six sites across `policy-permissions/`
and `_shared/`. Adding, renaming, or rewording an approval mode means six hand-synced
edits, and missing one fails **silently** where TypeScript does not already check the
site — an undefined status label, missing system-prompt text (`index.ts`'s
`Record<string, string>` maps), or a mode that saves to the state file but silently
falls back to `default` on the next load (`mode-store.ts`'s `VALID_MODES` has no
exhaustiveness check against the union, and `saveModeToFile` never validates;
`MODE_LABELS` and the lifecycle switch, by contrast, already fail compilation):

| Site | What it re-derives | Where |
|---|---|---|
| `_shared/command-policy.ts:7` | `type ApprovalMode` union — the type's only consumers are policy-permissions files (grep-verified), yet it lives inside the exec-policy grab-bag module | type |
| `mode-store.ts:18` | `VALID_MODES` (persisted-value validation) | vocabulary |
| `commands.ts:28-42` | `VALID_MODES`, `ALIAS_MAP` (`auto→default, full→full-access, ro→read-only, review→auto-review`), `MODE_LABELS` (long picker descriptions); `:48` full-access confirm gate + copy; `:63`, `:70`, `:92` enumerate the modes again in prose strings | vocabulary ×4 |
| `index.ts:98-102` | `modeLabels` (status-line labels; identity map today) | vocabulary |
| `index.ts:205-211` | `modeInstructions` (per-mode system-prompt text; read-only's wording is computed from `event.systemPrompt.includes("cwd")`) | vocabulary |
| `permission-enforcement-lifecycle.ts:129-147` | `requestApproval` switch: read-only → deny `"Read-only mode."`, default → prompt via adapter (no-UI → deny `"No UI available for approval."`), auto-review/full-access → allow | per-mode semantics |

**The switch is fully live, not defensive.** The execpolicy check in
`permission-policy.ts:54-78` runs in *every* mode and can call `deps.requestApproval`,
so the read-only deny path and the auto-review/full-access allow path both execute in
production today.

**Friction in design terms:** the permission-mode vocabulary has no owner module; five
files each hold a slice, and two hot callers (`/permissions` input resolution, the
lifecycle's disposition dispatch) hand-write the same per-mode knowledge the registry
should own. The seam is real — four call sites already need the facts — it just has no
interface.

---

## 2. Design decisions (grilling tree, recommended answers adopted)

**Q1 — Scope.** The registry covers: the `ApprovalMode` union (moved out of
`_shared/command-policy.ts`), canonical order, aliases + input resolution,
persisted-mode validation, status-line labels, picker descriptions, per-mode
system-prompt instructions, per-mode approval disposition, and the full-access switch
confirmation. **Out of scope:** `permission-policy.ts`'s trigger-level mode gating
(read-only blocks, default prompts, auto-review guardian flow — trigger classification,
not vocabulary; strongly tested, stays); the Permission enforcement lifecycle's
decision ordering (one-shots, authorization generation, guardian fallback, verdict
persistence — stays); the exec-policy grab-bag split (carried candidate, untouched
beyond the type move); the approve-or-block repetition (review candidate 6).

**Q2 — Home and name.** New `policy-permissions/mode-registry.ts`; CONTEXT.md term
**Permission-mode registry** (consistent with the existing "permission mode"
vocabulary and the sibling `mode-store.ts`). All consumers are inside
`policy-permissions/` today, so the seam lives there — a `_shared/` placement would be
a hypothetical seam with zero second adapters.

**Q3 — Type home.** `ApprovalMode` moves to the registry as its single home;
`_shared/command-policy.ts` keeps exec-policy machinery only. Straight move, **no
compat re-export** — every importer is in-repo and grep-verified (only
`commands.ts`, `mode-store.ts`, `permission-enforcement-lifecycle.ts`,
`policy-types.ts`). This shrinks the grab-bag the carried exec-policy candidate will
split, without executing that candidate.

**Q4 — Interface shape (design-it-twice).** Three designs compared:

- *A. Minimal interface* (3 entries: descriptor array, total lookup, resolution) —
  tightest interface; descriptors mix facts with a function; call sites destructure
  (`approvalMode(mode).gate`).
- *B. Max flexibility* (exported record map + 5 derived functions; zero imports) —
  declarative core with compile-time exhaustiveness; the exported record shape leaks
  the implementation's structure into the interface.
- *C. Hot-caller ergonomics* (flat functions; disposition truth table folds `hasUI`;
  precomputed prose hint constants; strict/lenient validation split) — smallest call
  sites; hint constants are three exports for three strings.

✅ **Chosen: hybrid.** C's flat entry points and disposition truth table for the two
hot callers; B's private declarative record table (compile-exhaustive, registry owns
the switch confirmation) as implementation rather than interface; B's ruling that
prose composition (`" | "` joins, or-lists) is presentation and stays adapter-side.
Flat functions over an exported record: the record is the implementation's business,
one-line call sites are the callers' leverage.

**Q5 — What absorbs the lifecycle switch.** The registry owns the per-mode
disposition *fact* (`approvalDisposition(mode, hasUI)` → decided result or prompt);
the lifecycle's `requestApproval` switches on the returned kind and keeps prompt
execution (adapter call, `"\n\nProceed?"` suffix, `onAllowed` wiring,
`"User declined."`). The lifecycle remains the deep owner of ordering — it consumes
facts, it does not become a pass-through.

**Q6 — Read-only instruction variability.** The registry owns a typed parameter,
`workspacePhrasing: "workspace" | "current-directory"`; the adapter computes it from
`event.systemPrompt.includes("cwd")` (Pi-prompt inspection stays adapter knowledge).
Three of four modes ignore the parameter — accepted uniformity tax so one
signature serves all modes. Each phrasing's output is byte-identical to today's
corresponding string.

**Q7 — Strict vs lenient validation.** Two needs, two entries: `isApprovalMode`
(exact canonical match, no aliases, no case folding — persisted file values must not
load through `"RO"` or `" default"`) and `resolveModeInput` (trim + lowercase +
aliases + canonical ids, total, never throws — command input). Today's behavior is
exactly this split; the registry names it.

**Q8 — Switch confirmation.** Registry-owned (`modeSwitchConfirmation`): the
full-access title/message copy is a per-mode fact; leaving it in `commands.ts` keeps a
mode literal + five lines of copy outside the seam. The `⚠️ Full Access Mode`
confirmation requirement becomes data, so a future mode with a confirmation gets it
for free.

**Q9 — Tests.** New `mode-registry.test.ts` is the byte-identity guarantee: every
moved string pinned verbatim **before** any caller is rewired, plus the alias table
(including the `auto→default` quirk), the 4×2 mode×hasUI disposition truth table
(first-ever pin of `"Read-only mode."` and `"No UI available for approval."`), and the
strict/lenient validation split. New minimal `commands.test.ts` closes the
"commands.ts vocabulary untested" gap from the review. Existing suites survive
unchanged: `mode-store.test.ts` (invalid-value → null path now flows through
`isApprovalMode`), `permission-enforcement-lifecycle.test.ts` (crosses the same
adapter harness), `permission-policy.test.ts` (untouched), `index.test.ts` (status
`"default"` byte-identical). No tests deleted — replace-don't-layer costs nothing
here; the vocabulary had zero direct tests before, which was the problem.

**Q10 — Migration.** Straight move, no shims: registry created with its own
`ApprovalMode` (identical union) and its tests green first; callers rewired one file
at a time; the type deleted from `_shared/command-policy.ts` **last**, with typecheck
proving no importer remains.

---

## 3. Target architecture

### Interface (`policy-permissions/mode-registry.ts`)

Pure in-process module: no imports — no node, no Pi, no `_shared`. All user-facing
strings are user-facing contract; changing one is a behavior change and must update
the characterization pins.

```ts
/**
 * Permission-mode registry: the single home of the approval-mode vocabulary.
 * Owns the ApprovalMode union and canonical order, /permissions aliases and
 * input resolution, persisted-mode validation, per-mode status labels, picker
 * descriptions, system-prompt instructions, approval disposition, and the
 * full-access switch confirmation. Pure and in-process: no I/O, no clock,
 * no host context at this seam. Prose composition stays adapter-side.
 */

export type ApprovalMode = "read-only" | "default" | "auto-review" | "full-access";

/** Canonical order: picker rows, prose lists, and validation derive from this. */
export const APPROVAL_MODES: readonly ApprovalMode[];

/** Exact canonical match only — no aliases, no case folding. For persisted values. */
export function isApprovalMode(value: unknown): value is ApprovalMode;

export type ModeResolution = { ok: true; mode: ApprovalMode } | { ok: false };

/** Trim + lowercase, then aliases (`auto, full, ro, review`) and canonical ids. Total. */
export function resolveModeInput(raw: string): ModeResolution;

/**
 * Per-mode approval disposition resolved against the in-memory hasUI fact.
 * read-only            → decided { allowed: false, reason: "Read-only mode." }
 * default + no UI      → decided { allowed: false, reason: "No UI available for approval." }
 * default + UI         → prompt
 * auto-review/full-access → decided { allowed: true }
 * The prompt outcome is reachable only for default mode with a UI.
 */
export type ApprovalDisposition =
	| { kind: "decided"; result: { allowed: boolean; reason?: string } }
	| { kind: "prompt" };

export function approvalDisposition(mode: ApprovalMode, hasUI: boolean): ApprovalDisposition;

/** Bare status-line label ("read-only" …) — identity today, single home for divergence. */
export function modeStatusLabel(mode: ApprovalMode): string;

/** Long /permissions picker description (byte-identical to today's MODE_LABELS). */
export function modePickerDescription(mode: ApprovalMode): string;

/**
 * Per-mode system-prompt section. Only read-only varies on phrasing; the other
 * modes return their fixed text regardless. Adapter computes the phrasing.
 */
export function modeSystemPrompt(
	mode: ApprovalMode,
	workspacePhrasing: "workspace" | "current-directory",
): string;

/** Confirmation required before switching INTO a mode; undefined = switch directly. */
export interface ModeSwitchConfirmation { title: string; message: string }
export function modeSwitchConfirmation(mode: ApprovalMode): ModeSwitchConfirmation | undefined;
```

### Implementation shape (hidden behind the seam)

```ts
interface ModeFacts {
	aliases: readonly string[];
	statusLabel: string;
	pickerDescription: string;
	systemPrompt: string | ((phrasing: "workspace" | "current-directory") => string);
	approval:
		| { kind: "deny"; reason: string }
		| { kind: "allow" }
		| { kind: "prompt"; unavailableReason: string };
	switchConfirmation?: ModeSwitchConfirmation;
}

const MODE_FACTS: Record<ApprovalMode, ModeFacts> = { /* … */ };
```

`Record<ApprovalMode, ModeFacts>` makes a mode without its facts a **compile error** —
the exhaustiveness machinery is implementation, not interface. Alias precedence is
aliases-before-canonical (moot today: no alias equals an id); the alias table lives
here, so the `auto→default` quirk is documented once.

### What moves where

| From | To | Notes |
|---|---|---|
| `_shared/command-policy.ts:7` `ApprovalMode` | `mode-registry.ts` | line deleted; policy-permissions importers re-point (Q3) |
| `mode-store.ts:18` `VALID_MODES` | deleted | load validation → `isApprovalMode`; `ModeState`/`DEFAULT_MODE_STATE` stay (persistence shape, not vocabulary) |
| `commands.ts:28-42` `VALID_MODES`/`ALIAS_MAP`/`MODE_LABELS` | deleted | description, no-UI hint, and invalid message derive from `APPROVAL_MODES` in the adapter; `resolveModeInput` replaces the alias block and the `"" as ApprovalMode` cast hack |
| `commands.ts:48-54` full-access gate + copy | deleted | `modeSwitchConfirmation` in `switchMode` |
| `index.ts:98-102` `modeLabels` | deleted | `modeStatusLabel(enforcement.mode.mode)` |
| `index.ts:205-211` `modeInstructions` | deleted | `modeSystemPrompt(mode, phrasing)`; the `includes("cwd")` probe stays adapter-side (Q6) |
| `lifecycle:129-147` `requestApproval` switch | deleted | `approvalDisposition(mode, environment.hasUI)`; prompt path (adapter call, `"\n\nProceed?"`, `onAllowed`, `"User declined."`) stays — Q5 |

### Callers after (adapters at the registry's seam)

```
commands.ts adapter (/permissions)          resolveModeInput · APPROVAL_MODES ·
  alias + validation + picker + confirm  ──► modePickerDescription ·
                                             modeSwitchConfirmation
mode-store adapter (persistence)            isApprovalMode · ApprovalMode
index.ts adapter (status + prompt)          modeStatusLabel · modeSystemPrompt
permission-enforcement-lifecycle adapter    approvalDisposition
  ordering, guardian, one-shots stay          (prompt execution stays here)
permission-policy (trigger classification)  untouched — mode literals are uses,
                                             not re-derivations
```

## 4. Implementation phases (replace, don't layer — test-first)

### Phase 1 — Create the registry, pin the strings
1. **Red:** add `extensions/policy-permissions/mode-registry.test.ts`, copying every
   string **verbatim** from today's sites:
   - `APPROVAL_MODES` order `["read-only","default","auto-review","full-access"]`.
   - `isApprovalMode`: four canonical ids true; `"AUTO"`, `" default"`, `""`,
     `"bogus"`, `null`, `42`, `{}` false.
   - `resolveModeInput`: all four aliases (`auto`→default — pin the quirk; `full`,
     `ro`, `review`), all four canonical ids, case/whitespace (`"FULL"`,
     `" default"`), empty/unknown → `{ ok: false }`.
   - `approvalDisposition` truth table, 4 modes × both `hasUI`, byte-pinning
     `"Read-only mode."` and `"No UI available for approval."` (first-ever pins).
   - `modeStatusLabel` ×4; `modePickerDescription` ×4 (from `commands.ts:37-42`).
   - `modeSystemPrompt`: read-only under **both** phrasings (assert the interpolated
     `the workspace` / `the current directory` bullet) from `index.ts:205-210`; the
     other three ignore the phrasing argument, byte-pinned.
   - `modeSwitchConfirmation`: exact title + message for full-access (from
     `commands.ts:50-54`), `undefined` for the other three.
2. **Green:** implement `mode-registry.ts` per §3 (private `MODE_FACTS` record table;
   module imports nothing).
3. Run `pnpm test:safety` → green (old sites untouched; registry coexists).

### Phase 2 — Rewire the command adapter
1. **Red:** add `extensions/policy-permissions/commands.test.ts`: a fake
   `CommandService` + fake `pi.registerCommand` capture + fake `ctx.ui`; assert the
   registered description string, no-UI notify text, invalid-input message
   (`bogus` → `"Invalid mode. Use: read-only, default, auto-review, or full-access"`),
   alias resolution (`ro`, `auto`, `FULL`, ` review `), the already-in-mode notify,
   the full-access confirmation (decline → no `changeMode`), and the picker option
   assembly (labels, descriptions, checked marking) via a stubbed `pickGuiOption`.
2. **Green:** `commands.ts`:
   - Delete `VALID_MODES`, `ALIAS_MAP`, `MODE_LABELS`, the inline full-access
     confirmation block, and the `"" as ApprovalMode` resolution hack.
   - `description: \`Switch approval mode: ${APPROVAL_MODES.join(" | ")}\``; no-UI
     hint via `APPROVAL_MODES.join("|")`; invalid message via a one-line or-list
     helper over `APPROVAL_MODES` (byte-identical: `"read-only, default,
     auto-review, or full-access"`).
   - `resolveModeInput(trimmed)` replaces the alias/validity block; the handler keeps
     its own `trim().toLowerCase()` (harmless, and `resolveModeInput` is idempotent
     over it).
   - `switchMode`: `const confirmation = modeSwitchConfirmation(newMode)` — same
     `ctx.hasUI` gating and flow.
3. Run `pnpm test:safety` → green (`commands.test.ts` pins adapter prose).

### Phase 3 — Rewire persistence, display, and the lifecycle
1. `mode-store.ts`: delete `VALID_MODES`; `import { isApprovalMode, type ApprovalMode }
   from "./mode-registry.ts"`; load check becomes
   `if (raw?.mode && isApprovalMode(raw.mode))`. Exact-match semantics preserved.
2. `index.ts`:
   - Delete the `modeLabels` record; `updateStatus` calls
     `modeStatusLabel(enforcement.mode.mode)`.
   - Delete the `modeInstructions` record; the `before_agent_start` handler calls
     `modeSystemPrompt(enforcement.mode.mode,
     event.systemPrompt.includes("cwd") ? "workspace" : "current-directory")`.
   - Update the header comment's mode list to reference the registry (doc-only).
3. `permission-enforcement-lifecycle.ts`: re-point the `ApprovalMode` import at the
   registry; `requestApproval` becomes:
   ```ts
   const disposition = approvalDisposition(mode, environment.hasUI);
   if (disposition.kind === "decided") return Promise.resolve(disposition.result);
   // prompt path (default mode with UI): adapter call + "\n\nProceed?" + onAllowed
   ```
   The guardian fallback, one-shots, generations, and verdict persistence are
   untouched.
4. `policy-types.ts`: re-point the `ApprovalMode` import at the registry.
5. Run `pnpm test:safety` → green. `mode-store.test.ts`,
   `permission-enforcement-lifecycle.test.ts`, `permission-policy.test.ts`, and
   `index.test.ts` pass **unmodified** — the invariant that behavior didn't move.

### Phase 4 — Delete the type loan from _shared
1. Delete `export type ApprovalMode = …` from `_shared/command-policy.ts:7`.
2. `pnpm typecheck` — proves no importer remains (grep already says none outside
   policy-permissions; this makes it mechanical).

### Phase 5 — Full verification
1. `cd .pi && pnpm typecheck`
2. Targeted: `pnpm test:safety`
3. Full suite: `pnpm test`
4. Manual TUI checklist (`pi` in a scratch project):
   - `/permissions` opens the picker: four options, descriptions match today's
     wording, current mode pre-checked
   - `/permissions ro` → switches; status line shows `read-only`
   - `/permissions FULL` → alias accepted (case-insensitive), confirmation dialog
     appears; declining leaves the mode unchanged
   - `/permissions bogus` → `Invalid mode. Use: read-only, default, auto-review, or
     full-access` (byte-identical)
   - `/permissions auto` → lands in **default** (the alias quirk, unchanged)
   - Restart `pi` → mode persisted and reloaded (mode-store unchanged)
   - In read-only mode, run a bash command matched to an execpolicy `prompt` rule →
     **no approval dialog opens** and the command is denied with `User declined via
     execpolicy prompt.` (the live cross-mode path, now registry-fed: the read-only
     disposition supplies the deny without an adapter call; `"Read-only mode."` is
     the disposition's internal reason and does not surface — the execpolicy block at
     `permission-policy.ts:71-74` discards it and hardcodes the block reason)
   - In auto-review mode, a dangerous command → Guardian review fires (unchanged)
   - Status label + `/approve` flow still behave in default mode (lifecycle
     untouched)

## 5. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Moved strings drift byte-by-byte | Characterization pins written **first** (Phase 1 Red), strings copied verbatim from today's sources; `commands.test.ts` pins the three adapter-composed prose strings. |
| The `auto→default` alias quirk regresses (it looks like a bug; "fixing" it to `auto-review` would be a behavior change) | Pinned explicitly in `mode-registry.test.ts`; noted in the registry's implementation comment. |
| Lifecycle loses depth by consuming the registry | The disposition is *data*; prompt execution (`"\n\nProceed?"`, `onAllowed`, `"User declined."`), guardian fallback, one-shots, and generations stay in the lifecycle. Existing lifecycle tests prove ordering unchanged. |
| `resolveModeInput` accidentally lenient for persisted values (loading `"RO"` from disk) | Strict/lenient split is two named entries (`isApprovalMode` vs `resolveModeInput`); `mode-store.test.ts`'s invalid-value case keeps guarding the strict path. |
| Registry becomes a metadata dumping ground | Purity rule (no imports) + "no record field without a consumer" discipline; every field has exactly one consumer today. |
| Exec-policy split candidate conflicts with the type move | None: the move *removes* the type from the grab-bag, which the carried candidate would otherwise have to handle; the split remains a separate candidate. |

## 6. Wins (glossary terms)

- **Locality:** mode vocabulary, aliases, strings, and approval disposition concentrate in one module; adding a mode is one table row plus trigger-table work.
- **Leverage:** one interface, four call sites; a new mode is one record and TypeScript forces the facts.
- **Interface shrinks; implementation absorbs** the alias table, the cast hack, the switch, and the confirmation copy.
- **Compile-time exhaustiveness:** a mode without facts is a type error, not a silent undefined label.
- **First tests for the mode vocabulary:** the disposition truth table and every user-facing string get their first pins.
- **Deletion:** `VALID_MODES` ×2, `ALIAS_MAP`, `MODE_LABELS`, `modeLabels`, `modeInstructions`, the full-access copy block, the `"" as ApprovalMode` hack, and the `ApprovalMode` loan from `_shared/command-policy.ts`.

## 7. Out of scope (recorded, not re-litigated)

- `permission-policy.ts` trigger-level mode gating and its approve-or-block
  repetition (review candidate 6, `Speculative`).
- The exec-policy grab-bag split (carried candidate, strengthened today: per-tool-call
  reloads, the `"/Users"` home fallback, untested commands CRUD).
- The four other candidates from this review (usage totals accumulator, Observability
  translation, dead legacy render path, agent-defaults policy) and the three still
  open from the 17:28 review.
- commands.ts full test coverage beyond the `/permissions` vocabulary paths added in
  Phase 2 (`/approve`'s no-denied-action branch and `/execpolicy`'s command mechanics
  remain untested — `/approve`'s approved path is already covered through the real
  wiring in `index.test.ts`; separate small task).