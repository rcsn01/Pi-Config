# Tool-output efficiency options

Research date: 2026-09-09

## Bottom line

There is no single winning choice between dropping tool output and compacting it. Mature agent systems layer several controls:

1. Prevent broad outputs with filtering, projection, pagination, and sensible defaults.
2. Keep full output outside model context and return a short, retrievable handle.
3. Replace stale successful tool results after the model has used them.
4. Compact the wider conversation near the context limit.

For this Pi setup, I would implement those layers in that order. I would not summarize every large result with another model by default. Deterministic reduction is cheaper, faster, and easier to verify.

## Three different efficiency problems

These are easy to conflate:

| Problem | What reduces it |
|---|---|
| Model input tokens | Shorter `content`, outbound context pruning, compaction |
| Session JSONL size | Shorter persisted `content` and `details`, or external storage |
| Terminal clutter | A collapsed/custom renderer |

A compact renderer does not reduce model input. An outbound `context` filter does not shrink the append-only session file. Prompt caching lowers repeated processing cost and latency, but cached tokens still occupy the context window. The [v0.85.1 Pi extension docs](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/docs/extensions.md) describe the separate `tool_result`, `context`, and rendering hooks. [OpenAI](https://developers.openai.com/api/docs/guides/prompt-caching) and [Anthropic](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) both require matching prompt prefixes for cache reuse.

A quick measurement of the current session file makes the target clear. I parsed the JSONL path in `PI_SESSION_FILE`, selected every `message` entry whose message role was `toolResult`, summed text and image-data characters by tool, and separately measured serialized `details`. It contains about 1.32 million characters of persisted tool-result `content`; `read`, `bash`, and `ddg_fetch` account for 93.8 percent of that total. The JSONL file is 2.7 MB. This includes every stored branch entry, including material no longer active after compaction, so it is a storage measurement, not a current provider-prompt measurement.

## What Pi already does

Pi 0.85.1 has several useful pieces:

- Pi's shared truncation helpers default to 50 KB or 2,000 lines. The built-in text mode of `read` and `bash` uses those limits; `grep`, `find`, and `ls` use their own default result limits of 100 matches, 1,000 paths, and 500 entries. `grep` also clips each matching line to 500 characters and has the shared 50 KB byte cap. `read`'s line and byte limits apply to text, while images are handled as attachments. `read`, `grep`, and `find` keep the head, while shell output keeps the tail. The built-in bash tool and the official custom-tool example save complete truncated output to a temporary file and return its path. See the version-pinned [truncation helper](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/src/core/tools/truncate.ts), [tool implementations](https://github.com/earendil-works/pi/tree/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/src/core/tools), and [truncated-tool example](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/examples/extensions/truncated-tool.ts).
- `read` accepts `offset` and `limit`, so the caller can retrieve another range from the source file instead of loading it all at once.
- A `tool_result` handler can replace `content` and `details` before Pi finalizes and persists the result. This can reduce future model input and session-file growth.
- A `context` handler can replace messages before each model request. Pi gives it a deep copy, so this saves provider tokens without rewriting the transcript.
- Pi's native automatic compaction is disabled in the current project settings and profiles: `.pi/settings.json` and the profile documents set `compaction.enabled` to `false` and `keepRecentTokens` to `20,000`. Manual `/compact` still enters the compaction path. This project does have a replacement automatic path: [`.pi/extensions/session-compaction/index.ts`](../.pi/extensions/session-compaction/index.ts) uses the shared [`COMPACT_THRESHOLD = 0.8`](../.pi/extensions/_shared/auto-compact.ts), handles provider overflow, and resumes the turn. The flag disables Pi's native threshold and overflow checks, not this extension-owned path.
- When Pi's native compactor does run, its summary serializer limits each tool result to 2,000 characters in the summarizer request. [The v0.85.1 compaction docs](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/docs/compaction.md#message-serialization) and [serializer source](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/src/core/compaction/utils.ts) spell this out.

Two local details matter. The current cache-aware compactor builds a full provider context from the branch and appends its summary instruction. It does not use Pi's native `serializeConversation()` path, so the 2,000-character per-result summary cap does not apply. It also passes the current session ID but leaves `cacheRetention` unspecified. That means cache reuse is provider-dependent, not guaranteed. Pi's native `completeSummarization()` explicitly sets `cacheRetention: "none"` for one-off summaries. See [the local compactor](../.pi/extensions/_shared/cache-aware-compaction.ts) and [Pi's native summarization options](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/src/core/compaction/compaction.ts#L562-L598).

The local `ddg_fetch` tool is unbounded by default after extraction. Its `max_chars` argument is optional, has no maximum, and defaults to no extra truncation. A fetched document can therefore be much larger than Pi's recommended custom-tool limit. A safe fix needs both a finite default and a hard upper clamp. See [`.pi/extensions/tools-web-fetch/index.ts`](../.pi/extensions/tools-web-fetch/index.ts).

## Existing approaches

### Shape and bound output at the source

This is the cheapest option and should come first.

Anthropic recommends high-signal tool responses plus pagination, range selection, filtering, and truncation with useful defaults. Its own example offers `concise` and `detailed` response formats, with the concise form using roughly one third of the tokens in that case. [Writing effective tools for AI agents](https://www.anthropic.com/engineering/writing-tools-for-agents) also recommends targeted tools such as `search_logs` instead of returning complete logs.

OpenAI exposes the same control in File Search. `max_num_results` reduces tokens and latency, with a documented risk to answer quality. [OpenAI File Search](https://developers.openai.com/api/docs/guides/tools-file-search#limiting-the-number-of-results)

Useful controls include:

- filters and queries rather than full listings
- selected fields rather than complete API objects
- line, byte, item, and token limits
- `offset` or cursor-based continuation
- head, tail, or head-plus-tail policies chosen per output type
- total counts and an explicit truncation marker

This can remain lossless if the tool provides a way to fetch the rest.

### Externalize full output and return a handle

This is the strongest general pattern when exact recovery matters.

Pi's truncation example writes the full output to a temporary file. MCP tools can return a resource link instead of embedding a resource, and clients can fetch that URI through `resources/read`. MCP resources carry fields such as MIME type, byte size, priority, and last-modified time. [MCP tool results](https://modelcontextprotocol.io/specification/2025-06-18/server/tools#tool-result) and [MCP resources](https://modelcontextprotocol.io/specification/2025-06-18/server/resources)

A useful result contains:

- a short excerpt or deterministic digest
- the artifact path or URI
- byte and line counts
- a content hash or source version
- truncation direction
- exact instructions for range reads or targeted search

Do not put the whole blob in Pi's `details` if session-file size matters. Provider serializers use model-visible `content`, but Pi persists `details` in the JSONL session. Keep only display and retrieval metadata there. Temporary files also need an expiry policy, while remote handles need access control.

### Reduce a result immediately

Pi's `tool_result` event can replace a result before persistence. This is appropriate when a deterministic reducer can preserve what downstream work needs.

Examples include:

- parse test output into failed test names, error messages, and a handle to the full log
- turn a build log into exit status, warnings, errors, and the last relevant lines
- turn JSON into selected fields plus IDs needed by later calls
- deduplicate search hits by canonical URL
- collapse unchanged file reads to path, hash, requested range, and excerpt

OpenAI's Programmatic Tool Calling is a provider-native version of this idea. Generated JavaScript can call several tools, join or filter their outputs, and expose only a smaller final object to the model. OpenAI recommends it for bounded filtering, ranking, aggregation, validation, and deduplication. [OpenAI Programmatic Tool Calling](https://developers.openai.com/api/docs/guides/tools-programmatic-tool-calling)

LLM summarization is another immediate reducer, but it should be selective. It pays the large-input cost once, adds latency, and can omit exact identifiers or rare error lines. If used, preserve exact facts and an artifact handle outside the prose summary. Pi lets a tool-result hook report nested model usage.

### Clear stale tool results mid-session

Yes, this is an established option. It is often called context editing or observation masking.

Anthropic's `clear_tool_uses_20250919` strategy removes the oldest tool results after a token threshold and inserts placeholders. It can retain the latest N tool uses, clear at least a chosen number of tokens, exclude named tools, and optionally remove old tool inputs too. Anthropic's advanced example triggers at 30,000 input tokens, keeps the latest three tool uses, reclaims at least 5,000 tokens, and exempts web search. Those numbers are examples, not universal defaults. [Anthropic context editing](https://platform.claude.com/docs/en/build-with-claude/context-editing#advanced-configuration)

LangChain's provider-neutral `ContextEditingMiddleware` and `ClearToolUsesEdit` expose the same controls: trigger threshold, minimum reclamation, recent results to keep, excluded tools, input clearing, and placeholder text. [LangChain context editing](https://docs.langchain.com/oss/python/langchain/middleware/built-in#context-editing)

OpenCode implements this directly in a coding agent. At commit [`dff8fbc`](https://github.com/anomalyco/opencode/commit/dff8fbc149fb7492e4f07b713ac31ea70d9a541c), it protects the newest 40,000 estimated tool-output tokens and at least the latest user turn, then prunes only when it can reclaim more than 20,000 tokens. It skips incomplete and failed calls, protects selected tools, and renders old completed results as `[Old tool result content cleared]`. See its [thresholds](https://github.com/anomalyco/opencode/blob/dff8fbc149fb7492e4f07b713ac31ea70d9a541c/packages/opencode/src/session/compaction.ts#L28-L31) and [pruning loop](https://github.com/anomalyco/opencode/blob/dff8fbc149fb7492e4f07b713ac31ea70d9a541c/packages/opencode/src/session/compaction.ts#L271-L315).

For Pi, a `context` hook can implement this for ordinary provider requests without changing persisted history. It is not a universal message rewriter: native compaction calls the summarizer directly, and the current custom compactor calls `provider.streamSimple()` directly, so neither path receives the ordinary `context` event's filtered messages. The policy must therefore be shared with the custom compactor if its summary request should shrink. Replace old result content rather than deleting one side of a tool-call/result pair. A good first policy would:

- leave the current turn untouched
- retain at least the latest two user turns or a token budget
- prune only completed successful results
- retain errors and non-repeatable evidence
- exempt tools whose exact output is durable state
- use a placeholder containing the tool name, artifact handle, size, and hash
- prune in batches to avoid rewriting the cached prefix every turn

The downside is cache invalidation. Anthropic explicitly notes that clearing an old result invalidates the cached prefix at that point and recommends reclaiming enough tokens to justify the rewrite. OpenAI also requires an exact rendered prefix match. Hysteresis, such as a trigger threshold plus a minimum reclamation amount, matters.

### Truncate tool results only for the compaction request

This is narrower than mid-session clearing.

Pi native compaction already sends at most 2,000 characters from each tool result to its summarizer. After compaction succeeds, the old full results leave active context, while the JSONL history remains append-only. This reduces summary-call input and post-compaction context, but it does nothing before compaction triggers.

It is a good fit when assistant messages already record the conclusions drawn from raw output. It is risky for results whose only important detail appears late in the output. Head-only truncation is especially weak for test logs and command failures, where the tail often matters.

For the current custom compactor, there are two choices:

1. Preserve the full provider context and leave cache behavior to the provider. This may reuse a prefix, but the current code does not guarantee it.
2. Apply a shared stale-result reducer, or summarize only `preparation.messagesToSummarize` through Pi's serializer. This shrinks the request but can change the prefix and reduce cache reuse.

If tool-output efficiency is now more important than a possible cache hit, the second option is the better trade.

### Compact the whole conversation

Full compaction is the broad safety net when it is enabled. It preserves goals, decisions, progress, and recent messages while replacing older dialogue and results with a summary.

Pi's automatic path checks whether context exceeds `contextWindow - reserveTokens`, then retains the configured recent-token budget. The current project sets `compaction.enabled` to `false`, so this threshold and overflow path are inactive. Manual `/compact` still works and can invoke the custom compactor. [The v0.85.1 Pi compaction source](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/src/core/compaction/compaction.ts#L235-L238) and [manual-session path](https://github.com/earendil-works/pi/blob/d981de1229ef899957bbe968bc8dcda02a21f477/packages/coding-agent/src/core/agent-session.ts#L1930-L1942) show the distinction. LangChain's summarization middleware likewise supports token, context-fraction, and message-count triggers. [LangChain summarization](https://docs.langchain.com/oss/python/langchain/middleware/built-in#summarization)

Anthropic reports that Claude Code's compaction discards redundant tool output while preserving key decisions and the five most recently accessed files. It also recommends tuning summaries for recall before trying to make them shorter. [Anthropic context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents#context-engineering-for-long-horizon-tasks)

Compaction is too late to be the only tool-output policy. A few large recent results can still consume most of the retained 20,000-token tail, and the summarization request must process the old history somehow.

### Use provider-native context management

Providers now expose their own controls:

- Anthropic has server-side tool-result clearing and whole-conversation compaction. The client can retain the original history while Claude sees the edited context. [Anthropic context editing](https://platform.claude.com/docs/en/build-with-claude/context-editing) and [server-side compaction](https://platform.claude.com/docs/en/build-with-claude/compaction)
- OpenAI Responses supports `context_management` with `compact_threshold` and a standalone `/responses/compact` endpoint. It emits an opaque encrypted compaction item that must be carried forward. [OpenAI compaction](https://developers.openai.com/api/docs/guides/compaction)

These are useful precedents, but they are not the best first implementation here. Current profiles use OpenAI Codex, GitHub Copilot, and Ollama providers. Anthropic's clearing is unavailable there. OpenAI's opaque compaction state would need provider-adapter and session support so Pi can preserve it correctly. A Pi-level policy can run across these profiles, but provider serializers still differ in how they validate tool-result ordering, attachments, and cache controls.

### Isolate exploratory work

Subagents are another form of output reduction. The child can read large files and logs in its own context, then return compact findings to the parent. Anthropic describes this as context isolation and says research subagents often return summaries around 1,000 to 2,000 tokens after much larger explorations. [Anthropic context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents#context-engineering-for-long-horizon-tasks)

This works well for repository surveys and research. It is a poor fit when the parent needs exact raw evidence unless the child also returns artifact handles and citations.

## Comparison

The `Primary-context tokens` column means tokens in the next ordinary agent request. An LLM summary can shrink that request while still increasing aggregate provider tokens because the summarizer must first read the original result.

| Option | When savings begin | Primary-context tokens | Session bytes | Fidelity | Main cost |
|---|---|---:|---:|---|---|
| Filtering and pagination | Before execution | Strong reduction | Strong reduction | Lossless with continuation | More calls may be needed |
| Truncation plus artifact | At tool completion | Strong reduction | Strong reduction | Recoverable | Artifact lifecycle |
| Deterministic projection | At tool completion | Strong reduction | Strong reduction | High if schema is right | Tool-specific work |
| LLM summary per result | At tool completion | Strong reduction | Strong reduction | Lossy | Extra summarizer input, latency, and model cost |
| Outbound stale-result clearing | Mid-session | Strong reduction | None | Recoverable with handles | Cache invalidation |
| Summary-input-only truncation | During compaction | Compaction call only | None | Lossy summary input | No pre-compaction benefit |
| Whole-history compaction | Near context limit | Strong reduction | Usually none | Lossy | Summary quality |
| Provider-native editing | Mid-session or threshold | Strong reduction | None on the client | Provider-dependent | Lock-in |
| Subagent isolation | During delegated work | Strong parent reduction | Depends on storage | Summary-dependent | Coordination |

## Recommended design for this repository

### First pass

1. Give every custom tool a hard output budget. Fix `ddg_fetch` first by setting a finite default and clamping caller-supplied `max_chars` to a hard maximum.
2. Save full fetch, command, test, and search output as artifacts when truncated. Return a short excerpt, URL or path, byte count, and hash.
3. Keep `details` small. It should contain renderer and retrieval metadata, not a second copy of the raw output.
4. Prefer deterministic reducers for known formats. Keep LLM summaries for unstructured prose where extraction rules perform poorly.
5. Add a combined cap to parallel subagent results. Per-child limits can still produce one very large parent result.

### Second pass

Add a provider-neutral stale-result policy in a Pi `context` handler. Start conservatively, using OpenCode's policy as a reference rather than a magic constant:

- protect the latest two user turns
- protect roughly 40,000 tokens of recent tool output
- run only when at least 20,000 tokens can be reclaimed
- replace old successful results with metadata-rich placeholders
- retain errors, current work, and results without durable handles

Measure before lowering those thresholds. The configured model contexts are large, so an aggressive small fixed window may hurt more than it helps.

The same reducer must be applied inside the custom compactor. That compactor rebuilds raw branch context, so an outbound `context` edit alone will not shrink its summary request.

### Third pass

Change custom compaction to use reduced history for the discarded span while still keeping the 20,000-token recent tail verbatim. If cache reuse and small summary requests conflict, prefer the smaller request once the context crosses a high threshold. Cache savings do not prevent context overflow or context dilution.

Provider-native compaction can remain an optional adapter later. It should not define the portable session format.

## What to measure

A useful benchmark should record:

- provider input, cache-read, and cache-write tokens per turn
- tool-result characters and estimated tokens by tool
- active-context tokens versus session JSONL bytes
- compaction frequency and compaction-request size
- artifact re-read count
- end-to-end latency and model cost
- task correctness, exact evidence retention, and recovery after pruning

Token savings without correctness checks will reward over-pruning. Test with long coding traces containing failed builds, repeated file reads, broad web pages, and one late line that changes the correct answer.

## Recommendation in one sentence

Bound and externalize tool output when it is created, clear old successful results from outbound context in batches, and keep whole-history compaction as the final safety net.