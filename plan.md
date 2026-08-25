Goal

 Make both user /compact and .pi/extensions/auto-compact calls to
 ctx.compact() summarize through the active provider while preserving
 the previous prompt prefix.

 Native threshold and overflow compaction remain vetoed.

 1. Add a shared cache-aware compaction helper

 Create:

 - .pi/extensions/_shared/cache-aware-compaction.ts
 - .pi/extensions/_shared/cache-aware-compaction.test.ts

 The helper will:

 1. Reconstruct the active conversation with public Pi APIs:
     - buildSessionContext(event.branchEntries)
     - convertToLlm(...)
 2. Reconstruct active tools in their current order using:
     - pi.getActiveTools()
     - pi.getAllTools()
 3. Build a provider context containing:
     - The unchanged system prompt.
     - The unchanged historical messages.
     - The unchanged active tool definitions.
     - One appended user message containing the compaction
       instructions.
 4. Tell the model how many trailing messages Pi will retain so the
    summary focuses on discarded history.
 5. Include event.customInstructions in the appended instruction.
 6. Never serialize the conversation into a new standalone prompt or
    replace the system prompt.

 2. Track cache-prefix eligibility without retaining payloads

 Add an in-memory context fingerprint tracker:

 - On context, calculate hashes for the current model, system prompt,
   ordered tools, thinking level, session ID, and converted messages.
 - Commit that snapshot when the corresponding before_provider_request
    fires.
 - Store only hashes, message count, and non-sensitive identifiers.
 - Clear pending and committed snapshots on session replacement,
   reload, and shutdown.
 - Never write fingerprints, provider payloads, messages,
   authentication data, or headers to disk.

 Before cache-aware compaction:

 1. Confirm the model, thinking level, system prompt, tools, and
    session ID still match.
 2. Confirm the current message sequence begins with the last provider
    request's message sequence.
 3. Reject image-containing contexts because Pi's image-blocking
    transformation is not exposed to extensions.
 4. Fall back to native compaction if there was no provider request in
    the current runtime or fidelity cannot be established.

 3. Invoke the active provider through its normal renderer

 Use the provider-neutral public path:

 1. Resolve the active provider with
    ctx.modelRegistry.getProvider(model.provider).
 2. Resolve authentication through
    ctx.modelRegistry.getApiKeyAndHeaders(model).
 3. Apply any resolved baseUrl override to an effective model copy.
 4. Call:
     - provider.streamSimple(effectiveModel, context,
       options).result()
 5. Preserve:
     - Current model.
     - Current thinking level.
     - Current session ID.
     - Provider environment.
     - Resolved authentication and headers.
     - Effective cache retention. Do not use cacheRetention: "none".
 6. Set a summary output limit derived from
    preparation.settings.reserveTokens, model limits, and available
    context headroom.

 This path does not use an API allowlist. Built-in and custom
 providers use their registered streamSimple implementation.

 4. Validate the summary result

 Accept the result only when:

 - stopReason indicates normal completion.
 - At least one non-empty text block exists.
 - No tool call was returned.
 - The response was not truncated, aborted, deferred, or errored.

 If validation or the provider call fails, return undefined from
 session_before_compact. Pi will then run native compaction. Warn once
 in the UI unless the operation was aborted.

 Use an in-flight guard to prevent duplicate or reentrant cache-aware
 summary calls.

 5. Preserve Pi compaction metadata

 Return a custom CompactionResult containing:

 - summary
 - firstKeptEntryId
 - tokensBefore
 - Provider usage
 - details: { readFiles, modifiedFiles }

 Derive file lists from preparation.fileOps using Pi-compatible
 semantics:

 - Modified files include writes and edits.
 - Read-only files exclude modified files.
 - Sort both lists.
 - Append the native <read-files> and <modified-files> sections to the
   summary.

 Handle split-turn preparation by calculating the retained suffix from
 firstKeptEntryId and telling the model which trailing provider
 messages remain verbatim.

 6. Integrate with auto-compact

 Update .pi/extensions/auto-compact/index.ts:

 - Replace the current synchronous session_before_compact handler with
   an async router.
 - Continue returning { cancel: true } for native "threshold" and
   "overflow" reasons.
 - For "manual", run cache-aware compaction.
 - Do not exclude requests while compactionInProgress is true. Pi
   reports the extension's ctx.compact() calls as "manual", and those
   calls should now use the same cache-aware path as /compact.
 - Keep the existing auto-compaction scheduling, timeout handling,
   notification, and callback cleanup unchanged.

 7. Extend tests

 Update .pi/extensions/auto-compact/index.test.ts and add shared
 helper tests covering:

 - The summary context exactly preserves system prompt, ordered tools,
   and historical messages.
 - Only one user instruction is appended.
 - Model, reasoning, session ID, authentication environment, and cache
   retention are preserved.
 - Genuine /compact returns a custom compaction.
 - Extension-triggered ctx.compact() uses the same custom path.
 - Native threshold and overflow requests remain canceled.
 - A custom provider's registered streamSimple implementation is used.
 - Missing or stale snapshots fall back without sending the
   cache-aware request.
 - Model, system prompt, tools, thinking level, session ID, and
   message-prefix changes cause fallback.
 - Images cause fallback.
 - Provider error, abort, truncation, tool use, empty output, and
   insufficient headroom cause fallback.
 - Split-turn retained-message counting is correct.
 - Previous compaction summaries remain part of the unchanged prefix.
 - firstKeptEntryId, tokensBefore, usage, file lists, and XML sections
   match native behavior.
 - State and in-flight markers clear after success, failure, abort,
   reload, and session replacement.
 - No raw payload or message content is retained by the fingerprint
   tracker.

 Add a rendered-payload regression test for the configured API
 families, openai-codex-responses and openai-completions, using fake
 transports. Verify that the compaction request's rendered input
 extends the normal request's input and keeps the same cache key,
 system prompt, tools, and reasoning configuration.

 8. Verification

 Run:

 ```bash
   cd .pi
   pnpm test:core
   pnpm typecheck
   pnpm test
 ```

 For an optional live acceptance check, make a normal cached turn and
 then run /compact. Confirm the compaction entry reports nonzero
 usage.cacheRead. This requires valid provider credentials and incurs
 a provider request, so it should only run with explicit approval.
