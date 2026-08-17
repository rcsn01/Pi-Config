# 1. Claude Code's `/advisor`

## 1.1 What it is

`/advisor` is a Claude Code slash command that lets the user pick a second,
typically stronger model — the **advisor** — which the main model (the
**executor**) can consult at key moments during a task: before committing to an
approach, when stuck on a recurring error, or before declaring a task complete.

The advisor receives the **full conversation** (every tool call and result) and
returns guidance that the executor applies before continuing. The advisor runs
**server-side on Anthropic's infrastructure** as a *server tool* (see
[doc 2](02-advisor-executor-mechanics.md)), available to both subscription and
API-billed accounts. The user chooses which model acts as advisor; **Claude
decides when to call it** (model-driven timing, not rule-based).

## 1.2 Enabling / configuring — three ways

| Way | What it does |
|-----|--------------|
| `/advisor` (no args) | Opens a picker listing available advisor models; selection is saved to `advisorModel` in user settings and persists across sessions |
| `/advisor <model>` | Sets the advisor directly; confirms with `Advisor set to <model>` |
| `/advisor off` (or "No advisor" in picker) | Stops using the advisor and clears the saved `advisorModel` |
| `advisorModel` setting | Persistent default in the settings file, no session needed |
| `--advisor <model>` CLI flag | Sets the advisor for a single session at launch; takes precedence over `advisorModel`; not listed in `claude --help`; errors if the main model doesn't support the advisor or the model is allowlist-blocked |

If any of these sets an advisor model, the advisor is enabled for sessions whose
main model supports it, and a notification appears after session start:

> `Advisor Tool (experimental) is on and may use more tokens · /advisor`

## 1.3 Session UX

- While an advisor call is in progress, the transcript shows an **`Advising`**
  line with the advisor model name.
- When the result returns, the line confirms the advisor has reviewed the
  conversation. Press **`Ctrl+O`** to expand and read the advisor's full
  guidance.
- Claude generally follows the advice but **surfaces conflicts** when its own
  evidence contradicts a specific claim (a recommended step fails when tried,
  or file contents contradict the advice).
- The advisor always receives the full conversation; Claude controls timing.
  Users can ask for a consult in their prompt ("consult the advisor before you
  continue") — there is no setting to cap or force calls.

## 1.4 Model pairing rules

- The advisor **must be at least as capable as the main model**.
- Accepted advisor aliases: `fable`, `opus`, `sonnet` — resolved to Claude
  Code's built-in default version for each family (advances with releases).
  Full model IDs (e.g. `claude-opus-5`) also work.
- Claude Code **validates the pairing before sending**:
  - Advisor less capable than main model → advisor not attached to the main
    model's requests; `/advisor` output and a notification show this. Subagents
    whose own model satisfies the pairing may still use the advisor.
  - Main model or advisor unrecognized → advisor not attached.
- **Subagents inherit the configured advisor** and apply the same pairing check
  against their own model.
- If the org's `availableModels` allowlist excludes the saved advisor model, the
  advisor is not invoked until the user picks an allowed model with `/advisor`.
  (Changelog: fixed the dialog pre-selecting a blocked saved advisor model, and
  `availableModels` not being applied to the advisor model.)

## 1.5 Requirements / availability

- **Anthropic API only** — not available on Amazon Bedrock, Claude Platform on
  AWS, Google Cloud's Agent Platform, or Microsoft Foundry. Through an LLM
  gateway (`ANTHROPIC_BASE_URL`), availability depends on whether the gateway
  forwards the request intact to the Anthropic API.
- **Supported main models**: Opus 4.6+, Sonnet 4.6+, Haiku 4.5; Fable 5 on
  Claude Code v2.1.170+ (a Fable 5 main accepts only a Fable advisor).
- **Feature-flag gating**: the advisor turns on via a feature flag fetched from
  Anthropic; with `DISABLE_TELEMETRY` (or anything that disables flag fetching)
  the advisor stays off.
- **Kill switch**: `CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1` disables the tool
  entirely — `/advisor` becomes unavailable, `advisorModel` is ignored, and
  `--advisor` is accepted but has no effect.

## 1.6 Cost & caching behavior

- Each advisor call sends the conversation to the advisor model; tokens are
  billed at the **advisor model's rates** (API billing) or count toward plan
  usage limits (subscription).
- Advisor usage counts toward session totals shown by `/usage`.
- **Prompt caching is unaffected**: toggling `/advisor` mid-session does *not*
  invalidate the main model's prompt cache (unlike changing model/effort). The
  advisor's returned guidance is cached as part of the transcript on later
  turns. The advisor model's own read of the conversation is **not** cached —
  each call processes the full transcript anew (unless the `caching` tool
  parameter is set; see doc 2).
- Fable 5 as advisor requires Fable access; usage-credits consent is set up
  through `/model fable` (changelog: fixed the consent message for interactive
  `--advisor fable` launches).

## 1.7 Changelog history (evidence of evolution)

| Version | Change |
|---------|--------|
| ~2.1.117 | **Advisor Tool (experimental) introduced**: dialog carries an "experimental" label, learn-more link, and startup notification when enabled; fixed sessions getting stuck with "Advisor tool result content could not be processed" errors on every prompt and `/compact` |
| ~2.1.1xx | Fixed a spurious "check your network" warning that appeared while the advisor was thinking |
| ~2.1.1xx | Fixed the `/advisor` dialog pre-selecting a saved advisor model blocked by the `availableModels` allowlist |
| ~2.1.1xx | Fixed `availableModels` restrictions not being applied to the advisor model |
| ~2.1.2xx | Fable temporarily shows as unavailable in the advisor picker while a server-side issue causing Fable advisor failures is fixed |
| 2.1.232 | Fable 5 offered as an advisor in `/advisor` again for orgs with Fable access; fixed the consent message for interactive `--advisor fable` launches |

## 1.8 Comparison with related features (from the docs)

- **`opusplan`**: a fixed "Opus plans, main model executes" mode for plan mode
  only. The advisor is dynamic (model decides when), works in any mode, and the
  advisor model is user-selectable.
- **Subagents**: an orchestrator decomposes work and delegates to workers. The
  advisor inverts this — a smaller executor drives and escalates *without*
  decomposition, worker pools, or orchestration logic.
- **Switching the main model**: for short tasks or work where every turn needs
  the strongest model, just switch the main model instead.

## 1.9 Key takeaways for a pi port

1. The user-facing surface is small: a picker command, a persisted setting, a
   startup notification, and an "Advising" status line — all easily replicated
   with `pi.registerCommand`, `ctx.ui.select`, `ctx.ui.notify`, and
   `ctx.ui.setStatus`.
2. The interesting part is the executor mechanics (doc 2) and how to wire them
   into pi's model loop (doc 3).
3. The pairing rule (advisor ≥ executor) and the "model decides when" behavior
   are the two invariants that make the strategy work.
