# Advisor extension — three issues from the post-implementation review

Follow-up to `advisor-gaps-plan.md`, after gaps 1–4 were implemented.

**Baseline at time of writing:** 29 tests passing (`npx vitest run extensions/tools-advisor`),
0 typecheck errors under `tools-advisor`. No correctness bugs found — the `consumedUses` →
`inFlight` refactor accounts correctly on all exit paths. These three are cleanup, a prompt
contradiction, and a cost decision.

---

## Issue 1 — `reconstruct()` / `usedUses()` are dead weight in production

**Severity:** no runtime impact; ~20 lines and one state variable of dead scaffolding.

### What's wrong

`usedUses()` has **zero production callers**. Verified:

```sh
grep -rn "usedUses" .pi/extensions/ | grep -v "tools-advisor/runner.ts\|tools-advisor/runner.test.ts\|tools-advisor/index.test.ts"
# (no output)
```

That makes the whole chain vestigial:

```
reconstruct()  →  reportedTurnUses  →  usedUses()  →  nothing
```

- `runner.ts:77` — `reportedTurnUses` exists only to serve `usedUses()`.
- `runner.ts:79` — `reconstruct()` now does nothing *but* set `reportedTurnUses`.
- `runner.ts:216` — `usedUses: () => reportedTurnUses + inFlight`, read only by tests.
- `index.ts:285` and `index.ts:451` — both `runner.reconstruct(ctx)` call sites are therefore
  no-ops in production.

This is leftover from the pre-change design, where an in-memory counter genuinely had to be
rebuilt after branch navigation. Deriving the count from the branch inside `execute()` is the
robustness win of the new design — it just made the old scaffolding redundant, and the
scaffolding stayed.

### Decide first

`usedUses()` is on the exported `AdvisorRunner` interface (`runner.ts:54`). Two valid outcomes:

- **(a) Delete it** — nothing surfaces consultation counts today.
- **(b) Keep and wire it** — if `/context` should show "2/3 consultations used this turn",
  keep the method but give it a real consumer, and keep `reconstruct()` so the display stays
  fresh after branch navigation.

Recommend **(a)**. Option (b) is only worth it if the diagnostic is actually wanted; adding it
later is cheap because the counting logic (`countAdvisorUses`) stays either way.

### Fix for (a)

1. `runner.ts` — delete `reportedTurnUses` (line 77) and its comment (line 76).
2. `runner.ts` — delete `reconstruct()` (lines 79–81) and drop `reconstruct` from the returned
   object and from the `AdvisorRunner` interface (line ~52).
3. `runner.ts` — delete `usedUses()` from the returned object (line 216) and the interface
   (line 54).
4. `runner.ts` — keep `countAdvisorUses` and `inFlight` untouched; they do the real work.
5. `index.ts:285` — remove the `runner.reconstruct(ctx)` line from `loadForSession`.
6. `index.ts:451` — remove the `session_tree` handler entirely if `reconstruct` was its only
   body (confirm nothing else was added to it first).

### Test fallout

- `runner.test.ts` — "scopes the reconstructed count to the current turn after the last user
  message" and the `usedUses()` assertion near it both go away. The behaviour they cover is
  already pinned by "resets the per-turn budget on a new user message", which exercises it
  through `execute()` rather than through a test-only accessor — that is the better test and
  should stay.
- `index.test.ts:195` — "keeps the advertised tool after /advisor off and reconstructs budget
  on tree events". Split it: keep the "advertised tool after /advisor off" half, drop the
  reconstruct half.
- `index.test.ts:266` — "persists a budget marker when an in-flight consultation is aborted and
  reconstructs it after reopening". The persistence half is valuable and should be kept,
  rewritten to assert through `execute()` (a second call after reopening is refused) rather
  than through `reconstructed.usedUses()`.

### Verify

`npx vitest run extensions/tools-advisor` and confirm the per-turn/session budget tests still
pass — they are the real coverage for this logic.

---

## Issue 2 — the prompt states two different word limits

**Severity:** low cost, but it undercuts the change that Gap 3 was meant to deliver.

### What's wrong

`prompt.ts:17` (inside `ADVISOR_SYSTEM_PROMPT`)
```
Return concise guidance under 150 words with these sections:
```

`prompt.ts:28` (`ADVISOR_WORD_LIMIT_INSTRUCTION`, injected into the final user message)
```
(Advisor: keep your guidance under 120 words — I need a focused starting point, not a comprehensive plan.)
```

The advisor sees both. The docs' guidance — *"ask for roughly 80 percent of your true ceiling"*
— means pick 150 **privately** and *ask* for 120. It does not mean publishing both numbers.
Stating 150 in the system prompt is explicit permission that undercuts the 120 ask; a model
reading both will reasonably treat 150 as the real bound and 120 as a preference.

This one came from an ambiguity in `advisor-gaps-plan.md`, which wrote "120 = 80% of a 150-word
ceiling" without saying the 150 should stay unstated. The implementation followed the plan
literally.

### Fix

Remove the number from the system prompt, keep the section list, and let the user-message ask
carry the limit alone. `prompt.ts:17`:

```ts
// before
Return concise guidance under 150 words with these sections:
- Recommended course
- Key risks

// after
Return concise guidance with these sections:
- Recommended course
- Key risks
```

Leave `ADVISOR_WORD_LIMIT_INSTRUCTION` at 120 words — the placement (user message, addressed to
the advisor) is already the one the docs found most effective.

Alternative if a hard number in the system prompt is wanted for belt-and-braces: set **both**
to 120. Do not leave two different figures.

### Do not touch `maxTokens`

`advisor.maxTokens` stays at 2048. It is the hard ceiling over thinking **plus** text, and
`runner.ts` has an `advisor_empty` path for exactly the case where reasoning consumes the whole
budget. Cutting it to "match" 120 words converts a soft prompt constraint into paying full
input cost for zero advice.

### Test fallout

- `transcript.test.ts:82` asserts `toContain("keep your guidance under 120 words")` — unaffected
  by this change, since only the system-prompt line moves.
- Consider adding an assertion that the projected system prompt contains no second word figure,
  so this can't regress.

### Verify

Behavioural, not unit-testable: run a few real consultations and check the advice still lands
near 120 words rather than drifting to 150.

---

## Issue 3 — the per-session spend ceiling more than doubled

**Severity:** intended direction, but currently inherited by default rather than chosen.

### What's wrong

Nothing is broken. But `.pi/settings.json` still reads:

```json
"advisor": {
  "provider": "openai-codex",
  "modelId": "gpt-5.6-sol",
  "maxUses": 3,
  "maxTokens": 2048,
  "allowCrossProvider": true
}
```

`maxUses: 3` was written under the **old per-session** meaning. It now means **per turn**, and
`maxUsesPerSession` is absent so it defaults to `DEFAULT_MAX_USES_PER_SESSION = 20`
(`runner.ts:14`).

| | before | after |
|---|---|---|
| consultations per session | 3 | up to 20 (3 per turn) |
| approx. cost per call | ~$0.70 | ~$0.25 (after the `contextBudget` work) |
| **per-session ceiling** | **~$2.10** | **~$5.00** |

More calls at lower unit cost is the direction the reference economics assume, and it is what
Gap 4 was for. The point is that the ceiling **went up**, by a factor inherited from a default
rather than picked — and this setup is cross-provider (`ollama` executor → `openai-codex`
advisor), so every consultation is a cold read with no cache benefit to amortise it.

### Fix

Set `maxUsesPerSession` explicitly in `.pi/settings.json` rather than inheriting 20:

```json
"advisor": {
  "provider": "openai-codex",
  "modelId": "gpt-5.6-sol",
  "maxUses": 3,
  "maxUsesPerSession": 10,
  "maxTokens": 2048,
  "allowCrossProvider": true
}
```

10 puts the ceiling near ~$2.50 — roughly the old budget, with the calls distributed the way
the design intends (2–3 per task) instead of 3 for the whole session. Raise it once real usage
shows the turn budget is the binding constraint rather than the session one.

### Also worth doing

Record the semantics change somewhere durable — `maxUses` silently changed meaning, so anyone
(including future you) reading an existing `settings.json` will misread it. A line in the repo
README or a comment where the setting is parsed is enough.

### Verify

After a few sessions, check actual advisor call counts and cost against the ceiling. If
sessions routinely hit 10, the turn budget is doing its job and the session cap can rise; if
they never exceed 4–5, lower it.

---

## Also noted during review (not part of the three)

Small, independent, safe to skip:

- **Boolean parameter reads poorly.** `countAdvisorUses(branch, true)` / `(branch, false)`
  (`runner.ts:221`). Two thin wrappers — `countTurnUses(branch)` / `countSessionUses(branch)` —
  would make the call sites self-describing.
- **`DEFAULT_MAX_USES` is duplicated.** Independent literals at `index.ts:36` and `runner.ts:13`
  that must stay in sync by hand. The new `DEFAULT_MAX_USES_PER_SESSION` (defined once in
  `runner.ts:14`, re-exported from `index.ts:33`) is the better pattern; align the old one to it.
- **`index.test.ts:195` name overstates its fixture.** Its branch contains no user message, so it
  no longer exercises turn scoping. Superseded by the new `runner.test.ts` cases; this resolves
  itself if Issue 1 is fixed.

## Suggested order

1. **Issue 3** — one settings edit, no code, immediate cost effect.
2. **Issue 2** — one-line prompt edit; do it before collecting advice-quality data so the
   observations are against the final prompt.
3. **Issue 1** — the largest diff and the only one touching test structure; do it last, when
   nothing else is in flight.
