# Plan — `/advisor` strict mode

Add a third mode to `/advisor` so the advisor can be forced to trigger on models
that will not self-elect.

**Status:** plan only. No code in this document has been applied.

---

## Why

Measured across four fresh sessions:

| Executor | Advisor tool in manifest | Spontaneous consults |
|---|---|---|
| `ollama/deepseek-v4-flash` | yes (verified, item 7) | **0 of 3 tasks** |
| `openai-codex/gpt-5.6-luna` | yes | fires |

Same system prompt, same guidelines, same tool — only the executor differs. Two
rounds of guideline rewording (`ADVISOR_PROMPT_GUIDELINES`) changed nothing on
deepseek. The tool works when invoked explicitly and returns good advice.

Conclusion: `deepseek-v4-flash` does not act on soft "consider consulting" guidance.
The fix cannot be prompt wording — it has to be a harness-enforced nudge, which is
what Anthropic's docs prescribe for the same failure on Haiku (+7pp).

Switching the executor to luna is not the answer: the advisor's whole economic
premise is a cheap executor plus a strong advisor, and the docs note the benefit
shrinks as the executor approaches the advisor in capability. Keep deepseek; force
the consult.

---

## UX

`/advisor` with no argument opens a three-option `SelectList`:

| Option | Behaviour |
|---|---|
| `on` | Model picker, exactly as today. Advisor available; the model decides when to call it. |
| `strict` | Model picker, then enable the nudge. Advisor available **and** prompted if unused by turn N. |
| `off` | Disable, exactly as today. |

Argument forms all keep working, with two additions:

```
/advisor                     → three-option menu
/advisor off                 → disable                      (unchanged)
/advisor <provider>/<model>  → set model, mode unchanged     (unchanged)
/advisor on                  → model picker, strict = false
/advisor strict              → model picker, strict = true
```

`getArgumentCompletions` currently only offers `off` — extend it to
`["on", "strict", "off"]`.

Status line: `Advising · <model>` becomes `Advising (strict) · <model>` when strict
is on, so the mode is visible without running the command.

---

## Settings

Two new fields on the `advisor` block, matching the existing flat-scalar style:

```json
"advisor": {
  "provider": "openai-codex",
  "modelId": "gpt-5.6-sol",
  "strict": true,
  "nudgeTurn": 3,
  "maxUses": 3,
  "maxUsesPerSession": 10,
  "maxTokens": 2048,
  "allowCrossProvider": true,
  "contextBudget": { ... }
}
```

| Field | Type | Default | Meaning |
|---|---|---|---|
| `strict` | boolean | `false` | Enable the nudge |
| `nudgeTurn` | positive integer | `3` | Nudge if no consult by this assistant turn within the current user turn |

**Mode is derived, not stored** — there is no `mode` field:

- no `provider`/`modelId` → **off**
- model set, `strict: false` → **on**
- model set, `strict: true` → **strict**

This keeps the existing "off means no model configured" representation, so no
migration is needed. An existing `settings.json` without `strict` defaults to
`false` and behaves exactly as today.

`disableAdvisorSettings` (the `/advisor off` kill switch) **must force
`strict: false`** — off has to mean off, including the nudge. It already forces
`allowCrossProvider: false`; follow that pattern, and keep the `try/catch` tolerance
for malformed values that `contextBudget` uses.

### Why `nudgeTurn` defaults to 3

Anthropic's reference uses 2, but warns that a nudge landing before the model has
read the problem produces a low-context consult that displaces a better-timed one —
measured at 3–4pp of task performance. The three failing transcripts show orientation
running 4–8 tool calls before the first real judgment, so 3 leaves room to orient
without waiting until the approach has set. Tunable per project.

---

## The nudge

### Mechanism

`auto-compact/index.ts:108` already proves the pattern works in this repo:

```ts
pi.on("turn_end", (event, ctx) => { ... });
pi.sendMessage(
  { customType: "...", content: "...", display: false },
  { deliverAs: "followUp", triggerTurn: true },
);
```

**Use `deliverAs: "steer"`, not `"followUp"`.** Per the extension docs:

- `"steer"` — delivered after the current assistant turn finishes its tool calls,
  **before the next LLM call**. This is where the nudge belongs: mid-run, while the
  agent can still change approach.
- `"followUp"` — waits until the agent has no more tool calls. Too late; by then the
  recommendation is already written. (auto-compact wants `followUp` because it is
  resuming after compaction — different goal.)

`triggerTurn` should be `false`. The nudge rides the run already in progress; it must
never start a turn on an idle session.

`display: false` keeps it out of the TUI. Note it *does* enter LLM context and will
therefore appear in the advisor's own transcript on a later consult — a few tokens,
acceptable.

### Nudge text

Adapted from the reference, naming the tool as pi's docs require
(*"Each guideline must name the tool it refers to"* — same reasoning applies here):

```
You have not consulted advisor yet on this task. If it involves a non-obvious
design decision, a recommendation you are about to commit to, or a failure mode
you have not ruled out, call advisor now before going further.
```

### Guards

All five must pass before nudging:

1. `strict` is on **and** a model is configured (not off).
2. At least `nudgeTurn` assistant turns have elapsed **within the current user turn**.
3. No advisor consult has happened in the current user turn.
4. No nudge has already been sent in the current user turn.
5. The per-turn budget (`maxUses`) is not already exhausted — nudging toward a call
   that will be refused is worse than silence.

### Where the state lives

**Derive all of it from the session branch. Do not add in-memory counters.**

This is the same decision made when fixing the per-turn budget (see `fix.md` Issue 1):
counting from `ctx.sessionManager.getBranch()` at the moment of use is robust against
branch navigation, session reopen, and event-delivery gaps — and it means the nudge
and the budget agree by construction rather than by coincidence.

`runner.ts` already has the helper shape to copy: `countAdvisorUses(branch, afterLastUser)`
scans back to the last `role: "user"` entry. Three counts are needed, all scoped the
same way:

- assistant messages since the last user message → the turn index (guard 2)
- advisor `toolResult` entries with `consumesBudget` since the last user message → guard 3
  (this is exactly `countTurnUses`, already exported-adjacent in `runner.ts`)
- custom entries of type `advisor-nudge` since the last user message → guard 4

Consider exporting the scan helper from `runner.ts` rather than duplicating the
"walk back to the last user message" loop in `index.ts`.

Do **not** use `event.turnIndex` for guard 2 — it is documented as per-turn but its
reset semantics across user messages are unverified. Branch scanning is unambiguous.

---

## Files to change

| File | Change |
|---|---|
| `runner.ts` | Add `strict: boolean` and `nudgeTurn: number` to `AdvisorSettings`. Export the branch-scan helper for reuse. Add `DEFAULT_NUDGE_TURN = 3` next to the other defaults. |
| `index.ts` | Three-option `SelectList` on bare `/advisor`; handle `on`/`strict` args; extend `getArgumentCompletions`; parse + serialize the two new fields; force `strict: false` in `disableAdvisorSettings`; add the `turn_end` nudge handler; show strict in the status line. |
| `prompt.ts` | Add `ADVISOR_NUDGE_MESSAGE`. Leave `ADVISOR_PROMPT_GUIDELINES` alone — it is already correct for models that read it. |
| `.pi/settings.json` | Add `"strict": true` once the feature works. |

No changes to `transcript.ts`.

---

## Tests

**Settings (`index.test.ts`)**
- Defaults: `strict: false`, `nudgeTurn: 3`.
- `strict` rejects non-boolean; `nudgeTurn` rejects `0` and negatives (reuse `positiveInteger`).
- `/advisor off` forces `strict: false` even when it was `true`.
- The kill switch survives a malformed `strict` value.

**Nudge (new `nudge.test.ts`, or extend `index.test.ts`)**

One test per guard, each asserting `sendMessage` is *not* called:
- advisor off → no nudge
- `strict: false` → no nudge
- fewer than `nudgeTurn` assistant turns → no nudge
- advisor already consulted this user turn → no nudge
- nudge already sent this user turn → no nudge
- per-turn budget exhausted → no nudge

Plus the positive case: strict on, `nudgeTurn` turns elapsed, no consult →
`sendMessage` called once with `deliverAs: "steer"`, `triggerTurn: false`,
`display: false`.

And the reset: after a new user message, the nudge is eligible again.

**Command (`index.test.ts`)**
- Bare `/advisor` presents three options.
- `/advisor strict` sets `strict: true`; `/advisor on` sets it to `false`.
- `/advisor off` still disables and now also clears `strict`.

---

## Open decisions

**1. Does `/advisor strict` re-run the model picker when a model is already set?**

- *Always pick* — predictable, matches "strict = on + nudge", but forces re-selecting
  the same model just to flip a flag.
- *Flip only* — `/advisor strict` toggles the flag when a model is configured, and
  only picks when none is; the bare-`/advisor` menu always picks after on/strict.

Recommend **flip only** for the explicit-argument form. It matches how a user would
expect `/advisor strict` to behave on an already-working setup, and the menu path
still offers full configuration.

**2. Should strict suppress itself in plan mode?**

`workflows-plan-mode` restricts tools and runs a different profile. A nudge mid-plan
may be unwanted, or may be exactly right. Leave it firing for now; revisit if it
proves noisy.

**3. Per-turn or per-task?**

Guards are scoped to the user turn, consistent with `maxUses`. A long multi-turn task
therefore gets one nudge per user message. That seems right — each user message is a
new opportunity to go wrong — but watch for it feeling repetitive.

---

## Verification

- `npx vitest run extensions/tools-advisor` — 28 passing today.
- `.pi/node_modules/.bin/tsc --noEmit -p .pi/tsconfig.json` — 0 `tools-advisor` errors today.
- **The real test:** re-run the auto-compact task verbatim on `deepseek-v4-flash` with
  `strict` on. It is the task with three clean baseline failures, so a consult there is
  unambiguous evidence the nudge works where wording did not.
- Then check the nudge lands with enough context to be useful — if the consult reads as
  low-context, raise `nudgeTurn`.
