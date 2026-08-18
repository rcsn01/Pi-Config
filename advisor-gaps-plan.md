# Advisor extension — plan to close four prompt/budget gaps

**Status:** plan only. No code in this document has been applied.

## Scope

Four gaps between `.pi/extensions/tools-advisor` and the behaviour Anthropic's
`advisor_20260301` tool documents
([docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/advisor-tool)).
All four are about **how the executor is told to use the advisor** and **how often it may** —
none are about payload size.

Explicitly **out of scope**: the `contextBudget` work already applied to `transcript.ts`
(thinking/tool-result/tool-schema compression). That addressed per-call input cost and is
orthogonal to everything below. It changed no prompt text and no budget logic.

Gaps 1–3 live entirely in `prompt.ts`, which the budget work never touched.
Gap 4 lives in `runner.ts`.

---

## Gap 1 — the executor is never told the full transcript is forwarded

### Current state

`prompt.ts:1`
```ts
export const ADVISOR_TOOL_DESCRIPTION =
	"Ask a stronger read-only model for guidance on a difficult decision. The advisor cannot use tools or change the repository; the executor remains responsible for all actions and verification.";
```

`index.ts:345`
```ts
parameters: Type.Object({
	question: Type.Optional(Type.String({ description: "Optional focus question for the advisor" })),
}),
```

Nothing states that `projectTranscript` forwards the system prompt, tool manifest, prior
turns and tool results automatically. From the executor's side `question` looks like the
channel through which the advisor learns anything.

### Why it matters

Anthropic's prompt blocks lead with this, in both the coding and the Haiku variants:

> It takes NO parameters — when you call advisor(), your entire conversation history is
> automatically forwarded. They see the task, every tool call you've made, every result you've seen.

Two failure modes when it's unstated: the executor spends output tokens re-summarising
context the advisor already has, and — worse — it under-shares, asking a narrow question
while assuming the advisor cannot see the evidence behind it.

Pi diverges from the reference here by design: `question` exists and is genuinely useful as a
focus hint. The fix is to keep the parameter and correct its *semantics*, not remove it.

### Proposed change

Rewrite `ADVISOR_TOOL_DESCRIPTION` (`prompt.ts:1`) along these lines:

```ts
export const ADVISOR_TOOL_DESCRIPTION =
	"Consult a stronger read-only model on a difficult decision. Your entire conversation is forwarded automatically — the task, every tool call you have made, every result you have seen, and your own reasoning. You do not need to summarise any of it. The optional `question` only sharpens the focus; omit it to ask for guidance on the most important next step. The advisor cannot use tools or change the repository; you remain responsible for all actions and verification.";
```

And restate the parameter description at `index.ts:346`:

```ts
question: Type.Optional(Type.String({
	description: "Optional focus for the advisor. The full conversation is forwarded either way — do not restate context here.",
})),
```

### Files

- `prompt.ts` (`ADVISOR_TOOL_DESCRIPTION`)
- `index.ts:346` (parameter description)

### Test fallout

None expected — no test asserts on either string today. Consider adding one that pins the
"forwarded automatically" claim, so a future edit can't silently drop it.

### Risk

Longer tool description costs tokens in *every* executor request, not just advisor calls.
The draft above is ~85 tokens vs ~40 today. That is the correct trade (it is read constantly
and shapes every call decision) but it is a real cost and should be a deliberate choice.

---

## Gap 2 — no guidance on how to treat the advice once it arrives

### Current state

`prompt.ts:4`
```ts
export const ADVISOR_PROMPT_GUIDELINES = [
	"Use advisor after initial read-only orientation and before a consequential design decision on a complex task.",
	"Use advisor after repeated failure or before completing a high-risk change.",
	"Skip advisor for simple lookups, mechanical edits, and steps dictated by fresh evidence.",
];
```

All three bullets are *when to call*. Nothing covers *what to do with the answer*.

### Why it matters

The reference splits guidance into two blocks and places the second immediately after the
timing block. Its content, paraphrased:

- Give the advice serious weight.
- Adapt only on empirical failure or primary-source contradiction — a passing self-test is
  not evidence the advice is wrong, it is evidence the test doesn't check what the advice checks.
- On conflict with evidence you already gathered, **do not silently switch**. Spend one more
  advisor call to reconcile: "I found X, you suggest Y, which constraint breaks the tie?"

Without this, a consultation that costs a full transcript read gets politely acknowledged and
then ignored — the worst possible return on the spend. The reconcile rule also matters
because it is the one case where a *second* call is the cheap option.

### Proposed change

Extend `ADVISOR_PROMPT_GUIDELINES` with three reception bullets, keeping the existing three
timing bullets first so the ordering matches the reference:

```ts
export const ADVISOR_PROMPT_GUIDELINES = [
	// when to call
	"Use advisor after initial read-only orientation and before a consequential design decision on a complex task.",
	"Use advisor after repeated failure or before completing a high-risk change.",
	"Skip advisor for simple lookups, mechanical edits, and steps dictated by fresh evidence.",
	// how to treat the answer
	"Give the advice serious weight; it is the reason you paid for the consultation.",
	"Depart from it only on empirical failure or primary-source contradiction. A passing self-test is not evidence the advice is wrong — it is evidence your test does not check what the advice checks.",
	"If the advice conflicts with evidence you already gathered, do not silently switch. Ask the advisor once more to reconcile: state what you found, what it suggested, and which constraint breaks the tie.",
];
```

### Files

- `prompt.ts` (`ADVISOR_PROMPT_GUIDELINES`)

### Test fallout

None — no test asserts on the array's contents or length.

### Open question

The reconcile bullet tells the executor to spend a second call. That directly interacts with
Gap 4: under today's 3-per-**session** cap, following this advice can exhaust the budget on a
single disagreement. **Sequence Gap 4 before or with Gap 2**, or the new guidance will
frequently hit `advisor_budget_exhausted`.

---

## Gap 3 — the 400-word limit is ~5x the documented figure

### Current state

Stated twice.

`prompt.ts:12` (inside `ADVISOR_SYSTEM_PROMPT`)
```
Return concise guidance under 400 words with these sections:
- Recommended course
- Key risks
- Missing evidence
- Verification steps
```

`prompt.ts:24`
```ts
export const ADVISOR_WORD_LIMIT_INSTRUCTION = "Keep your advice under 400 words.";
```

Injected into the final user message by `buildAdvisorFocusMessage` (`prompt.ts:26`).

### Why it matters

The docs put advisor output at 400–700 text tokens typically and call it "the advisor's
largest cost driver". Their suggested ceiling is **~80 words**, delivered as a line in the
user message addressed to the advisor:

> (Advisor: please keep your guidance under 80 words — I need a focused starting point, not a comprehensive plan.)

Two secondary findings worth carrying over:

- Ask for **~80% of your true ceiling**; the limit is soft and gets exceeded.
- The tighter limit *increased* consult frequency while still lowering total cost — more
  calls, each much shorter.

Pi's placement is already right (user message, advisor-directed). Only the number and the
phrasing are off.

### This is not a one-line number change

**80 words cannot carry four sections.** `ADVISOR_SYSTEM_PROMPT` mandates *Recommended
course / Key risks / Missing evidence / Verification steps* — roughly 20 words per section at
an 80-word budget, which produces four stubs rather than one useful answer. The section list
and the word limit must be changed together. Three coherent options:

| Option | Limit | Sections | Notes |
|---|---|---|---|
| A — match reference | ~80 words | drop to free-form, or *Recommended course* only | Biggest saving; loses the structured risk/verification prompts |
| B — middle | ~150 words | *Recommended course* + *Key risks* | Keeps the two sections that most change executor behaviour |
| C — status quo minus | ~250 words | all four, explicitly "one or two lines each" | Smallest change, smallest saving |

Recommend **B** as the default and A as an opt-in, because *Missing evidence* and
*Verification steps* are the two sections most often re-derivable by the executor itself,
while *Key risks* is the one that most reliably changes what it does next.

### Do not scale `maxTokens` down to match

`settings.json` currently sets `advisor.maxTokens: 2048`. 400 words ≈ ~530 tokens, so today
there is ~1500 tokens of headroom that reasoning models spend on thinking. `runner.ts` has
two failure paths that exist precisely for this:

- `advisor_truncated` — `stopReason === "length"`
- `advisor_empty` — *"The advisor returned no visible advice. Its response may have used the
  output budget for reasoning."*

The word limit is a **soft, prompt-side** constraint; `maxTokens` is the **hard** ceiling
covering thinking + text. Cutting `maxTokens` proportionally would convert a soft budget into
frequent `advisor_empty` results — paying full input cost for zero advice. **Leave
`maxTokens` at 2048** when lowering the word limit, and revisit only after observing real
`stopReason` values.

### Proposed change

- `prompt.ts:12` — replace the section block per the chosen option above.
- `prompt.ts:24` — re-address it to the advisor and set the limit to ~80% of the true ceiling:
  ```ts
  export const ADVISOR_WORD_LIMIT_INSTRUCTION =
  	"(Advisor: keep your guidance under 120 words — I need a focused starting point, not a comprehensive plan.)";
  ```
  (120 = 80% of a 150-word ceiling under option B.)
- Consider promoting the number to a setting (`advisor.adviceWordLimit`) so it can be tuned
  without a code edit, following the `contextBudget` precedent.

### Files

- `prompt.ts` (`ADVISOR_SYSTEM_PROMPT`, `ADVISOR_WORD_LIMIT_INSTRUCTION`)
- optionally `index.ts` + `runner.ts` if it becomes a setting

### Test fallout

- **`transcript.test.ts:82`** asserts `toContain("Keep your advice under 400 words.")` — will
  fail and must be updated. This is the only hard-pinned string among gaps 1–3.

### Verification

Word limits are quality-sensitive in a way the other three gaps are not. Run a handful of real
consultations at 400 vs the new limit on the same transcript and compare whether the advice
still changes what the executor does. The saving here (a few hundred output tokens) is far
smaller than the `contextBudget` saving, so this is the gap where quality should win ties.

---

## Gap 4 — `maxUses` is per session; the reference is per task

### Current state

`runner.ts:72`
```ts
function reconstruct(ctx: ExtensionContext): void {
	consumedUses = ctx.sessionManager.getBranch().reduce((count, entry) => {
		if (entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.toolName !== "advisor") {
			return count;
		}
		const details = entry.message.details as Partial<AdvisorToolDetails> | undefined;
		return details?.consumesBudget === true ? count + 1 : count;
	}, 0);
}
```

`runner.ts:92`
```ts
const maxUses = validPositiveInteger(input.settings.maxUses, DEFAULT_MAX_USES);
if (consumedUses >= maxUses) {
	return localFailure(
		"advisor_budget_exhausted",
		`The advisor consultation budget is exhausted (${maxUses} uses per session). Continue without another consultation.`,
	);
}
```

`reconstruct` counts advisor results across the **entire branch**; the check is global to the
session; the message tells the model to stop consulting permanently.

Wiring: `index.ts:442` — `pi.on("session_tree", async (_event, ctx) => runner.reconstruct(ctx))`.

### Why it matters

Anthropic's `max_uses` is **per request**, and one request there spans a whole agentic loop —
their guidance targets **2–3 calls per task**, with an explicit expectation of one call before
committing to an approach and one before declaring done.

Pi's nearest equivalent to "one request" is **one user turn**: from a user message until the
agent hands control back. Counting across the whole session means a long session gets three
consultations *total*, which:

- starves the reconcile pattern from Gap 2 (a single disagreement can consume the remaining budget);
- pushes calls far apart in wall-clock time, which is exactly the shape that never benefits
  from prompt caching (advisor-side caching breaks even at ~3 calls in one conversation);
- makes the `advisor_budget_exhausted` copy actively wrong — it tells the model to stop for
  good when the right instruction is "not again on this turn".

### Proposed change

Scope the counter to the current turn, with a session-level safety net.

**1. Scope the reconstruction.** Count only advisor results appearing **after the last
`role: "user"` message** in the effective branch:

```ts
function reconstruct(ctx: ExtensionContext): void {
	const branch = ctx.sessionManager.getBranch();
	let start = 0;
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry.type === "message" && entry.message.role === "user") { start = index; break; }
	}
	consumedUses = branch.slice(start).reduce(/* same predicate as today */);
}
```

**2. Do not depend on event timing.** Today the in-memory `consumedUses` is only refreshed by
the `session_tree` event. It is unverified whether that fires when a new user message is
appended — if it does not, the turn counter would never reset. Make `execute` derive its
baseline from the branch itself rather than trusting the cached counter, keeping the
synchronous in-memory increment purely as an in-flight reservation for concurrent calls within
one turn. This makes correctness independent of event delivery.
**Verify the `session_tree` firing behaviour before relying on either path.**

**3. Two limits, not one.** Add a session ceiling so a runaway loop cannot consult unboundedly:

| Setting | Default | Meaning |
|---|---|---|
| `advisor.maxUses` | 3 | per user turn (semantics change; name kept) |
| `advisor.maxUsesPerSession` | e.g. 20 | hard stop across the session |

Alternative: keep `maxUses` meaning session and add `maxUsesPerTurn`. Prefer changing
`maxUses`'s meaning, since per-turn is the semantics that should be reached for by default —
but note this **silently changes behaviour for anyone with an existing `maxUses` in
settings.json**, so it needs a changelog line.

**4. Fix the copy.** Two distinct messages:

- turn budget: `"The advisor consultation budget for this turn is exhausted (N uses per turn). Continue without another consultation; the budget resets on the next user message."`
- session ceiling: keep wording close to today's, since that one really is terminal.

Consider distinct codes (`advisor_turn_budget_exhausted` / `advisor_budget_exhausted`) so the
two are separable in `/context` diagnostics.

### Files

- `runner.ts` — `reconstruct`, the `execute` precondition, both messages, `AdvisorSettings`
- `index.ts` — `parseAdvisorSettings`, `serializedAdvisorSettings`, the disable kill-switch
  path (which rebuilds settings from raw values and must tolerate a malformed new field, same
  pattern already used for `contextBudget`)

### Test fallout

- `runner.test.ts:168` — exhaustion test uses `maxUses: 1` with two calls and no intervening
  user message. Still valid under per-turn semantics; assertion text may need updating if the
  message changes.
- `runner.test.ts:176` — "reconstructs the count from the active branch" uses a fixture with
  **no user message**. Under the new scoping, `start` stays 0 and the count is unchanged, so
  this should still pass — but it no longer tests what its name says. Add a sibling test with a
  user message partway through to pin the reset.
- `index.test.ts:195` — "reconstructs budget on tree events", fixture is a single advisor
  toolResult with no user message. Same situation.
- `index.test.ts:266` — abort/persistence test; verify the reconstructed count still reads 1
  after reopening.
- New tests needed: budget resets on a new user message; session ceiling still bites when the
  per-turn budget keeps resetting.

### Risk

This is the only gap of the four that changes runtime behaviour rather than prompt text, and
it **raises** spend — more consultations per session by design. That is the intended direction
(the reference expects 2–3 per task and the economics assume repeat calls), but it should land
*after* the `contextBudget` reduction is confirmed working, so per-call cost is already down
before per-session call count goes up.

---

## Suggested sequencing

1. **Gap 4** — unblocks Gap 2's reconcile guidance and is the only behavioural change; land and
   observe it first.
2. **Gap 2** — depends on Gap 4 for its reconcile bullet to be usable.
3. **Gap 1** — independent, low risk, pure prompt text.
4. **Gap 3** — last, because it is the most quality-sensitive and needs its own A/B.

Gaps 1–3 are all `prompt.ts` and could ship as one commit if preferred; keeping Gap 3 separate
makes it easier to revert if advice quality drops.

## Verification for the whole set

- `npx vitest run extensions/tools-advisor` — currently 26 passing.
- `.pi/node_modules/.bin/tsc --noEmit -p .pi/tsconfig.json` — currently 0 errors under
  `tools-advisor` (pre-existing errors elsewhere in `extensions/previous-message` are unrelated).
- Behavioural check that no unit test can cover: run one real task end to end and confirm the
  executor calls the advisor at the intended points (after orientation, before the first
  substantive write, before declaring done) rather than at turn 1 or not at all.
