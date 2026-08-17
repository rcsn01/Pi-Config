# 3. Implementing the advisor as a pi extension

This document maps the advisor concept onto pi's extension system, analyzes
what pi-ai supports today, and lays out four implementation approaches with a
recommended design.

## 3.1 What pi gives us (extension surface)

From `docs/extensions.md` (local install) and the existing extensions in this
repo, the relevant capabilities are:

| Capability | API | Use for the advisor |
|------------|-----|---------------------|
| Custom tool callable by the LLM | `pi.registerTool({ name, description, promptSnippet, promptGuidelines, parameters, execute })` | The `advisor` tool the executor can call |
| Custom command | `pi.registerCommand("advisor", { handler })` | The `/advisor` picker, `/advisor off`, `/advisor <model>` |
| UI interaction | `ctx.ui.select / confirm / input / notify / setStatus / setWidget` | Model picker, "Advising" status line, enable notification |
| Session state | `ctx.sessionManager.getEntries() / getBranch() / buildContextEntries()` | Reconstruct the conversation for the advisor |
| Entry → LLM messages | `sessionEntryToContextMessages` (exported from `@earendil-works/pi-coding-agent`) | Convert session entries to pi-ai `Message[]` |
| Nested model calls | `ctx.modelRegistry.completeSimple(model, context, opts)` / `streamSimple(...)` / `getAuth(providerId)` | Run the advisor inference pass |
| Model discovery | `ctx.modelRegistry.find(provider, id)`, `getAvailable()`, `ctx.scopedModels` | Enumerate candidate advisor models |
| System prompt | `ctx.getSystemPrompt()` (in `before_agent_start`), `event.systemPromptOptions` | Feed the executor's system prompt to the advisor |
| Inject messages | `pi.sendMessage({ customType, content }, { deliverAs: "steer" })`, `pi.sendUserMessage(text, { deliverAs })` | The "nudge" reminder; surfacing advice |
| Persist state | `pi.appendEntry(customType, data)` + `pi.registerEntryRenderer` | Per-session advisor call counts, last advice |
| Settings | read/write `.pi/settings.json` atomically (pattern: `tools-subagents/settings-store.ts`) | Persist `advisorModel` across sessions |
| Payload/header hooks | `before_provider_headers` (mutate headers), `before_provider_request` (replace payload) | Server-side injection path (approach B) |
| Tool result accounting | return `usage` from `execute()` | Advisor tokens show in `/session` totals |
| Custom rendering | `renderCall` / `renderResult` on the tool, `registerMessageRenderer` | "Advising" transcript line, expandable advice |

### pi-ai model-call API (verified in `@earendil-works/pi-ai/dist/models.d.ts`)

```ts
interface Models {
  getProvider(id: string): Provider | undefined;
  getModel(provider: string, id: string): Model<Api> | undefined;
  getAvailable(providerId?: string): Promise<readonly Model<Api>[]>;
  getAuth(providerId: string): Promise<AuthResult | undefined>; // apiKey/headers/baseUrl
  completeSimple(model, context, options?): Promise<AssistantMessage>;
  streamSimple(model, context, options?): AssistantMessageEventStream;
}
interface Context { systemPrompt?: string; messages: Message[]; tools?: Tool[]; }
// Message roles: "user" | "assistant" | "toolResult"
```

`ctx.modelRegistry` in an extension context is exactly this `Models` instance.

## 3.2 What pi-ai does NOT support today (verified in source)

The Anthropic layer (`dist/api/anthropic-messages.js`) has **no advisor
support**:

1. **No `advisor_20260301` tool type** — `convertTools()` only emits standard
   `{ name, description, input_schema }` tool definitions.
2. **`server_tool_use` blocks are dropped** — the stream handler branches only
   on `text`, `thinking`, `redacted_thinking`, and `tool_use` content blocks.
   The executor's advisor-call signal would be silently ignored.
3. **`advisor_tool_result` blocks are dropped** — same reason. The advice would
   never reach the executor's context, and `convertMessages()` would strip the
   blocks from history on later turns, breaking the round-trip contract.
4. **`pause_turn` is mapped to "stop"** — `mapStopReason` treats it as
   "Stop is good enough → resubmit", which loses the pending-call semantics
   (the pending `server_tool_use` block would also be dropped by #2).
5. **No `usage.iterations` handling** — top-level usage only; advisor
   sub-inference tokens would be invisible.

**Consequence**: the true server-side advisor (approach B) is *not* buildable
as a pure extension today. It needs pi-ai changes (new content-block types,
stream handling, message conversion, stop-reason mapping). Everything else —
the advisor *strategy* — is buildable as an extension.

## 3.3 Approach A — Client-side advisor tool (recommended, works today)

The executor gets a regular tool named `advisor`. When it calls it, the tool
gathers the conversation from the session and makes a **second model call** to
the configured advisor model. This is exactly the "advisor strategy" as it
existed before the server tool, and it works with **any provider** (Anthropic,
Ollama, OpenAI, …) — relevant for this repo, whose active profile uses
`ollama/deepseek-v4-flash:0731-cloud`.

### 3.3.1 Tool definition

```ts
pi.registerTool({
  name: "advisor",
  label: "Advisor",
  description:
    "Consult the advisor model for strategic guidance on the current task. " +
    "The advisor reviews the full conversation and returns a plan, correction, " +
    "or stop signal. Call it before committing to an approach, when stuck on " +
    "a recurring error, or before declaring the task complete.",
  promptSnippet: "Consult the advisor model for guidance",
  promptGuidelines: [
    "Use advisor early in complex tasks, after a few exploratory reads, and again before declaring the task done.",
    "Use advisor before todo/planning tools so its plan funnels into them.",
  ],
  parameters: Type.Object({
    question: Type.Optional(Type.String({ description: "Optional focus question for the advisor" })),
  }),
  async execute(toolCallId, params, signal, onUpdate, ctx) { ... },
});
```

### 3.3.2 The execute() flow

1. **Resolve the advisor model** from config (`advisorModel` in
   `.pi/settings.json`, e.g. `{ "provider": "anthropic", "modelId": "claude-opus-4-8" }`),
   falling back to the strongest available model (`ctx.modelRegistry.getAvailable()`).
2. **Pairing check**: advisor must be at least as capable as the executor
   (`ctx.model`). Implement a capability rank (haiku < sonnet < opus < fable <
   mythos, then version) and skip/notify when the pairing is invalid — mirroring
   Claude Code's validation.
3. **Build the context**:
   - `const entries = ctx.sessionManager.buildContextEntries()` (active branch,
     compaction applied)
   - `const messages = sessionEntryToContextMessages(entries)` (or filter
     `entry.type === "message"` and map `entry.message`)
   - `const systemPrompt = ctx.getSystemPrompt()`
   - Optionally append the executor's current task text / the `question` param
     as a final user message.
4. **Run the advisor inference**:
   ```ts
   const response = await ctx.modelRegistry.completeSimple(advisorModel, {
     systemPrompt,
     messages,
   }, { reasoning: "off", signal });
   ```
   Use `streamSimple` + `onUpdate` if you want live progress in the TUI.
5. **Return the advice** as the tool result, with usage accounting:
   ```ts
   return {
     content: [{ type: "text", text: response.contentText() }],
     details: { advisorModel: advisorModel.id, calls: calls + 1 },
     usage: response.usage, // shows in /session totals
   };
   ```
6. **Per-session call cap** (`max_uses` equivalent): count calls in tool-result
   `details` and reconstruct on `session_start` (the state-management pattern
   from `extensions.md`). When the cap is hit, return a short "advisor calls
   exhausted" result instead of calling the model.

### 3.3.3 The /advisor command

```ts
pi.registerCommand("advisor", {
  description: "Set the advisor model (or 'off')",
  getArgumentCompletions: (prefix) => candidateModels(prefix), // from ctx.scopedModels
  handler: async (args, ctx) => {
    if (args === "off") { /* clear advisorModel, notify */ return; }
    if (args) { /* parse provider/modelId, validate pairing, save */ return; }
    const choice = await ctx.ui.select("Advisor model:", modelLabels);
    // persist via settings-store pattern (read-modify-write .pi/settings.json,
    // preserving other keys — same as tools-subagents/settings-store.ts)
  },
});
```

Persistence: reuse the `settings-store.ts` pattern from `tools-subagents`
(atomic temp-file + rename write of `.pi/settings.json`, namespaced key such as
`"advisor"`). Note the repo's `config-profiles` extension owns profile
switching; a namespaced top-level key is preserved by that flow (like
`"subagents"` already is).

### 3.3.4 UX mirroring Claude Code

- **Enable notification**: on `session_start`, if `advisorModel` is set,
  `ctx.ui.notify("Advisor Tool is on · /advisor", "info")`.
- **"Advising" status**: in `tool_execution_start`/`tool_execution_end` for the
  `advisor` tool, `ctx.ui.setStatus("advisor", "Advising…")` / clear it.
- **Expandable advice**: `renderResult` on the tool renders the advice
  collapsed with an expand affordance (like Ctrl+O in Claude Code).
- **Nudge**: on `turn_end`, if the executor is a Haiku-class model, the advisor
  hasn't been called yet, and `turnIndex >= 2`, inject the nudge:
  `pi.sendUserMessage("Consider consulting the advisor before continuing.", { deliverAs: "steer" })`.
  Skip for Opus-class executors (Anthropic measured a slight drop). If the
  system prompt already contains restraint language, skip entirely.

### 3.3.5 Cost controls

- `max_uses` per session (client-side counter, as above).
- `max_tokens` equivalent: pass `maxTokens` in the `completeSimple` options
  (e.g. 2048) and/or append a "keep advice under N words" line to the advisor's
  final user message (Anthropic: direct-address instructions are followed much
  more reliably; ask for ~80% of the true ceiling).
- Advisor-side caching: pi-ai's `completeSimple` applies its own cache-control
  strategy; the advisor call re-sends the full transcript each time, so expect
  cache-reads on the second+ call if the provider caches the prefix.

### 3.3.6 Limitations vs the server tool

- The advisor sees the conversation **as of the tool call**, not including the
  executor's in-progress turn text (minor; the tool-calling message is in the
  transcript).
- No `pause_turn` semantics — the executor's turn simply pauses while the tool
  runs (same user-visible effect).
- No encrypted-result variant — the advice is always plaintext (which is what
  you want client-side anyway).
- The advisor call is a separate request (two round trips instead of one), and
  the advisor's own system prompt is yours to write, not Anthropic's.

## 3.4 Approach B — Server-side injection via provider hooks (faithful, blocked)

The idea: keep the true server-side tool by injecting it into pi's outgoing
Anthropic request.

1. `before_provider_headers`: add `anthropic-beta: advisor-tool-2026-03-01`.
2. `before_provider_request`: push
   `{ type: "advisor_20260301", name: "advisor", model, max_uses, max_tokens }`
   into `event.payload.tools`.

**Why it fails today** (see §3.2): pi-ai's stream parser drops
`server_tool_use` and `advisor_tool_result` blocks, so the executor never sees
the advice; `convertMessages` strips result blocks from history, breaking
multi-turn round-tripping; `pause_turn` resumption is lost. The extension
cannot observe the raw stream (pi-ai filters events before `message_update`).

**Path to make it work**: pi-ai needs (a) new content-block types
(`serverToolUse`, `advisorToolResult` with both result variants), (b) stream
handling for them, (c) `convertMessages` round-trip support, (d) `pause_turn`
→ resubmit-with-pending-call handling, (e) `usage.iterations` parsing. That is
a pi-ai feature, not an extension. Worth filing upstream; until then, approach
A or C.

## 3.5 Approach C — Raw API call from the tool (faithful semantics, more code)

Inside the `advisor` tool's `execute()`, bypass pi-ai and talk to the provider
directly:

1. Resolve auth: `const auth = await ctx.modelRegistry.getAuth(providerId)` →
   `{ auth: { apiKey } }` plus `model.baseUrl` / provider headers.
2. Serialize the conversation: `sessionEntryToContextMessages(...)` → Anthropic
   `MessageParam[]` (reuse the conversion logic shape from pi-ai's
   `convertMessages`).
3. POST `{baseUrl}/v1/messages` with `stream: false`, the `advisor_20260301`
   tool, and the beta header.
4. Handle `server_tool_use` → `advisor_tool_result` (plaintext variant),
   `pause_turn` resumption loop, and the error codes from doc 2 §2.4.
5. Return the advice text as the tool result.

**Critical caveat**: with an Opus 5-class advisor the result is the
**encrypted** `advisor_redacted_result` variant, which the client cannot read
and which only the server can render into the *next* request — and pi's next
request would strip the block. So approach C must pin a **plaintext advisor**
(e.g. `claude-opus-4-8`) or maintain its own message history for the executor,
which is not viable. This makes C strictly worse than A for the same fidelity
goal, unless the goal is exercising the exact server protocol.

## 3.6 Approach D — Spawn a pi subprocess (simplest, heavyweight)

Reuse the `tools-subagents` pattern (`subagent-runner.ts`): spawn
`pi --mode json -p --no-session --no-extensions --model <advisor> --append-system-prompt <advisor-prompt>` with the conversation written to a temp file
and passed as `@file`. Pros: trivially correct, reuses pi's tooling, works
with any provider. Cons: full pi startup per consult (latency), no streaming
into the session, manual usage accounting, no server-side semantics. Fine for a
quick prototype; not the recommended end state.

## 3.7 Recommended design (summary)

**v1 — Approach A**, as a new extension directory
`.pi/extensions/tools-advisor/`:

```
tools-advisor/
├── index.ts            # tool + /advisor command + nudge + UI wiring
├── config.ts           # advisorModel settings-store (settings-store.ts pattern)
├── advisor-runner.ts   # context building + completeSimple call + pairing check
├── pairing.ts          # capability ranking (haiku < sonnet < opus < fable < mythos)
└── advisor-runner.test.ts  # vitest, mirroring tools-subagents test style
```

Key decisions:

1. **Tool-driven timing** (not rule-based): the executor decides when to call
   `advisor`, steered by `promptGuidelines` + optional nudge — matching
   Anthropic's finding that model-driven timing with light steering works best.
2. **Pairing validation** client-side: advisor ≥ executor, else notify and
   skip (mirror Claude Code's behavior).
3. **Settings**: `"advisor": { "provider", "modelId", "maxUses", "maxTokens" }`
   in `.pi/settings.json`, written atomically, preserved across profile
   switches (like `"subagents"`).
4. **Accounting**: return `usage` from `execute()` so advisor tokens appear in
   session totals; count calls in `details` for the `maxUses` cap.
5. **UX**: `/advisor` picker, enable notification, "Advising" status line,
   expandable advice rendering, `/advisor off`.
6. **Nudge**: Haiku-class executors only, turn 2, `deliverAs: "steer"`.
7. **Testing**: vitest with a mocked `modelRegistry` (the repo's
   `test-harness.ts` in `tools-subagents` is a good template); test pairing
   logic, settings round-trip, call-cap counting, and context building.

**Later**: file a pi-ai feature request for `server_tool_use` /
`advisor_tool_result` / `pause_turn` support (approach B), which would let the
extension switch to the true server-side tool with minimal changes — the
`/advisor` command, settings, and UI stay identical.

## 3.8 Open questions / things to verify when implementing

- Does `sessionEntryToContextMessages` include compaction summaries and custom
  entries? (Check its behavior in `pi-coding-agent/dist/core/session-manager.js`
  before relying on it; otherwise filter `entry.type === "message"` manually.)
- `completeSimple` with `reasoning: "off"` — confirm the advisor call doesn't
  inherit the executor's thinking level (it shouldn't; the advisor should
  answer directly).
- Whether `ctx.getSystemPrompt()` inside a tool's `execute()` returns the
  current turn's chained prompt (docs say it reflects the system prompt as of
  the current turn during `before_agent_start`; verify inside tool execution).
- Ollama pairing: with `deepseek-v4-flash` as executor, the "advisor" would be
  a stronger Ollama model or an Anthropic model — the pairing rank must handle
  cross-provider comparisons (rank by model family, not provider).
