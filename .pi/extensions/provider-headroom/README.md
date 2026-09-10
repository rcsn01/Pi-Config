# Provider Headroom

This project-local extension emulates the tool-output part of Headroom without a proxy or native service.

It uses Pi's `tool_result` hook for new results and `context` hook for existing sessions. The reducer is deterministic TypeScript:

- lossless cleanup: ANSI removal, repeated-line folding, search-path grouping, and JSON minification;
- lossy reduction: bounded JSON, search, log, and plain-text sampling with priority/error rows retained;
- protected output: native `read`, `write`, `edit`, web, retrieval, shell read commands, source-like shell output, and small errors stay verbatim;
- CCR-style retrieval: lossy results carry a hash marker, retain the original in session-only metadata, and expose `headroom_retrieve` on demand.

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

CCR originals are stored in Pi session metadata/custom entries rather than sent in the model context. This preserves recoverability across session reloads, but session files can contain the original sensitive output.
