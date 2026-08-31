# config-system-prompt

Restores the dynamic `Guidelines` system-prompt section that pi drops when
a custom prompt (`SYSTEM.md`, `--system-prompt`) replaces the default build.
The `Available tools` list is intentionally not restored — tool discovery
rides on the provider payload's function schemas, so re-listing tools in the
prompt would duplicate them.

## Why

`buildSystemPrompt()` only renders those sections on its default path. With
`customPrompt` set, the prompt becomes: custom text → `APPEND_SYSTEM.md` →
`<project_context>` → skills → `Current working directory:` — no guidelines.
Guidelines are genuinely dynamic (per-tool bullets, tool-conditional rules),
so they cannot be frozen into `SYSTEM.md` without going stale when active tools
change through profiles or plan-mode swaps like `bash` → `plan_bash`.

## How

`before_agent_start` runs each turn with `event.systemPromptOptions` — the
same structured data pi used to build the prompt. When a custom prompt is
present, the extension re-renders the guidelines from those options
(mirroring pi's stock rendering byte for byte) and inserts them before the
trailing `Current working directory:` line, wrapped in `<tool_guidelines>`
sentinels. The chain resets to the base prompt every turn, so nothing
accumulates; the sentinels make the insert idempotent if the handler ever
runs twice.

`/system-prompt` writes the fully composed prompt (after all extensions) to a
temp file for inspection.

## Extension tool policy

Extension tools in this repo intentionally register no `promptGuidelines` —
usage policy lives in each tool's `description`, so the model reads mechanics
and policy together at schema-evaluation time (pi still supports
`promptGuidelines` for tools that need prompt-side bullets). The restored
section therefore carries pi's builtin-tool bullets, the tool-conditional
file-operations bullet, and the always-on pair.

## Extension boundaries

This extension only restores Pi's generic dynamic guidelines. `tools-advisor`
activates its tool without rewriting the executor system prompt, so
`../SYSTEM.md` does not depend on advisor configuration.