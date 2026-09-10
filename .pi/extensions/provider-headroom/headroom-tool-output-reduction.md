# How Headroom reduces tool-output tokens

This note explains the implementation at the pinned Headroom snapshot [`e67b3c8a29443a60d6b0018fb22f525c5cd7e709`](https://github.com/headroomlabs-ai/headroom/tree/e67b3c8a29443a60d6b0018fb22f525c5cd7e709), using Headroom's official documentation:

- [How Compression Works](https://docs.headroomlabs.ai/docs/how-compression-works)
- [Architecture](https://docs.headroomlabs.ai/docs/architecture)
- [Reversible Compression (CCR)](https://docs.headroomlabs.ai/docs/ccr)

The important distinction is:

| Mechanism | What the model receives | Where omitted detail is | Is the current prompt self-sufficient? |
|---|---|---|---|
| **Lossless compaction** | A smaller, format-native representation | Nowhere for the retained data; formatting or bookkeeping may be normalized | Yes, subject to the model understanding the fold |
| **Lossy compression** | A relevance/importance-selected view | Not in the inline text; detail is omitted | No |
| **CCR retrieval** | Lossy output plus a hash marker | Headroom's local compression store | Recoverable on demand, if the model retrieves it |

CCR changes the **risk/recoverability** of lossy compression; it does not itself improve the lossy ratio. A request that never retrieves can enjoy the smaller prompt. A retrieval continuation brings the original back and therefore consumes tokens on that continuation.

## 1. Request path: only safe text slots are candidates

Headroom sits between the application and the provider. The official architecture describes the proxy/SDK boundary, the transform pipeline, ContentRouter, and the fact that the current pipeline is live-zone-only: it compresses content in place and does not drop or reorder messages ([architecture](https://docs.headroomlabs.ai/docs/architecture); pinned [`pipeline.py#L86-L98`](https://github.com/headroomlabs-ai/headroom/blob/e67b3c8a29443a60d6b0018fb22f525c5cd7e709/headroom/transforms/pipeline.py#L86-L98)).

Provider adapters extract only mutable text ranges into `CompressionUnit`s and splice accepted replacements back into the native request shape ([`compression_units.py#L1-L7`](https://github.com/headroomlabs-ai/headroom/blob/e67b3c8a29443a60d6b0018fb22f525c5cd7e709/headroom/transforms/compression_units.py#L1-L7)). For OpenAI Responses, the adapter exposes text in tool-output item types such as `function_call_output` and `local_shell_call_output`, while reasoning items, tool calls, non-string values, and ordinary message items are not exposed as compression units ([`openai.py#L1016-L1023`](https://github.com/headroomlabs-ai/headroom/blob/e67b3c8a29443a60d6b0018fb22f525c5cd7e709/headroom/proxy/handlers/openai.py#L1016-L1023), [`openai.py#L1968-L1984`](https://github.com/headroomlabs-ai/headroom/blob/e67b3c8a29443a60d6b0018fb22f525c5cd7e709/headroom/proxy/handlers/openai.py#L1968-L1984), [`openai.py#L2043-L2063`](https://github.com/headroomlabs-ai/headroom/blob/e67b3c8a29443a60d6b0018fb22f525c5cd7e709/headroom/proxy/handlers/openai.py#L2043-L2063)).

The normal path then:

1. checks safety and cache-zone gates;
2. detects the content type;
3. applies lossless structural compaction first;
4. routes the remaining eligible content to one specialized compressor or a fallback;
5. accepts the result only when it is actually smaller, otherwise passing the original through.

The detector recognizes JSON arrays, source code, search results, logs/build output, diffs, HTML, tables, structured config, and plain text ([`content_detector.py#L7-L15`](https://github.com/headroomlabs-ai/headroom/blob/e67b3c8a29443a60d6b0018fb22f525c5cd7e709/headroom/transforms/content_detector.py#L7-L15), [`content_detector.py#L163-L220`](https://github.com/headroomlabs-ai/headroom/blob/e67b3c8a29443a60d6b0018fb22f525c5cd7e709/headroom/transforms/content_detector.py#L163-L220)).

### Gates that commonly prevent a reduction

These gates are why "all tool output is compressed" would be inaccurate:

- User, system/developer, and by-default assistant text is protected; tool/function output is the main eligible class ([`content_router.py#L6052-L6072`](https://github.com/headroomlabs-ai/headroom/blob/e67b3c8a29443a60d6b0018fb22f525c5cd7e709/headroom/transforms/content_router.py#L6052-L6072), [`compression_units.py#L256-L267`](https://github.com/headroomlabs-ai/headroom/blob/e67b3c8a29443a60d6b0018fb22f525c5cd7e709/headroom/transforms/compression_units.py#L256-L267)). The Anthropic-shaped path handles nested `tool_result` blocks as tool output even when the containing message has role `user` ([`content_router.py#L6133-L6156`](https://github.com/headroomlabs-ai/headroom/blob/e67b3c8a29443a60d6b0018fb22f525c5cd7e709/headroom/transforms/content_router.py#L6133-L6156)).
- Explicit `cache_control` blocks and frozen provider-cache prefixes are not rewritten. Cache mode concentrates work on the newest delta; token mode permits more aggressive raw token removal ([`content_router.py#L6054-L6060`](https://github.com/headroomlabs-ai/headroom/blob/e67b3c8a29443a60d6b0018fb22f525c5cd7e709/headroom/transforms/content_router.py#L6054-L6060), [`content_router.py#L5123-L5134`](https://github.com/headroomlabs-ai/headroom/blob/e67b3c8a29443a60d6b0018fb22f525c5cd7e709/headroom/transforms/content_router.py#L5123-L5134), [architecture](https://docs.headroomlabs.ai/docs/architecture)).
- Default-excluded tools include `Read`, `Glob`, `Grep`, `Write`, `Edit`, web tools, and `headroom_retrieve`; `Bash` is intentionally not excluded because logs and test output are useful compression targets ([`config.py#L206-L230`](https://github.com/headroomlabs-ai/headroom/blob/e67b3c8a29443a60d6b0018fb22f525c5cd7e709/headroom/config.py#L206-L230)). For ordinary excluded tools, the router blocks lossy compression but may apply an excluded-tool lossless fold; the stricter verbatim set skips that fold too ([`content_router.py#L6184-L6212`](https://github.com/headroomlabs-ai/headroom/blob/e67b3c8a29443a60d6b0018fb22f525c5cd7e709/headroom/transforms/content_router.py#L6184-L6212), [`config.py#L266-L289`](https://github.com/headroomlabs-ai/headroom/blob/e67b3c8a29443a60d6b0018fb22f525c5cd7e709/headroom/config.py#L266-L289)).
- Fresh native file-read outputs stay byte-exact because an agent may copy the shown bytes into an edit anchor. The separate `DEFAULT_BYTE_EXACT_EXCLUDE_TOOLS` gate prevents even a data-preserving reformat from changing what the model sees ([`config.py#L291-L338`](https://github.com/headroomlabs-ai/headroom/blob/e67b3c8a29443a60d6b0018fb22f525c5cd7e709/headroom/config.py#L291-L338)). For shell-based harnesses, the coding profile enables `HEADROOM_PROTECT_READS`; it protects `cat`/`sed`/`head`-style source reads, while data reads such as JSON, logs, and lockfiles can remain eligible ([`agent_savings.py#L149-L184`](https://github.com/headroomlabs-ai/headroom/blob/e67b3c8a29443a60d6b0018fb22f525c5cd7e709/headroom/agent_savings.py#L149-L184), [`content_router.py#L6133-L6156`](https://github.com/headroomlabs-ai/headroom/blob/e67b3c8a29443a60d6b0018fb22f525c5cd7e709/headroom/transforms/content_router.py#L6133-L6156), [`content_router.py#L627-L677`](https://github.com/headroomlabs-ai/headroom/blob/e67b3c8a29443a60d6b0018fb22f525c5cd7e709/headroom/transforms/content_router.py#L627-L677)).
- Small blocks, recent/protected code, analysis-context code, already-compressed content, and many short errors pass through. Small errors are protected verbatim; large logs can still be compressed by a log-aware path that retains error lines ([`content_router.py#L5278-L5347`](https://github.com/headroomlabs-ai/headroom/blob/e67b3c8a29443a60d6b0018fb22f525c5cd7e709/headroom/transforms/content_router.py#L5278-L5347)).
- The tool-result paths enforce reversibility for selected markerless lossy strategies when CCR is enabled. A candidate with no marker is skipped instead of being served, because the model would otherwise act on an unrecoverable view. The provider tokenizer is used for the final unit-sizedness check ([`compression_units.py#L217-L228`](https://github.com/headroomlabs-ai/headroom/blob/e67b3c8a29443a60d6b0018fb22f525c5cd7e709/headroom/transforms/compression_units.py#L217-L228), [`compression_units.py#L331-L371`](https://github.com/headroomlabs-ai/headroom/blob/e67b3c8a29443a60d6b0018fb22f525c5cd7e709/headroom/transforms/compression_units.py#L331-L371), [`content_router.py#L6576-L6601`](https://github.com/headroomlabs-ai/headroom/blob/e67b3c8a29443a60d6b0018fb22f525c5cd7e709/headroom/transforms/content_router.py#L6576-L6601)).

## 2. Lossless compaction: reduce representation without dropping records

ContentRouter's Stage 0 runs before lossy compression in every mode. The reversible folds self-verify or leave the input unchanged. ANSI normalization and diff-bookkeeping removal use a narrower data/semantic-preserving contract. The router keeps the result as a floor before considering word or row removal ([`content_router.py#L3205-L3225`](https://github.com/headroomlabs-ai/headroom/blob/e67b3c8a29443a60d6b0018fb22f525c5cd7e709/headroom/transforms/content_router.py#L3205-L3225), [`content_router.py#L2635-L2707`](https://github.com/headroomlabs-ai/headroom/blob/e67b3c8a29443a60d6b0018fb22f525c5cd7e709/headroom/transforms/content_router.py#L2635-L2707), [`lossless_compaction.py#L467-L520`](https://github.com/headroomlabs-ai/headroom/blob/e67b3c8a29443a60d6b0018fb22f525c5cd7e709/headroom/transforms/lossless_compaction.py#L467-L520)). Examples include:

- grep/search output: hoist a repeated path into a heading and leave `line:content` rows;
- repeated log lines: keep one line plus `... (repeated N times)`;
- repeated config stanzas: use a back-reference;
- diffs: remove `index` bookkeeping lines;
- generic text: collapse repeated blank lines;
- eligible structured JSON: minify whitespace while preserving the parsed data.

The helpers document exact inverses and the runtime checks that reject a non-smaller or non-round-tripping candidate ([`lossless_compaction.py#L1-L12`](https://github.com/headroomlabs-ai/headroom/blob/e67b3c8a29443a60d6b0018fb22f525c5cd7e709/headroom/transforms/lossless_compaction.py#L1-L12), [`lossless_compaction.py#L108-L176`](https://github.com/headroomlabs-ai/headroom/blob/e67b3c8a29443a60d6b0018fb22f525c5cd7e709/headroom/transforms/lossless_compaction.py#L108-L176), [`lossless_compaction.py#L467-L538`](https://github.com/headroomlabs-ai/headroom/blob/e67b3c8a29443a60d6b0018fb22f525c5cd7e709/headroom/transforms/lossless_compaction.py#L467-L538)).

"Lossless" needs a qualification. Some folds are byte-reversible; JSON minification is data-preserving but not byte-identical; ANSI color is intentionally removed; diff index lines are treated as non-semantic bookkeeping. That is sufficient for the data structure or log/search meaning, but not sufficient for a model constructing an exact source-file edit. That is why raw source reads are separately protected ([`content_router.py#L5758-L5787`](https://github.com/headroomlabs-ai/headroom/blob/e67b3c8a29443a60d6b0018fb22f525c5cd7e709/headroom/transforms/content_router.py#L5758-L5787)).

### Strict lossless mode

`--lossless` / `HEADROOM_LOSSLESS=1` is a contract, not merely a preference: ContentRouter stops after the format-native fold, and if no fold exists it passes the content through. It also forces SmartCrusher into marker-free lossless-only behavior ([`content_router.py#L3216-L3225`](https://github.com/headroomlabs-ai/headroom/blob/e67b3c8a29443a60d6b0018fb22f525c5cd7e709/headroom/transforms/content_router.py#L3216-L3225), [`content_router.py#L1791-L1799`](https://github.com/headroomlabs-ai/headroom/blob/e67b3c8a29443a60d6b0018fb22f525c5cd7e709/headroom/transforms/content_router.py#L1791-L1799)). It is therefore different from `--no-ccr`: `--no-ccr` can still permit intentionally unrecoverable lossy output.

JSON arrays have a second, SmartCrusher-specific lossless path. When a tabular/bucket rendering wins its savings threshold, all rows remain inline, `ccr_hash` is absent, and the compacted representation replaces the array in place ([Rust `crusher.rs#L59-L105`](https://github.com/headroomlabs-ai/headroom/blob/e67b3c8a29443a60d6b0018fb22f525c5cd7e709/crates/headroom-core/src/transforms/smart_crusher/crusher.rs#L59-L105), [`crusher.rs#L813-L845`](https://github.com/headroomlabs-ai/headroom/blob/e67b3c8a29443a60d6b0018fb22f525c5cd7e709/crates/headroom-core/src/transforms/smart_crusher/crusher.rs#L813-L845)). In normal CCR mode, long opaque cells inside a JSON document can themselves become CCR markers; strict `lossless_only` prevents that and leaves such content inline ([`crusher.rs#L656-L743`](https://github.com/headroomlabs-ai/headroom/blob/e67b3c8a29443a60d6b0018fb22f525c5cd7e709/crates/headroom-core/src/transforms/smart_crusher/crusher.rs#L656-L743), [`smart_crusher.py#L160-L200`](https://github.com/headroomlabs-ai/headroom/blob/e67b3c8a29443a60d6b0018fb22f525c5cd7e709/headroom/transforms/smart_crusher.py#L160-L200)).

## 3. Lossy compression: choose a smaller useful view

If the lossless floor is insufficient and the unit is eligible, ContentRouter routes by detected shape. The official documentation lists the same family of routes in its [content-type table](https://docs.headroomlabs.ai/docs/how-compression-works#content-type-detection).

- **JSON arrays / structured data.** SmartCrusher computes an adaptive keep count and uses relevance/structure constraints rather than taking an arbitrary prefix. The defaults preserve boundaries, error items, structural/numeric outliers, and query-matching items; the Rust path then plans and executes the surviving subset ([`config.py#L551-L590`](https://github.com/headroomlabs-ai/headroom/blob/e67b3c8a29443a60d6b0018fb22f525c5cd7e709/headroom/config.py#L551-L590), [`crusher.rs#L746-L811`](https://github.com/headroomlabs-ai/headroom/blob/e67b3c8a29443a60d6b0018fb22f525c5cd7e709/crates/headroom-core/src/transforms/smart_crusher/crusher.rs#L746-L811)). Dropped rows are represented by a CCR sentinel when markers are enabled ([`crusher.rs#L552-L576`](https://github.com/headroomlabs-ai/headroom/blob/e67b3c8a29443a60d6b0018fb22f525c5cd7e709/crates/headroom-core/src/transforms/smart_crusher/crusher.rs#L552-L576)).
- **Search results.** Matches are scored against context, error/priority matches get a boost, and selection is bounded per file and globally while retaining first/last boundaries where configured ([`search_compressor.py#L113-L129`](https://github.com/headroomlabs-ai/headroom/blob/e67b3c8a29443a60d6b0018fb22f525c5cd7e709/headroom/transforms/search_compressor.py#L113-L129), [`search_compressor.py#L247-L345`](https://github.com/headroomlabs-ai/headroom/blob/e67b3c8a29443a60d6b0018fb22f525c5cd7e709/headroom/transforms/search_compressor.py#L247-L345)).
- **Logs/build output.** Lines receive level/stack/summary scores. Selection prioritizes errors, failures, warnings, stack traces, summaries, and nearby context; similar warnings can be deduplicated ([`log_compressor.py#L323-L417`](https://github.com/headroomlabs-ai/headroom/blob/e67b3c8a29443a60d6b0018fb22f525c5cd7e709/headroom/transforms/log_compressor.py#L323-L417)).
- **Plain text and fallback text.** Kompress's ModernBERT model scores/keeps tokens or ranks them when a target ratio is supplied. A hard-keep layer protects numbers, IDs, paths, extensions, flags, error names, and directive/negation words such as `not`, `must`, and `unless` ([`kompress_compressor.py#L44-L88`](https://github.com/headroomlabs-ai/headroom/blob/e67b3c8a29443a60d6b0018fb22f525c5cd7e709/headroom/transforms/kompress_compressor.py#L44-L88), [`kompress_compressor.py#L1685-L1710`](https://github.com/headroomlabs-ai/headroom/blob/e67b3c8a29443a60d6b0018fb22f525c5cd7e709/headroom/transforms/kompress_compressor.py#L1685-L1710)).
- **Source code.** When enabled, CodeAwareCompressor parses with tree-sitter, preserves imports/signatures/types/decorators, compresses selected bodies, and validates the output syntax; invalid or over-aggressive output is discarded ([`code_compressor.py#L1-L27`](https://github.com/headroomlabs-ai/headroom/blob/e67b3c8a29443a60d6b0018fb22f525c5cd7e709/headroom/transforms/code_compressor.py#L1-L27), [`code_compressor.py#L1423-L1485`](https://github.com/headroomlabs-ai/headroom/blob/e67b3c8a29443a60d6b0018fb22f525c5cd7e709/headroom/transforms/code_compressor.py#L1423-L1485)). It is configuration-dependent and raw file reads remain protected by default in the coding posture.
- **HTML, tables, config, and diffs** use corresponding structural handlers. Diffs are deliberately not sent through the lossy-after-fold Kompress pass because rewriting hunks can break `git apply` ([`content_router.py#L3250-L3287`](https://github.com/headroomlabs-ai/headroom/blob/e67b3c8a29443a60d6b0018fb22f525c5cd7e709/headroom/transforms/content_router.py#L3250-L3287)).

The acceptance gate is important: it compares the result with the relevant token/ratio measure and caches only accepted results. For tool results, markerless lossy classes are rejected when CCR is on; a failed compressor, no-saving result, or unsafe result becomes passthrough ([`content_router.py#L6542-L6620`](https://github.com/headroomlabs-ai/headroom/blob/e67b3c8a29443a60d6b0018fb22f525c5cd7e709/headroom/transforms/content_router.py#L6542-L6620)). The optional `lossless_then_lossy` setting can run Kompress over a losslessly folded remainder, but only when it produces a further meaningful saving; diffs are excluded ([`content_router.py#L3250-L3282`](https://github.com/headroomlabs-ai/headroom/blob/e67b3c8a29443a60d6b0018fb22f525c5cd7e709/headroom/transforms/content_router.py#L3250-L3282), [`content_router.py#L3625-L3667`](https://github.com/headroomlabs-ai/headroom/blob/e67b3c8a29443a60d6b0018fb22f525c5cd7e709/headroom/transforms/content_router.py#L3625-L3667)).

## 4. CCR: keep the original outside the prompt and retrieve it if needed

With CCR enabled, a lossy compressor:

1. stores the original content under a hash;
2. puts a marker such as `[... Retrieve more: hash=...]` or `<<ccr:...>>` in the compressed output;
3. causes `headroom_retrieve` to be added to the available tools once the marker is found and verified as belonging to the local store;
4. lets the model request the original only if the compressed view is insufficient.

The tool definition and hash-marker scan/ownership check are implemented in [`tool_injection.py#L37-L118`](https://github.com/headroomlabs-ai/headroom/blob/e67b3c8a29443a60d6b0018fb22f525c5cd7e709/headroom/ccr/tool_injection.py#L37-L118) and [`tool_injection.py#L244-L372`](https://github.com/headroomlabs-ai/headroom/blob/e67b3c8a29443a60d6b0018fb22f525c5cd7e709/headroom/ccr/tool_injection.py#L244-L372). The official [CCR documentation](https://docs.headroomlabs.ai/docs/ccr) describes the same Compress → Cache → Retrieve flow.

When the model calls the tool, the response handler looks up the original, constructs the provider-specific tool result, and makes a continuation API call. It repeats up to the configured retrieval-round limit; mixed responses containing a client-owned tool call are passed back because Headroom cannot synthesize the other tool's result ([`response_handler.py#L183-L235`](https://github.com/headroomlabs-ai/headroom/blob/e67b3c8a29443a60d6b0018fb22f525c5cd7e709/headroom/ccr/response_handler.py#L183-L235), [`response_handler.py#L433-L545`](https://github.com/headroomlabs-ai/headroom/blob/e67b3c8a29443a60d6b0018fb22f525c5cd7e709/headroom/ccr/response_handler.py#L433-L545)). Retrieved output is then explicitly protected from recompression, avoiding a new marker/retrieval loop ([`content_router.py#L4867-L4887`](https://github.com/headroomlabs-ai/headroom/blob/e67b3c8a29443a60d6b0018fb22f525c5cd7e709/headroom/transforms/content_router.py#L4867-L4887), [`content_router.py#L6174-L6183`](https://github.com/headroomlabs-ai/headroom/blob/e67b3c8a29443a60d6b0018fb22f525c5cd7e709/headroom/transforms/content_router.py#L6174-L6183)).

So CCR is not "the model still sees all rows." The first prompt still contains the reduced view. CCR means the omitted rows remain available through a separate model/tool round instead of being permanently discarded. `--no-ccr` turns off markers and the injected retrieval tool; it is not equivalent to `--lossless` ([proxy options](https://docs.headroomlabs.ai/docs/proxy#reversible-compression-ccr-and-lossless-mode)).

## 5. Repeated reads and stale reads are separate optimizations

Two additional mechanisms can reduce repeated tool-output tokens without pretending they are ordinary lossy compression:

- **Cross-turn deduplication** (`HEADROOM_DEDUPE=1`) replaces a sufficiently large later verbatim span with a pointer to an earlier copy that remains in the same prompt. The earliest copy is never rewritten, and the transform is prefix-monotonic, so appending a later turn does not mutate the provider-cache prefix ([`cross_turn_dedup.py#L1-L35`](https://github.com/headroomlabs-ai/headroom/blob/e67b3c8a29443a60d6b0018fb22f525c5cd7e709/headroom/transforms/cross_turn_dedup.py#L1-L35), [`cross_turn_dedup.py#L260-L306`](https://github.com/headroomlabs-ai/headroom/blob/e67b3c8a29443a60d6b0018fb22f525c5cd7e709/headroom/transforms/cross_turn_dedup.py#L260-L306)). This is in-context and information-preserving, not CCR retrieval.
- **Read lifecycle management** classifies older `Read` outputs as stale after a later edit or superseded after a later covering read. It leaves fresh reads alone and can replace the provably stale/redundant ones with a short marker plus a CCR hash ([`config.py#L451-L470`](https://github.com/headroomlabs-ai/headroom/blob/e67b3c8a29443a60d6b0018fb22f525c5cd7e709/headroom/config.py#L451-L470), [`read_lifecycle.py#L451-L470`](https://github.com/headroomlabs-ai/headroom/blob/e67b3c8a29443a60d6b0018fb22f525c5cd7e709/headroom/transforms/read_lifecycle.py#L451-L470), [`read_lifecycle.py#L446-L515`](https://github.com/headroomlabs-ai/headroom/blob/e67b3c8a29443a60d6b0018fb22f525c5cd7e709/headroom/transforms/read_lifecycle.py#L446-L515)).

## Bottom line

For an eligible tool output, the practical pipeline is:

```text
extract safe output text
  → detect its shape
  → take a self-checked lossless fold
  → optionally remove low-value rows/words/details
  → require a real saving and pass safety gates
  → with CCR, store the original and expose a hash marker/retrieval tool
```

Lossless compaction saves tokens by changing representation. Lossy compression saves more by removing prompt-visible detail. CCR makes that removal recoverable on demand, but adds marker/storage/retrieval behavior rather than reducing tokens by itself. Actual savings are workload- and configuration-dependent; Headroom's published ranges are directional, not a guarantee for every tool output ([official caveat](https://docs.headroomlabs.ai/docs/how-compression-works#content-type-detection)).
