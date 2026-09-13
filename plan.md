# Implementation plan: deepen the `/goal` command surface into a Goal command module

## Status

Ready for implementation. The source inventory and behavior taxonomy below were checked against checkout `a344209`. The plan has no deferred verification items.

Planning baseline:

- Checkout: `a344209` (`HEAD` during this review)
- Changed source scope: `.pi/extensions/workflows-goal/index.ts`, `.pi/extensions/workflows-goal/goal-commands.ts` (new), `.pi/extensions/workflows-goal/goal-prompts.ts` (new), and their test files
- Test and documentation scope: `.pi/extensions/workflows-goal/goal-commands.test.ts` (new), `.pi/extensions/workflows-goal/goal-prompts.test.ts` (new), `.pi/extensions/workflows-goal/index.test.ts` (pruned), and `CONTEXT.md`
- Baseline verified on this checkout: `pnpm --dir .pi typecheck` passes. `pnpm --dir .pi test:goal` passes 2 files and 28 tests. No file outside `workflows-goal/` imports from the extension (repository search).
- Compatibility requirements: `goal-state.ts` keeps its public interface untouched. The `goal-state` session entry format, the `goal` tool name/parameters/result shapes, the `goal-status` widget id, the `/goal` command name, and every user-visible string, severity, and arm order are preserved exactly. The only intended observable change is listed under "Intentional observable changes".

This plan implements architecture-review candidate 1 (Strong): collapse the six `/goal` command arms into one deep Goal command module.

## Objective

Move the `/goal` command's decision-making — subcommand parsing, the transition→message policy, the replacement-confirmation requirement and its text, the kickoff message, and status formatting — out of the Pi adapter into a pure Goal command module. Move the goal prompt builders into a `goal-prompts.ts` sibling and hand the `before_agent_start` injection decision to it. Unify the `goal` tool's live failure signal on `details.error`.

This is a real deepening, not a file move:

- Six command arms each re-declare outcome → reason→message mapping → notify → persist → widget (`index.ts:385–506`). The deletion test passes: delete the message policy and it reappears six times.
- `buildActiveGoalPrompt`, `buildPausedGoalPrompt` (`index.ts:513–562`), and `formatGoalStatus` (`index.ts:564–577`) are pure but reachable only through a faked `ExtensionContext` — tests must cross the whole adapter to pin prompt text.
- Failure meaning for the `goal` tool is encoded three ways: the `isGoalFailureText` regex (`index.ts:59`), `details.error`, and `isError`.

After the deepening, the module owns everything the `/goal` surface says; the adapter owns everything Pi makes it do.

## Source inventory and verified behavior

### Command handler: `index.ts:367–509`

One `pi.registerCommand("goal", …)` handler parses `trimmedArgs = (args || "").trim()` and walks eight arms in a fixed order. The arm taxonomy, with exact behavior:

1. **View** (`:372–383`, empty args): no goal or `cleared` → `notify("No active goal. Use /goal <objective> to set one.", "info")`. Otherwise `notify(formatGoalStatus(goal), "info")`. No transition, no widget update.
2. **Pause** (`:385–402`): `pauseGoal(goal, Date.now())`. Rejections: `already-paused` → `"Goal is already paused."` warning; `completed` → `"Goal is already completed. Use /goal <objective> to set a new one."` warning; anything else (`no-goal`, cleared) → `"No active goal to pause."` warning. Success: `applyTransition(outcome)`, `notify('Goal paused: "<objective>"', "info")`, widget update.
3. **Resume** (`:404–421`): mirror of pause with `already-active` → `"Goal is already active."` and fallback `"No goal to resume."`; success message `'Goal resumed: "<objective>"'`.
4. **Edit** (`:423–439`): requires the literal prefix `"edit "` (with space). Blank objective → `"Usage: /goal edit <new objective>"` warning — **unreachable through the command**: `trimmedArgs` is trimmed, so it can never end in whitespace, and `slice(5).trim()` is therefore never empty; keep the branch verbatim in the module as defense since `editGoal` still returns `empty-objective`. No goal → `"No active goal to edit."` warning. Success: `notify("Goal updated: <objective>", "info")`, widget update. The transition action is `"set"` (goal-state's editGoal persists as a set). No length limit on the objective.
5. **Checkpoint** (`:441–453`): prefix `"checkpoint "`. One rejection message for every reason (`no-goal`, `not-active`): `"No active goal to checkpoint."` warning. Success: `notify("Checkpoint saved: <checkpointProgress>", "info")`, widget update.
6. **Clear** (`:455–470`): `wasCompleted = goal?.status === "completed"` is read *before* the transition. Rejection: `"No goal to clear."` warning. Success: `wasCompleted ? "Completed goal cleared." : "Goal cleared."` info, widget update. The transition carries `goal: null` and the cleared tombstone as `state`.
7. **Too-long guard** (`:472–479`): `trimmedArgs.length > MAX_OBJECTIVE_LENGTH` (4000) → `notify("Goal objective too long (max 4000 characters). Put details in a file and reference it.", "error")`. This fires before any confirmation and only for the fallback set arm.
8. **Set + kickoff** (`:481–506`): if a live goal exists (`active` or `paused`) and `ctx.hasUI`, `await ctx.ui.confirm("Replace goal?", 'An active goal already exists: "<objective>". Replace it?')`; a declined confirmation returns silently (no notification, no transition). `setGoal(trimmedArgs, Date.now())`; its `!ok` branch returns silently (unreachable after the guard and trim: only `empty-objective` and `too-long` are possible, both excluded). Success: `applyTransition`, `notify('Goal set: "<objective>"', "info")`, widget update, then `pi.sendUserMessage(kickoff)` where the kickoff text is exactly:

	```
	Goal: <objective>

	Start working on this goal now. Plan your approach, then begin implementing. Use the goal tool to report checkpoints as you make progress. Work independently and keep going until the goal is fully achieved.
	```

Arm-order fact: `"edit"` and `"checkpoint"` without a trailing space do **not** match their prefixes and fall through to the set arm — `/goal edit` sets a goal whose objective is the word "edit". The same fallback applies to `"edit "`/`"checkpoint "` with a trailing space (the whole-args trim removes it before the prefix check) and to any other non-matching args such as `"pause x"` or `"resume x"`, which set goals with those literals as objectives. This quirk is preserved.

`applyTransition` (`:195–201`) is the adapter's single apply point: swap the module-level `goal` with `outcome.goal` and `pi.appendEntry(GOAL_CUSTOM_TYPE, { action, state })`.

### Prompt injection: `index.ts:215–228`

`before_agent_start` skips injection when `!goal || goal.status === "cleared" || goal.status === "completed"`, picks paused vs. active by status, and returns `{ systemPrompt: event.systemPrompt + "\n\n" + goalInstructions }`.

### Prompt builders and status formatting: `index.ts:513–577`

`buildActiveGoalPrompt` (31 lines, `:513–543`), `buildPausedGoalPrompt` (18 lines, `:545–562`), and `formatGoalStatus` (`:564–577`) are pure functions of `GoalState`. `formatGoalStatus` emits `Goal: / Status: / Created: / Updated:` plus optional `Last checkpoint:` and, for completed goals, `Completed:` lines, with `toLocaleString()` timestamps. The tools-todo extension already extracted its counterpart as `todo-prompt.ts`; the goal builders never were.

### Failure vocabulary: `index.ts:59–60`, `:163`, `:349`

`isGoalFailureText` tests `/^(Cannot checkpoint|Goal is already|Unknown action)/` and is consumed by (a) the `tool_result` error handler at `:163` alongside `Boolean(details?.error)`, and (b) `renderResult` at `:349` alongside `context.isError` and `details?.error`. The tool's failure paths (`execute`, `:253–333`):

- No-goal, non-status actions (`:261–265`): text `"No active goal."`, **`details.error` is set**, `isError: true`. The no-goal `status` call (`:255–259`) is a **success** result: no `details.error`, no `isError`.
- Checkpoint transition rejection (`:285–291`): text `` `Cannot checkpoint: goal is ${goal.status}.` ``, **`details.error` is NOT set**, `isError: true`.
- Complete transition rejection (`:306–312`): text `` `Goal is already ${goal.status}.` ``, **`details.error` is NOT set**, `isError: true`.
- Unknown action (`:326–331`): text `` `Unknown action: ${action}` ``, `details: {}`, `isError: true`. **Unreachable in production**: pi validates tool arguments against the typebox schema before `execute` (`validateToolArguments` throws on a non-enum `action`), so this branch only guards direct calls.

The regex exists because the two transition-rejection paths never set `details.error`. Runtime fact (verified in pi's agent core): a returned `isError: true` property on a tool result is **ignored** — the generic executor hardcodes `isError: false` unless `execute` throws — so the `registerToolErrorHandler` bridge is what turns these results into protocol errors, and its predicate is load-bearing for every live failure. The error handler only ever sees live tool results; `renderResult` also renders historical entries persisted before any change (entries from before the bridge landed in `23eb5da` were persisted without `isError` at all, so the text regex is the only classifier for them).

### Widget: `index.ts:62–186`

`GoalStatusWidget` (cached render keyed by width, Esc/Ctrl+C close) and `updateGoalWidget` (widget only while a live goal exists) stay in the adapter. Widget updates happen on `session_start`, `session_tree`, `turn_end`, and after every applied transition — never on the view arm or on rejections.

### Existing coverage

- `goal-state.test.ts`: 18 tests over reconstruction and every transition, including injected-timestamp determinism. Untouched by this plan.
- `index.test.ts`: 10 tests — 3 tool rendering/failure tests, 2 widget tests, 5 command-surface tests. All 5 command tests drive the registered handler through a fake `pi` harness and pin the documented messages via `ctx.ui.notify` mocks; one of them additionally pins `appendEntry` and `sendUserMessage` wiring.

### Cross-extension consumers

None. `workflows-goal` exports only its default extension function; no other extension imports from it.

## Related implementations deliberately left outside

- **The `goal` tool's success texts and result shapes** stay in the adapter. They have one consumer, three small cases, and no duplication; moving them would widen the module's interface for hypothetical leverage. Only the failure *signal* is unified (see Design decisions).
- **The `turn_end` completion notice** (`:235–241`, text `Goal completed: ${goal.completionSummary || goal.objective}`) stays in the adapter: one string, one call site. Observed pre-existing quirk: it re-notifies on every `turn_end` while the goal stays `completed`. Out of scope; flagged for a follow-up decision, unchanged by this plan.
- **The widget shell** (cached render + Esc/Ctrl+C close, duplicated four times across goal, todo, and `gui-option-list`) is architecture-review candidate 5, a separate seam with four adapters. Not this plan.
- **tools-todo's adapter-side branch reconstruction and diff math** is candidate 3. Not this plan.
- **`goal-state.ts` transitions** stay exactly as they are. The new module sits on top of them and changes nothing about their interface.

## Design decisions

| Decision | Final answer | Reason |
| --- | --- | --- |
| Module placement | New sibling file `workflows-goal/goal-commands.ts`. | One consumer, so `_shared/` would be a hypothetical seam. `goal-state.ts` stays pure state and its docstring already delegates interaction to callers; a sibling file matches the `todo-state.ts` / `todo-prompt.ts` precedent. |
| Interface shape | `runGoalCommand(goal, args, now, host): Promise<GoalCommandOutcome>` returning `{ notification, transition, kickoff }`. | One entry hides all eight arms (depth). Domain-shaped outcome, not Pi-shaped results — the adapter wraps, the module decides. A two-phase plan/execute interface would spread one decision across two calls. |
| Async | `async` unconditionally. | Only the set arm can await, but a sync/async split interface would leak which arms confirm. |
| Confirmation seam | `host.confirm(title, body): Promise<boolean>`; the module composes `"Replace goal?"` and the body text itself. | The module must own all user-visible text (message policy). A domain-typed `confirmReplace(objective)` would push the question text back into the adapter — the wrong direction. The host owns the asking mechanics only. |
| `hasUI` guard | Adapter-side, inside its `confirm` implementation: no UI → resolve `true` (proceed without asking). | Preserves current behavior exactly and keeps the module UI-agnostic. |
| Silent outcomes | Declined confirmation and the unreachable `setGoal` rejection return `notification: null`; the adapter notifies only when non-null. | Preserves both silent paths byte-for-byte; `null` is the explicit "stay silent" signal, not an empty string. |
| Widget policy | Stays adapter-side: update iff `outcome.transition` was applied (plus the existing events). No widget flag in the outcome. | A boolean the adapter could derive is a shallow pass-through field. |
| Severity vocabulary | Reuse `ctx.ui.notify`'s `"info" \| "warning" \| "error"` in `GoalNotification`. | No new vocabulary to invent or translate. |
| Prompt builders | New `goal-prompts.ts` exporting `goalPromptAddendum(goal): string \| null`; the two builders become private. | Matches the `todo-prompt.ts` precedent. The status→prompt decision (none for no goal, `cleared`, `completed`) moves off the adapter; the `"\n\n"` joiner stays adapter-side as Pi assembly mechanics. |
| `formatGoalStatus` | Private inside `goal-commands.ts`. | Single consumer (the view arm); not exported without a second consumer. |
| LLM tool surface | Texts and shapes stay in the adapter. Both transition-rejection paths gain `details.error`; the error handler reads `details.error` only; `renderResult` keeps the text regex as a documented fallback for historical entries. | One live failure vocabulary (`details.error`) without changing historical rendering or any tool text. Dropping `Unknown action` from the live predicate is safe because that branch is unreachable (schema validation rejects non-enum actions before `execute`). Moving the whole tool surface would be interface width for one consumer. |
| `now` injection | `runGoalCommand` takes `now` and passes it to every transition. | House style (goal-state transitions already inject timestamps); deterministic tests. |
| Testing | New tests at the module interfaces; delete the harness-based message tests; keep one adapter wiring test. | Replace, don't layer (DEEPENING.md): the interface is the test surface. |
| Documentation | Add a **Goal command module** entry to `CONTEXT.md` and amend the **Goal state module** entry. | Done inline during planning; the module name is settled. |

## Target interface and exact semantics

```ts
// goal-commands.ts
import type { AppliedGoalTransition, GoalState } from "./goal-state.ts";

/** One user-facing message: text plus the notify severity. */
export interface GoalNotification {
	text: string;
	severity: "info" | "warning" | "error";
}

/** What the adapter must do after one /goal invocation. */
export interface GoalCommandOutcome {
	/** Show via ctx.ui.notify; null means stay silent (declined confirmation). */
	notification: GoalNotification | null;
	/** Apply via applyTransition: adopt outcome.goal and append the entry. */
	transition: AppliedGoalTransition | null;
	/** Send via pi.sendUserMessage after applying a set transition. */
	kickoff: string | null;
}

/** Mechanics the module cannot own: asking the user. */
export interface GoalCommandHost {
	confirm(title: string, body: string): Promise<boolean>;
}

export function runGoalCommand(
	goal: GoalState | null,
	args: string,
	now: number,
	host: GoalCommandHost,
): Promise<GoalCommandOutcome>;
```

```ts
// goal-prompts.ts
import type { GoalState } from "./goal-state.ts";

/** System-prompt addendum for a live goal; null when nothing should be injected. */
export function goalPromptAddendum(goal: GoalState | null): string | null;
```

`runGoalCommand` semantics — the arm order and every string are exactly the inventory above:

- The module trims: `(args || "").trim()` — the same expression as today's adapter (pi's `RegisteredCommand.handler` types `args` as `string`, and both invocation sites always pass one), so the adapter cannot get it wrong. Empty → view arm.
- Arms are evaluated in order: view, `pause`, `resume`, `"edit "` prefix, `"checkpoint "` prefix, `clear`, too-long guard, set. `"edit"`/`"checkpoint"` without a trailing space fall through to set, preserving the quirk.
- Every success arm returns the transition from `goal-state` verbatim (`AppliedGoalTransition`), a notification whose text embeds the objective/summary exactly as today, and — for the set arm only — the kickoff text.
- Every rejection arm returns the mapped message with `warning` (or `error` for the too-long guard) and `transition: null`, `kickoff: null`.
- The set arm asks `host.confirm("Replace goal?", 'An active goal already exists: "<objective>". Replace it?')` only when the current goal is live (`active` or `paused`); the too-long guard runs before the confirmation; a declined confirmation yields `{ notification: null, transition: null, kickoff: null }`.
- The too-long message uses `MAX_OBJECTIVE_LENGTH` from `goal-state.ts` so the number cannot drift from the guard.
- `now` flows into every `goal-state` transition; the module never calls `Date.now()`.
- The module performs no I/O, no `ctx.*`, no `pi.*` calls; its only effect is the injected `confirm`.

`goalPromptAddendum` semantics:

- `null` goal, `cleared`, or `completed` → `null` (exact current guard).
- `paused` → the current `buildPausedGoalPrompt` text verbatim; otherwise the current `buildActiveGoalPrompt` text verbatim, including the `**Last Checkpoint:**` suffix when `checkpointProgress` is set.
- The `"\n\n"` joiner and the `{ systemPrompt }` return stay in the adapter.

## Adapter contract after migration

`index.ts` keeps: the tool registration (parameters, execute, `renderCall`, `renderResult`), the error-handler registration, `GoalStatusWidget` and `updateGoalWidget`, `reconstructState`, `applyTransition`, all `pi.on` lifecycle wiring, and the completion notice in `turn_end`. The command handler shrinks to:

```ts
handler: async (args, ctx) => {
	const outcome = await runGoalCommand(goal, args, Date.now(), {
		confirm: (title, body) =>
			ctx.hasUI ? ctx.ui.confirm(title, body) : Promise.resolve(true),
	});
	if (outcome.transition) applyTransition(outcome.transition);
	if (outcome.notification) {
		ctx.ui.notify(outcome.notification.text, outcome.notification.severity);
	}
	if (outcome.transition) updateGoalWidget(ctx);
	if (outcome.kickoff) pi.sendUserMessage(outcome.kickoff);
},
```

The apply → notify → widget → kickoff order matches today exactly. `before_agent_start` shrinks to the `goalPromptAddendum` call plus the joiner. `index.ts` stops importing `pauseGoal`, `resumeGoal`, `editGoal`, `setGoal`, `clearGoal`, and `MAX_OBJECTIVE_LENGTH`; it keeps `checkpointGoal` and `completeGoal` for the tool. Expected size: 577 → roughly 420 lines. Every command-arm notification, the confirmation text, and the kickoff move into the module; the adapter keeps only the tool surface's texts, the turn_end notice, the widget's own strings (including its duplicate of the view arm's "No active goal. Use /goal <objective> to set one." line), and the `registerCommand` description.

## Intentional observable changes

Exactly one:

1. The `goal` tool's checkpoint- and complete-transition rejections now set `details.error` (to the same string as the content text). Live tool results are classified as errors through `details.error` alone; texts, `isError`, and rendering are unchanged. Dropping the text regex from the live predicate changes nothing observable: the only regex-only live path, `Unknown action`, is unreachable (schema validation rejects non-enum actions before `execute`).

Not changes: historical tool results rendered after this change still classify through the preserved text fallback; session entries, tool shapes, widget behavior, and all command strings/severities/orders are identical.

## Migration sequence

1. Add `goal-commands.ts` and `goal-prompts.ts` with the interfaces and semantics above, plus their test files (below). Nothing imports them yet. Run `pnpm --dir .pi test:goal` — new tests pass against untouched production code.
2. Rewire `index.ts`: replace the command handler body with the adapter contract above; replace the `before_agent_start` body with the `goalPromptAddendum` call; delete `buildActiveGoalPrompt`, `buildPausedGoalPrompt`, `formatGoalStatus`, and the now-unused `goal-state` imports. In the tool's two transition-rejection returns, add `error: <same text>` to `details`, and change the error-handler predicate at `:163` to `Boolean(details?.error)` only, keeping the regex solely in `renderResult` with a comment marking it as the historical-entries fallback (the `Unknown action` branch needs no live coverage — schema validation makes it unreachable).
3. Prune `index.test.ts`: delete the four harness tests whose assertions moved to the module interface ("views, pauses, …", "rejects transitions from dead goals …", "confirms replacement …", "rejects oversized objectives …"). Keep the "sets a goal, persists it, and kicks off work" test as the adapter wiring pin, and keep the tool and widget tests; extend the rejected-checkpoint test to assert `details.error` is set. Run `pnpm --dir .pi test:goal`.
4. `CONTEXT.md` already carries the new **Goal command module** entry (done at planning); its wording was verified during this review against the planned host seam and outcome shape — the `runGoalCommand(goal, args, now, host)` signature, the `confirm(title, body)` host with the adapter-side `hasUI` guard, the null-notification silence signal, and the `goalPromptAddendum` decision all match, and the amended **Goal state module** entry now scopes the adapter's share to notification *delivery*. Run `pnpm --dir .pi typecheck`, then the full `pnpm --dir .pi test`.

## Test plan

Create `goal-commands.test.ts` and test through `runGoalCommand` only. The host is a stub: `{ confirm: vi.fn(async () => true) }`; goals are built through `goal-state` constructors or literal `GoalState` values; `now` is a constant. No Pi harness, no fake `ExtensionContext`.

### Arm and message cases

- View: no goal or cleared tombstone → `"No active goal. Use /goal <objective> to set one."` info, `transition` null. Active goal → text starts `"Goal: "`, contains `"Status: active"` and the checkpoint line when present; completed goal adds `"Completed: "`. `transition` null.
- Pause: active → `'Goal paused: "<objective>"'` info with `transition.action === "pause"` and `transition.state.updatedAt === now`; paused → `"Goal is already paused."` warning; completed → the completed message warning; null and cleared → `"No active goal to pause."` warning. All rejections: `transition` null.
- Resume: mirror of pause with `already-active` and `"No goal to resume."`.
- Edit: `'Goal updated: <objective>'` info with `transition.action === "set"`; no goal or cleared → `"No active goal to edit."` warning; `"edit"` and `"edit "` (trailing space) both trim to `"edit"` and set a goal named "edit" (quirk pin — the usage branch is unreachable through the trimmed surface); an objective longer than 4000 characters is accepted (quirk pin: edit has no length limit).
- Checkpoint: `"Checkpoint saved: <summary>"` info; paused, completed, cleared, and null goals all → `"No active goal to checkpoint."` warning; `"checkpoint"` and `"checkpoint "` (trailing space) both set a goal named "checkpoint" (quirk pin).
- Clear: active → `"Goal cleared."` info with the tombstone transition (`goal: null`, `state.status === "cleared"`); completed → `"Completed goal cleared."` info; null or cleared → `"No goal to clear."` warning.
- Set: success → `'Goal set: "<objective>"'` info, `transition.action === "set"`, and the kickoff text byte-identical to the inventory string; too long → the exact error text with `severity: "error"`, `transition` null, and `confirm` not called; timestamps in the transition equal the injected `now`.

### Confirmation cases

- Active or paused goal + set: `confirm` called once with `("Replace goal?", 'An active goal already exists: "<objective>". Replace it?')`.
- `confirm` resolves `false` → `{ notification: null, transition: null, kickoff: null }` — nothing to notify, nothing to persist.
- `confirm` resolves `true` → full success outcome; `confirm` awaited before any transition is produced.
- Cleared, completed, or null goal + set → `confirm` never called.
- Too-long objective → `confirm` never called (guard precedes confirmation).

### Prompt cases (`goal-prompts.test.ts`)

- `null`, `cleared`, and `completed` goals → `null`.
- Active goal → text starts `"## Active Goal"`, contains the objective, and appends `**Last Checkpoint:**` when `checkpointProgress` is set.
- Paused goal → text starts `"## Paused Goal"`, with the `**Last Checkpoint:**` suffix when `checkpointProgress` is set.
- No test pins the full prompt prose; the builders move verbatim and the interface pins the decision, not the prose.

### Adapter tests kept in `index.test.ts`

- The one wiring test: set command → `notify`, `appendEntry`, widget factory, `sendUserMessage` each called with the module's outcome (proves the adapter contract, not message policy).
- Tool rendering/failure tests (3), with the rejected-checkpoint assertion extended to `details.error`.
- Widget tests (2), untouched.

## Risks controlled by the checklist

- **Message drift.** Every arm's text and severity is pinned at the module interface; the kept wiring test proves the adapter forwards `notification.text` verbatim.
- **Arm-order drift.** The quirk pins (`"edit"` → set, `"checkpoint"` → set) and the too-long-before-confirm pin freeze the dispatch order.
- **Silent paths regressing into notifications.** Explicit `{ notification: null }` assertions for declined confirmation.
- **Confirmation text escaping.** The objective is embedded in a double-quoted body; the pin asserts the exact body string.
- **Historical rendering regression.** The text regex stays in `renderResult` only, commented as the fallback for entries persisted before `details.error` was always set; the error handler (live results only) drops it.
- **Kickoff drift.** The kickoff string is asserted byte-for-byte, including the two newlines around "Start working…".
- **`Date.now()` sneaking into the module.** The injected-`now` timestamp assertions in the set/pause cases catch it.

## Definition of done

- `goal-commands.ts` owns all eight arms' parsing, message policy, confirmation requirement, and kickoff; `goal-prompts.ts` owns the injection decision; `index.ts` keeps no `/goal` command-arm message text of its own — the tool surface's texts, the turn_end notice, the widget's own strings, and the command description remain.
- The four replaced harness tests are gone; module-interface tests cover every arm, every reachable rejection, every confirmation path, and the prompt decision.
- The `goal` tool classifies live failures through `details.error` alone, with every reachable failure path setting it (`Unknown action` is unreachable — schema validation rejects non-enum actions).
- `goal-state.ts` is untouched; session entries, tool shapes, and widget behavior are unchanged.
- `CONTEXT.md` matches the implemented module, host seam, and outcome shape.
- `pnpm --dir .pi typecheck` and the full `pnpm --dir .pi test` pass.