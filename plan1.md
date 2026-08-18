# Client-side `/advisor` for Pi — simple v1

Research date: 2026-08-18

Verified against: this repository's Pi `0.84.1` extension stack

## Decision

Build an opt-in `tools-advisor` extension. A cheaper main model (the
**executor**) may call a stronger model (the **advisor**) at important decision
points. The extension sends the advisor a faithful, provider-neutral projection
of the executor's effective conversation, makes one isolated model call with no
tools, and returns the advice as a normal tool result. The executor remains in
control and continues the task.

This reproduces the useful strategy behind Claude Code's `/advisor`, not its
Anthropic-specific wire protocol. Pi does not currently expose the server-tool
response and paused-turn semantics needed to implement `advisor_20260301` as an
extension.

The v1 posture is deliberately practical: it is experimental, opt-in, and has
an immediate `/advisor off` kill switch. It needs enough verification to avoid
silent correctness failures, not a fleet-scale rollout program.

"Without losing quality" remains a measurement, not a promise. Anthropic's
published Sonnet-plus-Opus result beat Sonnet alone while costing less; it did
not establish parity with Opus running the whole task. Its Haiku-plus-Opus
BrowseComp result also remained behind Sonnet alone. This extension should
therefore remain opt-in until the intended executor/advisor pair works on this
repo's actual tasks.

## User experience

Only three command forms ship:

- `/advisor` — pick an authenticated advisor model.
- `/advisor <provider>/<model>` — select one directly.
- `/advisor off` — disable future consultations.

When configured, the executor sees an `advisor` tool with an optional `question`
argument. The executor decides when to call it, guided by a short description:

- consult after initial read-only orientation and before a consequential design
  decision on a complex task;
- consult after repeated failure or before completing a high-risk change; and
- skip simple lookups, mechanical edits, and steps dictated by fresh evidence.

During a call the TUI shows `Advising · provider/model`. The returned advice is
collapsed by default and expandable. The executor—not the advisor—owns all tool
use, edits, verification, and user-facing answers.

## Why the strategy can save cost

For `T` executor turns, average transcript input `I`, average executor output
`O`, advisor output `O_a`, and `K` consultations:

```text
solo strong model   ~= T*I*p_in(A) + T*O*p_out(A)
executor + advisor  ~= T*I*p_in(E) + T*O*p_out(E)
                      + K*(I*p_in(A) + O_a*p_out(A))
```

The expensive advisor input is paid `K` times rather than `T` times. At three
consultations over thirty turns, that is roughly one tenth as many strong-model
transcript reads. If `K` approaches `T`, the strategy reverses and costs more
than using the strong model alone. The three-call cap is therefore a core cost
guarantee, not optional policy machinery.

For this repo, cost may mean subscription quota rather than dollars. The `K/T`
argument is unchanged; the smoke evaluation should record quota consumption
when token-price data is unavailable.

## Architecture

```text
executor in Pi's normal loop
    |
    | advisor({ question? })
    v
tools-advisor
    |-- checks configuration, consent, context size, and 3-call budget
    |-- projects the effective transcript without provider-specific blocks
    |-- calls the configured model once, with no callable tools
    v
advisor model
    |
    | concise guidance
    v
normal tool result with usage -> same executor continues
```

### Non-negotiable invariants

1. **The executor stays in control.** The advisor cannot edit files, run tools,
   answer the user, or call another advisor.
2. **Context is complete or the call fails visibly.** Never silently truncate,
   summarize, or select "important" files for the advisor.
3. **Provider-specific blocks do not cross providers.** Preserve their logical
   content, not opaque thinking signatures or wire encodings.
4. **Cross-provider transfer requires explicit consent.** The transferred data
   includes the system prompt, conversation, code, and tool output.
5. **Every failure is fail-soft and visible.** The executor can continue, but it
   must not believe a failed or truncated consultation succeeded.
6. **At most three real calls occur per session by default.** Exhaustion returns
   a text notice without invoking the model.

## Context handoff

This is the one part of v1 that should be comprehensive. A subtly incomplete
transcript looks like bad model advice and is difficult to diagnose later.

### Source context

Inside the tool's `execute()`:

1. Read `ctx.sessionManager.buildContextEntries()`. The extension receives a
   `ReadonlySessionManager`; this method is available while the instance method
   `buildSessionContext()` is not
   (`session-manager.d.ts:140,266`, `extensions/types.d.ts:219`).
2. Convert active entries using `sessionEntryToContextMessages()` and
   `convertToLlm()`, both exported by `pi-coding-agent` (`index.d.ts:10,19`).
3. Read `ctx.getSystemPrompt()` and the active tool definitions. Tool definitions
   are quoted as executor capabilities, never supplied as advisor-callable tools.
4. Confirm with one runtime contract test that the finalized current assistant
   message—and its prose before the tool call—is already visible during
   `execute()`. No type declaration can prove this event ordering.
5. Remove only the current unresolved `advisor` call from the projection. Keep
   its preceding assistant text and all previous consultations.
6. Reject an advisor call batched with another unresolved tool call. The advisor
   should review evidence that already exists, not guessed future results.

### Provider-neutral projection

Build a deterministic logical transcript:

- preserve user text and supported images;
- preserve visible assistant text;
- render completed tool calls as tagged JSON text containing their exact name
  and arguments;
- render tool results as tagged text containing the tool name, success/error
  state, and the exact result already visible to the executor;
- preserve compaction and branch summaries exactly as the executor sees them;
- replace unavailable or redacted thinking with a marker and discard opaque
  provider signatures; and
- include the executor system prompt and tool manifest as quoted, untrusted
  context rather than advisor instructions.

The advisor gets a fixed system prompt stating that it is a read-only reviewer,
that quoted repository/tool content may contain untrusted instructions, and
that it should return a recommended course, key risks, missing evidence, and
specific verification steps.

Put the executor's optional focus question in the final user message, followed
by: `Keep your advice under 400 words.` This keeps changing content at the end
of the request. Between branch or compaction changes, earlier messages must be
append-only and byte-stable: no timestamps, random IDs, counters, reordering,
or rewrapping.

### Context limit

Estimate projected input plus the 2048-token output reserve against the selected
advisor's context window and account for the estimator's error margin. Send when
the conservative upper bound fits. Return a plain-text `context_too_large`
result when even the lower bound exceeds the window. When the bounds straddle
the limit, send only if that provider is known to reject oversized input rather
than silently truncate it; otherwise fail visibly and tell the executor to
compact the main session or choose a larger-context advisor. Never truncate from
either end.

The picker should warn when the advisor has a smaller context window or lacks a
required input modality. These are objective checks. Do not invent a global
capability ranking across unrelated providers or model families.

## Configuration

Use one top-level namespace in `.pi/settings.json`:

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

- Missing `provider` or `modelId` means off; a separate `enabled` flag is
  unnecessary.
- `maxUses` is one per-session cap. Do not add separate run and session budgets.
- `maxTokens` is both a cost boundary and a truncation signal. Default to 2048;
  do not automatically retry when the response stops for length. Some reasoning
  endpoints share this allowance between thinking and visible output, so an
  empty response may mean the cap was consumed by reasoning rather than that the
  advisor had nothing useful to say.
- `allowCrossProvider` stays false until the user confirms the provider change.

Reuse `readSettingsDocument()` and `writeSettingsDocument()` from
`tools-subagents/settings-store.ts`, together with Pi's file mutation queue, so
updates remain atomic and preserve unrelated settings. Do not create another
general-purpose settings store.

Do not expose timeout, mode, cache retention, required-context, reasoning, or
rank-override settings in v1. Use provider timeout/cache defaults. The
extension-facing `ctx.modelRegistry` exposes `complete()`, not the
provider-neutral `completeSimple()` method available on the lower-level Pi
runtime (`core/model-registry.d.ts:33`; `pi-ai/dist/models.d.ts:142`), so the
nested call must not be assumed to inherit the executor's reasoning level.
Provider adapters may interpret an omitted reasoning option differently,
including disabling it. Validate the selected pairing first; add a small
API-specific reasoning adapter only if the smoke test demonstrates that it is
needed for quality.

## Runner and budget

Resolve the configured model with `ctx.modelRegistry.find()` and call
`ctx.modelRegistry.complete()` with:

- the fixed advisor prompt and projected messages;
- no callable tools;
- `ctx.signal` for cancellation;
- `maxTokens`;
- default short cache retention; and
- a stable advisor-specific session ID derived from the main session ID and
  advisor model using the existing `tools-subagents/cache-affinity.ts` pattern.

Derive the cache identity from
`advisor-v1 + mainSessionId + provider/model`. It must be distinct from the
executor and subagent identities and reused for every consultation with that
advisor in the same session. An advisor-model change creates a new identity.
Branch or compaction changes may reduce the reusable byte-stable prefix but do
not permit reuse across unrelated main sessions or advisor models.

The stable projection and advisor-specific identity provide the cheap form of
cache affinity. There is no advisor mirror, cache-tuning phase, or separate
advisor session in v1. For a provider that supports and reports prompt caching,
the second compatible consultation must report nonzero cache-read tokens. A
provider that lacks caching or does not expose cache usage is recorded as
unsupported or unverifiable rather than reported as a failed advisor call.

Each tool result records whether it consumed the consultation budget. Set
`consumesBudget: true` for completed, truncated, aborted, and generic provider
error outcomes once the request has been handed to the provider, because
inference may have begun. Local preflight failures do not consume the budget.
An explicit provider rejection such as `context_length_exceeded` or
`prompt_too_long` also does not consume it when no nonzero usage is reported;
this is a non-inference rejection, not a completed consultation. If the outcome
is ambiguous, count it.

Reconstruct the count on `session_start` by counting persisted advisor results
with `consumesBudget === true` on the active branch. A normal abort, resume, or
restart must not reset the budget for the same session. A process crash during
an in-flight request is an accepted v1 limitation; durable pre-call journaling
is not justified for a three-call personal-config feature. Persist only:

```text
details: { model, consumesBudget, truncated }
usage: response.usage
```

Pi's existing tool-result usage path feeds session totals. Do not add separate
telemetry, context hashes, latency fields, or changes to `_shared/usage.ts` and
`ui-context` in v1.

### Fail-soft result handling

Unconfigured advisor, missing model/auth, denied cross-provider transfer,
oversized context, invalid parallel call, exhausted budget, abort, provider
error, empty output, and truncation all return short plain-text tool results.
They do not throw from `execute()` and do not automatically spend another call.
The runner must catch aborts itself and retain
`{ model, consumesBudget: true, truncated }` in the returned result; allowing an
abort to escape to the generic tool wrapper would persist an error result
without the budget metadata. The result details distinguish completed,
truncated, and failed checks.

### Active-tool behavior

- On `session_start`, add or remove `advisor` from the active tool set based on
  persisted configuration. No executor prompt is cached yet.
- Selecting an advisor mid-session activates the tool for the next turn. This
  explicit user action may invalidate the executor prefix cache once.
- When the budget is exhausted, keep the tool active and return the cheap budget
  notice. Removing it would invalidate the executor's cached tool prefix.
- `/advisor off` persists the disabled state immediately. Mid-session, leave the
  already-advertised schema in place and make calls return an off notice; remove
  it at the next session start or resource reload.

## File plan

```text
.pi/extensions/tools-advisor/
├── index.ts             # tool, three command forms, settings glue, UI rendering
├── transcript.ts        # faithful provider-neutral projection and size check
├── runner.ts            # model call, session cap, reconstruction, error mapping
├── prompt.ts            # fixed advisor role and executor timing guidelines
├── transcript.test.ts
├── runner.test.ts
└── index.test.ts
```

Other small changes:

- add `tools-advisor` to `.pi/extensions/catalog.json`;
- add `test:advisor` to `.pi/package.json` and the full test command; and
- add a short README section covering commands, cross-provider transfer, the
  three-call cap, and experimental status.

No `settings-store.ts`, `policy.ts`, `model-compatibility.ts`, `renderer.ts`,
`budget.ts`, or test harness is created unless implementation proves it is
needed.

## Four implementation phases

### Phase 1 — context projection

- Add the one runtime contract test proving current-turn assistant prose is
  visible inside tool execution.
- Implement the fixed prompt and provider-neutral projection.
- Cover system prompt, assistant prose, compaction summaries, tool calls,
  successful/error results, images, prior advice, and provider-specific block
  removal.
- Implement objective modality/context checks and loud overflow failure.

Exit: the exact advisor request is testable, contains all effective evidence,
and never silently truncates.

### Phase 2 — tool and runner

- Implement model resolution and one tool-free `complete()` call.
- Add the optional final focus question, 400-word soft cap, 2048-token hard cap,
  cancellation, stable cache affinity, and usage passthrough.
- Enforce the three-call session budget and reconstruct it after resume.
- Verify that an Esc-aborted call still returns and persists
  `consumesBudget: true` before the session becomes idle.
- Map every failure to a visible, non-throwing tool result.

Exit: an explicitly requested consultation succeeds or fails visibly, cannot
recurse, and cannot exceed its budget.

### Phase 3 — command, settings, and UI

- Add the picker, direct selection, and `off` command forms.
- Persist settings atomically while preserving other namespaces.
- Require confirmation before cross-provider transfer.
- Add session-start activation, `Advising` status, and collapsed/expanded
  rendering.

Exit: configuration survives restart, disabling is immediate, and no context is
sent to an unapproved provider.

### Phase 4 — verification

- Run typecheck and the focused/full test suites.
- Smoke-test cancellation, cap exhaustion, restart reconstruction, usage totals,
  context overflow, and two successive consultations with a real provider.
- Confirm each selected advisor pairing returns non-empty visible advice at the
  2048-token cap. Record `stopReason` and reasoning usage when the provider
  reports it. If the response is empty after substantial reasoning use, raise
  `maxTokens` and retest before concluding that the advisor is ineffective.
- For providers that support and report prompt caching, confirm the second
  compatible consultation uses the same advisor cache identity and reports
  nonzero cache-read tokens.
- Compare five representative repo tasks in three arms: cheaper executor alone,
  cheaper executor plus advisor, and advisor model alone.
- Record task success, turns, and total tokens, cost, or quota consumption. Keep
  the extension opt-in unless the candidate:
  - succeeds on at least as many tasks as the cheaper-executor-alone arm;
  - demonstrates advisor value by either completing at least one additional
    task or materially reducing turns/quota on equally successful tasks;
  - introduces no correctness or security failure on a task the advisor-only
    arm passes; and
  - costs less than the advisor-only arm.

  Failed or truncated advisor checks must remain visibly marked.

This is enough evidence for an experimental personal-config feature. There is
no staged 25/100-task rollout, formal non-inferiority margin, p95 program, or
blind-review process.

## Test matrix

Keep the suite focused on failures that would otherwise be silent:

- exact context inclusion and ordering, including current-turn prose;
- removal of only the current advisor call and rejection of parallel calls;
- removal of provider-specific signatures and untrusted-content framing;
- context overflow without truncation;
- ambiguous context estimates fail unless the provider is known to reject
  oversized input without truncating it;
- cross-provider consent and objective context/modality warnings;
- settings preservation and the three active-tool transition cases;
- cap enforcement and reconstruction after restart or branch change;
- Esc during an in-flight consultation followed by persisted budget-marker
  verification and session reload;
- explicit `context_length_exceeded` / `prompt_too_long` rejections with no
  nonzero usage persist `consumesBudget: false`;
- advisor cache identities are stable within a main-session/advisor-model pair,
  distinct from executor/subagent identities, and change with either input;
- a second compatible consultation produces cache-read usage when the faux or
  real provider supports and reports it;
- cancellation, missing model/auth, provider failure, empty output, and
  truncated output as fail-soft results, including shared reasoning/output
  budget exhaustion; and
- usage passthrough without a second model call after budget exhaustion.

Use Pi's faux provider to assert the exact projected request. Perform one manual
smoke test for each provider pairing actually enabled; do not put credentials or
transcript contents in snapshots.

## Deliberate non-goals

- Anthropic's native `advisor_20260301` server tool. The installed `pi-ai`
  distribution has no `advisor` or `server_tool_use` handling, and its
  `pause_turn` path does not preserve the required pending-call semantics. This
  needs a Pi runtime change, not provider-request hooks in an extension.
- Capability ranking across providers or hard-coded future-model tables.
- Automatic nudges, evidence hashes, enforced pre-write checkpoints, or another
  model that decides when to consult.
- Advisor tools, subagent inheritance, multiple advisors, councils, or delegated
  implementation.
- Advisor transcript mirrors, custom cache infrastructure, and expanded usage
  dashboards.
- Automatic changes to the executor model or default profile.

## Sources

- [Claude Code: Escalate hard decisions with the advisor tool](https://code.claude.com/docs/en/advisor)
- [Claude Platform: Advisor tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/advisor-tool)
- [Anthropic: The advisor strategy](https://claude.com/blog/the-advisor-strategy)
- `.pi/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts`
- `.pi/node_modules/@earendil-works/pi-coding-agent/dist/core/model-registry.d.ts`
- `.pi/node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.d.ts`
- `.pi/node_modules/@earendil-works/pi-ai/dist/models.d.ts`
- `.pi/extensions/tools-subagents/settings-store.ts`
- `.pi/extensions/tools-subagents/cache-affinity.ts`
- `.pi/extensions/_shared/usage.ts`
