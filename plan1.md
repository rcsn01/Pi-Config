# Client-side `/advisor` for Pi

Research date: 2026-08-18
Target: this repository's Pi `0.84.1` extension stack

## Executive decision

Build a `tools-advisor` extension whose advisor runtime is opt-in. It lets a
cheaper main model (the **executor**) call a stronger model (the **advisor**)
only at high-leverage decision points. The advisor call is made by the Pi
client through the existing model registry, with no tools and with a faithful,
provider-neutral projection of the executor's effective conversation. The
advice comes back as a normal tool result, after which the executor continues
the same task.

This is the closest provider-agnostic equivalent to Claude Code's native
`/advisor`. It will not be the same protocol: Claude's version is an Anthropic
server tool running inside one Messages API request, while Pi's version will be
a second request owned by the extension.

"Without losing quality" must be a release gate, not an unsupported promise.
Anthropic's published result shows Sonnet plus an Opus advisor beating **Sonnet
alone** by 2.7 percentage points on SWE-bench Multilingual while costing 11.9%
less per task; it does not prove equality with Opus running the whole task.
Likewise, Anthropic reports that Haiku plus Opus remains behind Sonnet alone on
BrowseComp despite large savings. We should therefore keep the extension
opt-in until a paired evaluation on our workloads demonstrates non-inferiority
to our current high-quality baseline.

## What Claude Code `/advisor` does

### User-facing behavior

- `/advisor` opens a model picker; `/advisor <model>` selects an advisor; and
  `/advisor off` disables it. The selection persists as `advisorModel`.
- The slash command configures the facility. It does not itself run a
  consultation. The executor decides when to call the advisor, although the
  user can ask it to consult.
- Claude Code normally consults before committing to an approach, after
  repeated failure, when changing direction, and before declaring a
  substantial task complete.
- The transcript shows an `Advising` row. The returned guidance can be
  expanded, but the executor—not the advisor—owns the user-facing answer and
  all tool use.
- Claude Code validates that its advisor is at least as capable as its main
  model. Its aliases and compatibility table are Anthropic-specific.

### Protocol behavior

The native implementation is the beta Anthropic server tool
`advisor_20260301`:

1. The executor emits a `server_tool_use` block named `advisor` with empty
   input.
2. Anthropic starts a separate advisor-model inference inside the same
   `/v1/messages` request.
3. The advisor receives quoted context containing the executor system prompt,
   tool definitions, prior messages, tool calls and results, and text already
   produced in the current assistant turn.
4. The advisor runs without tools or context management. Its private thinking
   is discarded and only guidance is returned.
5. The executor resumes generation with that guidance.

The server API supports a per-request `max_uses`, a per-call `max_tokens`, and
optional advisor-side prompt caching. Claude Code itself exposes model
selection but no hard call cap or force setting; timing is model-driven.

### Cost and cache behavior

- Executor and advisor usage are billed at their respective model rates.
- The saving comes from paying the stronger model for a short plan or course
  correction while the cheaper executor performs exploration, tool calls,
  edits, tests, and the final response.
- Anthropic says ordinary advisor output is roughly 400–700 visible text
  tokens. On a small hard-reasoning study, an advisor `max_tokens` of 2048 cut
  total advisor output by about 7x with no detected degradation, but Anthropic
  explicitly recommends validating on the target workload.
- Claude Code's current documentation says its advisor rereads the transcript
  without advisor-side cache reuse. The lower-level API now has an optional
  `caching` parameter and says caching becomes worthwhile at roughly three
  calls per conversation. These are not contradictory: the API offers a knob
  that Claude Code does not currently expose.
- The advisor can improve total cost even though it adds an inference because
  a better early trajectory can reduce tool calls, failed attempts, and
  conversation length.

### Where it helps and where it does not

Good fits are long, multi-step coding tasks whose routine execution is cheap
but whose plan, diagnosis, or final risk check is consequential. It is a poor
fit for simple lookups, one-step mechanical edits, and tasks where every step
requires the strongest model. For the last category, the correct action is to
run the stronger model as the executor.

## What Pi already provides

The installed Pi APIs and this repo provide nearly every client-side seam we
need:

- `ExtensionAPI.registerCommand()` and `registerTool()` support the `/advisor`
  surface and the model-callable `advisor` tool.
- A tool's `execute()` receives `ctx.modelRegistry`, `ctx.sessionManager`, the
  current model, the abort signal, and the current effective system prompt.
- `ctx.sessionManager.buildContextEntries()` returns the active,
  compaction-aware branch rather than abandoned or already summarized history.
  `sessionEntryToContextMessages()` and `convertToLlm()` project those entries
  into model messages.
- Pi persists the finalized assistant message before executing its tool calls,
  so the advisor can receive the executor's prose from the current turn as
  well as earlier tool evidence. A contract test should lock down this event
  ordering.
- `ctx.modelRegistry.complete()` performs an authenticated model call through
  the same provider runtime as the main session and returns normal usage data.
- A custom tool result may attach `usage`; Pi persists that usage and the
  existing `_shared/usage.ts` collector already counts usage attached to tool
  results.
- `pi.setActiveTools()` can completely remove the advisor schema and prompt
  overhead while the feature is off.
- The settings-profile extension replaces the whole settings document, so a
  top-level `advisor` namespace naturally follows the active profile.
- The in-process, tool-free guardian session demonstrates the desired
  isolation, but the advisor does not need a second `AgentSession`: one direct
  model completion is smaller, faster, and cannot recurse into extensions.

The existing `tools-subagents` process runner is not the right backend. It is
designed for delegated tasks with fresh context and optional tools. Passing a
serialized transcript as one large subagent task adds process startup,
weakens prefix caching, and makes exact context handoff harder.

## Proposed architecture

```text
user task
   |
   v
cheap executor in the normal Pi loop
   |  calls advisor() alone at a decision point
   v
tools-advisor extension
   |-- reads effective, compaction-aware session context
   |-- projects it into a provider-neutral transcript
   |-- adds executor system prompt + active tool manifest as quoted context
   |-- performs one authenticated, tool-free completion
   v
strong advisor model
   |  concise plan / correction / risk check
   v
normal advisor tool result (with usage metadata)
   |
   v
same executor continues, verifies, and answers the user
```

### Core invariants

1. **The executor stays in control.** The advisor never edits files, runs
   commands, sends a user-facing answer, or recursively calls another advisor.
2. **No silent context loss.** Use the executor's entire effective context,
   including its current-turn prose and all active tool results. Do not apply
   a character cutoff, "top files" heuristic, or lossy advisor-only summary.
3. **No extra routing model.** The executor chooses when to consult, guided by
   a short tool description and prompt guidelines. An extra classifier would
   consume tokens and could suppress a consultation that mattered.
4. **One consultation is one isolated completion.** No agent loop and no tools
   exist on the advisor side.
5. **Advice is evidence, not authority.** The executor should follow it unless
   primary evidence contradicts a specific claim. Conflicts are surfaced and,
   when material, reconciled with one further consultation.
6. **Quality failures stop rollout.** A cheaper pairing is not called
   quality-preserving merely because it looks plausible or costs less.

## Context handoff design

This is the highest-risk implementation boundary and should be built before
the command UI.

### Source context

At advisor tool execution:

1. Read `ctx.sessionManager.buildContextEntries()`. This matches what the
   executor can currently see after compaction and excludes abandoned tree
   branches.
2. Project entries with `sessionEntryToContextMessages()` and
   `convertToLlm()`.
3. Read `ctx.getSystemPrompt()` and the active tools from
   `pi.getActiveTools()` / `pi.getAllTools()`.
4. Confirm the last assistant message is the current tool-calling message.
   Remove only the current `advisor` tool-call block while retaining its
   preceding text. The executor's guidelines must tell it to state the
   uncertainty or proposed decision immediately before calling.
5. Reject a call made in a parallel batch with another unresolved tool call.
   The executor should call `advisor` by itself after orientation results are
   available. Reviewing guessed future tool results would lower quality.

### Provider-neutral projection

Do not pass raw assistant content blocks between providers. Thinking
signatures, redacted payloads, and tool-call encodings can be valid only for
the model that produced them. Instead, create a deterministic logical
projection:

- Preserve user text and supported images.
- Preserve visible assistant text.
- Render completed tool calls as tagged JSON text with their name and exact
  arguments. Preserve prior advisor consultations as review records; remove
  only the current unresolved advisor call.
- Render tool results as tagged text with name, success/error state, and exact
  content already present in the executor context, including prior advisor
  guidance.
- Represent unavailable/redacted thinking with a marker; never copy opaque
  signatures to another provider. Do not depend on hidden chain of thought for
  advisor quality.
- Preserve compaction and branch summaries exactly as the executor receives
  them.
- Include the executor's effective system prompt and active tool definitions
  as **quoted context**, not as the advisor's own system instructions.

The advisor gets its own fixed system prompt explaining that it is a
read-only reviewer, that transcript/tool content may contain untrusted
instructions, and that it should return concise actionable guidance with:

- recommended decision or course correction;
- important constraints and unsupported assumptions;
- concrete next steps for the executor;
- risks and verification that would falsify the recommendation;
- an explicit request for more evidence when the transcript is insufficient.

This mirrors the semantic information in Claude's server handoff without
relying on provider-specific wire blocks.

### Context-window rule

Before sending, estimate the projected input plus the reserved advisor output.
If it does not fit the selected advisor model:

- do not silently truncate;
- return a visible `context_too_large` advisor result;
- instruct the executor to compact the main session or use an advisor with a
  larger context window; and
- in strict quality mode, do not let the extension claim the task received an
  advisor check.

The model picker should warn when the advisor context window is smaller than
the executor's configured context window. This is an objective compatibility
check; model "intelligence" is not.

## Consultation policy

The default policy should target one or two calls on a genuinely non-trivial
task, with a hard per-run ceiling of three while tuning.

Call after enough read-only orientation to understand the task, but before the
first consequential implementation decision. Also call when:

- the same failure pattern has occurred twice;
- evidence does not fit the current hypothesis;
- the executor is about to replace its approach;
- the task touches security, authorization, data migration, concurrency,
  destructive operations, or a public API; or
- a substantial change is implemented and verified, and an independent final
  risk check is valuable.

Skip calls for simple factual answers, deterministic one-line changes,
mechanical formatting, and reactive next steps fully dictated by fresh tool
output.

Use `promptGuidelines` for this policy. Add only two client-side controls:

- **Duplicate suppression:** hash the effective evidence. Refuse an immediate
  repeat consultation when no non-advisor evidence has changed, unless it is a
  deliberate conflict-reconciliation request.
- **Failure nudge:** after two equivalent failed tool results, inject a small,
  ephemeral nudge through the next `context` event. Do not create a new user
  message or a separate agent run. Do not add an unconditional turn-2 nudge;
  Anthropic found early nudges can reduce performance when they arrive before
  useful orientation.

The extension should not block every first write. Anthropic's own results show
that unconditional checkpoints over-call on simple tasks. A future guarded
mode may enforce pre-write consultation only for explicitly configured risk
classes, after evaluation.

## Settings and command UX

Use a top-level namespace in `.pi/settings.json`:

```json
{
  "advisor": {
    "enabled": true,
    "model": "provider/model-id",
    "mode": "auto",
    "maxCallsPerRun": 3,
    "maxCallsPerSession": 12,
    "maxOutputTokens": null,
    "timeoutMs": 120000,
    "cacheRetention": "short",
    "requireFullContext": true,
    "allowCrossProvider": false
  }
}
```

Correctness-first defaults matter:

- `maxOutputTokens` starts unset during evaluation. Tune it down per advisor
  model only after truncation and quality measurements; 2048 is a strong first
  experiment, not a universal safe value.
- `allowCrossProvider` defaults to false because a full system prompt, code,
  and tool output may otherwise be sent to a different data processor without
  an explicit decision.
- Call ceilings prevent runaway spend, but the target behavior is below the
  ceiling rather than consuming the allowance.

Command behavior:

- `/advisor` — searchable picker from the session-scoped model list, or all
  authenticated models when no scope exists.
- `/advisor <provider>/<model>` — select and enable directly.
- `/advisor off` — disable and remove the tool from `pi.getActiveTools()` so
  it contributes no schema or prompt tokens.
- `/advisor status` — show executor, advisor, mode, call counts, recent usage,
  truncation/error state, and whether cross-provider transfer is allowed.
- `/advisor reset` — restore conservative defaults without guessing a model.

The picker should show provider, context window, reasoning support, and known
input modalities. Do **not** hard-code a global `haiku < sonnet < opus < ...`
rank across arbitrary providers. Warn for clearly suspect same-family choices,
but let the evaluation-qualified pairing be the source of truth.

When selecting a different provider, show exactly what context will cross the
provider boundary and ask for confirmation before persisting
`allowCrossProvider: true`.

On session start, a short notification should identify the enabled advisor.
During a call, render `Advising · provider/model`; the result is collapsed by
default and expandable. Errors, truncation, and context omissions must be
visually distinct from a successful review.

## Runner, caching, and accounting

### Runner

Use `ctx.modelRegistry.complete()` with:

- the selected advisor model;
- the fixed advisor system prompt and projected messages;
- `ctx.signal` for Escape/cancellation;
- `timeoutMs`;
- a stable session-affinity ID derived from the main session ID and advisor
  model;
- configured cache retention; and
- a per-call `maxTokens` option only when the evaluated configuration has a
  cap.

Keep the advisor model's default/high reasoning behavior for the initial
quality baseline. Do not turn reasoning off simply because the final visible
advice is short; Claude's native advisor also spends hidden reasoning tokens.
If provider-neutral thinking-level control is needed, add a small shared
adapter or propose `ModelRegistry.completeSimple()` upstream rather than
scattering provider-specific option names through the extension.

### Prefix stability

Build the projection deterministically and keep the advisor system prompt and
tool manifest byte-stable. Use the same session-affinity ID for repeated calls
with the same main session and advisor model. This gives providers with
automatic prefix caching the best chance of a hit.

After correctness is established, maintain an in-memory advisor mirror that
appends only new executor messages between calls. This can improve explicit
cache reuse, but it must produce advice identical in quality to rebuilding
from the effective main context and must reconstruct safely after resume,
branch, compaction, and model change. It is an optimization phase, not v1.

Enable aggressive advisor-side caching only when measurements show enough
calls to break even. Anthropic's lower-level API guidance says two or fewer
calls generally do not repay cache-write cost.

### Usage

Return `response.usage` on the advisor tool result. Persist details such as:

```text
schema version, advisor model, run/session call index, duration,
projected input estimate, actual input/output/cache read/cache write,
monetary cost when reported, stop reason, truncation flag,
context hash, and outcome/error code
```

Extend `_shared/usage.ts` and `/context` so advisor usage is shown separately
from executor and subagent usage. Do not double-count tool-level usage already
attached to the message.

Measure both:

1. raw tokens, because a duplicated transcript can increase them; and
2. actual/normalized cost, because cheaper executor tokens, cached input, and
   fewer failed turns may still lower the bill or subscription consumption.

The candidate cost is:

```text
executor input/output/cache cost
+ sum(advisor input/output/cache cost for each consultation)
```

Claims of savings must use this total, not executor usage alone.

## Failure, privacy, and safety behavior

- Timeout, abort, provider overload, missing auth, malformed output, and call
  cap exhaustion return typed tool errors. The executor may continue, but the
  final status must say the advisor check did not complete.
- If advice is cut off (`stopReason === "length"`), mark it truncated. Do not
  automatically spend another call; let the executor request continuation
  only when the missing tail matters.
- Never persist a second full transcript. The main session already owns it.
  Persist only the normal tool result and usage metadata.
- The advisor is read-only by construction: no tool definitions are supplied
  as callable tools, only as quoted capability context.
- Treat repository content and tool output as untrusted data in the advisor
  system prompt to reduce indirect prompt-injection risk.
- Cross-provider transfer is explicit and off by default. Same-provider does
  not automatically mean same retention policy, so the status UI should show
  the actual provider/model selected.
- On resume, fork, tree navigation, compaction, or advisor model change, reset
  ephemeral mirror/cache state and reconstruct counters from persisted advisor
  tool results.

## File plan

```text
.pi/extensions/tools-advisor/
├── index.ts                 # extension factory, tool, command, lifecycle wiring
├── advisor-prompt.ts        # fixed advisor role and executor timing guidelines
├── transcript.ts            # faithful provider-neutral context projection
├── runner.ts                # model resolution, completion, timeout, result mapping
├── policy.ts                # per-run/session caps, evidence hash, failure nudge
├── settings-store.ts        # validated atomic advisor namespace updates
├── model-compatibility.ts   # context/modality checks; warnings, not fake ranking
├── renderer.ts              # collapsed call/result and status UI
├── test-harness.ts
├── transcript.test.ts
├── runner.test.ts
├── policy.test.ts
├── settings-store.test.ts
└── index.test.ts
```

Other changes:

- `.pi/extensions/catalog.json`: add `tools-advisor` with no dependency on
  `tools-subagents`. Keep the lightweight command extension loaded by default,
  but keep `advisor.enabled` false and the model-callable tool inactive until
  the user selects a model. That preserves `/advisor` discoverability with
  zero tool-schema/prompt overhead while off.
- `.pi/package.json`: add `test:advisor` and include it in the full suite.
- `.pi/extensions/_shared/usage.ts`: add advisor-specific collection without
  changing existing totals.
- `.pi/extensions/ui-context/index.ts` and its model/tests: display advisor
  usage as a distinct block.
- `.pi/profiles/*.json`: do not add a default advisor until a pairing passes
  the evaluation gate. Then add it only to the profiles for which it was
  measured.
- `README.md`: document command usage, privacy boundary, and the fact that
  savings/quality are pairing-specific.

## Implementation phases

### Phase 0 — prove the Pi seams

- Add an event-order contract test showing that the current finalized
  assistant message is available through `buildContextEntries()` when a custom
  tool executes.
- Run one direct tool-free completion through `ctx.modelRegistry.complete()`
  using a non-main model and verify auth, abort, timeout, response extraction,
  and usage.
- Test raw cross-provider message replay and confirm why signatures/tool blocks
  require the neutral projection.
- Record the current high-quality executor baseline on the initial evaluation
  set before changing prompts or profiles.

Exit criterion: there is a tested, cancellation-safe one-shot advisor call
whose usage is visible and whose input contains the current-turn prose.

### Phase 1 — faithful minimal tool

- Implement `transcript.ts`, the fixed advisor prompt, and `runner.ts`.
- Register an empty-argument, sequential `advisor` tool.
- Add the call-alone rule and reject unresolved parallel batches.
- Return advice plus typed details and usage.
- Implement full-context preflight and no-truncation failure behavior.

Exit criterion: a user can explicitly ask the executor to consult, and the
executor receives a complete, tool-free second opinion without separate state
or configuration UI.

### Phase 2 — configuration and UX

- Implement the atomic settings store, validation, and profile-safe writes.
- Add `/advisor`, direct model selection, `off`, `status`, and `reset`.
- Activate/deactivate the tool dynamically so disabled means zero prompt/tool
  overhead.
- Add cross-provider consent, startup notification, live status, and
  expandable results.

Exit criterion: configuration survives restart/profile switch and never sends
context to an unapproved provider.

### Phase 3 — bounded automatic timing

- Add concise model-driven timing guidance.
- Track per-agent-run and per-session call counts.
- Add evidence-hash duplicate suppression.
- Add the repeated-failure ephemeral nudge; do not add unconditional nudges or
  pre-write blocking.
- Test behavior on trivial, normal, stuck, conflict, and high-risk prompts.

Exit criterion: trivial tasks normally make zero calls, representative complex
tasks normally make one or two, and no run can exceed the configured ceiling.

### Phase 4 — observability and cost tuning

- Add separate advisor accounting to `/context` and `/advisor status`.
- Capture cache hits, truncation, latency, errors, and calls per run.
- Experiment with model-specific output caps (start with 2048 where supported)
  and cache retention.
- Only then consider the incremental advisor-mirror optimization.

Exit criterion: total candidate cost can be compared honestly against the
baseline, including advisor usage.

### Phase 5 — quality evaluation

Run three paired configurations on the same tasks and clean worktrees:

1. current strong executor alone (quality reference);
2. proposed cheaper executor alone (control); and
3. proposed cheaper executor plus advisor (candidate).

Declare the reference before running the suite. It should be the production
quality profile we intend to replace—typically the selected advisor model
running end to end at its normal reasoning level—not whichever model happens
to be active while developing the extension.

The suite should contain real tasks from this repo and representative linked
projects:

- bug diagnosis with hidden regression tests;
- multi-file feature work;
- refactors with behavior preservation;
- concurrency and state-management changes;
- security/permission changes;
- ambiguous architecture decisions;
- research/documentation work with source checks; and
- trivial tasks that should not pay for an advisor.

Use deterministic build/test/typecheck results first, then blind patch review
and a small human review for semantics that tests do not cover. Repeat
stochastic tasks enough to avoid judging a pairing from one lucky run.

Release gates:

- every must-pass deterministic regression task that the reference completes
  also passes for the candidate;
- zero new critical/high-severity correctness or security defects;
- paired aggregate success is within a predeclared non-inferiority margin
  (start at 2 percentage points, tighten as the sample grows);
- blind review shows no material degradation in maintainability or scope
  discipline;
- median total cost is at least 20% lower, including advisor usage;
- p95 latency remains acceptable;
- trivial tasks make no advisor call in at least 95% of runs; and
- advisor failure/truncation is visible rather than falsely reported as a
  successful review.

If the candidate misses a quality gate, tune timing/context/pairing and rerun.
If it still misses, keep the stronger model as executor for that profile. Cost
savings are not a reason to waive the quality requirement.

### Phase 6 — controlled rollout

- Enable only in an experimental profile first.
- Review local metrics after 25, then 100 representative tasks.
- Promote the evaluated pair to other profiles individually; do not assume one
  provider/model result transfers to another.
- Keep `/advisor off` as the immediate kill switch and retain the original
  strong-executor profile as the fallback.

## Test matrix

Unit tests should cover:

- settings validation, atomic writes, preservation of unrelated keys, and
  profile switching;
- active-tool add/remove without disturbing other tools;
- exact inclusion of system prompt, current assistant prose, compaction
  summary, tool calls, tool results, images, and error states;
- removal of the current advisor call and rejection of parallel unresolved
  calls;
- removal of provider-specific thinking signatures and opaque data;
- full-context overflow failure with no hidden truncation;
- same- and cross-provider consent/compatibility;
- call caps, run reset, resume reconstruction, and evidence deduplication;
- cancellation, timeout, rate limit, missing model/auth, malformed/empty text,
  and output truncation;
- tool-result usage persistence and no double counting; and
- no unconditional nudge and no advisor recursion.

Integration tests should use Pi's faux provider to assert the exact projected
request and usage. At least one manual smoke test per enabled real provider
should verify authentication, cache reporting, and TUI rendering without
putting secrets or transcript contents in snapshots.

## Deliberate non-goals for v1

- Injecting Anthropic's native `advisor_20260301` blocks into provider payloads.
  Pi `0.84.1` does not expose the required server-tool result and paused-turn
  semantics end to end, and the requested design is client-side.
- A second LLM that decides whether to call the advisor.
- A generic model-name capability rank across providers.
- Silent transcript truncation or advisor-only lossy compaction.
- Advisor file or shell tools, implementation delegation, parallel councils,
  or multiple advisors.
- Automatically changing the user's main model. Executor selection remains a
  `/model` or settings-profile decision.

## Sources

- [Claude Code: Escalate hard decisions with the advisor tool](https://code.claude.com/docs/en/advisor)
- [Claude Platform: Advisor tool protocol, prompting, caching, and cost controls](https://platform.claude.com/docs/en/agents-and-tools/tool-use/advisor-tool)
- [Anthropic: The advisor strategy](https://claude.com/blog/the-advisor-strategy)
- [Claude Code command reference](https://code.claude.com/docs/en/commands)
- Local Pi extension types:
  `.pi/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts`
- Local Pi model registry:
  `.pi/node_modules/@earendil-works/pi-coding-agent/dist/core/model-registry.d.ts`
- Local patterns:
  `.pi/extensions/tools-subagents/`,
  `.pi/extensions/safety-permissions/guardian-runner.ts`,
  `.pi/extensions/_shared/usage.ts`, and
  `.pi/extensions/ui-context/`
