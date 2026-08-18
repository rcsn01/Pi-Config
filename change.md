# Revisions to `plan1.md`

Two things are recorded here:

1. **What plan 1 should change** — cuts that make it simple without making it incomplete.
2. **What plan 1 should take from plan 2** — the parts plan 2 got right that plan 1 is missing.

Every API claim below was checked against the installed packages
(`pi-ai@0.84.1`, `pi-coding-agent@0.84.1`, per `.pi/package.json`). Line references
are in the appendix.

---

## Part 1 — What plan 1 should change

### The reframe

Plan 1 is written as if shipping to a fleet: non-inferiority margins, a predeclared
quality reference, p95 latency budgets, staged rollout at 25 then 100 tasks. This is a
personal config repo with a one-command kill switch.

**The correct posture is a fast undo, not a proof** — and `/advisor off` already is one.

This matters because plan 1's expensive parts are almost entirely *verification
apparatus*, not design. Its correctness instincts are cheap and should survive
untouched. Cut the proof, keep the design.

Scale benchmark: `tools-subagents` is **3,759 lines across 20 files** and does strictly
more than this (parallel runners, agent registry, progress rendering, model commands).
One nested model call should land well under half that.

### The cuts

| # | Cut | From → To |
|---|---|---|
| 1 | Phase 6 rollout + Phase 5 evaluation | ~200 plan lines → ~15 |
| 2 | File count | 13 → 5 |
| 3 | Settings keys | 10 → 5 |
| 4 | Subcommands | 5 → 3 |
| 5 | Cache / advisor-mirror optimization track | delete, don't defer |
| 6 | Policy machinery | delete |
| 7 | Usage detail fields | 12 → 3 |
| 8 | Phase 0 | 4 experiments → 1 |

#### 1. Collapse the evaluation, delete the rollout

The single biggest win. Plan 1 §"Phase 5" specifies three arms across eight task
categories with blind patch review, a small human review, repeated stochastic runs, and
eight release gates. Phase 6 then stages that across profiles at 25 and 100 tasks.

Replace both with: **five real tasks from this repo, three arms, ship if pass rate
doesn't drop and cost does.** Delete staged rollout entirely — there is no population to
stage across.

Delete these gates outright: predeclared non-inferiority margin, p95 latency, the 95%
trivial-task threshold, blind maintainability review. Keep two, because they are the
actual ship/no-ship question: *no new correctness or security defects*, and *advisor
failure is visible rather than reported as a successful review*.

#### 2. Merge 13 files into 5

- `model-compatibility.ts` → inline. Once plan 1 correctly drops capability ranking,
  this file is a context-window comparison and a warning string — roughly 15 lines.
- `renderer.ts` → inline. `renderCall` / `renderResult` are two functions.
- `policy.ts` → fold the call cap into `runner.ts`; the rest of it is cut by #6.
- `settings-store.ts` → **delete and import instead.**
  `tools-subagents/settings-store.ts` already exports `readSettingsDocument` and
  `writeSettingsDocument` — atomic temp-file + rename, preserves all other top-level
  keys, already tested at 98 lines. Do not write a second one.
- `test-harness.ts` → only if the tests actually need it.

#### 3. Five settings, not ten

```json
{
  "advisor": {
    "provider": "ollama",
    "modelId": "deepseek-v4-pro:cloud",
    "maxUses": 3,
    "maxTokens": 2048,
    "allowCrossProvider": false
  }
}
```

Dropped and why:

- `enabled` — redundant; unset `modelId` means off.
- `mode: "auto"` — there is only one mode.
- `maxCallsPerRun` + `maxCallsPerSession` — one cap is enough at these numbers.
- `timeoutMs` — `ctx.signal` plus the provider default already covers it.
- `cacheRetention` — see cut #5.
- `requireFullContext` — make it unconditional behavior. Plan 1 argues at length that
  silent truncation is unacceptable; it should not then ship a knob that enables it.

`allowCrossProvider` **stays**. It is one boolean guarding a real decision — whether your
system prompt, code, and tool output cross to a different data processor.

#### 4. Three commands, not five

Keep `/advisor`, `/advisor <provider>/<model>`, `/advisor off`.

- Drop `/advisor reset` — that is `off` followed by picking again.
- Drop `/advisor status` — usage already reaches `/context` once it rides on the tool
  result. If the information is wanted, make it the picker's header line, not a
  subcommand with its own parsing, rendering, and tests.

#### 5. Delete the optimization track

Plan 1 already defers the incremental advisor mirror to "an optimization phase, not v1."
Delete it rather than deferring it — a deferred phase still costs review attention and
still shapes the interfaces around it.

Same for explicit cache tuning. Plan 1's own note says caching does not repay its write
cost under ~3 calls, and the cap **is** 3. Keep only the free version: build the
projection deterministically, and reuse the `deriveSubagentSessionId(mainSessionId,
resolvedModel)` pattern from `tools-subagents/cache-affinity.ts` for session affinity.
Zero extra code, zero extra phase, and it is the part that actually pays.

#### 6. Delete the policy machinery

- **Evidence-hash duplicate suppression** solves a problem the cap already bounds. At
  `maxUses: 3`, a wasted duplicate costs exactly one call.
- **The "ephemeral nudge via the next `context` event"** is a bespoke mechanism for
  something `pi.sendUserMessage(text, { deliverAs: "steer" })` already does in one line.

Better still: ship v1 with no nudge at all, and add it only if the executor observably
under-calls. See Part 3 for the constraints if you do add it.

#### 7. Three usage fields, not twelve

`{ model, calls, truncated }`, plus `response.usage` passed straight through so it lands
in `/context`. Drop schema version, context hash, projected-input estimate, duration, and
run/session call indices — that is telemetry with no consumer.

#### 8. Phase 0 is an afternoon, not a phase

Three of its four experiments are answerable by reading `.d.ts` files. Keep exactly one
runtime check, because no type signature can answer it:

> Does `buildContextEntries()`, called inside a tool's `execute()`, already contain the
> current turn's assistant prose?

The whole design rests on it. Everything else in Phase 0 is a grep.

### One correction to plan 1

Plan 1's "Runner" section suggests proposing `ModelRegistry.completeSimple()` upstream.
**It already exists** — `pi-ai/dist/models.d.ts:142` — and its options carry a
provider-neutral `reasoning?: ThinkingLevel`. The exact seam plan 1 wants to request is
already installed. Use `completeSimple`, not `complete`, for precisely the reason plan 1
gives: it avoids scattering provider-specific option names through the extension.

---

## Part 2 — What plan 1 must keep

These are cheap — a paragraph, a boolean, or an `if` — and each is a correctness call
plan 1 got right. Simplification must not eat them.

- **The provider-neutral projection.** The one place to spend complexity.
- **No cross-provider capability ranking.** Decisive here: the executor is
  `ollama/deepseek-v4-pro:cloud`, which no `haiku < sonnet < opus` table can rank.
  Objective checks (context window, modality) plus a warning.
- **Context overflow → visible `context_too_large`**, never silent truncation.
- **`allowCrossProvider: false`** with explicit consent before persisting.
- **Untrusted-content framing** in the advisor system prompt.
- **Tool definitions as quoted context, never as callable tools.**
- **Honest framing of Anthropic's numbers.** +2.7pp over *Sonnet solo* is not parity with
  *Opus solo*, and the BrowseComp counter-example shows the pairing can still lose. Plan
  1 is the only plan that reads this correctly. Keep the paragraph.

---

## Part 3 — What to take from plan 2

### 3.1 The cost model (plan 2 §4) — take this first

Plan 1 never shows arithmetically why the strategy saves anything. This is a real gap in
a plan whose stated goal is cost reduction. For a task of `T` turns, transcript size `I`,
output `O`, and `K` consultations:

```
solo strong model   ≈  T·I·p_in(A)  +  T·O·p_out(A)
executor + advisor  ≈  T·I·p_in(E)  +  T·O·p_out(E)  +  K·(I·p_in(A) + O_a·p_out(A))
```

The advisor's expensive input is paid **K times, not T times**. At `K=3, T=30` you pay
~10% of the strong model's input cost. That ratio *is* the strategy.

The consequence plan 1 is missing: **if `K → T`, the strategy inverts** and is strictly
worse than just running the strong model, since you pay the strong model's full input
cost *plus* the executor's. This is what makes the call cap load-bearing rather than a
convenience — and it is the argument that justifies keeping the cap while cutting nearly
every other control.

Note for this repo: cost here is subscription quota, not dollars (`subscription-usage`
tracks it). The K/T argument is unit-agnostic; only the measurement changes.

### 3.2 Fail soft, never throw (plan 2 §6.5)

Plan 1 returns "typed tool errors." Plan 2 is right that throwing from `execute()` sets
`isError: true` and reports a failure to the model. Map **every** failure — unconfigured
advisor, budget exhausted, model error, timeout, abort — to a short plain-text result the
executor absorbs and continues past. An advisor outage must never cost a turn.

### 3.3 Prefix stability rules (plan 2 §6.2)

Plan 1 says "build the projection deterministically" and stops. Plan 2 gives the actual
rules, and they are the difference between a cache hit and full price:

- Append only. Never re-order, re-summarize, or re-wrap earlier messages between calls.
- Put the focus question in the **final** user message. Varying suffix, stable prefix.
- No timestamps, UUIDs, or call counters in the system prompt or any leading message.
- Verify with `cache_read_input_tokens > 0` on the second consult. Zero means a silent
  invalidator is in the prefix.

That last line is the whole value: a one-line assertion that turns an invisible failure
into a visible one.

### 3.4 The two-level output cap (plan 2 §6.3)

Hard cap via `maxTokens: 2048`, **plus** a soft cap as a direct-address line in the final
user message ("Keep your advice under 400 words"). Second-person instructions are
followed more reliably than third-person description in a system prompt, and asking for
~80% of the true ceiling leaves headroom. The soft cap shapes the response; the hard cap
bounds it. Plan 1 has only the hard cap, and defers even that.

### 3.5 Reasoning: `low`, and never hard-coded `off`

Plan 1 says keep default/high reasoning. Plan 2 says default `low` and explicitly warns
against `off` — thinking is roughly two-thirds of advisor spend but is what makes the
advice good. Take plan 2's `low` as the default and plan 1's warning against `off`. This
is the setting most likely to quietly cost quality, which is the exact failure mode both
plans are trying to avoid.

(Plan 3 hard-codes `reasoning: "off"`. Do not copy that.)

### 3.6 Nudge constraints — if a nudge ships at all

Cut #6 says drop the nudge from v1. If it is added later, plan 2 has the constraints plan
1 lacks:

- Haiku-class: ~+7pp. Sonnet-class: no measurable effect. **Opus-class: slightly *lower*
  pass rates — never nudge them.**
- 74–98% of nudged attempts consult immediately at the nudge turn, so a nudge can
  *displace* a better-timed later call (−3–4pp when the natural first call was turn 7+).
  Nudge once, early, or not at all.
- Skip entirely when the system prompt already contains restraint language.

Plan 1's instinct — no unconditional nudge — is right, and plan 2 explains why.

### 3.7 The blocked-path note (plan 2 §3), compressed

Plan 1 lists "don't inject Anthropic's native `advisor_20260301`" as a non-goal without
evidence. Plan 2 verified it, and I re-confirmed: `pi-ai/dist/` has **zero** matches for
`advisor` and `server_tool_use`, and `anthropic-messages.js:1036` reads
`case "pause_turn": // Stop is good enough -> resubmit`.

So the tool definition can be put on the wire via `before_provider_request` /
`before_provider_headers`, but the response blocks are dropped on the way back and
stripped from history on later turns. **The server-side path is a pi-ai feature, not an
extension.** Compress plan 2's section to three lines and put it in plan 1's non-goals as
a verified finding rather than an assumption.

### 3.8 Cite file:line

Plan 2's citation density is its best habit — it makes claims auditable in seconds rather
than trusted on faith. Adopt it. (It also cuts both ways: precise citations are how
plan 2's one real error was caught. See Part 4.)

---

## Part 4 — What NOT to take from plan 2

- **`ctx.sessionManager.buildSessionContext()`** — plan 2's central context call, cited as
  `session-manager.d.ts:271`. The method is real on `SessionManager`, but extensions
  receive `ReadonlySessionManager` (`extensions/types.d.ts:219`), and that `Pick`
  (`session-manager.d.ts:140`) includes `buildContextEntries` and **omits**
  `buildSessionContext`. As written it does not compile. Plan 1's
  `buildContextEntries()` is correct — keep it.

  If the resolved-message shape is wanted, the free function is exported from
  `index.d.ts:19` and both of its inputs are on the readonly surface:
  `buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId())`.

- **The pairing table.** Plan 2's §2 table lists models that could not be corroborated
  (Mythos 5, Opus 4.8, Opus 4.7, Sonnet 4.6), then mandates encoding it in `pairing.ts`
  *and* adds a regression test to lock it in. Plan 1's refusal to hard-code a
  cross-provider rank is the better call and should not be traded away.

- **`pairing.ts` as a whole.** With no capability table, what remains is the objective
  compatibility check from cut #2 — inline, ~15 lines.

- **Version claims.** Plan 2's header says pi 0.84.2 and its sources cite
  `pi-coding-agent@0.84.2`; `.pi/package.json` pins **0.84.1** for all three packages.
  Plan 2 also names `ollama/deepseek-v4-flash:0731-cloud` as the active model;
  `settings.json` now reads `deepseek-v4-pro:cloud`.

---

## Part 5 — One direct conflict, resolved

Plan 1 wants `/advisor off` to call `pi.setActiveTools()` so a disabled advisor costs
zero schema and prompt tokens. Plan 2 says never mutate the tool set mid-session: tools
render at the very front of the provider payload, so changing them invalidates the
**executor's** prompt cache for the rest of the run, costing far more than the ~60 tokens
of schema saved.

**Both are right about different moments.** Resolve by when the mutation happens:

- **At `session_start`** — use `setActiveTools()`. Nothing is cached yet, so plan 1's
  zero-overhead goal is free. Keep it.
- **Mid-session** (budget exhausted, or `/advisor off` during a run) — do **not** mutate.
  Return the cheap text notice instead, per plan 2 §6.1. The cap enforcement lives in
  `execute()`, which returns without calling the model.

This costs one sentence in the plan and avoids the worst case: an extension marketed on
cost reduction that silently blows the executor's cache every time it toggles.

---

## Part 6 — Resulting shape

```text
.pi/extensions/tools-advisor/
├── index.ts            # tool + /advisor command + render + session_start
├── transcript.ts       # provider-neutral projection
├── runner.ts           # completeSimple + call cap + error mapping
├── prompt.ts           # advisor system prompt + timing guidelines
├── transcript.test.ts
├── runner.test.ts
└── index.test.ts
```

Reused rather than rewritten:

- `tools-subagents/settings-store.ts` → `readSettingsDocument` / `writeSettingsDocument`
- `tools-subagents/cache-affinity.ts` → session-affinity ID pattern
- `_shared/usage.ts` → `collectSubagentUsage` as the pattern for advisor usage

Phases:

1. **Context projection** — `transcript.ts`, plus the one Phase 0 runtime check
   (does `buildContextEntries()` inside `execute()` include the current turn's prose?).
2. **Tool + runner** — `completeSimple`, call cap, fail-soft error mapping, usage
   passthrough.
3. **Command + settings + UI** — `/advisor`, `<model>`, `off`; cross-provider consent;
   `Advising` status and expandable result.
4. **Smoke eval** — five tasks, three arms, ship on pass-rate-flat / cost-down.

Four source files, four phases, five settings, three commands — down from 13 / 7 / 10 / 5,
with nothing removed that affects whether the system works.

---

## Part 7 — The one thing not to simplify

`transcript.ts`.

If the projection silently drops the compaction summary or the current turn's prose, the
advisor gives confident advice about a conversation it cannot fully see. That failure is
invisible: it reads as *bad advice*, not as a bug, so the natural response is to blame the
pairing and tune the wrong thing indefinitely.

Every other cut in this document is reversible in an afternoon. That one is not even
detectable. Spend the test budget here — exact inclusion of system prompt, current
assistant prose, compaction summary, tool calls, tool results, and error states; removal
of the current advisor call; removal of provider-specific thinking signatures; and
overflow failing loudly.

---

## Appendix — Verified references

Checked against `.pi/node_modules/@earendil-works/` at `pi-ai@0.84.1`,
`pi-coding-agent@0.84.1`.

| Claim | Location |
|---|---|
| `completeSimple(model, context, options?)` exists | `pi-ai/dist/models.d.ts:142` |
| `complete(...)` also exists | `pi-ai/dist/models.d.ts:140` |
| `reasoning?: ThinkingLevel` | `pi-ai/dist/types.d.ts:212` |
| `maxTokens` / `cacheRetention` | `pi-ai/dist/types.d.ts:118` / `:128` |
| Extensions get `ReadonlySessionManager` | `pi-coding-agent/dist/core/extensions/types.d.ts:219` |
| That `Pick` omits `buildSessionContext` | `pi-coding-agent/dist/core/session-manager.d.ts:140` |
| `buildContextEntries()` method | `pi-coding-agent/dist/core/session-manager.d.ts:266` |
| `buildSessionContext()` free fn, exported | `session-manager.d.ts:166`, `index.d.ts:19` |
| `sessionEntryToContextMessages` exported | `pi-coding-agent/dist/index.d.ts:19` |
| `convertToLlm` exported | `pi-coding-agent/dist/index.d.ts:10` |
| `pi.setActiveTools(toolNames)` | `extensions/types.d.ts:950` |
| `ctx.getSystemPrompt()` / `ctx.scopedModels` / `ctx.signal` | `extensions/types.d.ts:248` / `:228` / `:38` |
| `pi.sendUserMessage(content, options?)` | `docs/extensions.md:1412` |
| `before_provider_headers` / `before_provider_request` | `docs/extensions.md:660` / `:678` |
| No `advisor` or `server_tool_use` anywhere in pi-ai | `grep -rl` over `pi-ai/dist/` → 0 files |
| `case "pause_turn": // Stop is good enough -> resubmit` | `pi-ai/dist/api/anthropic-messages.js:1036` |
| Atomic settings read/write helpers | `tools-subagents/settings-store.ts:18`, `:30` |
| Session-affinity ID pattern | `tools-subagents/cache-affinity.ts:13` |
| Usage collector pattern | `_shared/usage.ts:68`, `:85` |
| `tools-subagents` size benchmark | 3,759 lines / 20 files |
| Installed versions | `.pi/package.json` — all three at `0.84.1` |
| Active model | `.pi/settings.json` — `ollama` / `deepseek-v4-pro:cloud` |
