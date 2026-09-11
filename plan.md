# Deepen the Tool-output retention module's query seam

## Status

Ready for implementation. The design decisions in this plan are settled.

## Goal

Delete the only derived concept crossing the Tool-output retention module's
seam — `FreshToolOutput.query` — and let the module derive every query itself.

The module will own both query walkers: the fresh query, derived from the live
Session context entries the Pi adapter supplies per rewrite as raw entries, and
the historical query, already derived from the input message list that
`projectHistory` is about to project. The Pi adapter keeps only Pi translation
and fail-open access to Pi's Session manager:
it passes the tool result fields and the entries it already knows how to read,
and it stops carrying the "last truthy extracted user text,
8,000-code-unit tail" invariant and its copy-duplicated text helpers. The
module's `resolveConfig` in turn stops duplicating the four reduction limits the
reducer already declares (those defaults are not adapter code; see Final design
decision 4).

This is a behavior-preserving refactor. It does not change reduction outcomes,
dedupe ordering, CCR persistence, retrieval, tool policy, or any user-visible
message. The registry consumer (`_shared/cache-aware-compaction.ts`) changes
zero lines.

## Why this work is next

Provider Headroom is the most recently changed extension in the repo:

- Commit `58c5e18` added the extension at 12:03 on 2026-09-10, and `82cc696`
  refactored retention at 14:08 that day. The only later commits in the current
  history touch the older `config-skill` extension (`76fb9ac`, `049916a`).
- The fresh-query invariant (last truthy extracted user text by array position,
  then `slice(-8_000)`) is declared
  twice: `latestUserQueryFromSession` (`index.ts:42-54`) walks Pi Session
  context entries, while `latestUserQuery` (`tool-output-retention.ts:154-160`)
  walks provider messages inside the module.
- The adapter copy-duplicates `textFromContent` / `textFromMessage` /
  `isRecord` (`index.ts:24-40` vs `tool-output-retention.ts:99-101` and
  `:140-152`; the module's copies sit apart because env and config helpers sit
  between them).
- The interface forces this duplication: `FreshToolOutput.query`
  (`_shared/tool-output-retention.ts:13`) makes every caller supply a derived
  concept the module itself derives at `tool-output-retention.ts:441` for the
  historical projection.
- `resolveConfig` duplicates the four reduction limits that `reducer.ts:42-45`
  already declares (`tool-output-retention.ts:26-29`).

The deletion test supports the deepening: delete the adapter's query walker and
duplicated text helpers, and collapse the reduction defaults to the reducer's
single `REDUCTION_DEFAULTS` home. Query complexity then sits in the module that
already owns historical query derivation. The caller supplies only irreducible
live Session state because the `tool_result` event does not carry messages.

## Audited baseline

The plan is based on the current checkout.

- `.pi/extensions/provider-headroom/index.ts`: 171 lines (Pi adapter).
- `.pi/extensions/provider-headroom/tool-output-retention.ts`: 518 lines (the
  deep module).
- `.pi/extensions/provider-headroom/reducer.ts`: 515 lines (reduction).
- `.pi/extensions/_shared/tool-output-retention.ts`: 64 lines (registry seam,
  `globalThis` symbol key `pi-config.tool-output-retention.v1`).
- `.pi/extensions/_shared/cache-aware-compaction.ts`: 227 lines (registry
  consumer; uses only `projectHistory` through `safeProjectHistory`).
- Tests: `tool-output-retention.test.ts` 389 lines, `index.test.ts` 207,
  `integration.test.ts` 198, `reducer.test.ts` 129.
- `pnpm exec vitest run extensions/provider-headroom` passes: 4 files, 61
  tests.
- `pnpm typecheck` passes.
- The `test` chain in `.pi/package.json` has **no** `provider-headroom`
  script: the extension's own suite currently runs only when invoked manually.
  `_shared/tool-output-retention.test.ts` and `cache-aware-compaction.test.ts`
  run via `test:shared`.
- All implementation, test, and package files this plan will edit are clean.
  Current local changes are `.pi/profiles/openai.json`, `CONTEXT.md`, and
  `plan.md`; `.pi/skills/diagram-design/` is untracked. The `CONTEXT.md` diff is
  a draft of the amendment in design decision 9 and still names the rejected
  `FreshQuerySource`; step 7 corrects it.
- `git ls-files` finds no tracked `adr/` or `adrs/` path. The tracked Provider
  Headroom design note is `headroom-tool-output-reduction.md`; it documents the
  upstream reduction mechanisms and does not govern this internal interface
  refactor.

Baseline commands were run from `.pi/`:

```bash
pnpm exec vitest run extensions/provider-headroom
pnpm typecheck
```

Both passed again during this audit. The Provider Headroom command reported 4
files and 61 tests. A temporary test-only substitution of `fresh()`'s query from
`"database timeout"` to `""` also passed all 44 module tests; the source file was
restored with no diff afterward.

## Design exploration (design-it-twice)

Four interface designs were compared on depth (leverage at the interface),
locality (where change concentrates), and seam placement. All delete
`FreshToolOutput.query` and move both query walkers into the module. They differ
only in how live Session context entries cross the seam.

1. **Constructor accessor** —
   `CreateToolOutputRetentionOptions.contextEntries?: () => readonly unknown[]`,
   captured at rebuild time like the existing `branch` option. Per-call
   knowledge is zero, but forgetting the optional accessor silently degrades the
   query to `''`. Freshness also rests on an unstated Pi invariant that the `ctx`
   captured at `session_start` remains current for every later `tool_result`.
2. **Host accessor** — `ToolOutputRetentionHost.contextEntries()`. This mixes
   input-pull into an effect-only host (`appendEntry`,
   `setRetrievalAvailable`) and requires mutable adapter state to track the
   latest context.
3. **Per-call source object** —
   `rewriteFresh(input, live: FreshQuerySource)`. This makes freshness explicit
   and lets the module catch Session-manager failures, but it adds a one-use
   interface whose only implementation is the Pi context. It also leaks Pi's
   nested `sessionManager` shape into the shared registry interface. That is a
   hypothetical seam, not useful variation.
4. **Per-call raw entries** —
   `rewriteFresh(input, contextEntries: readonly unknown[])`. The adapter reads
   `ctx.sessionManager.buildContextEntries()` once, falls back to `[]` if that
   Pi call throws, and passes the result. The retention module owns all entry
   filtering, text extraction, ordering, and truncation. The required parameter
   prevents a caller from silently omitting live state, without introducing a
   source interface used by only one adapter.

**Chosen: variant 4.** The `tool_result` event carries no message list, so raw
live entries are irreducible caller-supplied state. Reading Pi's Session manager
and handling its failure belong in the Pi adapter; deriving a relevance query
belongs in retention. This keeps both sides honest and smaller than the source
object design. The registry method used by the compaction consumer,
`projectHistory`, remains unchanged; `retrieve` also remains unchanged.
`rewriteFresh` has one production call expression, in the Pi adapter.

## Final design decisions

### 1. Scope

Move query derivation and its duplicated support code behind the Tool-output
retention module's seam. Included: the `FreshToolOutput` shape change, the
required raw-context-entries parameter, both walkers and their shared
extraction/tail rule, the reduction-limits single home, adapter deletion, test updates, and the missing
`test:headroom` wiring. Not included:
`projectHistory`'s internal eligibility re-derivation (internal to an already
deep module, pinned by ordering tests), the compaction trigger module, any
policy change, or any reducer behavior change.

### 2. Interface (`_shared/tool-output-retention.ts`)

```ts
export interface FreshToolOutput {
	toolName: string;
	input: Readonly<Record<string, unknown>>;
	isError: boolean;
	content: ToolResultContent;
	details: unknown;
} // `query: string` deleted

/** Raw material for the fresh query is supplied as live Session context entries. */
export interface ToolOutputRetention {
	rewriteFresh(
		input: FreshToolOutput,
		contextEntries: readonly unknown[],
	): FreshToolOutputRewrite;
	projectHistory(messages: readonly RetentionMessage[]): HistoryProjection; // unchanged
	retrieve(hash: string): RetentionRetrieval;                               // unchanged
}
```

`FreshToolOutputRewrite`, `HistoryProjection`, `RetentionRetrieval`,
`ToolOutputRetentionHost`, the registry functions, and the registry symbol key
`pi-config.tool-output-retention.v1` are unchanged; see design decision 10.

Caller knowledge after the change:

- `rewriteFresh`: supply the tool result fields and the live context entries.
  The adapter reads the entries exactly once before calling the module, which
  is before the enabled, protection, size, and content-block gates and matches
  today's evaluation order. `buildContextEntries()` returns the active branch
  entries after Pi applies compaction, including non-message entries. If the
  Session-manager read throws, the adapter supplies `[]`; ranking falls back to
  query `''` and an enabled reduction still runs.
- `projectHistory`: supply the messages to project; the query comes from that
  input message list before projection, never from live state or from rewritten
  output. Registry consumers keep calling it exactly as today.
- `retrieve`: unchanged. The adapter continues its first normalization stage
  and `retrieve()` continues its second. Keeping both preserves repeated-prefix
  and space-separated-prefix behavior without adding an exported helper for a
  one-line rule used at only two sites.

### 3. Walker ownership (`provider-headroom/tool-output-retention.ts`)

Two walkers share text extraction and a tail helper, but retain their current
iteration strategies:

```ts
function queryTail(text: string): string {
	return text.slice(-8_000);
}

function latestUserQueryFromEntries(entries: readonly unknown[]): string {
	let latest = "";
	for (const entry of entries) {
		if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message)) continue;
		const text = textFromMessage(entry.message as RetentionMessage);
		if (text) latest = text;
	}
	return queryTail(latest);
}
```

Do not flatten entries into a message array and then call the existing backward
walker. The current fresh walker reads messages forward and catches the whole
walk. With accessor-bearing malformed records, flatten-then-reverse can return
a later valid query without touching an earlier throwing record, while today's
walker returns `''`. Keeping the forward walk preserves that failure boundary
and avoids an intermediate array. The historical walker remains backward and
short-circuiting.

Use the direct assertion `entry.message as RetentionMessage`. After the
`isRecord` narrowing, current TypeScript 7.0.2 accepts the assertion without
TS2352. The adapter's existing `as unknown as PiAgentMessage` is unnecessary and
must not be copied into the module.

- Both walkers use `textFromMessage` and `queryTail`. They choose by array
  position, never timestamp. The fresh walker records each truthy user text
  while scanning forward; the historical walker scans backward and returns the
  first truthy user text. String content is used directly. Array content keeps
  only valid text blocks and joins their text with `"\n"`; image-only and empty
  arrays extract to `""`. This means whitespace-only strings count, and two
  empty text blocks extract to `"\n"` and shadow an earlier query. The final
  `slice(-8_000)` counts JavaScript UTF-16 code units. The fresh walker accepts
  only `{ type: "message", message: <record> }`, matching the current adapter.
  The rejected Session-entry kinds in Pi 0.84.4 are
  `thinking_level_change`, `model_change`, `compaction`, `branch_summary`,
  `custom`, `custom_message`, `label`, and `session_info`. A `message` entry is
  still ignored unless its message role is `user`; this excludes `assistant`,
  `toolResult`, `bashExecution`, `custom`, `branchSummary`, and
  `compactionSummary`. Current `CompactionEntry` has a `summary`, not a
  `retainedTail`, and `buildSessionContext()` converts it to a
  `compactionSummary` message. Neither walker treats that summary as a user
  query.
- `rewriteFresh` derives the fresh query once at entry, before resolving the
  enabled gate:

```ts
rewriteFresh(
	input: FreshToolOutput,
	contextEntries: readonly unknown[],
): FreshToolOutputRewrite {
	let query = "";
	try {
		query = latestUserQueryFromEntries(contextEntries);
	} catch {
		// Malformed live context must not prevent reduction.
	}
	const config = resolveConfig(overrides);
```

  It passes `query` to `rewriteText`, replacing the single `input.query` read
  (`tool-output-retention.ts:419`); `rewriteText`'s `query` parameter (`:338`)
  and both internal `query` pass-throughs (`:354`, `:369`) are unchanged. The
  catch preserves the current helper's treatment of exceptions while iterating
  entries or reading malformed entry/message properties. The adapter separately
  catches the Pi Session-manager call that obtains the array. If a runtime value
  violates the declared array return type and is not iterable, the module catch
  also preserves the current fallback to `''`.
- `latestUserQuery` changes only by calling `queryTail(text)` instead of the
  inline `text.slice(-8_000)`. `projectHistory` keeps
  `const query = latestUserQuery(inputMessages)`
  (`tool-output-retention.ts:441`) unchanged. Unlike the fresh path, this walker
  has no internal catch: a throwing later message aborts projection, while a
  valid later user message short-circuits before any earlier throwing message.
  The adapter and `safeProjectHistory` remain the error boundaries for that
  failure.

### 4. Reduction defaults single home (`provider-headroom/reducer.ts`)

```ts
export const REDUCTION_DEFAULTS = {
	maxLines: 120,
	maxItems: 20,
	maxSearchMatches: 40,
	maxChars: 12_000,
} as const;
```

`reducer.ts`'s internal fallbacks (`:230, :340, :443-444`) read
`REDUCTION_DEFAULTS.*`; the four private `DEFAULT_*` constants are deleted.
`resolveConfig` in `tool-output-retention.ts` imports `REDUCTION_DEFAULTS` and
its duplicated `DEFAULT_MAX_LINES/ITEMS/SEARCH_MATCHES/CHARS` constants are
deleted. `DEFAULT_MIN_CHARS`, `DEFAULT_DEDUPE_MIN_CHARS`, and
`SMALL_ERROR_MAX_CHARS` stay in the module — they are retention policy, not
reduction policy.

### 5. Adapter (`provider-headroom/index.ts`)

- Deleted: the query-helper block `:22-54`, namely the orphaned
  `PiAgentMessage` type alias (`:22`), `isRecord`, `textFromContent`,
  `textFromMessage`, and `latestUserQueryFromSession` (`:24-54`), plus the
  now-unused `ContextEvent` import specifier. `ExtensionAPI` stays used at the
  factory signature. `normalizedHash` (`:56-58`) stays unchanged; see the
  retrieval decision below.
- The `tool_result` handler keeps its guard and outer try/catch, reads live
  context once with a local `[]` fallback, and constructs the input explicitly:

```ts
pi.on("tool_result", async (event, ctx) => {
	if (!retention || event.toolName === RETRIEVE_TOOL_NAME) return;
	try {
		let contextEntries: readonly unknown[] = [];
		try {
			contextEntries = ctx.sessionManager.buildContextEntries();
		} catch {
			// Live context is optional; reduction must still run without it.
		}
		const rewritten = retention.rewriteFresh({
			toolName: event.toolName,
			input: event.input,
			isError: event.isError,
			content: event.content,
			details: event.details,
		}, contextEntries);
		return rewritten.changed ? { content: rewritten.content, details: rewritten.details } : undefined;
	} catch {
		return undefined;
	}
});
```

  Explicit construction (rather than passing the whole event) keeps the
  interface independent of Pi's per-tool event shapes and documents the
  consumed fields. The inner catch is required for behavior preservation: the
  current query helper turns a failed Session read into `''` and still invokes
  retention. Relying only on the outer catch would skip the rewrite.
- The `context` handler is unchanged.
- The `headroom_retrieve` implementation stays unchanged:

```ts
const hash = normalizedHash(params.hash);
const result = retention?.retrieve(hash) ?? { found: false as const, hash };
```

  This is deliberate. On the active path the adapter and `retrieve()` each
  normalize once. A single raw call to `retrieve()` is not equivalent for
  inputs such as `hash=hash=<valid hash>` or `hash= HASH=<valid hash> `. The
  unavailable-retention path normalizes once. Exporting a shared helper and
  reproducing the two stages elsewhere would add interface and test cost with
  no current consumer or behavior gain.

### 6. Error posture

Unchanged. Retention is optional. Host calls and the `tool_result` and
`context` event calls stay wrapped in try/catch; `safeProjectHistory` still
catches `projectHistory` failures. The registered retrieval tool is not and was
not wrapped around `retrieve()`. A throwing `buildContextEntries`, a
non-iterable runtime return, or an exception while the module examines a fresh
entry becomes query `''`; none skips an enabled reduction. When retention is
enabled, historical query extraction still throws from the module and relies on
its two existing caller error boundaries.

### 7. Tests

- `tool-output-retention.test.ts`: the `fresh()` helper drops `query`; the
  harness gains configurable context entries. They default to one user message
  with content `database timeout`, exactly matching today's `fresh()` query, so
  every pinned reduction outcome stays byte-identical by construction.
  Independently verified: all 44 current module tests pass with `query: ""`.
  None depends on query terms: the ranking fixtures retain important or boundary
  rows, while the remaining fixtures exercise paths that do not consult query
  terms. Every `rewriteFresh(fresh(...))` call passes the harness entries. Add
  seven focused interface-level tests, raising this file from 44 to 51 executed
  tests:
  1. Fresh extraction and ordering. Use query-sensitive, non-priority lines to
     prove that array position, not timestamp, chooses the last truthy user
     text. Use unique terms of at least three characters away from selected
     boundaries, because `termsFromQuery` drops shorter terms. Cover string
     content, mixed text/image block content, empty and whitespace-only strings,
     empty and image-only arrays, malformed content, and invalid text blocks.
     Pin the existing two-empty-text-block edge: it extracts to `"\n"` and
     shadows an earlier query.
  2. Fresh entry filtering. Cover every current non-message Session-entry kind:
     `thinking_level_change`, `model_change`, `compaction`, `branch_summary`,
     `custom`, `custom_message`, `label`, and `session_info`. Cover malformed
     message entries and every non-user `AgentMessage` role: `assistant`,
     `toolResult`, `bashExecution`, `custom`, `branchSummary`, and
     `compactionSummary`. None may replace an earlier user query.
  3. Fresh failure handling. A throwing `type`, `message`, `role`, `content`, or
     text-block property, including a throwing record before a later valid
     message, must degrade the whole query to `''` while an enabled rewrite still
     runs. A non-iterable entries value supplied through an `any` fixture must do
     the same. This pins the current helper's one catch around iteration and all
     extraction, rather than accidentally preserving a partial query.
  4. The fresh 8,000 UTF-16-code-unit tail applies. Put an ASCII decoy term
     before enough astral characters that code-point slicing would retain the
     decoy while `slice(-8_000)` excludes it; put the meaningful ASCII term
     inside the retained tail. Only the tail term may affect selection.
  5. Historical extraction and ordering. Prove reverse array order rather than
     timestamps with query-sensitive selection. Cover string and mixed-block
     extraction, empty content that does not shadow, truthy whitespace and
     joined-empty-block content that does shadow, malformed content, and all
     non-user roles listed above. It takes no live entries.
  6. The historical walker applies the same 8,000-code-unit tail fixture.
  7. The historical failure boundary stays distinct: a valid later user message
     short-circuits before an earlier throwing message, while a throwing later
     message propagates out of `projectHistory`.
- `index.test.ts`: the "maps fresh and context events" test asserts the new
  `rewriteFresh` call shape, the five-field input object and the built entries
  as second argument, and one `buildContextEntries` call. Add one adapter test
  in which `buildContextEntries` throws: `rewriteFresh` must still be called
  with `[]`, and its result must still be returned. Retrieval tests stay
  unchanged. This raises the adapter file from 8 to 9 tests and the full
  Provider Headroom suite from 61 to 69.
- `reducer.test.ts`, `_shared/tool-output-retention.test.ts`,
  `cache-aware-compaction.test.ts`: unchanged (existing fakes remain
  assignable; the registry fake's single-parameter `rewriteFresh` still
  satisfies the widened signature).
- `integration.test.ts`: unchanged.

### 8. Test wiring (`package.json`)

Add `"test:headroom": "vitest run extensions/provider-headroom"` and insert
`pnpm test:headroom` into the `test` chain after `test:provider-ollama`. The
`_shared` retention and compaction tests are already covered by
`test:shared`.

### 9. CONTEXT.md

The "Tool-output retention module" entry gains query derivation ownership and
the fresh-vs-historical query sources (already amended with this plan, but the
current draft must replace `FreshQuerySource` with raw context entries). No new
glossary term is warranted: the entries parameter is an interface detail of one
module, not a domain concept.

### 10. Registry versioning

Keep the symbol key `pi-config.tool-output-retention.v1`. The changed
`rewriteFresh` method is not called through the registry in production: the Pi
adapter calls the retention instance it created in the same module graph. The
only production registry consumer is cache-aware compaction, and it calls only
the unchanged `projectHistory` method. A stale registered producer therefore
remains compatible with that consumer across module re-imports. Bumping the key
would split compatible `projectHistory` producers and consumers to protect a
hypothetical registry caller that grep does not find. That cost has no current
consumer or behavior benefit.

## Implementation sequence

Steps 2–5 form one atomic unit (an interface change and its callers) and land
together; only steps 1 and 6–8 leave `pnpm typecheck` green on their own. From
step 2 until step 5 the unit is red by design: the deleted `query` field leaves
the module's own `input.query` read (`tool-output-retention.ts:419`) and the
adapter's single-argument call failing typecheck, and the test call sites are
red on arity because every `rewriteFresh(fresh(...))` call lacks the required
entries. The leftover `query` field in `fresh()` is merely stale because width
subtyping accepts it, and step 5 removes it. Do not run `pnpm typecheck`
mid-unit; run it after step 5.

1. **Reducer defaults** (`provider-headroom/reducer.ts`): add and export
   `REDUCTION_DEFAULTS`; switch the four fallback sites to it; delete the four
   private `DEFAULT_*` constants. Run `pnpm exec vitest run
   extensions/provider-headroom/reducer.test.ts`.
2. **Registry interface** (`_shared/tool-output-retention.ts`): delete `query`
   from `FreshToolOutput` and widen `rewriteFresh` to
   `(input, contextEntries)`. Keep the global symbol key unchanged.
3. **Module** (`provider-headroom/tool-output-retention.ts`): add
   `latestUserQueryFromEntries`; derive the fresh query from the second argument
   before the enabled gate in `rewriteFresh`; import `REDUCTION_DEFAULTS` in
   `resolveConfig` and delete the duplicated constants. Leave `retrieve()`
   unchanged. `_shared/tool-output-retention.test.ts` and
   `cache-aware-compaction.test.ts` must still pass untouched.
4. **Adapter** (`provider-headroom/index.ts`): delete the four query helper
   functions and the `PiAgentMessage` alias; rewire `tool_result` with the
   one-read, fail-open entries block in Final design decision 5. Leave
   `normalizedHash` and `headroom_retrieve` unchanged.
5. **Extension tests**: update `fresh()`/harness and the call-shape assertion;
   add the seven module query tests and one adapter Session-read failure test
   from Final design decision 7. The Provider Headroom command must report 4
   files and 69 tests.
6. **Test wiring** (`package.json`): add `test:headroom` and chain it.
7. **CONTEXT.md**: the module entry amendment (already drafted in Final
   design decision 9).
8. **Verification**, from `.pi/`:

```bash
pnpm exec vitest run extensions/provider-headroom
pnpm test:shared
pnpm typecheck
pnpm test
```

## Acceptance criteria

- `pnpm typecheck` passes; the full `pnpm test` chain passes, including the
  newly chained `test:headroom`.
- `FreshToolOutput` declares no `query` field; `rg "query"` in
  `provider-headroom/index.ts` returns no adapter-side query derivation.
- `index.ts` no longer defines `isRecord`, `textFromContent`,
  `textFromMessage`, or `latestUserQueryFromSession`, and carries no orphaned
  `PiAgentMessage` alias or `ContextEvent` import specifier. `normalizedHash`
  remains unchanged.
- The fresh-query rule (last truthy extracted user text by array position,
  exact content extraction, and the 8,000-code-unit tail) and the historical
  query rule are pinned through the `ToolOutputRetention` interface. The Pi
  adapter test pins one Session read and the throw-to-empty-array fallback.
- The four production reduction-default definitions exist exactly once, in
  `REDUCTION_DEFAULTS` in `reducer.ts`; documentation and test literals are not
  duplicate definitions.
- `_shared/cache-aware-compaction.ts` has a zero-line diff.
- `normalizedHash`, `retrieve()`, and the full `headroom_retrieve` path have a
  zero-line diff, preserving the current two-stage active normalization and
  single-stage unavailable-retention normalization.
- All pre-existing reduction outcomes, dedupe ordering, CCR persistence, and
  retrieval behavior stay byte-identical; test changes are limited to the
  interface-shape updates, seven query-derivation tests, and one adapter
  Session-read failure test.
- CONTEXT.md's Tool-output retention module entry states query-derivation
  ownership and the raw fresh-context-entries parameter.
- The registry symbol remains `pi-config.tool-output-retention.v1`; no registry
  consumer or registry function changes.

## Risks and controls

- **Ranking regression from walker drift.** Control: the harness's default
  live entries reproduce today's `database timeout` query exactly, so existing
  outcomes stay byte-identical. Verified: no current pinned outcome depends on
  the query terms; all 44 `tool-output-retention.test.ts` tests pass with
  `query: ""`. Ranking fixtures retain important or boundary rows, and the
  others do not consult query terms. All 61 existing tests must still pass, and
  the command must report 69 after the eight additions.
- **Walker semantic drift.** "Latest" means last by array position, and
  "non-empty" is too imprecise for the current code. Whitespace and joined
  empty text blocks are truthy. Control: the seven query tests cover every
  accepted and rejected entry, role, and content category listed in design
  decision 7.
- **Silent `''` degradation if Pi's entry shape changes.** The entry walker
  reads `unknown` entries. Control: the new walker test pins realistic
  `{type: "message", message}` fixtures and every malformed category listed in
  decision 7. The adapter's Session-manager method is typechecked; the module
  deliberately validates the returned entry contents at runtime.
- **Freshness assumptions.** Per-call entries remove the rebuild-capture
  question; no captured-state invariant is introduced. Control: the adapter
  keeps no query-related state, `index.test.ts` pins one read per event, and the
  module tests exercise the supplied entries. The integration test does not
  dispatch `tool_result`, so it covers only rebuild-time `getBranch` reads
  across branch changes, not the fresh query path.
- **Untracked `rewriteFresh` consumer.** Grep finds no second in-repo call
  expression. The adapter does not obtain retention from the registry, and the
  sole production registry consumer calls only unchanged `projectHistory`.
  Keep `v1`; do not add a key bump, overload, or compatibility adapter for a
  hypothetical registry caller.
- **Hash-normalization scope creep.** The active and unavailable-retention
  paths intentionally apply different numbers of normalization stages, and a
  one-call rewrite changes malformed-but-accepted inputs. Control: leave the
  adapter helper, module method, and retrieval tests untouched.

## Final review checklist

- The interface is the test surface: the new walker tests pass raw entry arrays
  and assert through `rewriteFresh`/`projectHistory`, never past the seam. The
  adapter alone tests Pi Session-manager access and its fail-open behavior.
- Deletion test: deleting the adapter's query walker and duplicated text
  helpers, and collapsing the reduction limits' duplicate home in
  `resolveConfig`, concentrates complexity in the module; only irreducible raw
  live entries cross the interface.
- No vocabulary drift in CONTEXT.md: module, interface, seam, adapter, depth,
  leverage, locality.

## ADR assessment

No tracked `adr/` or `adrs/` path exists, and no ADR governs this area. Provider
Headroom's tracked design note documents upstream reduction behavior rather
than this interface decision. No rejected alternative needs a separate durable
record. This plan and the CONTEXT.md amendment record the chosen interface.

## Completion condition

All steps implemented, all acceptance criteria met, the verification commands
green, and CONTEXT.md consistent with the shipped interface.