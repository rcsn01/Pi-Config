# Deepen tool-output retention

## Status

Implemented. This plan records the finalized design for architecture-review candidate 1.

## Goal

Turn Provider Headroom's orchestration into a deep Tool-output retention module. The module will own tool policy, fresh-result rewriting, historical projection, CCR lifetime, retrieval, and cross-turn deduplication behind one small interface.

The Pi-facing Provider Headroom extension and custom compaction remain adapters at the module's seam. Normal model requests and custom compaction will use the same historical projection, so a change to reduction safety or CCR behavior has locality in one module and leverage across both callers.

## Why this work is next

Commit `58c5e18` added 595 lines in `provider-headroom/index.ts` and 515 lines in `provider-headroom/reducer.ts`; `wc -l` confirms those files remain exactly 595 and 515 lines in this checkout. The reducer is already a focused deterministic module. The extension entry point is not. It currently owns all of these concerns:

- environment and override resolution;
- tool eligibility policy;
- fresh `tool_result` rewriting;
- historical `context` rewriting;
- cross-turn deduplication;
- CCR hashing, storage, hydration, metadata, and persistence;
- retrieval-tool activation;
- retrieval result formatting;
- Pi event registration.

Custom compaction independently builds model messages with `buildSessionContext(event.branchEntries)` and `convertToLlm(...)` in `.pi/extensions/_shared/cache-aware-compaction.ts`. That path does not invoke Provider Headroom's `context` hook. Fresh results already rewritten in `tool_result` stay reduced because Pi persists the patched result, but historical-only reduction and cross-turn deduplication are absent from the summarizer request.

The deletion test confirms that the current orchestration is real but misplaced. Deleting it would spread policy, ordering, CCR state, and persistence behavior across the Pi hooks and compaction. The refactor must concentrate that complexity rather than move it.

## Domain terms

The implementation must add this term to `CONTEXT.md` after the refactor is passing:

- **Tool-output retention module**: the deep in-process module that owns Provider Headroom configuration, tool-output eligibility, fresh rewriting, historical provider projection, cross-turn deduplication, CCR state and retrieval, and the ordering of those behaviors. Provider Headroom's Pi hooks and custom compaction are adapters at its seam. The Session transcript remains authoritative. Fresh result patches persist through normal tool-result storage, while historical and compaction projection do not rewrite old Session messages.

Use existing terms exactly:

- **Session entry** and **Classified usage entry** retain their current meanings.
- **Subagent result status** and **Subagent invocation adapter** remain owned by Subagent tooling.
- **Tool-output retention module**, **CCR entry**, **historical projection**, and **custom compaction** name the concepts in this plan.

## Final decisions

The user selected the recommended answer for every design question. These are the resulting decisions.

### 1. Scope

Recommended decision: preserve current Headroom behavior, close the custom-compaction gap, and do not add new reduction behavior.

Included:

- Move orchestration out of `provider-headroom/index.ts`.
- Reuse the same historical projection for normal `context` events and custom compaction.
- Preserve all current environment variables, defaults, tool policy, metadata keys, marker syntax, and reduction rules.
- Keep retention fail-open at each Pi adapter call. A failed fresh rewrite leaves the result unchanged; a failed historical projection leaves the request or compaction input unchanged. Do not add per-block exception handling inside deterministic policy code, because it would hide programming defects without covering a current failure mode.
- Add explicit Session and active-branch lifecycle plus cross-extension registration. Rebuilding on `session_tree` preserves the current retrieve-time hydration of the selected branch and intentionally stops stale originals from an abandoned branch remaining retrievable.
- Make the existing "exact duplicate" contract literal by checking full text after the 96-bit digest lookup. This changes only the collision case.
- Add Subagent regression coverage at the generic tool-result seam.

Excluded:

- New reducer algorithms.
- Read lifecycle management.
- Provider-tokenizer integration.
- Changes to compaction thresholds or cut points.
- Rewriting assistant or user messages.
- Changes to Subagent execution, scheduling, rendering, or result formatting.
- Changes to the extension catalog or Profile defaults.
- Migration to a new CCR hash or metadata format.

### 2. Deep module shape

Recommended decision: use one stateful Tool-output retention module per active Session branch.

The module will have three behavioral entry points:

1. Rewrite one fresh tool result.
2. Project historical messages for a provider request.
3. Retrieve one CCR original.

Session hydration occurs when the adapter constructs the module, both at `session_start` and after `session_tree` changes the active branch. It is not a fourth caller-visible lifecycle protocol. Configuration remains behind the interface and is resolved on each operation so the current override and environment precedence stays intact.

### 3. Seam placement

Recommended decision: put the implementation beside Provider Headroom and put only cross-extension discovery plus structural types in `_shared/`.

Target files:

```text
.pi/extensions/_shared/tool-output-retention.ts
.pi/extensions/_shared/tool-output-retention.test.ts
.pi/extensions/provider-headroom/tool-output-retention.ts
.pi/extensions/provider-headroom/tool-output-retention.test.ts
.pi/extensions/provider-headroom/index.ts
.pi/extensions/provider-headroom/index.test.ts
.pi/extensions/provider-headroom/integration.test.ts
.pi/extensions/_shared/cache-aware-compaction.ts
.pi/extensions/_shared/cache-aware-compaction.test.ts
```

This avoids a dependency from `_shared/` back into one extension. The shared registry knows the interface, not the implementation. `provider-headroom/tool-output-retention.ts` imports `reducer.ts`; custom compaction does not.

### 4. Cross-extension discovery

Recommended decision: register the active branch's module in an identity-safe `globalThis` registry keyed by `Symbol.for`.

This seam is required because Pi loads each extension through a fresh jiti module graph. Plain module state is not shared across Provider Headroom and Session Compaction. The repository already uses the same mechanism in `_shared/subagent-service.ts` and `_shared/editor-slot.ts`.

The registry will expose:

```ts
export type RetentionMessage = SessionContext["messages"][number];

export interface ToolOutputRetention {
  rewriteFresh(input: FreshToolOutput): FreshToolOutputRewrite;
  projectHistory(messages: readonly RetentionMessage[]): HistoryProjection;
  retrieve(hash: string): RetentionRetrieval;
}

export function registerToolOutputRetention(
  retention: ToolOutputRetention,
): () => void;

export function getToolOutputRetention(): ToolOutputRetention | undefined;

export function clearToolOutputRetention(): void;
```

`clearToolOutputRetention()` exists for tests. Production code uses the identity-safe unregister function.

Registry rules:

- Use a versioned key such as `Symbol.for("pi-config.tool-output-retention.v1")`.
- Registration replaces the prior value. There is one proven producer, Provider Headroom, so owner ids, validation, and conflict policy would solve a hypothetical multi-producer problem.
- The unregister function removes only the exact module it registered. Stale cleanup from an old branch or extension instance must not remove a newer module.
- `getToolOutputRetention()` returns `undefined` when the Provider Headroom extension is not loaded or no Session has started. If the extension is loaded with `PI_HEADROOM_ENABLED=0`, it still registers a no-op module so configuration can continue to resolve on each operation.
- The registry record stores only the active module interface. The module closes over the current Session host, so registration and cleanup must match Session start, active-branch changes, and shutdown exactly.

### 5. Module interface

Recommended decision: keep the interface specific to the three proven callers rather than introduce a generic pipeline.

Use these exact operation and data names. Their information content must not grow.

```ts
export interface FreshToolOutput {
  toolName: string;
  input: Readonly<Record<string, unknown>>;
  isError: boolean;
  content: (TextContent | ImageContent)[];
  details: unknown;
  query: string;
}

export interface FreshToolOutputRewrite {
  changed: boolean;
  content: (TextContent | ImageContent)[];
  details: unknown;
}

export interface HistoryProjection {
  changed: boolean;
  messages: RetentionMessage[];
}

export type RetentionRetrieval =
  | { found: true; hash: string; original: string }
  | { found: false; hash: string };
```

The installed Pi types settle this question: `ContextEvent.messages` and `buildSessionContext(...).messages` are both the package's `AgentMessage[]`. The package does not re-export `AgentMessage` directly, but it does export `SessionContext`; derive `RetentionMessage` as `SessionContext["messages"][number]` instead of importing the transitive `@earendil-works/pi-agent-core` package. Tool-result content uses the directly exported pi-ai `TextContent` and `ImageContent` types. Do not introduce parallel structural types or broad `any` casts.

The interface deliberately does not expose:

- reduction modes or strategy names;
- `CcrStore`;
- CCR metadata validation;
- hash generation;
- block indexes;
- persistence callbacks;
- retrieval-tool activation;
- dedupe maps;
- environment parsing;
- `ExtensionAPI` or SessionManager.

### 6. Side effects

Recommended decision: inject a narrow Session host when constructing the module. Keep side-effect ordering behind the module interface.

The implementation-local constructor dependency is:

```ts
interface ToolOutputRetentionHost {
  appendEntry(customType: string, data: unknown): void;
  setRetrievalAvailable(available: boolean): void;
}
```

Rules:

- The Provider Headroom adapter implements the host with `pi.appendEntry`, `pi.getActiveTools`, and `pi.setActiveTools`.
- The Provider Headroom adapter supplies a guarded host implementation. Each host method catches its own `pi` failure. The module can therefore call the host in order without duplicating try/catch policy.
- The module decides when persistence and activation occur. Callers do not replay effect lists or learn CCR ordering.
- Custom compaction invokes the registered module. Any persistence or activation uses the Session host captured by the Provider Headroom adapter for that active Session.
- The registry unregisters the module during `session_shutdown`, so custom compaction cannot retain a stale Session host after replacement or reload.

This choice gives a smaller interface than returning effect objects and keeps ordering local. It is safe because the registry follows the active Session branch lifecycle explicitly.

### 7. Session and active-branch lifecycle

Recommended decision: construct, hydrate, register, and dispose the module with the active Session branch. Pi emits `session_tree` without a new `session_start`; constructor-only Session hydration would otherwise miss CCR custom entries on the selected branch and retain originals from the abandoned branch.

Use one adapter helper for both `session_start` and `session_tree`. It must:

1. Dispose any prior registration defensively and clear the local module reference.
2. Read `ctx.sessionManager.getBranch()` once, catching branch access failures and using an empty branch on failure.
3. Construct a fresh module with:
   - the existing extension overrides;
   - a configuration resolver that preserves current environment behavior;
   - the guarded Session host;
   - the current branch for initial hydration.
4. Hydrate `provider-headroom-ccr` custom entries and `__headroom_ccr` entries from every branch message entry's `details`, without filtering by message role, in branch and metadata-array order, so the last accepted record for a repeated hash remains the stored value. Use the current format exactly: version `1`; a lowercase 24-hex-character hash; string `original`, `toolName`, and `strategy`; and numeric `omitted`, `createdAt`, and `blockIndex`. Preserve the current acceptance of any numeric value and extra object fields. Do not recompute hashes or tighten numeric ranges in this refactor.
5. Ignore records that fail that shape or use an unknown version.
6. Activate `headroom_retrieve` only if Headroom is enabled, CCR is enabled, and the hydrated store contains at least one accepted entry. Otherwise remove it while preserving the order of every unrelated active tool.
7. Register the module.

On `session_shutdown`, the adapter must:

1. Call the identity-safe unregister function.
2. Clear its local module reference.
3. Clear its unregister reference.
4. Avoid using stale `pi` or Session objects after teardown.

All event handlers must fail open when the local module reference is absent. Retrieval returns the existing not-found result in that case. `session_tree` rebuilding is also what prevents retrieval from leaking CCR originals from an inactive branch.

### 8. Persistence and canonical data

Recommended decision: preserve the current split between fresh persistence and historical projection.

Fresh `tool_result` path:

- Rewrite eligible text before Pi persists the final tool result.
- Store CCR originals in the existing `__headroom_ccr` metadata attached to `details`.
- Preserve every pre-existing details field.
- For a record details value, add only the namespaced sibling field.
- For a non-record details value, preserve it under the existing `originalDetails` compatibility shape.
- Preserve the current `__headroom_protected` details marker for fresh `bash` and `powershell` read commands even when content stays byte-exact. This details-only patch is what lets historical projection recognize the result after command input is no longer available.
- Do not append a separate custom CCR entry for a newly rewritten fresh result. The final tool-result Session entry carries the original.

Historical `context` path:

- Project messages without rewriting old Session message entries.
- When a previously unprocessed historical result gets a lossy CCR marker, append one `provider-headroom-ccr` custom entry through the Session host.
- Mark a hash persisted before calling `appendEntry`, matching current best-effort semantics. A failed append is not retried until a new module is hydrated, so repeated requests in one branch do not flood the Session.
- Keep the current rule that persistence failure does not fail the provider request.

Custom compaction path:

- Build canonical messages from the event's fixed `branchEntries` snapshot.
- Run historical projection over that message list before `convertToLlm`.
- Do not rewrite `branchEntries`, `preparation`, `firstKeptEntryId`, or the retained-message count.
- Append the compaction instruction only after projection.
- Keep compaction summary persistence, usage, file metadata, abort behavior, and native fallback unchanged.

### 9. Processing order

Recommended decision: preserve today's ordering as a contract.

Configuration resolution is part of the compatibility contract:

- Resolve all ten current variables: `PI_HEADROOM_ENABLED`, `PI_HEADROOM_CCR`, `PI_HEADROOM_DEDUPE`, `PI_HEADROOM_MODE`, `PI_HEADROOM_MIN_CHARS`, `PI_HEADROOM_MAX_LINES`, `PI_HEADROOM_MAX_ITEMS`, `PI_HEADROOM_MAX_SEARCH_MATCHES`, `PI_HEADROOM_MAX_CHARS`, and `PI_HEADROOM_DEDUPE_MIN_CHARS`.
- Preserve the exact defaults: enabled, CCR, and dedupe are `true`; mode is `lossless_then_lossy`; `minChars` is 500; `maxLines` is 120; `maxItems` is 20; `maxSearchMatches` is 40; `maxChars` is 12,000; `dedupeMinChars` is 240; and the small-error protection cutoff is 4,000 characters.
- Extension options win through nullish precedence. Preserve the current lack of runtime validation for typed option values.
- Boolean environment values are false only for trimmed, case-insensitive `0`, `false`, `no`, and `off`; every other defined value is true.
- Positive-integer environment values use `Number(raw)` and accept only positive safe integers; all others use the current default.
- Mode is `lossless` only for the exact string `lossless`; every other value selects `lossless_then_lossy`.

For each fresh text block:

1. Read the current resolved configuration.
2. Pass through if disabled, below `minChars`, empty, or already marked.
3. Classify the tool as verbatim, lossless-only, or lossless-then-lossy.
4. Preserve the exact current taxonomy: normalized `read`, `write`, `edit`, `websearch`, `webfetch`, `web_search`, `web_fetch`, and `headroom_retrieve`; names matched by the current read-like regex; `grep`, `find`, and `ls` as lossless-only; normalized `bash` and `powershell` policy for commands matched by the current `cat|head|tail|nl|less|more|sed -n` regex, including its optional `cd ... &&` prefix; source-like shell output; and errors of at most 4,000 characters. Do not broaden shell parsing during this refactor. Preserve the fresh-marker asymmetry: only exact lowercase built-in names receive `__headroom_protected`; an uppercase custom tool name such as `BASH` gets protected by policy but does not receive that details marker.
5. Run `reduceToolOutput` with the current limits and latest user query.
6. Pass through when no candidate is smaller.
7. For lossy output with CCR enabled, create a candidate entry and decorate the result with the current marker, but do not store or persist it yet.
8. If marker overhead removes the saving, discard that candidate entry and fall back to the smaller safe lossless result or the original.
9. Only after the decorated result passes the size check, store the CCR entry and add metadata without altering unrelated details. Historical projection then marks and appends that entry through the host; fresh rewriting relies only on tool-result metadata.
10. Activate retrieval only after an accepted CCR entry is in the module's store.

For historical projection:

1. Read the current resolved configuration.
2. Derive the latest user query from the supplied messages. This intentionally makes old per-block projections query-sensitive: appending a later user message can change which rows an older result retains.
3. Traverse messages and blocks in source order.
4. Hydrate CCR metadata on messages only when it matches the exact accepted version-1 shape defined in the lifecycle section.
5. Preserve explicitly protected messages and blocks already backed by CCR metadata.
6. Reduce eligible unprocessed text blocks with the same tool policy and limits as the fresh path.
7. Persist new historical CCR originals once per hash.
8. Run cross-turn deduplication after per-block reduction.
9. Record an earliest-copy dedupe anchor only when that complete text block remained unchanged during per-block projection.
10. Replace a later projected text block when it exactly matches an anchor, is a single text block, meets `dedupeMinChars`, has no pre-existing CCR metadata for block `0`, has no Headroom marker, and is neither protected nor lossless-only. The later block need not have remained unchanged: current code may losslessly rewrite it and then dedupe it against an unchanged earlier anchor. The current code keys only by a 96-bit truncated SHA-256 digest even though its contract says exact. Store the anchor text with the digest and compare the text before replacement; this collision check is an intentional safety fix, not a policy expansion.
11. Preserve message count, order, roles, timestamps, and every untouched message field. For tool results this includes `toolCallId`, `toolName`, `usage`, `addedToolNames`, `isError`, unrelated details, image blocks, and unchanged text-block fields.
12. Return the original message array on a no-op. The verified common message type makes this possible; `changed` remains the authoritative adapter signal.

### 10. Failure semantics

Recommended decision: fail open at adapter calls. The deterministic module itself should not catch and suppress its own programming errors.

- Invalid positive-integer environment values use the current defaults. Boolean and mode environment values retain the exact permissive rules above; typed extension option values are not newly validated.
- Invalid branch entries and metadata are ignored.
- Branch access failure starts with an empty CCR store.
- The `tool_result` adapter catches an unexpected `rewriteFresh` exception and returns no patch.
- The `context` adapter catches an unexpected `projectHistory` exception and returns no patch.
- Custom compaction catches an unexpected `projectHistory` exception and uses canonical messages unchanged.
- `appendEntry` failure does not fail rewriting or compaction because the guarded host swallows it after the module marks the hash persisted.
- Active-tool read or update failure does not fail rewriting or compaction because the guarded host swallows it.
- Invalid or unknown retrieval hashes return the existing not-found result.
- Missing registry during compaction means unprojected canonical messages, not compaction failure.
- Existing custom-compaction provider, authentication, summary, and abort failures retain their current handling.

Do not add user notifications for retention failures. Current behavior is silent and best effort.

### 11. Subagent treatment

Recommended decision: do not add a Subagent-specific seam or edit `tools-subagents`.

A Subagent invocation already returns one ordinary model-visible text block and opaque rendering data in `details.results`.

The generic fresh-result adapter will:

- treat `toolName === "subagent"` with the same current default policy as any other eligible tool;
- reduce only `content` text;
- preserve `details.mode` and `details.results`;
- preserve nested `AgentResult.output`, progress, usage, timing, truncation, and status data;
- add only the existing namespaced CCR metadata sibling when a fresh lossy reduction needs recovery;
- leave Subagent rendering unchanged because the renderer continues to read `details.results`.

The tests must prove this. No production dependency from Provider Headroom to Subagent types is allowed.

### 12. Registry availability in compaction

Recommended decision: look up the module at compaction execution time.

`createCacheAwareCompaction(pi)` must not capture the registry value in its constructor because extension factories run before `session_start`. Inside `compact(...)`:

1. Build Session messages once.
2. Call `getToolOutputRetention()`.
3. If present, call `projectHistory(...)` on the canonical Pi messages, typed through `RetentionMessage`.
4. If absent or if projection throws, use the canonical messages unchanged.
5. Call `convertToLlm(...)` only after the optional projection.
6. Continue constructing provider context exactly as today.

This makes Provider Headroom optional. Disabling the extension removes the registered module, and Session Compaction does not recreate Headroom from environment defaults.

## Detailed implementation sequence

### Phase 0: establish the behavioral baseline

From `.pi/`, run:

```bash
pnpm exec vitest run extensions/provider-headroom
pnpm exec vitest run extensions/_shared/cache-aware-compaction.test.ts
pnpm test:subagents
pnpm typecheck
```

Record any pre-existing failures before editing. Do not weaken assertions to accommodate the refactor.

### Phase 1: add the shared registry seam

Create `.pi/extensions/_shared/tool-output-retention.ts`.

Implementation tasks:

1. Define the three-method `ToolOutputRetention` interface using the verified `SessionContext`, `TextContent`, and `ImageContent`-derived types above.
2. Add the versioned `globalThis` registry.
3. Implement replacement registration with identity-safe unregister.
4. Implement retrieval of the active module.
5. Export a test-only clear function consistent with `_shared/subagent-service.ts`.
6. Keep the file free of Provider Headroom constants, reducer imports, Pi event registration, and Session state.

Create `.pi/extensions/_shared/tool-output-retention.test.ts` first.

Required tests:

- returns `undefined` before registration;
- returns the registered module;
- unregister clears the exact registered module;
- stale unregister does not clear a replacement;
- later registration replaces the prior module;
- clear resets global state between tests;
- `vi.resetModules()` followed by re-import still reaches the same `globalThis` registry, proving extension-loader-style module duplication does not isolate the registration.

Do not add owner ids or multi-producer arbitration until a second producer exists.

### Phase 2: create the deep implementation

Create `.pi/extensions/provider-headroom/tool-output-retention.ts`.

Move these responsibilities from `index.ts` into the new module:

- all default constants and tool-policy sets; export the four existing compatibility constants from this module and re-export them from `index.ts`;
- `HeadroomConfig`, the exported `HeadroomExtensionOptions`, and environment parsing;
- option resolution;
- `isRecord` where it is retention-specific;
- hash generation as the first 24 lowercase hex characters of SHA-256 over the original UTF-8 text, plus direct `Date.now()` capture for the existing `createdAt` field;
- content text extraction used by projection;
- latest user query extraction from message lists: scan backward for the latest non-empty `user` text, join array text blocks with `\n`, ignore other roles and non-text blocks, and keep the final 8,000 UTF-16 code units;
- stored CCR entry and metadata validation;
- metadata extraction and additive metadata/protection helpers;
- `CcrStore` and persisted-hash tracking;
- hydration from the active Session branch's custom entries and every message entry's details, without a role filter;
- `isReadCommand`, `isReadLikeTool`, and `toolPolicy`;
- JSON marker insertion and loss descriptions;
- marker decoration and no-expansion fallback;
- single-block rewriting;
- fresh result rewriting;
- historical message projection;
- cross-turn deduplication;
- retrieval normalization and lookup;
- persistence and retrieval-availability ordering through the injected host.

Keep these in `reducer.ts`:

- content detection;
- ANSI and structural cleanup;
- JSON, search, log, and plain-text reduction;
- source-code detection;
- reduction result construction;
- Headroom marker recognition.

Do not split the new module further during this refactor. The deletion test must show that removing it would force policy, CCR, and ordering back into both adapters.

### Phase 3: test the module through its interface

Create `.pi/extensions/provider-headroom/tool-output-retention.test.ts` before moving all adapter tests. Construct the module through one concrete factory, `createToolOutputRetention({ overrides, host, branch })`; keep that factory and `ToolOutputRetentionHost` implementation-local rather than adding them to the shared registry interface.

Test categories:

#### Configuration

- all ten existing `PI_HEADROOM_*` variables;
- extension option precedence over environment values, including explicit `false`;
- the exact boolean false spellings plus uppercase/whitespace forms, and the fact that every other defined value is true;
- positive safe-integer environment parsing with zero, negative, fractional, unsafe, empty, and nonnumeric fallback cases;
- exact `lossless` versus all-other-values `lossless_then_lossy` selection;
- typed option values are not newly runtime-validated;
- disabled mode is a no-op and does not activate retrieval.

#### Fresh rewriting

- empty text and text below `minChars` pass through, while text exactly at `minChars` is eligible;
- lossless change without CCR;
- lossy change with CCR metadata and retrieval activation;
- CCR disabled leaves no hash marker or activation;
- multiple distinct text blocks keep stable `blockIndex` values;
- identical lossy blocks produce the same content hash and current metadata coalesces them by hash, retaining the later entry's `blockIndex`; both markers still retrieve the same original. Preserve and characterize this compatibility behavior rather than changing the hash or metadata format;
- image and unknown blocks are untouched;
- original content arrays and details are not mutated;
- marker overhead can force lossless fallback;
- already-marked content is idempotent;
- arbitrary record and non-record details retain their data.

#### Protection

- normalized `read`, `write`, and `edit` stay verbatim;
- all five configured web/retrieval spellings stay verbatim;
- positive and near-miss cases for both current read-like name regexes;
- normalized `grep`, `find`, and `ls` are lossless-only;
- lowercase built-in `bash` and `powershell` tool names with commands using `cat`, `head`, `tail`, `nl`, `less`, `more`, and `sed -n` stay verbatim, including leading whitespace, case-insensitive command words, and the optional `cd ... &&` prefix;
- an uppercase custom tool name such as `BASH` follows normalized protection policy but does not receive the lowercase-only fresh details marker;
- near-miss shell commands not accepted by `READ_COMMAND_RE` remain eligible;
- a protected shell read returns the current details-only `__headroom_protected` patch even when content is unchanged;
- non-record shell-read details retain the current `originalDetails` compatibility shape;
- a later historical projection reads that marker and keeps the result byte-exact;
- source-like shell output stays verbatim;
- errors of exactly 4,000 characters stay verbatim;
- errors of 4,001 characters still use the current reducer policy when they also meet `minChars`.

#### Historical projection

- accepted message metadata hydrates retrieval for both `toolResult` and non-`toolResult` roles, preserving constructor hydration's current role-agnostic scan;
- accepted custom entries hydrate retrieval;
- hydration follows branch and metadata-array order, with the last accepted repeated hash winning while any accepted custom entry marks that hash persisted;
- malformed entries and unknown versions are ignored, while accepted numeric fields and extra fields retain the current permissive validation;
- old eligible output is projected without mutating the input message;
- new historical CCR originals append once per hash;
- append failure remains fail-open;
- protected metadata survives repeated projection;
- repeated projection is idempotent;
- message order, roles, timestamps, and all untouched fields remain unchanged, including tool-result `toolCallId`, `toolName`, `usage`, `addedToolNames`, `isError`, unrelated details, image blocks, and unchanged text-block fields.

#### Deduplication

- earliest eligible result stays intact;
- later exact duplicate becomes the current Headroom reference text;
- output below `dedupeMinChars` is not replaced;
- protected reads are not deduped;
- CCR-backed blocks are not deduped;
- multi-block output is not deduped;
- non-exact projected text is not deduped; inspect that the anchor map stores the full text and checks equality after the digest lookup. Do not expose or inject the hash helper solely to manufacture a collision test;
- a later block that losslessly rewrites to an unchanged anchor's exact projected text is deduped, preserving current post-reduction ordering;
- dedupe disabled is a no-op;
- appending later messages does not change earlier dedupe replacements when per-block projection leaves those earlier blocks unchanged. Do not assert that the entire provider prefix is monotonic: the latest-user-query input can legitimately change an older lossy projection.

#### Retrieval

- plain hash, `hash=` prefix, surrounding whitespace, and uppercase normalize correctly;
- known hash returns the exact original;
- malformed and unknown hashes return not found;
- retrieval does not reduce or alter the original;
- one Session branch's module cannot retrieve another branch's entry unless that entry is present on and hydrated from the active branch.

#### Subagent regression

Use a structural `details` fixture shaped like the current Subagent invocation result. Assert that:

- model-visible `content` may be reduced;
- `details.mode` remains unchanged;
- `details.results` and every nested result field remain deeply equal;
- the nested results reference remains unchanged when additive CCR metadata is attached;
- `isError` is not changed;
- no Subagent status is inferred or rewritten.

### Phase 4: reduce Provider Headroom's Pi adapter

Refactor `.pi/extensions/provider-headroom/index.ts`.

Keep only:

- the existing exported `HeadroomExtensionOptions` and four compatibility constants, re-exported from the implementation module;
- latest-user-query extraction from `ctx.sessionManager.buildContextEntries()` for a fresh result;
- the guarded Session host implementation;
- retrieval tool registration and Pi result formatting;
- `session_start`, `session_tree`, `session_shutdown`, `tool_result`, and `context` event adaptation;
- module registration and cleanup.

Event behavior:

#### `session_start` and `session_tree`

- call the same rebuild helper with the current context;
- dispose the old registration and clear the old local reference;
- read the active branch once, construct and hydrate a new module, and register it globally;
- synchronize retrieval-tool availability from the new branch's hydrated state;
- on branch-read failure, install an empty module and deactivate retrieval rather than retaining stale state.

#### `tool_result`

- skip `headroom_retrieve` exactly as today;
- derive the latest user query from the Session;
- call `rewriteFresh` inside the adapter's fail-open guard;
- return only `content` and `details` when changed;
- return `undefined` on no-op.

#### `context`

- call `projectHistory` inside the adapter's fail-open guard;
- return `{ messages }` only when changed;
- return `undefined` on no-op.

#### retrieval tool

- call `retrieve` on the current module;
- preserve the current found and not-found content and details shape;
- return not found when no Session module exists.

#### `session_shutdown`

- unregister and drop active-branch references.

Shrink `.pi/extensions/provider-headroom/index.test.ts` to adapter tests:

- hooks and retrieval tool are registered;
- Session start constructs and registers the module;
- fresh event shape maps correctly and only allowed fields are patched;
- context event shape maps correctly;
- retrieval formatting remains byte-for-byte compatible;
- active tools retain existing order and unrelated tools;
- tree navigation rebuilds from only the selected branch, activates entries on that branch, and drops retrieval access to entries found only on the abandoned branch;
- shutdown unregisters the module;
- reload/start replacement is safe against stale unregister callbacks;
- module-call and host failures are fail-open.

Move policy, CCR, and dedupe assertions to the deep module tests. Do not keep duplicate tests on private implementation paths.

### Phase 5: integrate custom compaction

Modify `.pi/extensions/_shared/cache-aware-compaction.ts`.

At the current line that computes:

```ts
const messages = convertToLlm(buildSessionContext(event.branchEntries).messages);
```

replace the one-step conversion with explicit stages:

```ts
const canonicalMessages = buildSessionContext(event.branchEntries).messages;
const retention = getToolOutputRetention();
const projectedMessages = retention
  ? safeProjectHistory(retention, canonicalMessages)
  : canonicalMessages;
const messages = convertToLlm(projectedMessages);
```

Implement `safeProjectHistory` as a small private helper. It must catch an unexpected projection exception and return canonical messages unchanged. Do not notify the user because Headroom is optional optimization.

Preserve all existing compaction behavior:

- provider and authentication lookup;
- abort checks;
- retained-message count and invalid retained-message position fallback;
- system prompt;
- active tool definitions;
- compaction instruction text;
- model base URL override;
- summary token limit;
- thinking level;
- session id;
- summary validation;
- usage forwarding;
- file metadata;
- native fallback notifications for actual compaction failures.

Do not run projection over the synthetic compaction instruction. Append that instruction afterward as today.

Extend `.pi/extensions/_shared/cache-aware-compaction.test.ts` with:

- no registered module keeps the exact current provider context;
- a registered module receives canonical Pi messages before `convertToLlm`;
- projected messages reach `provider.streamSimple`;
- the compaction instruction is appended after projected history;
- projection does not change retained-message counting;
- projection failure falls back to canonical messages and still summarizes;
- projection failure does not emit a native-compaction warning;
- existing provider/auth/abort/summary failures behave unchanged;
- registry cleanup runs after each test to prevent cross-test leakage.

### Phase 6: prove normal and compaction parity

Add `.pi/extensions/provider-headroom/integration.test.ts` for one focused cross-extension test. Keeping it separate prevents the Pi-adapter test file from owning a compaction-provider harness.

Scenario:

1. Start Provider Headroom with a branch containing two identical dedupe-eligible historical tool results plus one larger lossy-eligible historical result. Configure `minChars` above the duplicate fixture size but below the larger fixture size, and set `dedupeMinChars` below the duplicate size. The first duplicate remains unchanged and becomes the valid dedupe anchor; the larger result creates a CCR record.
2. Run the normal `context` handler and capture projected messages.
3. Build a custom compaction event from the same branch.
4. Run cache-aware compaction with a fake provider that captures its input.
5. Assert that the historical portion sent to the summarizer equals `convertToLlm(normalContextProjection)`; do not compare provider `Message[]` directly with Pi agent messages.
6. Assert that the second duplicate is replaced in both paths. Add a companion assertion that a first result changed by per-block reduction does not become a dedupe anchor.
7. Assert that the larger result is lossy in both projections and that its custom CCR entry is persisted exactly once across the normal and compaction projections when the fake host append succeeds.
8. Retrieve that lossy result's hash through `headroom_retrieve` and assert exact original text.
9. Navigate to a branch without that CCR entry and assert retrieval no longer finds it; navigate to a branch with a pre-existing custom CCR entry and assert hydration makes it retrievable.
10. Shut down Provider Headroom and assert a later compaction call uses canonical messages because the registry is absent.

This test is required because the changed seam crosses separately loaded extensions. Unit coverage alone cannot prove registration timing and Session cleanup.

### Phase 7: documentation

Update `CONTEXT.md` with the finalized Tool-output retention module definition from this plan.

Update `.pi/extensions/provider-headroom/README.md`:

- name the deep module;
- state that normal context and custom compaction share historical projection;
- preserve the warning that Session files contain CCR originals;
- explain that moving the Provider Headroom extension to `extensions-disabled/` leaves custom compaction unprojected, while `PI_HEADROOM_ENABLED=0` leaves a registered no-op module;
- state that Subagent model-visible text is eligible while Subagent rendering details remain intact;
- keep all current environment variable documentation.

Do not change `headroom-tool-output-reduction.md`; it documents upstream Headroom behavior rather than this module layout.

No ADR is required. The plan does not contradict an existing ADR, and this checkout has no applicable ADR for Provider Headroom.

## Acceptance criteria

### Architecture

- `provider-headroom/index.ts` is a Pi adapter rather than the owner of reduction policy and CCR orchestration.
- Tool policy, fresh rewriting, historical projection, dedupe, CCR state, and retrieval have locality in one deep module.
- The external interface has exactly three behavioral operations.
- Custom compaction depends only on the shared interface and registry, never on Provider Headroom implementation files.
- Moving the Provider Headroom extension to `extensions-disabled/` leaves custom compaction behavior unchanged; `PI_HEADROOM_ENABLED=0` leaves a registered no-op module.
- The registry follows Session start, active-branch changes, and shutdown through explicit registration and identity-safe cleanup.

### Behavior

- Existing reducer output remains unchanged for all current fixtures.
- Existing Headroom environment variables and defaults remain unchanged.
- Fresh lossy results remain recoverable after Session reload.
- Historical lossy results remain recoverable after Session reload.
- Read, source, web, edit, write, retrieval, and small-error protection remain unchanged.
- Cross-turn dedupe keeps the earliest exact result and only replaces eligible later results.
- Normal context and custom compaction project the same historical tool outputs for the same canonical messages.
- Missing or failed retention never prevents compaction.
- Compaction's summary, usage, file metadata, abort handling, and fallback behavior remain unchanged.
- Subagent rendering details and authoritative status remain unchanged.

### Test quality

- Core behavior is tested through the Tool-output retention interface.
- Adapter tests assert only Pi translation, registration, lifecycle, and result formatting.
- Old orchestration tests are moved or deleted rather than retained beside equivalent new tests.
- The cross-extension integration test covers registration, projection, CCR persistence, retrieval, active-branch replacement, and teardown.
- Tests do not inspect private reducer orchestration or `CcrStore` internals.

## Verification commands

Run from `.pi/` in this order:

```bash
pnpm exec vitest run extensions/_shared/tool-output-retention.test.ts
pnpm exec vitest run extensions/provider-headroom/tool-output-retention.test.ts
pnpm exec vitest run extensions/provider-headroom
pnpm exec vitest run extensions/_shared/cache-aware-compaction.test.ts
pnpm test:shared
pnpm test:subagents
pnpm typecheck
pnpm test
```

Why this order:

1. Registry failures are cheapest to diagnose first.
2. The deep module contract runs before Pi adapters so failures stay localized.
3. Provider Headroom tests verify behavior parity.
4. Compaction tests verify the new caller.
5. Shared and Subagent suites catch registry and opaque-details regressions.
6. Typechecking catches message-shape drift across the seam.
7. The full suite is justified because both Provider Headroom and Session Compaction are default-enabled core extensions.

## Risk controls

### Risk: stale process-global module

Control:

- register on every `session_start` and rebuild on every `session_tree`;
- identity-safe unregister on rebuild and `session_shutdown`;
- no registry lookup captured at extension construction;
- tests for stale unregister, branch replacement, and post-shutdown compaction;
- no Session host remains reachable from the registry after identity-safe unregister.

### Risk: changed Session persistence ordering

Control:

- preserve fresh CCR metadata in tool-result details;
- preserve historical custom-entry persistence timing;
- keep persistence best effort;
- integration test reload retrieval, active-branch replacement, and one-entry-per-hash behavior.

### Risk: Subagent renderer drift

Control:

- no production import from `tools-subagents`;
- only model-visible content is rewritten;
- namespaced metadata is additive;
- structural Subagent fixture proves nested details remain unchanged.

### Risk: compaction behavior changes beyond projection

Control:

- isolate the code change immediately before `convertToLlm`;
- preserve the event snapshot and retained count;
- pass through when the registry is absent;
- fail open on projection exceptions;
- retain all existing compaction tests.

### Risk: tests pass against one module graph but runtime isolation fails

Control:

- registry test across module re-import/reset;
- integration test that calls Provider Headroom and custom compaction through separate imports;
- use `globalThis[Symbol.for(...)]`, matching proven repository seams.

### Risk: the refactor only moves code

Control:

Apply the deletion test at review time:

- Deleting `tool-output-retention.ts` must force policy, ordering, CCR, and dedupe back into at least the Provider Headroom and compaction adapters.
- `index.ts` must not retain parallel copies of those rules.
- `cache-aware-compaction.ts` must know only `getToolOutputRetention()` and `projectHistory(...)`.
- Tests must use the external interface as the test surface.

## Review checklist

Before merging, inspect the final diff for these specific mistakes:

- reducer strategy names leaked into the shared interface;
- broad `any` casts at the message seam;
- Provider Headroom implementation imports from custom compaction;
- custom compaction imports from `provider-headroom/`;
- a registry value captured before `session_start`;
- missing unregister during `session_shutdown`;
- stale unregister removing a newer module;
- mutation of input messages, content blocks, or Subagent nested details;
- loss of `toolCallId`, `toolName`, `timestamp`, `usage`, `addedToolNames`, `isError`, text-block fields, or image blocks during projection;
- duplicate CCR custom entries on repeated projection;
- retrieval activation for an unowned marker;
- dedupe of protected or CCR-backed output;
- projection of the synthetic compaction instruction;
- user warnings for optional projection failures;
- duplicated old tests after interface-level replacements exist;
- accidental catalog, Profile, threshold, or reducer changes.

## Expected final diff

Expected additions:

- `.pi/extensions/_shared/tool-output-retention.ts`
- `.pi/extensions/_shared/tool-output-retention.test.ts`
- `.pi/extensions/provider-headroom/tool-output-retention.ts`
- `.pi/extensions/provider-headroom/tool-output-retention.test.ts`
- `.pi/extensions/provider-headroom/integration.test.ts`

Expected modifications:

- `.pi/extensions/provider-headroom/index.ts`
- `.pi/extensions/provider-headroom/index.test.ts`
- `.pi/extensions/_shared/cache-aware-compaction.ts`
- `.pi/extensions/_shared/cache-aware-compaction.test.ts`
- `.pi/extensions/provider-headroom/README.md`
- `CONTEXT.md`

Expected unchanged files:

- `.pi/extensions/provider-headroom/reducer.ts`, except import or export cleanup proven necessary by the compiler;
- `.pi/extensions/provider-headroom/reducer.test.ts`;
- `.pi/extensions/tools-subagents/**`;
- `.pi/extensions/session-compaction/index.ts`;
- `.pi/extensions/catalog.json`;
- `.pi/settings.json`;
- `.pi/profiles/**`;

## Completion condition

The work is complete when the full test suite and typecheck pass, the shared historical projection is proven through both normal context and custom compaction, CCR retrieval survives Session reload and active-branch navigation, moving Provider Headroom to `extensions-disabled/` leaves custom compaction unchanged, and the final code passes the deletion test with the Tool-output retention module as the single place where retention meaning lives.
