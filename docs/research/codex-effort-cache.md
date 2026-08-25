# Codex/Pi reasoning-effort changes and cache reuse

## Summary

OpenAI prompt caching and Responses continuation are separate mechanisms. The official prompt-caching guide identifies `reasoning.effort` as a setting that can change model-side reasoning instructions, so an effort change can make the rendered prefix ineligible for the prior cache entry. A stable `prompt_cache_key` influences routing but does not pin a request or guarantee a hit.

Current Pi 0.84.2 also conservatively drops WebSocket incremental continuation when effort changes. A client patch could attempt `previous_response_id` continuation across the change, but OpenAI's public documentation does not explicitly guarantee that changing `reasoning.effort` on an existing chain is supported. This should be feature-gated and tested before becoming normal behavior.

## Evidence

### OpenAI server prompt caching

OpenAI says cache reuse requires the full rendered prefix to match and specifically lists `reasoning.effort` among settings that can alter model-side instructions. It also states that `prompt_cache_key` only influences routing and cannot guarantee a hit. GPT-5.6 supports explicit breakpoints and has a 1,024-visible-token minimum cacheable prefix, but an explicit breakpoint cannot make two differently rendered prefixes identical.

Source: [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)

The local repeated experiment on `openai-codex/gpt-5.6-sol` produced four valid SSE effort-change probes in both directions. Every same-effort control read 2,816 cached tokens, while every changed-effort turn read zero. This matches the documented rendered-prefix behavior rather than routing noise.

### Responses and WebSocket continuation

OpenAI documents `previous_response_id` as conversation lineage. In WebSocket mode, connection-local state allows the client to send only new input items. With `store=false`, an unavailable prior response has no persisted fallback, so clients must replay full context or begin a new compacted chain. Prior input remains billable even with response chaining.

Sources:

- [OpenAI conversation state](https://developers.openai.com/api/docs/guides/conversation-state)
- [OpenAI WebSocket mode](https://developers.openai.com/api/docs/guides/websocket-mode)
- [OpenAI reasoning models](https://developers.openai.com/api/docs/guides/reasoning)

The WebSocket guide also documents `generate: false` warmups, which prepare request state and return a response ID for later chaining. This can prewarm an effort-specific lane, but the warmup still performs work; it moves or duplicates the miss rather than eliminating it.

### Current Codex and Pi behavior

The openai/codex issue below records the same client-side transition: changing reasoning effort invalidated incremental WebSocket reuse and caused a full-history resend. The report identifies Codex's request-property comparison, which includes the entire reasoning object. It does not prove that the backend rejects `previous_response_id` combined with a changed effort because Codex never sent that combination.

Source: [openai/codex issue #32533](https://github.com/openai/codex/issues/32533)

Installed Pi 0.84.2 behaves similarly in `@earendil-works/pi-ai/dist/api/openai-codex-responses.js`:

- `requestBodyWithoutInput()` excludes only `input` and `previous_response_id`.
- `requestBodiesMatchExceptInput()` therefore compares `reasoning.effort`.
- A mismatch clears continuation and sends the full request body.
- Pi uses `store: false`, so WebSocket continuation is connection-local.

The local repeated experiment confirmed `full → delta → full → delta` for all four `auto` trials: same-effort turns used a delta, while effort-change turns used full context.

## Practical options

1. **Fixed provider effort (safe, immediate):** Keep `reasoning.effort` constant for the entire session. Prompt-level instructions can ask for more or less deliberation, but this is not a true provider effort change.
2. **Effort-specific warm lanes (supported primitives, higher cost):** Maintain one cache/continuation lane per effort and prewarm the target lane, potentially with WebSocket `generate: false`. This can make the user-visible switch warm, but the warmup itself consumes a request and cache write; keeping every lane current duplicates work.
3. **Optimistic continuation across effort changes (best potential, unproven):** Change Pi's WebSocket matcher so `reasoning.effort` does not invalidate `previous_response_id` continuation. Send only the new input with the new effort. Gate this behind a setting, retain canonical full history, and fall back to compacted/full replay on backend rejection. A controlled live test is required because official documentation does not explicitly guarantee this combination.
4. **Full replay plus explicit breakpoints (cannot ensure cross-effort hits):** Explicit breakpoints improve reuse within each effort-specific rendered prefix but cannot guarantee reuse across different reasoning instructions.

## Recommendation

Prototype option 3 in an isolated, commit-pinned Pi AI fork or temporary child adapter—not by silently patching the installed global package. Test `A → A → B → B` over WebSocket while forcing `previous_response_id` on the change turn. Record acceptance, actual delta/full behavior, `cached_tokens`, billing, and output correctness. If it succeeds repeatedly in both directions, add a feature-gated Pi setting with automatic fallback. If it fails, use fixed effort or accept the unavoidable first miss for each effort-specific lane.
