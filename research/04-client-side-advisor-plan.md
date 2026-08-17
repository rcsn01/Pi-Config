# 4. Plan: Client-side advisor system for pi

Implements the **advisor strategy** (research doc 3, Approach A) as a pi
extension in this repo: the executor model gets an `advisor` tool it can call;
the tool gathers the conversation from the session and makes a second model
call to a stronger advisor model. Works with any provider (Anthropic, Ollama,
…), no pi-ai changes required.

## 4.1 Goal

A user can run `/advisor` to pick an advisor model (persisted in
`.pi/settings.json`), and from then on the main model can consult the advisor
at decision points. The advisor reviews the full conversation and returns a
plan/correction; the executor continues. Advisor calls are capped per session,
counted in usage totals, and surfaced in the TUI ("Advising" status, expandable
advice).

**Out of scope (v1):** server-side `advisor_20260301` tool (needs pi-ai
changes, see research doc 3 §3.4), subagent inheritance of the advisor,
per-agent advisor config.

## 4.2 Architecture

```
┌─ executor (main model, e.g. ollama/deepseek-v4-flash)
│    │  calls advisor tool (model-driven timing, steered by promptGuidelines)
│    ▼
│  tools-advisor extension
│    ├─ index.ts            tool + /advisor command + UI wiring + nudge
│    ├─ config.ts           advisor settings store (settings.json, key "advisor")
│    ├─ pairing.ts          capability ranking + pairing validation
│    ├─ advisor-runner.ts   context building + completeSimple call + call cap
│    └─ *.test.ts           vitest suites
│    ▼
│  ctx.modelRegistry.completeSimple(advisorModel, { systemPrompt, messages })
│    ▼
└─ advisor model (e.g. anthropic/claude-opus-4-8) → advice text → tool result
```

Data flow of one consultation:

1. Executor emits `advisor` tool call (optional `question` focus).
2. `execute()` resolves the advisor model from config; validates pairing
   (advisor ≥ executor, else returns a short notice).
3. Builds context: `ctx.sessionManager.buildContextEntries()` →
   `sessionEntryToContextMessages(entry)` per entry → `Message[]`; system
   prompt via `ctx.getSystemPrompt()`; appends the `question` as a final user
   message.
4. Calls `ctx.modelRegistry.completeSimple(advisorModel, { systemPrompt,
   messages }, { reasoning: "off", maxTokens, signal })`.
5. Returns `{ content: [advice text], details: { advisorModel, calls },
   usage }` — usage lands in `/session` totals; `calls` feeds the per-session
   `maxUses` cap (reconstructed on `session_start` from tool-result details).

## 4.3 File layout

```
.pi/extensions/tools-advisor/
├── index.ts                  # extension entry: tool, /advisor command, nudge, UI
├── config.ts                 # AdvisorConfigStore (settings-store.ts pattern)
├── pairing.ts                # capability rank + validatePairing()
├── advisor-runner.ts         # buildAdvisorContext() + runAdvisorCall() + call cap
├── config.test.ts            # settings round-trip, defaults, migration
├── pairing.test.ts           # rank ordering, cross-provider cases
└── advisor-runner.test.ts    # context building, cap counting, result mapping
```

Conventions to follow (from `tools-subagents`):
- `.ts` extension in relative imports (`import ... from "./config.ts"`)
- Settings store: atomic temp-file + rename write of `.pi/settings.json`,
  namespaced top-level key, preserving all other keys
- Test harness style: dependency-injected factory
  (`createAdvisorExtension(deps)`) so tests can mock `modelRegistry`
- Add `"test:advisor": "vitest run extensions/tools-advisor"` to
  `.pi/package.json` and wire it into the `test` script

## 4.4 Settings schema

Top-level key in `.pi/settings.json` (preserved by `config-profiles` like
`"subagents"`):

```json
{
  "advisor": {
    "provider": "anthropic",
    "modelId": "claude-opus-4-8",
    "maxUses": 3,
    "maxTokens": 2048,
    "nudgeTurn": 2
  }
}
```

- `provider`/`modelId` — the advisor model; unset = advisor disabled
- `maxUses` — per-session call cap (default 3; 0 = unlimited)
- `maxTokens` — advisor output cap (default 2048, per Anthropic's
  recommendation; min 1024)
- `nudgeTurn` — when to nudge under-calling executors (default 2; 0 = off)

## 4.5 Implementation phases

### Phase 0 — Scaffolding
- [ ] Create `.pi/extensions/tools-advisor/` with `index.ts` stub exporting
      `createAdvisorExtension(deps)` factory
- [ ] Add `test:advisor` script to `.pi/package.json`; run `pnpm typecheck`
      and `pnpm test:advisor` to confirm green baseline

### Phase 1 — Config store (`config.ts`)
- [ ] Port the `settings-store.ts` pattern (read/write document atomically,
      namespaced `readNamespace`/`updateNamespace`)
- [ ] `AdvisorConfig` type + defaults; `load()`/`save()`; validation of
      `provider`/`modelId` presence
- [ ] Tests: missing file → defaults; malformed root → error; update preserves
      other top-level keys; round-trip

### Phase 2 — Pairing (`pairing.ts`)
- [ ] `capabilityRank(model): number` — tier by family (haiku < sonnet < opus
      < fable < mythos), then version; cross-provider safe (rank by model id
      heuristics, not provider)
- [ ] `validatePairing(executor, advisor): { ok, reason? }` — advisor must be
      ≥ executor; unknown models → `ok: false` with reason (mirrors Claude
      Code's "not attached" behavior)
- [ ] Tests: rank ordering within a family; cross-provider (ollama executor vs
      anthropic advisor); unknown model ids; equal-capability allowed

### Phase 3 — Advisor runner (`advisor-runner.ts`)
- [ ] `buildAdvisorContext(ctx, question)`:
      `buildContextEntries()` → `sessionEntryToContextMessages` per entry →
      filter empty; prepend system prompt; append `question` as final user
      message; truncate to advisor model's `contextWindow` if needed
- [ ] `runAdvisorCall(deps, ctx, params)`:
      resolve model via `ctx.modelRegistry.find(provider, modelId)`; pairing
      check; `completeSimple(model, context, { reasoning: "off", maxTokens,
      signal })`; map `AssistantMessage` → advice text
- [ ] Call cap: count from tool-result `details.calls` reconstructed on
      `session_start`; when capped, return short "advisor calls exhausted"
      result without calling the model
- [ ] Tests: context building (entries → messages, question appended); cap
      counting across reconstructed state; unconfigured advisor → helpful
      result; model call failure → error result (not a throw)

### Phase 4 — Tool + command (`index.ts`)
- [ ] `pi.registerTool("advisor", …)`:
      - `description` + `promptSnippet` + `promptGuidelines` (timing guidance
        from research doc 2 §2.10: call early after exploratory reads, before
        committing, when stuck, before declaring done; call before todo tools)
      - `parameters: Type.Object({ question: Type.Optional(Type.String()) })`
      - `execute()` → runner; return `{ content, details, usage }`
      - `renderCall`/`renderResult` for the TUI (collapsed advice, expandable)
- [ ] `pi.registerCommand("advisor", …)`:
      - no args → `ctx.ui.select` picker of candidate models
        (`ctx.scopedModels` if set, else `ctx.modelRegistry.getAvailable()`)
      - `<provider>/<modelId>` → validate pairing, save, notify
        `Advisor set to <model>`
      - `off` → clear config, notify
      - `getArgumentCompletions` for model ids
- [ ] `session_start`: if advisor configured, `ctx.ui.notify("Advisor Tool is
      on · /advisor", "info")`; reconstruct call counter
- [ ] `tool_execution_start`/`tool_execution_end` for `advisor`:
      `ctx.ui.setStatus("advisor", "Advising…")` / clear

### Phase 5 — Nudge (under-calling executors)
- [ ] `turn_end` handler: if advisor enabled, `turnIndex >= nudgeTurn`, advisor
      not yet called this session, and executor is Haiku-class (per
      `pairing.ts` rank) → `pi.sendUserMessage("Consider consulting the
      advisor before continuing.", { deliverAs: "steer" })`
- [ ] Skip nudge for Opus-class executors and when the system prompt already
      contains restraint language (Anthropic findings, research doc 2 §2.10)
- [ ] Test: nudge fires on turn 2 for Haiku-class, not for Opus-class, not
      after first advisor call

### Phase 6 — Docs + verification
- [ ] README section in `research/` or extension folder documenting usage
- [ ] Manual verification script (see §4.7)
- [ ] `pnpm typecheck` + full `pnpm test` green

## 4.6 Key decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Tool always registered | Yes, even when unconfigured | Model stays aware; `execute()` returns "run /advisor" notice when unset |
| Advisor reasoning | `reasoning: "off"` by default | Cost control; server-side advisor drops thinking anyway. Configurable later |
| Advisor output cap | `maxTokens: 2048` | Anthropic: ~7× output reduction, ~0% truncation (research doc 2 §2.7) |
| Call cap | `maxUses: 3` per session, counted in tool-result `details` | Mirrors `max_uses`; survives restarts via state reconstruction |
| Nudge | Haiku-class executors only, turn 2, `deliverAs: "steer"` | Anthropic: +7pp on Haiku, harmful on Opus |
| Pairing | Client-side rank check, notify + skip on invalid | Mirrors Claude Code's validation |
| Settings | Namespaced `"advisor"` key, atomic write | Survives profile switches; consistent with `"subagents"` |

## 4.7 Manual verification

1. `cd .pi && pnpm typecheck && pnpm test:advisor`
2. `pi` in a test project; run `/advisor` → picker shows candidate models;
   pick one → "Advisor set to …" notification
3. Ask for a complex task; verify the model calls `advisor` (or nudge appears
   on turn 2 for a Haiku-class executor); "Advising…" status shows during the
   call; advice appears as an expandable tool result
4. `/session` shows advisor tokens in totals (usage accounting)
5. Call the advisor `maxUses` times → "advisor calls exhausted" result
6. `/advisor off` → notification; next turn the model no longer calls advisor
7. Restart pi → advisor still configured (settings persisted); call counter
   reset

## 4.8 Risks / open questions

- **`ctx.getSystemPrompt()` inside tool `execute()`** — verify it returns the
  current turn's chained prompt (docs guarantee it during
  `before_agent_start`; confirm in tool context). Fallback: capture it in
  `before_agent_start` and stash per-turn.
- **`sessionEntryToContextMessages` behavior** — confirm it includes
  compaction summaries and skips custom entries; otherwise filter
  `entry.type === "message"` manually (pattern exists in `ui-context`).
- **Cross-provider ranking** — heuristics may misrank unknown model ids; keep
  the rank table in one place and allow a settings override
  (`advisor.rankOverrides`) if needed.
- **Ollama advisor** — a local advisor model works but may be weaker than the
  executor; pairing check will reject it, which is correct behavior.
- **`completeSimple` + `signal`** — pass `ctx.signal` so Esc cancels the
  advisor call (pattern from `extensions.md`).
