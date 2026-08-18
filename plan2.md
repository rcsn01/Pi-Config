# claude_plan.md — A client-side `/advisor` for pi

**Goal:** reproduce Claude Code's `/advisor` as a pi extension that *reduces* token cost
without losing quality.

**Date:** 2026-08-18 · **Verified against:** pi 0.84.2 (global), `@earendil-works/pi-ai`
0.84.1, `@earendil-works/pi-coding-agent` 0.84.1 (`.pi/package.json`)

---

## 1. What `/advisor` is

`/advisor` pairs a cheap **executor** model (the one driving the task) with a stronger
**advisor** model the executor may consult mid-task. The advisor sees the full
conversation, returns a plan / correction / stop-signal, and the executor continues. The
user picks *which* model advises; **the model decides *when* to consult** — timing is
model-driven, not rule-based.

The user-facing surface is small:

| Surface | Behavior |
|---|---|
| `/advisor` | Picker of eligible advisor models; selection persists to `advisorModel` |
| `/advisor <model>` | Set directly, confirms `Advisor set to <model>` |
| `/advisor off` | Clear the advisor |
| `--advisor <model>` | Per-session override, beats the persisted setting |
| Startup notice | `Advisor Tool (experimental) is on and may use more tokens · /advisor` |
| In-transcript | An `Advising` line while the call runs; `Ctrl+O` expands the advice |

Invariants worth preserving in a port:

- **Pairing rule:** the advisor must be at least as capable as the executor. Claude Code
  validates before sending and silently declines to attach an under-powered advisor.
- **Subagents inherit** the configured advisor and re-run the pairing check against their
  own model.
- **Conflicts surface:** the executor generally follows the advice but says so when its own
  evidence contradicts a specific claim.

## 2. How it works on the wire

The advisor is a **server-side tool** — the second inference happens inside a single
`/v1/messages` request, with no extra round trip and no client-side context management.

```json
{
  "type": "advisor_20260301",
  "name": "advisor",
  "model": "claude-opus-4-8",
  "max_uses": 3,
  "max_tokens": 2048,
  "caching": { "type": "ephemeral", "ttl": "5m" }
}
```

Beta header `anthropic-beta: advisor-tool-2026-03-01`.

**The loop.** The executor emits a `server_tool_use` block named `advisor` with an *empty*
`input` — it signals timing only; the server supplies the context. Anthropic runs a
separate inference on the advisor model, under its own system prompt, with the executor's
full transcript quoted in. The result comes back as an `advisor_tool_result` block and the
executor keeps generating. The advisor never calls tools, produces no user-facing output,
and its thinking blocks are dropped before the result returns.

**Result is a discriminated union** — this is the sharp edge:

| `content.type` | Fields | When |
|---|---|---|
| `advisor_result` | `text`, `stop_reason` | Plaintext advisors (e.g. Opus 4.8) |
| `advisor_redacted_result` | `encrypted_content`, `stop_reason` | Claude Opus 5, Fable 5, Mythos 5 |
| `advisor_tool_result_error` | `error_code` | Consultation failed |

With the redacted variant the client **cannot read the advice** — only the server can
decrypt it into the executor's next prompt. Error codes (`max_uses_exceeded`,
`prompt_too_long`, `too_many_requests`, `overloaded`, `unavailable`,
`execution_time_exceeded`, `model_not_found`) never fail the request; the executor sees
them and continues.

**Pairing table** (advisor must be ≥ executor):

| Executor | Valid advisors |
|---|---|
| Haiku 4.5 / Sonnet 4.6 / Sonnet 5 / Opus 4.6 / Opus 4.7 | Opus 5, Fable 5, Mythos 5, Opus 4.8, Opus 4.7 |
| Opus 4.8 | Opus 5, Fable 5, Mythos 5, Opus 4.8 |
| Opus 5 | Opus 5, Fable 5, Mythos 5 |
| Fable 5 | Fable 5, Opus 5 |
| Mythos 5 | Mythos 5, Opus 5 |

> ⚠️ This supersedes the table in `research/02-advisor-executor-mechanics.md`, which listed
> Sonnet-tier models as valid advisors. Current guidance requires an Opus-4.7-or-better
> advisor. **The extension's `pairing.ts` must encode this table, not the older one.**

**Availability:** beta on the Claude API and Claude Platform on AWS. **Not** on Amazon
Bedrock, Google Vertex AI, or Microsoft Foundry.

## 3. Why pi cannot use the server-side tool today

I verified this against the installed `pi-ai` rather than trusting the earlier research
note. The conclusion holds:

```
$ grep -rn "advisor"         --include='*.js' --include='*.d.ts' dist/   →  0 matches
$ grep -rn "server_tool_use" --include='*.js' --include='*.d.ts' dist/   →  0 matches
```

- `dist/api/anthropic-messages.js:396-440` — the `content_block_start` handler branches on
  `text`, `thinking`, `redacted_thinking`, and `tool_use` **only**. A `server_tool_use` or
  `advisor_tool_result` block is silently discarded: the advice never reaches the executor's
  context, and `convertMessages` strips the blocks from history on later turns, breaking the
  round-trip contract the API requires.
- `dist/api/anthropic-messages.js:1036` — `case "pause_turn": // Stop is good enough -> resubmit`.
  Pending-advisor-call semantics are lost.
- No `usage.iterations` parsing, so advisor sub-inference tokens would be invisible.

Injecting the tool via `before_provider_request` + `before_provider_headers` (both hooks
exist — `docs/extensions.md:660,678`) puts the tool definition on the wire but the response
blocks are dropped on the way back. **The server-side path is a pi-ai feature, not an
extension.** Everything below implements the *strategy* client-side, which works today and
works across providers — relevant here, because the active profile is
`ollama/deepseek-v4-flash:0731-cloud` (`.pi/settings.json`), not Anthropic.

## 4. The cost model — where the saving actually comes from

This is the part a naive port gets wrong, so it drives the whole design.

For an agentic task of **T** turns, the transcript is re-sent on **every** executor turn.
Let `I` = average transcript size, `O` = output per turn, `K` = advisor consultations.

```
solo strong model   ≈  T·I·p_in(A)  +  T·O·p_out(A)
executor + advisor  ≈  T·I·p_in(E)  +  T·O·p_out(E)  +  K·(I·p_in(A) + O_a·p_out(A))
```

The advisor's expensive input is paid **K times, not T times**. With `K=3` and `T=30` you
pay ~10% of the strong model's input cost. That ratio *is* the strategy. Anthropic's
measurements bear it out: Sonnet + Opus advisor on SWE-bench Multilingual scored +2.7pp
over Sonnet solo at −11.9% cost; Haiku + Opus advisor on BrowseComp more than doubled Haiku
solo (41.2% vs 19.7%).

Three consequences that must be designed for, not bolted on:

1. **If `K → T`, the strategy inverts.** An executor that consults every turn pays the full
   strong-model input cost *plus* the executor's own. That is strictly worse than just
   running the strong model. A call cap is therefore load-bearing, not a nicety.
2. **The advisor's output must be capped.** Uncapped, advisor responses average
   ~4,200–5,900 tokens. At `max_tokens: 2048` they average ~630–840 with ≈0% truncation; at
   1024, ~370–480 with ~10% truncation. **2048 is the right default** — a ~7× output
   reduction for no measured quality loss.
3. **Client-side, the advisor's prompt has its own cache.** The server tool's `caching`
   parameter breaks even at ~3 calls per conversation. Client-side we get the same effect
   only if we keep the advisor's prompt prefix **byte-stable** across calls. Rebuilding the
   advisor context differently each time (re-summarizing, reordering, injecting a timestamp)
   silently costs full price on every call. See §6.2.

**On this repo specifically:** "token cost" here is subscription quota, not dollars —
`subscription-usage` tracks Codex and Ollama Cloud quota. The K/T ratio argument is
unit-agnostic and applies unchanged, but the *measurement* has to read the quota bars, not
a price sheet.

## 5. Design

**Approach A — client-side advisor tool.** The executor gets a regular tool named
`advisor`. On call, the tool reconstructs the conversation from the session and makes one
nested model call to the configured advisor model. Works with any provider, no pi-ai
changes.

```
executor (ollama/deepseek-v4-flash)
   │  calls `advisor` — model-driven timing, steered by promptGuidelines
   ▼
tools-advisor
   ├─ budget check  (maxUses / maxTokens / pairing)
   ├─ advisor-context.ts → prefix-stable Context
   └─ ctx.modelRegistry.completeSimple(advisorModel, ctx, { reasoning, maxTokens, signal })
   ▼
advisor model → advice text → tool result (+ usage → /session totals)
```

### 5.1 Verified API surface

Every call below was checked against the installed packages:

| Need | API | Source |
|---|---|---|
| Nested model call | `ctx.modelRegistry.completeSimple(model, context, options?) → Promise<AssistantMessage>` | `pi-ai/dist/models.d.ts:142` |
| Streaming variant | `streamSimple(...)` → `AssistantMessageEventStream` | `models.d.ts:141` |
| Context shape | `{ systemPrompt?, messages, tools? }` | `pi-ai/dist/types.d.ts:370` |
| Advisor thinking level | `SimpleStreamOptions.reasoning?: ThinkingLevel` | `types.d.ts:211` |
| Output cap | `StreamOptions.maxTokens?: number` | `types.d.ts:118` |
| Cache retention | `StreamOptions.cacheRetention?: CacheRetention` | `types.d.ts:128` |
| Cancellation | `ProviderRequestOptions.signal?: AbortSignal` | `types.d.ts:50` |
| Usage to report | `AssistantMessage.usage: Usage` | `types.d.ts:304` |
| Usage accounting | tool result `usage` → footer, `/session`, RPC totals | `docs/extensions.md:1986` |
| Transcript | `ctx.sessionManager.buildSessionContext()` (compaction applied) | `session-manager.d.ts:271` |
| Entry → messages | `sessionEntryToContextMessages(entry)` | exported from `pi-coding-agent` (`index.d.ts:19`) |
| Executor system prompt | `ctx.getSystemPrompt()` | `docs/extensions.md:1066` |
| Model catalogue | `ctx.scopedModels`, `ctx.modelRegistry.getAvailable()` | `docs/extensions.md:990`, `models.d.ts:123` |
| Abort signal | `ctx.signal` (defined during `tool_call`, `turn_end`, …) | `docs/extensions.md:992` |
| State across branches | tool-result `details` + rebuild on `session_start` | `docs/extensions.md:1850` |
| Nudge injection | `pi.sendUserMessage(text, { deliverAs: "steer" })` | `docs/extensions.md:1412` |

`completeSimple` is not yet used anywhere in `.pi/extensions/` — this would be the repo's
first nested-model-call site. The closest existing precedent is
`safety-permissions/guardian-runner.ts`, which runs an isolated in-process `AgentSession`
(`SessionManager.inMemory()`, `noTools: "all"`, `noExtensions`, `noSkills`, shared
`ModelRuntime`). **Prefer `completeSimple` for the advisor**: the guardian reuses one
long-lived session that accumulates its own history, whereas the advisor must see the
*executor's* transcript afresh on each consult. Keep `createAgentSession` in reserve only if
a tool-using advisor is ever wanted.

### 5.2 File layout

```
.pi/extensions/tools-advisor/
├── index.ts               # tool registration, /advisor command, UI wiring, nudge
├── config.ts              # "advisor" settings namespace (settings-store.ts pattern)
├── pairing.ts             # capability rank + validatePairing()
├── advisor-context.ts     # transcript → prefix-stable Context
├── advisor-runner.ts      # completeSimple call, error mapping, usage passthrough
├── budget.ts              # per-session call cap, reconstruction from tool-result details
└── *.test.ts              # vitest, mirroring tools-subagents/test-harness.ts style
```

Repo conventions to follow (from `tools-subagents/`): `.ts` suffix in relative imports;
atomic temp-file + rename writes to `.pi/settings.json` preserving other top-level keys;
dependency-injected factory (`createAdvisorExtension(deps)`) so tests can mock
`modelRegistry`.

### 5.3 Settings

Namespaced top-level key, preserved across profile switches exactly like `"subagents"`:

```json
{
  "advisor": {
    "provider": "anthropic",
    "modelId": "claude-opus-4-8",
    "maxUses": 3,
    "maxTokens": 2048,
    "reasoning": "low",
    "nudgeTurn": 2,
    "rankOverrides": {}
  }
}
```

Unset `provider`/`modelId` = advisor disabled. `maxUses: 0` = unlimited (documented as
"this removes the cost guarantee").

## 6. Cost controls

Each of these is a lever from §4, made concrete.

### 6.1 Per-session call cap (the load-bearing one)

Count consults in the tool result's `details`, rebuild the counter on `session_start` by
walking `ctx.sessionManager.getBranch()` for `toolResult` entries named `advisor`
(`docs/extensions.md:1850`). This survives restarts and branches correctly on session forks.

When the cap is hit, `execute()` returns a short "advisor budget exhausted for this session"
text result **without calling the model**.

> **Do not deregister the tool when the budget is exhausted.** `pi.setActiveTools()` would
> remove it from the prompt — but tools render at the very front of the provider payload, so
> mutating the tool set mid-session invalidates the **executor's** prompt cache for the rest
> of the run. The cache write-off costs far more than the ~60 tokens of tool schema you'd
> save. Return the cheap notice instead.

### 6.2 Advisor-side prompt caching

The advisor's prompt is `[executor system prompt] + [transcript] + [focus question]`. Across
calls 1→2→3 the first two parts are a growing prefix, so the provider can serve them from
cache if — and only if — we never perturb the prefix. Rules for `advisor-context.ts`:

- Build from `buildSessionContext()` once per call and **append only**; never re-order,
  re-summarize, or re-wrap earlier messages between calls.
- Put the focus `question` in the **final** user message, after the prefix. Varying suffix,
  stable prefix.
- No timestamps, no UUIDs, no call counters in the system prompt or any leading message.
- Pass `cacheRetention` from settings (default short/5m; `1h` for long sessions).
- Consider deriving a stable advisor session ID the way
  `tools-subagents/cache-affinity.ts` does (`sha256(version, mainSessionId, resolvedModel)`)
  so repeat consults share a cache namespace without leaking the main session ID.

Verify with `cache_read_input_tokens > 0` on the 2nd+ consult. If it's zero, a silent
invalidator is in the prefix.

### 6.3 Output cap, two ways

- **Hard:** `maxTokens: 2048` in the `completeSimple` options.
- **Soft:** a direct-address line in the *final user message* — `"Keep your advice under 400
  words."` Direct second-person instructions are followed far more reliably than
  third-person descriptions in a system prompt, and asking for ~80% of the true ceiling
  leaves headroom. Use both; the soft cap shapes the response, the hard cap bounds it.

### 6.4 Advisor thinking level

Default `reasoning: "low"`. The server-side advisor *discards* thinking before the result
reaches the executor, so from the executor's point of view thinking tokens are pure cost —
but they do improve the advice (advisor output is ~400–700 text tokens, ~1,400–1,800
including thinking, i.e. thinking is roughly ⅔ of the spend). `low` is the honest default;
make it a setting and let §8's eval decide whether `off` or `medium` is better for this
repo's workloads. **Do not hard-code `off`** — that's the change most likely to quietly cost
quality, which is exactly what this plan is trying to avoid.

### 6.5 Fail soft, never throw

Throwing from `execute()` sets `isError: true` and reports a failure to the LLM
(`docs/extensions.md:1988`). Mirror the server tool instead: map every failure —
unconfigured advisor, invalid pairing, budget exhausted, model call error, timeout, abort —
to a short **plain text result** so the executor absorbs it and continues. An advisor outage
must never cost a turn.

## 7. Quality controls

Cost controls without these are just a downgrade.

**Timing guidance** (`promptGuidelines` — note each bullet must name the tool, since pi
appends them flat to the shared Guidelines section, `docs/extensions.md:1892`):

- "Call `advisor` early on complex tasks, after a few exploratory reads and before
  committing to an approach."
- "Call `advisor` again before declaring a difficult task complete."
- "Call `advisor` when the same error recurs after two attempts."
- "Call `advisor` *before* `todo_write`, so its plan funnels into the todo list."
- "Do not call `advisor` for single-file edits, lookups, or tasks you can finish directly."

Target ~2–3 consults per task. The last bullet matters as much as the first four.

**Advice treatment** — the executor should apply the advice but surface conflicts when its
own evidence contradicts a specific claim (a recommended step fails when tried; file
contents contradict the advice). Put this in the tool `description`, where it is read at the
moment of use.

**The nudge, narrowly scoped.** Executors under-call the advisor without steering,
especially on coding tasks. On `turn_end`, if the advisor is enabled, `turnIndex >=
nudgeTurn`, no consult has happened yet, and the executor is *Haiku-class*, inject
`pi.sendUserMessage("Consider consulting the advisor before continuing.", { deliverAs:
"steer" })`. Constraints from Anthropic's measurements:

- Haiku: +~7pp pass rate. Sonnet: no measurable effect. **Opus: slightly *lower* pass rates
  — never nudge Opus-class executors.**
- 74% (Sonnet) to 98% (Haiku) of nudged attempts consult immediately at the nudge turn, so a
  nudge can *displace* a better-timed later call (−3–4pp when the natural first call was turn
  7+). Nudge once, early, or not at all.
- Skip entirely if the system prompt already contains restraint language.

**Pairing validation.** `pairing.ts` encodes the §2 table by family and version, with
cross-provider ranking by model-family heuristics (not by provider) so an
`ollama/deepseek-v4-flash` executor can be paired against an Anthropic advisor. Ship a
`rankOverrides` settings escape hatch for unknown IDs. On an invalid pair: notify once and
return the tool notice — mirroring Claude Code's "not attached" behavior rather than
erroring.

## 8. Measuring "without losing quality"

The claim in the title is not verifiable by inspection, so build the harness with the
feature:

1. Pick 10–15 representative tasks from this repo's real workload (extension edits, test
   fixes, multi-file refactors).
2. Run three arms: **executor solo**, **executor + advisor**, **advisor model solo**.
3. Record per arm: pass/fail, wall-clock, total tokens (executor + advisor separately), and
   consults per task.
4. Ship only if arm 2 ≥ arm 1 on pass rate *and* < arm 3 on tokens. If consults/task > 5,
   the guidelines are under-restraining; tighten before re-running.

Token totals come free: returning `usage` from `execute()` puts advisor tokens into
`/session` and the footer (`docs/extensions.md:1986`). For subscription providers, snapshot
the `subscription-usage` quota bars before and after each arm.

## 9. Phases

### Phase 0 — Scaffolding
- [ ] Create `.pi/extensions/tools-advisor/` with `createAdvisorExtension(deps)` stub
- [ ] Add `"test:advisor": "vitest run extensions/tools-advisor"` to `.pi/package.json` and
      wire it into the `test` script
- [ ] `pnpm typecheck && pnpm test:advisor` green

### Phase 1 — Config (`config.ts`)
- [ ] Port the `tools-subagents/settings-store.ts` pattern (atomic read-modify-write,
      namespaced `readNamespace`/`updateNamespace`)
- [ ] `AdvisorConfig` type + defaults from §5.3; validate `provider`/`modelId` presence
- [ ] Tests: missing file → defaults; malformed root → error; update preserves other
      top-level keys; round-trip

### Phase 2 — Pairing (`pairing.ts`)
- [ ] `capabilityRank(model)` encoding the **§2 table** (haiku < sonnet < opus < fable ≈
      mythos, then version); cross-provider safe
- [ ] `validatePairing(executor, advisor) → { ok, reason? }`; unknown IDs → `ok: false`
- [ ] `rankOverrides` merge
- [ ] Tests: within-family ordering; ollama-executor vs anthropic-advisor; equal-capability
      allowed; unknown IDs; **a regression test asserting Sonnet is not accepted as an
      advisor for an Opus executor** (guards against the stale research table)

### Phase 3 — Context (`advisor-context.ts`)
- [ ] `buildAdvisorContext(ctx, question)`: `buildSessionContext()` → `Message[]`; prepend
      `ctx.getSystemPrompt()`; append question as the final user message with the soft word cap
- [ ] Prefix-stability guarantees from §6.2 (append-only, no volatile leading content)
- [ ] Truncate from the head if the transcript exceeds the advisor model's context window
- [ ] Tests: entries → messages; question is last; **two successive builds share a
      byte-identical prefix**; oversize transcript truncates from the head

### Phase 4 — Runner + budget (`advisor-runner.ts`, `budget.ts`)
- [ ] `runAdvisorCall(deps, ctx, params)`: resolve model → pairing check → budget check →
      `completeSimple(model, context, { reasoning, maxTokens, cacheRetention, signal: ctx.signal })`
- [ ] Map `AssistantMessage` → advice text; pass `response.usage` through as the tool
      result's `usage`
- [ ] Every failure path returns a text result, never throws (§6.5)
- [ ] Budget counter reconstructed on `session_start` from tool-result `details`
- [ ] Tests: cap counting across reconstructed state; unconfigured advisor → helpful notice;
      model failure → text result not throw; abort via `signal`; usage passthrough

### Phase 5 — Tool + command (`index.ts`)
- [ ] `pi.registerTool({ name: "advisor", … })` with the §7 `description`,
      `promptSnippet`, and `promptGuidelines`; `parameters: Type.Object({ question:
      Type.Optional(Type.String()) })`
- [ ] `renderCall` / `renderResult` — collapsed advice with an expand affordance
- [ ] `pi.registerCommand("advisor", …)`: no args → `ctx.ui.select` over `ctx.scopedModels`
      (falling back to `getAvailable()`), `<provider>/<id>` → validate + save + notify,
      `off` → clear; `getArgumentCompletions` for model IDs
- [ ] `session_start`: notify when configured; rebuild the budget counter
- [ ] `tool_execution_start` / `tool_execution_end`: `ctx.ui.setStatus("advisor", "Advising…")`
      and clear
- [ ] `pi.registerFlag("advisor", …)` for the per-session override

### Phase 6 — Nudge
- [ ] `turn_end` handler implementing the §7 constraints (Haiku-class only, once, at
      `nudgeTurn`, skipped when restraint language is present)
- [ ] Tests: fires on turn 2 for Haiku-class; **does not fire for Opus-class**; does not fire
      after a consult; does not fire twice

### Phase 7 — Measure and document
- [ ] Build the §8 three-arm harness; record the numbers in the extension README
- [ ] `pnpm typecheck` + full `pnpm test` green
- [ ] Manual verification (§10)

### Phase 8 — Upstream (optional, unblocks the faithful path)
- [ ] File a pi-ai feature request for: `serverToolUse` / `advisorToolResult` content-block
      types (both result variants), stream handling, `convertMessages` round-trip,
      `pause_turn` resume-with-pending-call, and `usage.iterations` parsing
- [ ] If accepted, the switch is small: `before_provider_headers` adds the beta header,
      `before_provider_request` injects the tool definition, and the runner is retired. The
      `/advisor` command, settings, pairing, and UI are unchanged.

## 10. Manual verification

1. `cd .pi && pnpm typecheck && pnpm test:advisor`
2. `pi` in a scratch project → `/advisor` shows eligible models → pick one → confirmation
3. Give it a genuinely multi-step task. Expect: `Advising…` status, an expandable advice
   result, and **2–3 consults, not one per turn**
4. `/session` includes advisor tokens in the totals
5. Exhaust `maxUses` → subsequent calls return the notice **without** a model call (confirm
   no token delta)
6. Second consult shows `cache_read_input_tokens > 0` (advisor-side cache is working)
7. Set an under-powered advisor → notice, no call
8. `/advisor off` → next turn the tool is inert
9. Restart pi → advisor still configured, budget counter reset
10. Press Esc mid-consult → the call aborts via `ctx.signal`

## 11. Risks and open questions

| Risk | Mitigation |
|---|---|
| `ctx.getSystemPrompt()` inside tool `execute()` — docs only *guarantee* chained-prompt semantics during `before_agent_start` | Capture it in a `before_agent_start` handler and stash per-turn; fall back to the live call |
| Client-side advisor sees the transcript as of the tool call, not the executor's in-progress turn text | Minor — the tool-calling message is in the transcript. Include the `question` param so the executor can state its current intent |
| Cross-provider ranking misjudges unknown model IDs | Single rank table + `rankOverrides` setting; unknown → refuse to attach rather than guess upward |
| Advisor-side cache silently missing | Assert `cache_read_input_tokens > 0` on 2nd consult in the manual checklist; log it behind a debug flag |
| An advisor that is *not* actually stronger (e.g. a local Ollama model) | Pairing check rejects it — correct behavior, but make the notice explain *why* |
| `maxUses: 0` (unlimited) reverses the cost argument | Document it inline in settings; consider warning on `session_start` |
| Two round trips instead of one; advisor system prompt is ours to write, not Anthropic's | Inherent to the client-side approach; Phase 8 removes it |
| Redacted advisors (Opus 5 / Fable 5 / Mythos 5) | Irrelevant client-side — we get plaintext. It *is* the blocker for the raw-API variant, which would have to pin a plaintext advisor |

## 12. Approaches considered and rejected

| | Approach | Verdict |
|---|---|---|
| **A** | Client-side tool + `completeSimple` | **Recommended.** Works today, any provider, full cost control |
| B | Inject `advisor_20260301` via provider hooks | Faithful but **blocked** — pi-ai drops the result blocks (§3). Revisit after Phase 8 |
| C | Raw `/v1/messages` call from inside the tool | Strictly worse than A: same two round trips, but must pin a plaintext advisor because the redacted variant is undecryptable client-side, and hand-rolls `pause_turn` resumption for no gain |
| D | Spawn a `pi --mode json` subprocess | Rejected for the reason `safety-permissions/guardian-runner.ts` already documents: process spawn + full pi startup per consult dominates the latency budget |

---

### Sources

- Claude Code docs — *Escalate hard decisions with the advisor tool*
- Claude API docs — *Advisor tool* (`advisor_20260301`, beta `advisor-tool-2026-03-01`)
- Anthropic — *The advisor strategy: give agents an intelligence boost*
- `claude-api` skill: advisor contract, current pairing table, platform availability
- Local: `pi-ai@0.84.1/dist/{models,types}.d.ts`, `dist/api/anthropic-messages.js`;
  `pi-coding-agent@0.84.2/docs/extensions.md`; `.pi/extensions/{tools-subagents,safety-permissions}/`
- Prior research in this repo: `research/01`–`04` (in `git show HEAD:research/`) — superseded
  on the pairing table, confirmed on the pi-ai gaps
