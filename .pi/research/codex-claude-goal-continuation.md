# How Codex and Claude Code keep `/goal` running

**Researched:** 2026-09-18  
**Scope:** OpenAI Codex 0.155.0, Anthropic Claude Code 2.1.276, and the current local `.pi/extensions/workflows-goal` implementation.

## Answer in one paragraph

Neither product relies on telling the working model "keep going." Both add host-side control after a model turn finishes. Codex persists a goal on the thread and, when the thread becomes idle, conditionally starts another ordinary model turn with an internal continuation message. Claude Code implements `/goal` as a session-scoped prompt-based `Stop` hook: a separate fast model judges the completion condition after each turn, blocks the stop when the condition is not met, and feeds its reason into the next turn. The local Pi extension currently has persistent state and prompt instructions, but no equivalent continuation boundary. Once Pi reaches `agent_settled`, it stays idle until something sends another message.

## OpenAI Codex

### Availability and user-facing contract

Goals shipped in Codex 0.128.0 as persisted `/goal` workflows with model tools, runtime continuation, app-server APIs, and TUI controls. The latest release when this note was written was 0.155.0.

OpenAI describes a Goal as a thread-scoped completion contract, not global memory or a large prompt. The state contains the objective, lifecycle, budget, and usage accounting. The documented terminal conditions include success, pause, clear, interruption, budget exhaustion, usage limits, and a blocker that needs user input.

Sources:

- [OpenAI, "Using Goals in Codex"](https://developers.openai.com/cookbook/examples/codex/using_goals_in_codex)
- [Codex 0.128.0 release notes](https://github.com/openai/codex/releases/tag/rust-v0.128.0)
- [Codex 0.155.0 release](https://github.com/openai/codex/releases/tag/rust-v0.155.0)

### What happens when the model stops

The model is allowed to finish its response. Codex then reacts at the thread-idle boundary:

```text
model finishes turn
  -> thread becomes idle
  -> Goal extension receives on_thread_idle
  -> continue_if_idle reads the persisted goal
  -> require goal.status == active
  -> build an internal continuation item
  -> start_turn_if_idle starts another regular turn
```

This is real scheduling, not prompt pressure. The Goal runtime calls the host's turn-start operation after the previous turn has ended. The call is conditional and does not enqueue work when the thread is no longer eligible.

The runtime holds a per-thread goal-state permit across the read/start window. That prevents a stale idle callback from reading an active goal, racing with a pause or clear, and then starting obsolete work.

Sources, pinned to the Codex 0.155.0 release tag:

- [`on_thread_idle` in the Goal extension](https://github.com/openai/codex/blob/rust-v0.155.0/codex-rs/ext/goal/src/extension.rs)
- [`continue_if_idle` in the Goal runtime](https://github.com/openai/codex/blob/rust-v0.155.0/codex-rs/ext/goal/src/runtime.rs)
- [The thread's idle-start API](https://github.com/openai/codex/blob/rust-v0.155.0/codex-rs/core/src/codex_thread.rs)

### Why it does not blindly loop

Codex only continues when the goal is active, within budget, and the thread is safely idle. Its public guide says it does not continue while another turn is active, user input is queued, other thread work is pending, or plan-only work is running. This gives user work priority over autonomous continuation.

The current Goal code also contains loop guards:

- Goal state can become `paused`, `blocked`, `usage_limited`, `budget_limited`, or `complete`; only `active` is continuation-eligible.
- Token and wall-clock usage are accounted to the goal.
- Terminal turn errors stop automatic continuation. Usage exhaustion becomes `usage_limited`; other terminal errors become `blocked`.
- Three consecutive automatic turns with an empty final response and no recorded activity block the goal.
- Three consecutive turns that only produce failed execution attempts, without any successful tool call, block the goal.
- The public guide also states that a continuation with no tool call suppresses the next automatic continuation, so Codex does not spin on prose-only turns.

The exact lower-level counters are implementation details and can change. The stable design point is that the host, not the model, decides whether another turn may start.

Sources:

- [OpenAI Goals guide, architecture and safe-boundary discussion](https://developers.openai.com/cookbook/examples/codex/using_goals_in_codex)
- [Goal accounting and no-progress counters](https://github.com/openai/codex/blob/rust-v0.155.0/codex-rs/ext/goal/src/accounting.rs)
- [Turn-stop and turn-error handling](https://github.com/openai/codex/blob/rust-v0.155.0/codex-rs/ext/goal/src/extension.rs)
- [Persistent statuses and budget accounting](https://github.com/openai/codex/blob/rust-v0.155.0/codex-rs/state/src/runtime/goals.rs)

### How Codex decides it is done

Codex does not use a separate verifier model. The working model receives `get_goal`, `create_goal`, and `update_goal` tools. Its continuation prompt requires an evidence audit before it calls `update_goal` with `status: "complete"`.

The prompt tells the model to derive every requirement from the original objective, inspect authoritative current state, and treat uncertain or missing evidence as incomplete. It also tells the model not to redefine success around a smaller task.

The current `update_goal` contract accepts:

- `complete`, only when every required part is achieved and verified;
- `blocked`, only after the same real blocker persists for at least three consecutive goal turns;
- `paused`, only when the user explicitly requested a pause.

This completion decision is still model judgment. The host enforces lifecycle and scheduling, but it does not independently run tests to prove completion. Tests and commands become evidence because the working model runs them and audits their results.

Sources:

- [Codex continuation prompt](https://github.com/openai/codex/blob/rust-v0.155.0/codex-rs/ext/goal/templates/goals/continuation.md)
- [Goal tool schemas and status rules](https://github.com/openai/codex/blob/rust-v0.155.0/codex-rs/ext/goal/src/spec.rs)
- [Goal tool execution](https://github.com/openai/codex/blob/rust-v0.155.0/codex-rs/ext/goal/src/tool.rs)

### Persistence

Codex stores the goal against the thread in its state database. The persisted record includes a goal ID, objective, status, token budget, tokens used, elapsed time, and timestamps. On thread resume, the Goal extension reads that state and restores active-goal accounting.

This means the objective is independent of conversation compaction and can be restored with the thread. It does not mean work continues while the Codex process is absent. A live runtime must reach an eligible idle boundary to schedule the next turn.

Sources:

- [Codex goal state store](https://github.com/openai/codex/blob/rust-v0.155.0/codex-rs/state/src/runtime/goals.rs)
- [Goal restoration on thread resume](https://github.com/openai/codex/blob/rust-v0.155.0/codex-rs/ext/goal/src/runtime.rs)

## Anthropic Claude Code

### Availability and user-facing contract

Claude Code added `/goal` in v2.1.139. Anthropic described it as a completion condition that keeps Claude working across turns in interactive mode, `-p`, and Remote Control. The latest release when this note was written was v2.1.276.

Sources:

- [Claude Code v2.1.139 release notes](https://github.com/anthropics/claude-code/releases/tag/v2.1.139)
- [Claude Code v2.1.276 release](https://github.com/anthropics/claude-code/releases/tag/v2.1.276)
- [Claude Code `/goal` documentation](https://code.claude.com/docs/en/goal)

### What happens when the model stops

Claude Code places the control point directly on the stop event:

```text
working Claude finishes a turn
  -> session-scoped Stop hook runs
  -> separate fast model receives the goal condition and conversation
  -> evaluator returns a verdict and reason
       not yet met -> block the stop and continue with the reason
       met         -> clear the goal and end
       impossible  -> clear the goal as failed and end
```

Anthropic documents `/goal` as a wrapper around a session-scoped prompt-based `Stop` hook. A blocked Stop hook feeds its reason back to Claude, which becomes guidance for another turn. Unlike Codex, Claude Code does not first let the thread settle and then ask an idle scheduler to start a new turn. It prevents the normal stop from completing.

Sources:

- [Claude Code `/goal`, "How evaluation works"](https://code.claude.com/docs/en/goal#how-evaluation-works)
- [Claude Code prompt-based hooks](https://code.claude.com/docs/en/hooks-guide#prompt-based-hooks)
- [Claude Code Stop-hook reference](https://code.claude.com/docs/en/hooks#stop)

### The evaluator is separate from the worker

The goal evaluator uses the configured small fast model, Haiku by default on the Claude API. It receives the condition and conversation so far, but cannot call tools or inspect files. Therefore the working Claude must surface proof such as test output in the transcript.

That separation matters. The worker cannot end the goal merely by deciding to write a final answer. A fresh model checks the explicit condition. It is still probabilistic evaluation, not a deterministic test gate.

For a deterministic custom gate, Claude Code's general hook system can run a command hook. For tool-using verification, it can run an agent hook. The built-in `/goal` evaluator itself is documented as prompt-based.

Sources:

- [Claude Code `/goal` condition-writing and evaluator sections](https://code.claude.com/docs/en/goal)
- [Claude Code prompt and agent hook comparison](https://code.claude.com/docs/en/hooks-guide#prompt-based-hooks)

### Loop and failure safeguards

Claude Code does not let the Stop hook block forever without evidence of work:

- If Claude produces several turns without tool use, Claude Code stops the loop, returns control to the user, and leaves the goal set. Evaluation can resume after the next prompt.
- The underlying Stop-hook system has an eight-consecutive-block cap without progress. The cap can be configured with `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`.
- An `impossible` verdict clears the goal and records failure.
- Unrecoverable errors such as an exhausted credit balance, unavailable model, or context overflow that compaction cannot fix clear the goal.
- Transient errors may retry automatically. Current interactive versions retry up to three times before pausing.
- Rate limits and similar conditions pause rather than burn turns. Work can resume after the limit resets or after a user message.
- Permissions remain separate. `/goal` does not approve tools, so unattended work generally also needs an appropriate permission mode.

Sources:

- [Claude Code `/goal`, evaluation and failure behavior](https://code.claude.com/docs/en/goal#how-evaluation-works)
- [Claude Code hooks guide, Stop-hook block cap](https://code.claude.com/docs/en/hooks-guide#stop-hook-hits-the-block-cap)

### Background work and check-ins

Claude Code defers goal evaluation while a background command or subagent is still running. When that work reports a result, it delivers the result as a new turn. Long waits receive increasingly spaced check-ins. In an interactive session, Claude Code can start an idle check-in turn itself, capped at three idle check-ins per goal between user prompts.

This is a separate mechanism from the ordinary post-turn Stop-hook loop. It prevents the evaluator from declaring failure merely because useful asynchronous work has not finished.

Source: [Claude Code `/goal`, "Background work defers evaluation"](https://code.claude.com/docs/en/goal#background-work-defers-evaluation)

### Persistence

Claude Code allows one active goal per session. Active goals are restored through all current resume routes. The condition survives, while the turn count, timer, and token-spend baseline reset. Achieved and cleared goals are not restored.

Anthropic does not publish the Claude Code runtime implementation, so the exact storage schema and internal scheduling code cannot be verified from source. The behavior above comes from first-party documentation and release notes.

Source: [Claude Code `/goal`, "Resume with an active goal"](https://code.claude.com/docs/en/goal#resume-with-an-active-goal)

## Side-by-side comparison

| Question | OpenAI Codex | Anthropic Claude Code |
|---|---|---|
| Where is the goal stored? | Persistent thread state | Session state, restored on resume |
| What catches a model stop? | Thread-idle lifecycle | Stop hook before control returns |
| How does another turn begin? | Host calls an idle-only turn-start API | Stop is blocked and evaluator reason drives the next turn |
| Who judges completion? | Working model, under a strict audit prompt, calls `update_goal` | Separate fast evaluator model |
| Can the verifier inspect files itself? | The working model can use tools before deciding | No; built-in evaluator reads conversation evidence only |
| Main loop guards | Idle admission, user-work priority, statuses, budgets, error handling, no-progress counters | Stop-block cap, prose-only/no-tool detection, impossible verdict, error retry/pause/clear rules |
| Does it run after process exit? | No; state resumes with the thread | No; state resumes with the session |

## Comparison with this repository's Pi extension

The local implementation does two important parts correctly:

1. It persists goal transitions as branch-aware `goal-state` custom session entries.
2. It injects active-goal instructions through `before_agent_start` and sends one kickoff user message when a goal is created.

It does not implement the mechanism that makes Codex or Claude Code autonomous across completed turns:

- `.pi/extensions/workflows-goal/index.ts` has no `agent_settled` handler.
- Its `turn_end` handler only updates the widget and sends a completion notification.
- A checkpoint changes state but does not schedule another turn.
- If the model emits a final response with no tool call, Pi becomes idle even while the goal remains active.

Relevant local files:

- `.pi/extensions/workflows-goal/index.ts`
- `.pi/extensions/workflows-goal/goal-state.ts`
- `.pi/extensions/workflows-goal/goal-prompts.ts`

Pi documents `agent_settled` as the event that fires after the run, retries, compaction retries, and queued continuations are finished. That is the closest local boundary to Codex's thread-idle callback. A Pi implementation patterned after Codex would check the persisted goal there and explicitly queue a follow-up turn. A Claude-style design would instead need a pre-settlement stop gate with a separate evaluator. Pi's documented extension lifecycle does not currently expose a direct equivalent of Claude Code's blocking Stop hook, so `agent_settled` plus a new follow-up message is the practical design.

Source: [Pi extension lifecycle documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md#agent_start--agent_end--agent_settled)

## Design implications for Pi

Adding only this handler would be unsafe:

```ts
pi.on("agent_settled", () => {
  if (goal?.status === "active") pi.sendUserMessage("Continue.");
});
```

A production version needs at least:

- an atomic check that the same goal is still active;
- protection against duplicate or re-entrant continuation;
- user messages and explicit pause/clear taking priority;
- a completion decision separate from the working model's desire to stop;
- blocked, retryable-error, usage-limit, and budget states;
- a cap for empty, prose-only, or repeatedly failing turns;
- handling for background work so it is not mistaken for inactivity;
- stale-callback protection when the goal is replaced or the session branch changes;
- persisted continuation accounting so resume behavior is predictable.

The simplest robust model for Pi is closer to Codex than Claude Code: use `agent_settled` as the idle boundary, verify the goal and loop budget, then queue a follow-up user message. A separate evaluator can be added later if the working model completes goals too early. Without the scheduler, the current extension remains a useful persistent prompt, but it does not guarantee continued execution.

## Confidence and gaps

High confidence:

- Codex uses persisted thread state and an idle-triggered host turn-start path. This is documented and visible in released source.
- Claude Code uses a session-scoped prompt-based Stop hook and a separate evaluator. This is stated directly in official documentation.
- The local Pi extension has no automatic continuation after settlement. This is visible in local source.

Limits:

- Anthropic publishes release artifacts and documentation but not the Claude Code runtime source, so its exact internal state representation cannot be independently inspected.
- Both products evolve quickly. Version-specific retry, check-in, and no-progress details should be rechecked before copying exact thresholds.
- Model-based completion remains fallible in both designs. Host scheduling guarantees another opportunity to work; it does not guarantee that the model's completion judgment is correct.
