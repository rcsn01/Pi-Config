# 2. How the advisor executor works

This document covers the protocol-level mechanics of the advisor tool — the
"executor" loop, the server-side handoff, streaming, usage/billing, caching,
model pairing, and the prompting strategies that make executors call the
advisor at the right time.

## 2.1 The advisor strategy (why it exists)

From the Anthropic blog (*The advisor strategy*): developers converged on
pairing **Opus as advisor** with **Sonnet or Haiku as executor** to get
near-Opus intelligence at near-Sonnet cost. The executor runs the task
end-to-end — calling tools, reading results, iterating. When it hits a decision
it can't reasonably solve, it consults Opus, which accesses the shared context
and returns a plan, correction, or stop signal; the executor resumes.

This **inverts the sub-agent pattern**: no orchestrator, no decomposition, no
worker pool. Frontier-level reasoning applies only when the executor needs it.

Measured results (from the blog):

| Benchmark | Result |
|-----------|--------|
| SWE-bench Multilingual | Sonnet + Opus advisor: **+2.7pp** over Sonnet solo, **−11.9% cost** per agentic task |
| BrowseComp | Haiku + Opus advisor: **41.2%** vs 19.7% solo (more than double); trails Sonnet solo by 29% at 85% less cost |
| Terminal-Bench 2.0 | Sonnet + Opus advisor improved scores while costing less per task than Sonnet alone |

## 2.2 The server-side tool definition

The advisor is a **server tool**: add it to the `tools` array of a normal
Messages API request. The model handoff happens **inside a single
`/v1/messages` request** — no extra round trips or context management.

```json
{
  "type": "advisor_20260301",
  "name": "advisor",
  "model": "claude-opus-4-6",
  "max_uses": 3,
  "max_tokens": 2048,
  "caching": { "type": "ephemeral", "ttl": "5m" }
}
```

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `type` | string | required | Must be `"advisor_20260301"` |
| `name` | string | required | Must be `"advisor"` |
| `model` | string | required | Advisor model ID; billed at this model's rates for the sub-inference |
| `max_uses` | integer | unlimited | Max advisor calls per **request**; further calls return `advisor_tool_result_error` with `error_code: "max_uses_exceeded"` and the executor continues |
| `max_tokens` | integer | advisor model's output cap | Caps advisor output (thinking + text) per call; **minimum 1024**; setting above the model's cap → 400 error |
| `caching` | object | null | Enables prompt caching for the advisor's own transcript across calls within a conversation |

`caching` shape: `{"type": "ephemeral", "ttl": "5m" | "1h"}`. Unlike
`cache_control` on content blocks, this is an **on/off switch** — the server
decides where cache boundaries go.

**Beta header required**: `anthropic-beta: advisor-tool-2026-03-01`.

Generic tool properties also apply: `cache_control`, `allowed_callers`,
`defer_loading`, `strict`.

## 2.3 The executor loop (how a consultation happens)

1. The **executor model decides when to call** the advisor, like any other
   tool. It emits a **`server_tool_use`** block with `name: "advisor"` and an
   **empty `input`** — the executor signals timing, the server supplies
   context. Nothing the executor puts in `input` reaches the advisor.
2. Anthropic runs a **separate inference pass on the advisor model
   server-side**. The advisor runs under its **own Anthropic-supplied system
   prompt** and receives the **executor's full transcript as quoted context**:
   the system prompt, tool definitions, prior turns and tool results, and the
   text the executor has produced so far in this turn.
3. The advisor's response returns to the executor as an
   **`advisor_tool_result`** block.
4. The executor continues generating, informed by the advice.

Key properties:

- The advisor **never calls tools** and produces **no user-facing output** —
  only guidance to the executor.
- The advisor runs **without context management**; its **thinking blocks are
  dropped** before the result returns. Only the advice text reaches the
  executor.
- All of this happens inside the single request. The exception is a turn that
  pauses mid-call (see §2.5).

## 2.4 Result variants

`advisor_tool_result.content` is a discriminated union:

| Variant | Fields | Returned when |
|---------|--------|---------------|
| `advisor_result` | `text`, `stop_reason` | Advisor model returns plaintext (e.g. Claude Opus 4.8) |
| `advisor_redacted_result` | `encrypted_content`, `stop_reason` | Advisor model returns encrypted output (e.g. Claude Opus 5) |

- With `advisor_redacted_result`, the client cannot read the advice; on the
  **next turn the server decrypts it and renders the plaintext into the
  executor's prompt**.
- **Round-trip the result blocks verbatim** on subsequent turns. If switching
  advisor models mid-conversation, branch on `content.type`.
- `stop_reason` is present only when `max_tokens` is set on the tool
  definition: `"end_turn"` normally, `"max_tokens"` when the cap is hit. The
  API also appends `[Advisor output truncated at max_tokens=2048.]` to the
  advice text so the executor sees the truncation.

### Error results

Failures don't fail the request — the executor sees the error and continues:

| `error_code` | Meaning |
|--------------|---------|
| `max_uses_exceeded` | Request hit the `max_uses` cap |
| `too_many_requests` | Advisor sub-inference rate-limited |
| `overloaded` | Advisor sub-inference hit capacity limits |
| `prompt_too_long` | Transcript exceeded the advisor model's context window |
| `execution_time_exceeded` | Advisor sub-inference timed out |
| `model_not_found` | Configured advisor model unavailable |
| `unavailable` | Any other advisor failure |

Rate limits draw from the **same per-model bucket** as direct calls to the
advisor model (a rate limit on the advisor → `too_many_requests` inside the
tool result; on the executor → HTTP 429 for the whole request).

## 2.5 Multi-turn and `pause_turn` resumption

- Pass full assistant content (including `advisor_tool_result` blocks) back on
  subsequent turns. You may **drop the advisor tool from `tools`** on a
  follow-up turn while history still contains result blocks (the model just
  can't call the advisor that turn) — but the beta header must still be sent
  for the history blocks to be accepted.
- **Paused turn**: a response can end with `stop_reason: "pause_turn"` while an
  advisor call is pending (the response contains the `server_tool_use` block
  with no result). To resume: append that assistant message unchanged to
  `messages` and resend with the same advisor tool + beta header — **no user
  message or `tool_result` needed**. A resumed turn can pause again.
- Omitting the advisor tool from a resume request → 400 `invalid_request_error`
  (the pending `server_tool_use` block has no tool definition to run against).
- If the executor also called a client tool in the same turn, the response
  ends with `stop_reason: "tool_use"` instead; send the `tool_result` blocks as
  usual and the pending advisor call runs at the start of the next request.

## 2.6 Streaming behavior

- The advisor sub-inference **does not stream**. The executor's stream pauses
  while the advisor runs; the full result arrives in a **single
  `content_block_start` event** (no deltas), then executor output resumes.
- The `server_tool_use` block signals the call start; the pause begins when
  that block closes (`content_block_stop`). During the pause the stream is
  quiet except for SSE `ping` keepalives roughly every 30s.
- A `message_delta` follows with the updated `usage.iterations` array.

## 2.7 Usage and billing

- Advisor calls run as a **separate sub-inference billed at the advisor model's
  rates**. Usage is reported in **`usage.iterations[]`**:
  - `type: "advisor_message"` → billed at advisor rates
  - `type: "message"` → billed at executor rates
- **Top-level `usage` fields reflect executor tokens only** (each top-level
  field is the sum across executor iterations; summed `input_tokens` exceeds any
  single prompt because each iteration re-sends the growing conversation).
- Advisor output is typically **400–700 text tokens** (1,400–1,800 including
  thinking). The savings come from the advisor not generating the final output.
- Top-level `max_tokens` bounds **executor output only**; advisor tokens don't
  draw from task budgets either.
- **Priority Tier applies per model** — a commitment on the executor doesn't
  extend to the advisor.

### Capping advisor output (`max_tokens`)

| `max_tokens` | Mean advisor output | Calls truncated |
|--------------|--------------------:|----------------:|
| unset | ~4,200–5,900 | n/a |
| 2048 (recommended start) | ~630–840 | ~0% |
| 1024 (minimum) | ~370–480 | ~10% |

The server also passes the advisor its remaining-token budget, so the advisor
shapes its response to fit (not a hard truncation alone). Check
`output_tokens` on the `advisor_message` iteration to see how close each call
came to its cap.

## 2.8 Prompt caching — two independent layers

1. **Executor-side**: the `advisor_tool_result` block is cacheable like any
   content block; a `cache_control` breakpoint after it hits on later turns.
   The executor's prompt always contains plaintext advice regardless of result
   variant, so caching is identical for both.
2. **Advisor-side** (`caching` on the tool definition): the advisor's prompt
   on call N is call N−1's prompt plus one segment, so the prefix is stable;
   each call writes a cache entry and the next reads up to it
   (`cache_read_input_tokens` becomes non-zero on the 2nd+ `advisor_message`
   iteration). **Breaks even at ~3 calls per conversation** — enable for long
   agent loops, keep off for short tasks. Set it once and leave it; toggling
   mid-conversation causes cache misses.

## 2.9 Model compatibility (pairing table)

The advisor must be **Sonnet 4.6 or more capable** and **at least as capable as
the executor**. Equal-capability models can advise each other (e.g. Opus 4.7 ↔
Opus 4.8). Invalid pairs → `400 invalid_request_error` naming the combination.

| Executor | Advisors |
|----------|----------|
| Haiku 4.5 | Mythos 5, Fable 5, Opus 5, Opus 4.8, Opus 4.7, Opus 4.6, Sonnet 5, Sonnet 4.6 |
| Sonnet 4.6 | Mythos 5, Fable 5, Opus 5, Opus 4.8, Opus 4.7, Opus 4.6, Sonnet 5, Sonnet 4.6 |
| Sonnet 5 | Mythos 5, Fable 5, Opus 5, Opus 4.8, Opus 4.7, Sonnet 5 |
| Opus 4.6 | Mythos 5, Fable 5, Opus 5, Opus 4.8, Opus 4.7, Opus 4.6, Sonnet 5 |
| Opus 4.7 | Mythos 5, Fable 5, Opus 5, Opus 4.8, Opus 4.7 |
| Opus 4.8 | Mythos 5, Fable 5, Opus 5, Opus 4.8, Opus 4.7 |
| Opus 5 | Mythos 5, Fable 5, Opus 5 |
| Fable 5 | Mythos 5, Fable 5, Opus 5 |
| Mythos 5 | Mythos 5, Fable 5, Opus 5 |

**Platform availability**: beta on the Claude API and Claude Platform on AWS;
**not** on Amazon Bedrock, Google Cloud, or Microsoft Foundry.

## 2.10 Getting the executor to call the advisor (prompting research)

The executor **under-calls** the advisor without steering, especially on coding
tasks. Anthropic's findings:

- **Suggested system prompt for coding tasks** (prepend before any other
  advisor mentions): a timing block (call early after a few exploratory reads;
  call again before declaring done on difficult tasks) + an advice-treatment
  block (apply the advice, but surface conflicts when evidence contradicts it).
  Aim for ~2–3 calls per task. If the agent has planner tools (todo list),
  prompt the model to call the advisor *before* those tools so the plan funnels
  into them.
- **Mid-conversation nudge for under-calling executors**: append a short
  reminder as an **additional user message** before the second assistant turn
  (default `NUDGE_TURN` = 2). On Haiku this raised pass rates ~7pp; on Sonnet
  no measurable effect; on Opus it *slightly lowered* pass rates — don't nudge
  Opus. 74% (Sonnet) to 98% (Haiku) of nudged attempts called the advisor
  immediately at turn 2 — so if the baseline first call is later than the
  nudge turn, the nudge can displace a better-timed call (3–4pp drop when
  baseline was turn 7+). Skip the nudge if the system prompt already contains
  restraint language.
- **Haiku alternative block** for coding workloads: raises Haiku pass rates
  ~7.5pp over the built-in default, but costs ~4pp on browse workloads — gate
  on workload type.
- **Opus checkpoint**: only add if Opus is observed under-calling; net effect
  is flat on mixed workloads.
- **Forcing**: `tool_choice: {"type": "tool", "name": "advisor"}` forces a
  consult on a specific request; cannot be combined with manual extended
  thinking (`thinking: {type: "enabled"}` → 400; adaptive thinking is fine).
- **Trimming output**: a line in the *user message* addressing the advisor
  directly ("Keep your advice under N words") is followed much more reliably
  than third-person descriptions; ask for ~80% of the true ceiling (soft
  constraint). Pair with `max_tokens` for a hard ceiling.
- **Effort pairing**: Sonnet executor at medium effort + Opus advisor ≈ Sonnet
  at default effort, at lower cost.

## 2.11 Cost control patterns

- **Conversation-level budgets**: count advisor calls client-side; when the cap
  is reached, remove the advisor tool from `tools` (result blocks may stay in
  history).
- Enable `caching` only when ≥3 advisor calls per conversation are expected.
- `max_tokens: 2048` as the recommended starting cap.

## 2.12 Related: advisor on Claude Managed Agents

Managed Agents sessions support an advisor as a **roster entry** rather than a
tool definition: `{"type": "advisor", "model": ...}` in the agent's multiagent
roster. No `max_uses`/`max_tokens`/`caching` options; advice is delivered as
**thread events** on the session's event stream instead of
`advisor_tool_result` blocks.

## 2.13 What this means for a pi implementation

The server-side tool is the *ideal* mechanism but requires the client to
understand `server_tool_use` / `advisor_tool_result` / `pause_turn` — pi-ai
currently does not (see doc 3). The *strategy* (executor + second model
consulted at decision points) can be reproduced client-side with a regular
tool call, which is how the pattern worked before the server tool existed.
