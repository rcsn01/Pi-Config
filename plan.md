# plan.md — Deepen the Editor slot module

Candidate 1 of the 2026-09-07 architecture review (`/tmp/architecture-review-20260907-172814.html`),
worked through the grilling loop with **recommended answers adopted for every decision**.
Domain vocabulary lives in `CONTEXT.md` (new term: **Editor slot module**, added under
"## TUI editor slot").

---

## 1. Problem

Pi's TUI has exactly one input editor slot (`ctx.ui.setEditorComponent`). Four extensions
touch it with no owner:

| Extension | What it does today | Where |
|---|---|---|
| `ui-model-selector` | Persistently installs `ModelCommandRoutingEditor` on `session_start` | `index.ts:170-174` |
| `ui-message-history` | Persistently installs `PreviousMessageEditor`; **wins by a `setTimeout(0)` reclaim**; keeps `/model` routing alive by **constructing the other extension's editor and duck-reading its private `modelCommandHandler` field**; re-declares `parseModelCommand` locally | `index.ts:59-64, 312-322, 371-386` |
| `ui-steer-input` | Transient swap at `agent_start`, restore at `agent_end`; reads the /model handler via `getModelCommandHandler()` | `index.ts:103-107, 142-145` |
| `workflows-plan` | Transient swap of a submit bridge to capture `onSubmit` for `/plan-implement-fresh` | `plan-review.ts:112-131` |

**Live bug (confirmed):** the extension loader (`pi` 0.85.1,
`dist/core/extensions/loader.js:416-427`) creates a **fresh jiti instance with
`moduleCache: false` per extension**. Module state in `_shared/*` is therefore
**per-extension** (empirically verified: two extensions importing one stateful `_shared`
module see independent counters). Consequence: `installModelCommandHandler` sets the
handler in ui-model-selector's copy, but `getModelCommandHandler()` in ui-steer-input's
copy reads its own empty state — **silent `/model` routing is dead during streaming
today**, and the queued-slash `/model` path degrades to Pi's generic command submit.

**Friction in design terms:** the editor slot has no owner module; ownership is decided
by timing (a `setTimeout` race), the /model grammar leaks (declared twice), and one
consumer probes another's private field across the seam. The seam is real — three
adapters already exist — it just has no interface.

## 2. Design decisions (grilling tree, recommended answers adopted)

**Q1 — Scope.** Cover the three behavioral consumers: `ui-model-selector`,
`ui-message-history`, `ui-steer-input`; absorb `_shared/model-command-routing.ts`.
The `workflows-plan` submit bridge is a transient command-submission mechanism, not an
editor behavior — leave untouched, record as follow-up (§7).

**Q2 — Home and name.** New `_shared/editor-slot.ts`; CONTEXT.md term **Editor slot
module**. `_shared` is where shared machinery lives; the three extensions become
adapters at its seam.

**Q3 — Cross-extension state.** `globalThis` registry keyed
`Symbol.for("pi-config.editor-slot.v1")`, mirroring `_shared/subagent-service.ts:127-167`
(`Symbol.for` resolves to the same symbol across per-extension module copies — this is
the in-repo precedent). Ownership-safe register/unregister like the subagent service.

**Q4 — Interface shape (design-it-twice).**
- *A. Wave-coordinated install + shared handler registry + shared base editor class* ✅ **chosen**
- *B. Middleware behavior composition* (all key handling as registered behaviors in one
  module-owned composite editor) — rejected: a speculative rewrite of subtle, working
  key-handling (rollback draft restore, `setText` overrides, `CustomEditor` internals);
  only one extension supplies rollback behavior, so a generic behavior registry is a
  hypothetical seam.
- *C. Registry only, keep the `setTimeout` reclaim* — rejected: leaves ownership to
  timing luck; any future installer can clobber the slot.

**Q5 — Winner semantics.** Contributors register `{id, priority, createEditor}` during
the `session_start` wave; the module schedules **one** deferred flush (macrotask) and
mounts exactly one editor — the **highest-priority** contributor's; ties break by latest
registration. `ui-message-history` priority `20` (its editor is the composite: rollback
behavior plus inherited `/model` routing), `ui-model-selector` priority `10`. Lower
contributors' factories are never mounted; their contribution reaches the winner through
the shared registry (handler) and the shared base class.

**Q6 — Steer integration.** `SteerEditor` keeps extending the shared
`ModelCommandRoutingEditor` and receives the handler from the registry — the live bug
disappears. Its transient swap semantics are unchanged: capture at `agent_start`,
restore at `agent_end` restores exactly what the module installed.

**Q7 — History store testability.** In scope (same file being reworked): extract
`ui-message-history/history-store.ts` as `createHistoryStore({ file })` with an injected
path; the adapter wires `~/.pi/agent/previous-message-history.json`. Tests use a temp
file (local-substitutable dependency).

**Q8 — Test surface.** The module's interface is the test surface: registry ownership
semantics, wave flush, editor routing/rollback behavior through fed key data, history
store through a temp file. Deleted code (probe, local `parseModelCommand`, `setTimeout`
hack) is untested today — nothing to migrate. `parseModelCommand` tests move from
`ui-model-selector/index.test.ts:172-182` into the new module test.

**Q9 — Ordering invariant.** Checked against the installed `pi` 0.85.1
(`dist/core/extensions/runner.js:623-649`): `ExtensionRunner.emit()` walks
`this.extensions` in load order and does `await handler(event, ctx)` **per extension,
to full completion**, before calling the next extension's handler — there is no
concurrent "wave"; it's a strict chain. `ui-model-selector`'s contribution
(`registerSessionProfileBinding` → `wireSessionProfileBinding`'s own
`pi.on("session_start", ...)`) registers early in its handler, right after the earlier
`await activeLifecycle?.dispose()` (a no-op microtask on first start) and before
`await lifecycle.initializeSession(...)`. But that same handler's later work —
`applyStoredSelection` → `pi.setModel` → `checkAuth` plus a nested `model_select` emit
across every loaded extension — very likely crosses a real macrotask boundary before
the handler returns. Since `emit()` won't invoke `ui-message-history`'s handler until
`ui-model-selector`'s handler's promise fully resolves, the module's `setTimeout(0)`
flush scheduled at `ui-model-selector`'s registration typically fires — and mounts
`ui-model-selector`'s editor alone — before `ui-message-history` even gets its turn to
register.
So the invariant that actually has to hold is not "both contributors register before
any macrotask yield" (false in the common case — a returning user with a saved model
selection). It's the weaker one already captured in §5's risk table: **late
registration re-flushes and still wins by priority**. That path isn't a rare edge case
("async initialize path changes upstream") — it's the *normal* one, which is exactly
why today's `ui-message-history` already carries a defensive blind `setTimeout(0)`
reclaim (§1) to win the slot regardless of order. The new design generalizes that same
reclaim into the priority-ordered re-flush instead of removing the need for it.
Net effect on correctness: unchanged — the final mounted editor is still the
highest-priority registrant, just reached in two flushes (mount low-priority, then
re-flush to the winner) rather than one, in the common case. Confirmed end-to-end by
the manual check in Phase 5 step 5 (§4), which asserts the *final* editor after both
extensions are enabled, not the timing that gets it there.

**Q10 — Dispose semantics.** `removeSessionEditor(ctx, id)`: unregister; if no
contributors remain, `ctx.ui.setEditorComponent(undefined)` (restore Pi's built-in
editor — today's dispose behavior); otherwise re-flush so the remaining winner remounts
(e.g. a Profile transition disposes `ui-model-selector` while `ui-message-history`
stays).

## 3. Target architecture

### Interface (`_shared/editor-slot.ts`)

```ts
import { CustomEditor, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { EditorComponent, EditorTheme, KeybindingsManager, TUI } from "@earendil-works/pi-tui";
import { reapplyThinkingBorder } from "./editor-border.ts";

export type EditorFactory = (
  tui: TUI,
  theme: EditorTheme,
  keybindings: KeybindingsManager,
) => EditorComponent;

export type ModelCommandHandler = (args: string) => Promise<void>;

/** Parse a standalone, single-line /model invocation without rewriting it. */
export function parseModelCommand(text: string): string | undefined;

/**
 * Register the /model handler every editor routes to. Backed by a
 * globalThis registry (per-extension module copies share through it).
 * Ownership-safe: the returned unregister only removes this handler.
 */
export function registerModelCommandHandler(handler: ModelCommandHandler): () => void;
export function getModelCommandHandler(): ModelCommandHandler | undefined;

export interface SessionEditorContribution {
  /** Stable contributor id ("ui-message-history", "ui-model-selector"); re-registering replaces. */
  id: string;
  /** Higher priority wins the flush. */
  priority: number;
  createEditor: EditorFactory;
}

/**
 * Register this session's editor contributor and coordinate the
 * session_start wave: one deferred flush mounts the highest-priority
 * contributor's editor, reapplying the thinking border. The slot is
 * written exactly once per wave — no caller-owned timing.
 */
export function installSessionEditor(ctx: ExtensionContext, contribution: SessionEditorContribution): void;

/** Unregister a contributor; re-flush or restore the built-in editor when none remain. */
export function removeSessionEditor(ctx: ExtensionContext, id: string): void;

/**
 * Editor that silently intercepts /model before Pi's built-in command path.
 * `modelCommandHandler` becomes `protected` and mutable — NOT the current `private
 * readonly` (constructor-only) field. `PreviousMessageEditor` constructs its base with
 * no handler and assigns one later via `attach()` (Phase 3); a private readonly field
 * set only in the constructor cannot receive that assignment through inheritance
 * (TypeScript rejects both the private access and the readonly write from a subclass).
 * Routing logic itself is otherwise unchanged.
 */
export class ModelCommandRoutingEditor extends CustomEditor {
  protected modelCommandHandler: ModelCommandHandler | undefined;
}
```

### What moves where

| From | To | Notes |
|---|---|---|
| `_shared/model-command-routing.ts`: `parseModelCommand`, `ModelCommandHandler`, `ModelCommandRoutingEditor` | `_shared/editor-slot.ts` | Logic unchanged; file deleted |
| `_shared/model-command-routing.ts`: `installModelCommandHandler` / `getModelCommandHandler` module state | `globalThis` registry in `editor-slot.ts` | `installModelCommandHandler` deleted (its state was per-extension and read by nobody); replaced by `registerModelCommandHandler` |
| `ui-message-history`: `probeModelCommandHandler`, local `parseModelCommand`, `capturedPreviousFactory`, `setTimeout` reclaim, direct `setEditorComponent`, `reapplyThinkingBorder` call | deleted | Handler comes from the registry; install through `installSessionEditor` |
| `ui-message-history`: inline /model routing block in `PreviousMessageEditor.handleInput` | deleted | `PreviousMessageEditor extends ModelCommandRoutingEditor`; routing lives in the base class |
| `ui-model-selector`'s and `ui-message-history`'s `reapplyThinkingBorder(ctx, editor, tui)` calls | inside `installSessionEditor`'s flush | Those two callers stop repeating it; `ui-steer-input` keeps calling it directly (its transient swap never goes through `installSessionEditor`, per Q6); `_shared/editor-border.ts` unchanged (still has its own tests) |

### Composition after (class hierarchy per extension copy, state shared via registry)

```
ui-model-selector adapter ──registerModelCommandHandler(handler)──┐
                                                                  │ globalThis registry
ui-message-history adapter                                        │ (Symbol.for)
  PreviousMessageEditor                                           │
    extends ModelCommandRoutingEditor ◄────────────────────────────┘
      rollback ↑/↓ + Ctrl+C record + inherited /model routing

ui-steer-input adapter (transient swap at agent_start/end)
  SteerEditor extends ModelCommandRoutingEditor
    handler = getModelCommandHandler()   ← NOW ACTUALLY WORKS
```

Flush order for one `session_start` wave: `ui-message-history` (20) wins; its editor
inherits routing from the shared base; the handler arrives through the registry.

## 4. Implementation phases (replace, don't layer — test-first)

### Phase 1 — Create the module, migrate importers, delete the old file
1. **Red:** add `extensions/_shared/editor-slot.test.ts` with: registry tests
   (register/get, ownership-safe unregister removes only its own handler,
   re-register replaces), `parseModelCommand` cases (moved from
   `ui-model-selector/index.test.ts:172-182`), `ModelCommandRoutingEditor` routing
   behavior (submit key + `/model args` routes silently and clears the text;
   non-`/model` submit falls through; multiline is not parsed), wave-flush tests
   (two contributors, priorities 20/10, same tick → one `setEditorComponent` call with
   the winner's editor and border reapplied; same-id re-registration replaces; tie
   breaks by latest registration; **a lower-priority contributor registers, its flush
   fires and mounts it, then a higher-priority contributor registers on a later tick —
   a second flush fires and replaces the mount with the higher-priority contributor's
   editor**). That last case is not the rare path — per Q9, it's the one that actually
   runs in production whenever `ui-model-selector` crosses a macrotask before
   `ui-message-history` gets its turn — so it needs direct unit coverage, not just the
   manual end-state check in Phase 5 step 5.
2. **Green:** implement `_shared/editor-slot.ts` to the interface in §3
   (registry: `const REGISTRY_KEY = Symbol.for("pi-config.editor-slot.v1")`; flush:
   `setTimeout(0)`, winner's `ctx`, `reapplyThinkingBorder` inside the factory wrapper).
3. Update importers to the new path (behavior-identical in this phase):
   - `ui-model-selector/index.ts:13-16` → import from `editor-slot.ts`; keep
     `installModelCommandHandler` → rename to `registerModelCommandHandler` (Phase 2
     semantics, same call shape) — do it here to avoid two touches.
   - `ui-model-selector/index.test.ts:4-8` → update import; remove migrated
     `parseModelCommand` cases (lines 171-183) **and** the "does not let stale cleanup
     remove a newer active handler" test (lines 185-194). That test exercises
     `installModelCommandHandler`/`getModelCommandHandler` ownership semantics directly
     — both symbols are renamed in this same step, so left in place it references a
     deleted export and fails to compile. The same ownership semantics are already
     covered by `editor-slot.test.ts`'s registry tests (Red, step 1 above). **Also
     rename the surviving call site outside those two deleted ranges:** the file-level
     `afterEach` at lines 12-15 calls `installModelCommandHandler(async () => {})`
     directly as cleanup; update it to `registerModelCommandHandler` too, or the file
     won't compile even after the two test blocks above are removed.
   - `ui-steer-input/index.ts:16-20` → update import.
   - `ui-message-history/index.ts` → import `parseModelCommand` +
     `ModelCommandRoutingEditor` from `editor-slot.ts`; delete the local copy (deletion
     test passes: the local mirror only duplicated the shared grammar).
4. **Delete** `_shared/model-command-routing.ts`.
5. Run `pnpm test:shared test:features test:steer` → green.

### Phase 2 — Registry adoption (fixes the live steer bug)
1. **Red:** in `ui-steer-input/index.test.ts`, add: register a model handler through
   `editor-slot`, drive `agent_start`, feed Enter with `/model <args>` text through the
   installed `SteerEditor`, assert the handler was called and the editor cleared; also
   assert the queued-slash path routes `/model` to the handler (`run`) instead of the
   generic submit.
2. **Green:** no production change expected beyond Phase 1's registry (that is the
   point — the test pins the fixed behavior). If anything still reads dead module
   state, fix it here.
3. `ui-model-selector/index.ts`: dispose path (`index.ts:197-198`) keeps the
   ownership-safe unregister (already returned by `registerModelCommandHandler`).
4. Run `pnpm test:steer test:features` → green.

### Phase 3 — Wave-coordinated install; delete the timing hack and the probe
1. **Red:** add wave tests to `editor-slot.test.ts` if not already in Phase 1:
   `removeSessionEditor` with no contributors → `setEditorComponent(undefined)`;
   with a remaining contributor → re-flush remounts it; unknown id → no-op.
2. **Green:** no change needed if Phase 1 covered it.
3. `ui-message-history/index.ts`:
   - Delete: `capturedPreviousFactory`, `probeModelCommandHandler`, the
     `EditorFactoryLike` type, the `setTimeout` reclaim block, the direct
     `ctx.ui.setEditorComponent(...)` call, the `reapplyThinkingBorder` import/call,
     the inline routing block in `PreviousMessageEditor.handleInput`, the local
     `ModelCommandHandler` type (import it).
   - `ModelCommandRoutingEditor.modelCommandHandler` changes from `private readonly` to
     `protected` (mutable) — see §3's revised class comment. This is what lets
     `attach()` assign it after construction.
   - `PreviousMessageEditor extends ModelCommandRoutingEditor`; `handleInput` keeps
     rollback/`app.clear` logic and delegates everything else to `super` (routing runs
     in the base before the built-in submit — order preserved because the subclass
     exits rollback before delegating). `attach()` keeps its existing 3-arg shape
     (`entries`, `onRecord`, `modelCommandHandler`) and assigns
     `this.modelCommandHandler = modelCommandHandler` directly — legal now that the
     field is `protected`.
   - Replace `installEditor(ctx)` with:
     ```ts
     installSessionEditor(ctx, {
       id: "ui-message-history",
       priority: 20,
       createEditor: (tui, theme, keybindings) => {
         const editor = new PreviousMessageEditor(tui, theme, keybindings);
         editor.attach(entries, (text) => store.record(currentCwd, text), getModelCommandHandler());
         return editor;
       },
     });
     ```
   - Rewrite the file header design notes (ownership now delegated to the module).
4. `ui-model-selector/index.ts`:
   - Replace `ctx.ui.setEditorComponent(...)` (`index.ts:170-174`) with
     `installSessionEditor(ctx, { id: "ui-model-selector", priority: 10, createEditor })`.
   - Replace dispose's `ctx.ui.setEditorComponent(undefined)` (`index.ts:199`) with
     `removeSessionEditor(ctx, "ui-model-selector")`.
5. Run `pnpm test:features test:steer test:message-history` (script added in Phase 4) → green.

### Phase 4 — History store as its own module
1. **Red:** `extensions/ui-message-history/history-store.test.ts` with a temp `file`:
   record dedupes consecutive entries, re-submitting an older entry moves it to the
   top, `MAX_ENTRIES` cap, merge-on-save preserves entries written by another instance,
   debounced save coalesces, `flush()` persists pending debounce.
2. **Green:** extract the `store` object (`ui-message-history/index.ts:77-150`,
   including `flush()` at 143-149 — don't stop at `saveNow`) into
   `ui-message-history/history-store.ts` as
   `createHistoryStore({ file }: { file: string })` returning
   `{ load, listFor, record, flush }` (merge-on-write and debounce semantics unchanged);
   `index.ts` wires the default path via `historyFile()` and keeps `session_shutdown → flush`.
3. `package.json` (in `.pi/`): add `"test:message-history": "vitest run extensions/ui-message-history"`
   and insert it into the `test` chain next to `test:steer`.
4. Run `pnpm test:message-history` → green.

### Phase 5 — Full verification
1. `cd .pi && pnpm typecheck`
2. Targeted: `pnpm test:shared test:features test:steer test:message-history`
3. Full suite: `pnpm test`
4. Manual TUI checklist (`pi` in a scratch project):
   - ↑ recalls previous message; walks back/forward; past-newest restores the draft;
     first edit exits rollback
   - Ctrl+C on non-empty text records into history; history persists across restart
   - `/model <query>` at idle opens the selector silently (no builtin `/model` flash)
   - `/model <query>` **while the agent streams** routes to the selector — the fixed bug
   - Tab queues a follow-up and a slash command while streaming
   - thinking border colors track the live thinking level after install and after the
     steer swap-back
   - Profile switch (`/profile`): editor restores (model-selector dispose →
     `removeSessionEditor` re-flush or built-in)
   - `/plan` review → `/plan-implement-fresh` still submits (bridge untouched)
5. Wave-invariant spot check: start `pi` with only `ui-model-selector` enabled
   (move the other out temporarily) — editor must be the routing editor; then with
   both enabled — editor must be the rollback editor. Confirms priority, not timing,
   decides the winner.

## 5. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Per-extension module copies make cross-extension sharing untestable in vitest (one module registry per test process) | The registry is `Symbol.for`-keyed `globalThis` — same-string symbols resolve identically across module copies; semantics are unit-tested, the mechanism is JS-guaranteed. Manual checklist step 5 proves it end-to-end. |
| A contributor registers after the flush — the common case, not an edge case: `ExtensionRunner.emit()` awaits each extension's session_start handler to full completion before the next one runs (§2 Q9), and `ui-model-selector`'s handler routinely crosses a real macrotask boundary (`checkAuth`, nested `model_select` emit) after registering but before returning | Flush is re-triggerable: any late `installSessionEditor` schedules a new flush, so a late registration still wins by priority — degraded to "late install", never "lost install". This is the same outcome today's blind `setTimeout(0)` reclaim in `ui-message-history` produces, generalized. |
| `CustomEditor`/editor types differ between repo devDeps (0.84.4) and the global pi (0.85.1) | Typecheck and test against the repo's pinned devDeps; manual verification runs against the globally installed `pi`. |
| Transient swappers (steer, plan-review) interacting with the flush | They never register; they capture/restore whatever the module mounted. Tests pin restore-exactness in `ui-steer-input/index.test.ts`. |
| Model-selector's editor stops being mounted directly | Intended: its routing contribution reaches the winner via the shared base class + registry. If only it is registered, it still wins the flush — nothing is lost. |

## 6. Wins (glossary terms)

- **Locality:** editor ownership, /model grammar, and install ordering concentrate in one module; bugs fix once.
- **Leverage:** one interface, three adapter extensions; adding an editor behavior means registering, not racing.
- **Interface shrinks; implementation absorbs** the probe, the reclaim, and the border reapplication.
- **Live bug fixed:** `/model` routing during streaming works again (per-extension module state bypassed).
- **Deletion:** `probeModelCommandHandler`, local `parseModelCommand`, `setTimeout` hack, `capturedPreviousFactory`, `installModelCommandHandler`, the entire `model-command-routing.ts` file.

## 7. Out of scope (recorded, not re-litigated)

- `workflows-plan/plan-review.ts` submitEditorCommand bridge — a workaround for Pi lacking a submit-command capability; revisit if pi ships one.
- Architecture-review candidates 2–6: workflow run-state deepening, child-tool manifest, worktree result envelope, telemetry weekly bucketing, exec-policy split.