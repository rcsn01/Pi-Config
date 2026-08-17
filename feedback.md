# Feedback: Features Users Love in Claude Code, Codex, and OpenCode

Research notes on what users consistently praise about the three major terminal coding agents. Compiled from Hacker News threads, Reddit, and hands-on reviews (2025–2026). Useful as a reference for pi feature ideas.

> Status: features pi already implements (built-in or as an extension) are removed from this list; partial implementations are annotated with a **Pi status** note; everything else remains an open feature idea.

## Claude Code

**The pair programmer.** Users describe it as fast, steerable, and deeply configurable.

### What users love

- **Hooks** — deterministic automation on lifecycle events (lint after edit, block commands). Valued because they're *enforced*, not advisory: "a hook is a rule that the system enforces."
  > **Pi status:** partial — the extension API exposes lifecycle events (`pi.on(...)`) and the bash tool has a `spawnHook` to adjust or block commands, but there is no declarative, user-configurable hooks mechanism (Claude-Code-style JSON hooks).
- **Steerability / codebase adaptation** — "I am able to get it to write code mostly like I would've written it. It adapts to existing patterns, adjusts to the code style." Users can steer it mid-flight.
- **Speed and interactive rhythm** — fast iteration, explain-then-act feel. "Claude Code feels like a pair programmer, whereas Codex feels like a tool you instruct precisely."
- **Checkpoints / instant rewind** — every edit is reversible; double-Esc rewinds. Cited as a Claude Code exclusive that changes how boldly users prompt.
- **Configurability as performance** — "the configurability of Claude Code *is* its performance advantage." Plugins, MCP, slash commands, output styles.

### Common complaints

- Usage limits hit fast on the $20 plan; token burn on large codebases.
- Context window handling called "pretty poor" — compaction after 5–6 prompts in big sessions.
- Ignores instructions in long sessions ("the same issue of ignoring important instructions still happens about 90% of the time").
- Grep-based navigation misses the big picture in large codebases.

## Codex

**The contractor.** Users describe it as hands-off, token-efficient, and safer by default.

### What users love

- **OS-level sandboxing** — Seatbelt/bubblewrap, not just app-layer guardrails. "The sandboxing story is best-in-class." Users report feeling safer running each command.
  > **Pi status:** partial — `safety-permissions` gates risky commands, and isolated execution is documented (Gondolin micro-VM example extension, Docker, OpenShell), but no OS-level sandbox ships in this config.
- **Token efficiency** — consistently reported at 2–4x fewer tokens than Claude Code for comparable work. "Burns roughly a quarter of the tokens Claude Code does on the same prompts."
- **Cloud handoff** — `codex cloud` with best-of-N attempts; the same model and AGENTS.md drive the GitHub app (auto PR review, `@codex` on issues). "The CLI-to-GitHub consistency is the piece reviewers most often single out as Codex's edge."
- **Auto-PR creation** — clone, branch, change, test, open PR with summary. "I have not opened the GitHub web UI manually in two weeks."
- **Value** — bundled with ChatGPT Plus; users rarely hit limits. "On Plus I can run Codex hard for an entire workday."
- **Open-source client** — Apache-2.0, Rust, auditable, fast release cadence.
- **Pattern recognition on established codebases** — picks up middleware patterns, error handling, naming conventions without being told.
- **Voice transcription** — hold spacebar to dictate in the TUI.
- **Cached web search by default** — serves pre-indexed results to shrink the prompt-injection surface; a security-conscious default other agents don't ship.
  > **Pi status:** partial — `tools-web-search` exists but queries live (DuckDuckGo); there is no cached/pre-indexed result layer.

### Common complaints

- Frontend/UI work is the consistent weakness.
- Doesn't follow instructions literally: "codex writes what it thinks you meant, not what you actually said."
- Slow on high thinking effort; permission friction breaks flow ("safer, but a step slower").
- Opaque, token-denominated rate limits; erratic in extended sessions.

## OpenCode

**The open harness.** Users love the TUI, the model freedom, and the client/server design.

### What users love

- **TUI polish** — "the TUI is the repeated favorite in nearly every comparison thread." Non-flickering updates, independently scrolling sections, a sidebar with ongoing file changes, context/cost, and MCP status. "The first time I've not needed to worry about a custom statusline."
- **Client/server architecture** — one backend drives TUI, desktop app, and IDE extensions; sessions survive terminal close; expose the server over tailscale and drive it from a phone. Multiple parallel sessions against the same project.
  > **Pi status:** partial — headless RPC mode (`pi --mode rpc`, JSONL over stdin/stdout) and the `AgentSession` SDK exist, and sessions persist to disk, but there is no network-exposed daemon or shared multi-client backend.
- **`/undo` and `/redo`** — walk back any number of agent steps. "The safety net changes how boldly I prompt."
- **LSP integration** — loads language-server context automatically so the model knows types and errors before you explain them.
- **Local-first and inspectable** — open source, SQLite state, no company incentivized to increase token usage. "Its values align with many of my own regarding what constitutes good software."

### Common complaints

- Reformatting existing code without authorization — the most common real-world complaint; noisy diffs on mature codebases.
- Thinner plugin/skills ecosystem than Claude Code.
- Broad permissions by default; no OS-level sandbox guarantee (approval is a formality the model can sidestep).
- Anthropic's January 2026 OAuth block cut off Claude Pro/Max logins — a reminder that model access can be revoked.

## Cross-cutting themes

1. **Plan before edit** — every tool converged on a read-only planning mode; users consistently credit it with better outcomes.
2. **Context isolation** — subagents with their own windows are the accepted answer to context pollution.
3. **Deterministic guardrails beat prompt instructions** — hooks/permissions are trusted; "never do X" in a memory file is not.
4. **Undo changes prompting behavior** — checkpoints/rewind make users bolder and waste less time on manual reversion.
5. **Model freedom is the open-source wedge** — OpenCode's mid-session model switching is the feature closed tools can't copy.
6. **Token efficiency is a real differentiator** — Codex's 2–4x advantage drives subscription choices as much as output quality.
7. **The TUI is the product** — OpenCode's polish and Claude Code's speed are cited as often as model quality.

## Sources

- HN: "Why are so many still using CC and not Codex" (news.ycombinator.com/item?id=45787726)
- HN: "Codex vs. Claude Code (today)" (news.ycombinator.com/item?id=46391391)
- HN: "How Claude Code works in large codebases" (news.ycombinator.com/item?id=48144494)
- HN: "Claude Code > all" (news.ycombinator.com/item?id=43665894)
- XDA: "Codex CLI felt safer than Claude Code, but it cost me my flow" (xda-developers.com)
- DevAireviews: "Codex CLI review: OpenAI's terminal coding agent tested" (devaireviews.com)
- CodeMySpec: "Codex CLI Review 2026" (codemyspec.com)
- Skiln: "OpenAI Codex CLI Review 2026" (skiln.co)
- Gil Ricardo: "OpenAI Codex CLI Review 2026 — Honest Backend Verdict" (gilricardo.com)
- dev.to: "OpenCode: The Open Source Coding Agent That Doesn't Lock You In" (dev.to/playfulprogramming)
- Kaushik Gopal: "Reasons for using Opencode" (kau.sh/blog/opencode-reasons)
- Rida Kaddir: "How I Use opencode — Best Practices After Months of Daily Use" (ridakaddir.com)
- Siddharth Kannan: "OpenCode is Remarkable" (blog.siddharthkannan.in)
- Anthropic: "Steering Claude Code: when to use CLAUDE.md, skills, hooks, and subagents" (claude.com/blog)
