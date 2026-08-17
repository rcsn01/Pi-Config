# Research: Claude Code `/advisor` and a Pi extension implementation

Research into Anthropic's **advisor tool** — how Claude Code's `/advisor` command
works, how the advisor executor works at the protocol level, and how the same
capability can be implemented as an extension for **pi** (this repo's coding agent).

## Documents

| # | Topic | File |
|---|-------|------|
| 1 | Claude Code's `/advisor` — command, settings, UX, changelog history | [01-claude-code-advisor.md](01-claude-code-advisor.md) |
| 2 | Advisor executor mechanics — server-side tool protocol, streaming, usage, caching, pairing, prompting | [02-advisor-executor-mechanics.md](02-advisor-executor-mechanics.md) |
| 3 | Implementing it as a pi extension — extension system, pi-ai analysis, four approaches, recommended design | [03-pi-extension-implementation.md](03-pi-extension-implementation.md) |
| 4 | **Plan**: client-side advisor system — phased implementation plan for the `tools-advisor` extension | [04-client-side-advisor-plan.md](04-client-side-advisor-plan.md) |

## Sources

- Claude Code docs — *Escalate hard decisions with the advisor tool*:
  https://docs.anthropic.com/en/docs/claude-code/advisor
- Claude API docs — *Advisor tool*:
  https://platform.claude.com/docs/en/agents-and-tools/tool-use/advisor-tool
- Anthropic blog — *The advisor strategy: Give agents an intelligence boost*:
  https://claude.com/blog/the-advisor-strategy
- Claude Code changelog (v2.1.117 → v2.1.233):
  https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md
- pi extension docs (local install):
  `/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`
- pi-ai source (local install):
  `/Users/mac/Syncthing/Projects/Pi-Config/.pi/node_modules/@earendil-works/pi-ai/dist/`
- Existing extensions in this repo (patterns): `.pi/extensions/tools-subagents/`,
  `.pi/extensions/tools-code-review/`, `.pi/extensions/workflows-plan-mode/`

## TL;DR

- **`/advisor`** is Claude Code's command for picking a second, stronger model
  ("advisor") that the main model ("executor") can consult mid-task. It is backed
  by a **server-side tool** (`advisor_20260301`) that runs a separate inference
  pass on the advisor model inside the same `/v1/messages` request.
- The **executor decides when to consult** (model-driven timing, not rules). The
  advisor receives the full transcript, returns a plan/correction, and the
  executor continues. Advisor output is typically 400–700 text tokens, so pairing
  a cheap executor with a strong advisor gives near-advisor quality at
  near-executor cost (SWE-bench Multilingual: +2.7pp at −11.9% cost).
- **pi has no native advisor support today** (pi-ai's Anthropic layer ignores
  `server_tool_use` / `advisor_tool_result` blocks), but the advisor *strategy*
  can be implemented as a pure extension in two viable ways:
  1. **Client-side advisor tool** (recommended, works today): a custom tool the
     executor can call; the tool gathers the conversation from the session and
     makes a second model call to the advisor model via `ctx.modelRegistry`.
  2. **Server-side injection** (faithful, blocked by pi-ai): inject the
     `advisor_20260301` tool into the provider payload via
     `before_provider_request` + beta header — but pi-ai's stream parser drops
     the result blocks, so this needs pi-ai changes first.
