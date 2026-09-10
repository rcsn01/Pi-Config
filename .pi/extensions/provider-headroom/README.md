# Provider Headroom

This project-local extension emulates the tool-output part of Headroom without a proxy or native service.

Its stateful Tool-output retention module owns configuration, tool policy, rewriting, cross-turn deduplication, CCR storage, and retrieval. The Pi extension is a thin adapter:

- `tool_result` rewrites eligible new results before Pi stores them;
- `context` projects eligible historical results without changing old Session entries;
- cache-aware custom compaction discovers the same active module through the shared registry and applies the same historical projection before provider conversion;
- `session_start` and `session_tree` rebuild retrieval state from the active branch, and `session_shutdown` unregisters it.

The reducer remains deterministic TypeScript:

- lossless cleanup: ANSI removal, repeated-line folding, search-path grouping, and JSON minification;
- lossy reduction: bounded JSON, search, log, and plain-text sampling with priority/error rows retained;
- protected output: native `read`, `write`, `edit`, web, retrieval, shell read commands, source-like shell output, and small errors stay verbatim;
- CCR-style retrieval: lossy results carry a hash marker, retain the original in Session-only metadata or a custom entry, and expose `headroom_retrieve` on demand;
- cross-turn deduplication: an eligible later exact copy can become a reference while the earliest copy stays intact.

Fresh CCR originals are attached to the final tool result's `details`. When an unprocessed historical result is reduced, its original is appended once as a `provider-headroom-ccr` custom Session entry. Neither normal historical projection nor compaction rewrites prior Session messages. Navigating the Session tree discards in-memory originals from the abandoned branch and hydrates only the selected branch.

Retention is optional and fail-open. Moving Provider Headroom to `extensions-disabled/` leaves custom compaction unprojected. `PI_HEADROOM_ENABLED=0` instead keeps a registered no-op module so configuration can still be resolved for each operation. Projection, Session persistence, and active-tool failures do not block the provider request.

Subagent model-visible result text follows the same eligibility policy as other tools. Headroom leaves `details.mode`, `details.results`, and nested Subagent output, status, progress, usage, timing, and truncation data intact, so Subagent rendering is unchanged.

This is behaviorally similar, not bit-for-bit identical to Headroom. It does not reproduce Headroom's ModernBERT scorer, Rust SmartCrusher, provider tokenizers, read lifecycle, or provider-wire transforms.

## Configuration

The defaults are conservative: CCR and cross-turn deduplication are enabled, results under 500 characters are skipped, and the default limits are 120 lines, 20 JSON items, and 40 search matches.

Override with environment variables:

- `PI_HEADROOM_ENABLED=0`
- `PI_HEADROOM_CCR=0`
- `PI_HEADROOM_DEDUPE=0`
- `PI_HEADROOM_MODE=lossless`
- `PI_HEADROOM_MIN_CHARS=500`
- `PI_HEADROOM_MAX_LINES=120`
- `PI_HEADROOM_MAX_ITEMS=20`
- `PI_HEADROOM_MAX_SEARCH_MATCHES=40`
- `PI_HEADROOM_MAX_CHARS=12000`
- `PI_HEADROOM_DEDUPE_MIN_CHARS=240`

CCR originals are stored in Pi Session metadata/custom entries rather than sent in the model context. This preserves recoverability across reloads, but Session files can contain the original sensitive output.
