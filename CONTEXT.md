# Domain vocabulary

Shared terms for architecture work in this repo. One line per concept; extend
it when a design conversation names something new. The code lives in
`.pi/extensions/` — shared machinery in `_shared/`, one directory per
extension.

## Session & usage

- **Session entry** — one persisted record in a session file or live session
  (`message`, `model_change`, `custom`, `custom_message`, `compaction`,
  `branch_summary`, …). Carries `id`/`parentId` for the branch tree.
- **Usage classifier** — the single walker (`classifySessionEntries` in
  `_shared/usage.ts`) that turns session entries into classified usage
  entries. One rule, two consumers.
- **Classified usage entry** — one usage-bearing record: `{id, mode, model,
  input, output, cacheRead, cacheWrite, cost, turns}`.
- **Mode** — the exclusive bucket a record belongs to: `main`, `plan`,
  `subagent`, `advisor`, `guardian`. Plan mode is tracked per branch via
  `plan-mode-state` entries.
- **Usage snapshot** — the per-session view (`collectUsageSnapshot`):
  `session` is the union of all modes, `models` attributes usage to the
  producing model.
- **Accumulator** — a thin consumer that sums classified usage entries into
  an output shape (snapshot totals, per-mode totals). Classification rules
  never live here.
- **Usage table** — the bordered TUI renderer in `ui-context/usage-tables.ts`
  that turns usage rows into tables; layout fallbacks live behind its two
  functions.

## Telemetry dashboards

- **Usage dashboard** — the `/global-usage` dashboard: scans session files into
  a usage snapshot and serves it to the browser.
- **Analysis dashboard** — the `/analysis` dashboard: captures provider
  request/response events as inspectable records.
- **Analysis capture module** — the deep in-process module that owns event
  correlation, record retention, payload analysis, byte accounting, pause state,
  and diagnostics behind one synchronous interface. Analysis dashboard lifecycle
  and Pi event adaptation stay outside.
- **Child observation module** — the shared best-effort module that carries
  Observability events from a child Pi process into the parent process. It owns
  conditional child-extension loading, pipe setup, private framing, size limits,
  parsing, source attribution, and publication; observed work never fails because
  observation failed.
- **Persistent dashboard runtime** — the deep lifetime and server lifecycle
  module in `_shared/dashboard-runtime.ts` both dashboards sit on: one runtime
  per symbol key; lazy server adapters, coalesced start/close, close/start
  ordering, claim/release, orphan grace, and close-on-quit hide behind it.
- **Dashboard request lifecycle** — the shared inline-browser module in
  `_shared/dashboard-request-lifecycle.ts`: consumes and removes the capability
  token, owns authenticated JSON requests and structured failures, supersedes
  reads per named stream, supports explicit cancellation, and coalesces named
  mutations. Analysis and Usage remain separate dashboard adapters.
- **Dashboard client shell** — the shared inline-browser module in
  `_shared/dashboard-client.ts` that both telemetry dashboard pages load
  before their page clients: one capability-token guard, one roving-tablist
  behavior built from tab data, shared list/detail row styles, and shared DOM
  and number-formatting helpers. Usage and Analysis keep only their data
  rendering; tab data, statuses, fetch paths, and polling policy stay in the
  adapters.

## Subscriptions & quotas

- **Subscription probe** — the shared probe machinery in
  `provider-usage/src/probe.ts`: bounded fetch (timeout, abort,
  response-size limit), the 15-minute staleness policy, the result states
  (`ok`, `auth-required`, `unavailable`, `contract-unknown`), and the card
  row builders in `card.ts`. One probe, N provider adapters.
- **Provider probe adapter** — one provider's wire contract behind the
  probe seam (`codex` and `ollama` in `provider-usage/`): request auth,
  header candidates, contract check, normalization, and card text. Adding a
  provider means adding an adapter, never copying the probe.
- **Codex slot usage client** — the all-slot coordinator in
  `provider-usage/src/codex-slots.ts`: resolves each logical Pi Codex slot
  through the native OAuth provider, coalesces duplicate account requests,
  caches normalized results by an opaque account identity, and returns one
  safe result per slot without switching the active slot.

## Codex authentication

- **Codex credential slot** — one named account in the global
  `provider-codex` store. The active slot owns Pi's canonical `openai-codex`
  credential; inactive slots hold valid OAuth credentials in `auth.json`.
- **Logical slot auth callback** — the callback-scoped seam exposed by
  `CodexCredentialSlotStore.withRequestAuth()`. It supplies transient Pi
  request headers and an opaque cache identity while reusing native OAuth
  refresh and locking; callers cannot persist or render the credential through
  this API.

## Settings & profiles

- **Settings document** — the `.pi/settings.json` document and the shared
  read/mutate machinery in `_shared/settings-document.ts`; its canonical path
  is composed at extension entry points and passed through their dependency
  interfaces rather than rediscovered by leaf stores.
- **Profile** — a full settings document in `.pi/profiles/<name>.json`;
  switching replaces the active document.
- **Profile transition lifecycle** — the deep in-process module in
  `config-profiles/` that owns switch, create-and-activate, and active-Profile
  deletion ordering through model application, transition notices, and reload.
  Profile prompts and Pi adaptation stay outside.
- **Session profile binding** — the deep module in
  `_shared/session-profile-binding.ts` that resolves one immutable binding per
  `session_start`, owns entry/handoff/marker/reload precedence and validated
  Profile persistence, supplies the concrete Settings document path, applies
  Profile-aware adapter paths before stable initialization, isolates adapter
  failures, and performs reverse cleanup. Registration accepts the required
  Settings document path plus an optional custom Profiles directory; when the
  latter is omitted, it is derived next to the Settings document.
- **Session profile transfer** — explicit retention of the resolved Profile when
  one fresh Session replaces another; cancellation leaves the original Session
  and its Profile unchanged.
- **Plan Mode lifecycle** — the deep orchestration module that owns live Plan
  State, transitions, Profile rollback, tool projection, proposed-plan state,
  and ordering across Plan Runtime and Plan Review.
- **Model-selection lifecycle** — the deep in-process module in
  `ui-model-selector/` that owns one Session's operation admission, disposal
  draining, initialization decisions, interactive selection ordering, Profile
  persistence outcomes, and context-reduction and compaction policy. Pi
  adaptation and Session profile binding stay outside.
- **Model-selection persistence** — fixed-path, Profile-aware storage of one
  mode's model selection, constructed from an immutable Session profile binding;
  it preserves other modes and unrelated Settings document fields.

## Advisor tooling

- **Advisor execution outcome** — the structured result of one Advisor run:
  success, warning, or failure with a stable code, message, model, budget effect,
  truncation state, and optional usage. The Advisor runner owns outcome meaning;
  one Pi adapter owns tool text, details, error flags, and legacy result reading.

## Git machinery

- **Git executor** — the deep module in `_shared/git.ts` that owns bounded git
  process execution: timeout, abort, output caps, failure semantics, porcelain
  parsing, and working-tree diff collection. One executor, N callers. The
  Repository store's bounded remote fetch and tools-worktree's host-exec
  adapter sit deliberately outside it.

## Repository snapshots

- **Repository snapshot** — an immutable, commit-pinned source tree under `.pi/repos`.
- **Repository store** — the module that owns acquisition, manifests, limits, listing, locking, and explicit removal.

## Ollama Cloud catalog

- **Ollama catalog publication** — the deep consistency operation that applies
  one refresh outcome to native catalog persistence and the static `models.json`
  catalog used by extension-less child processes. It owns restore and cooldown
  bootstrap, partial-failure persistence, supersession, and best-effort static
  writes; fetching and model assembly stay outside.

## Subagent tooling

- **Subagent child execution module** — the deep process-lifetime module for one
  resolved Subagent launch. It owns private prompt and task files, child
  observation setup, process spawning and termination, JSON event meaning,
  progress and usage state, partial output, truncation, terminal results, and
  cleanup on every exit path. Agent and model resolution stay in the runner;
  Pi result rendering stays in the invocation adapter.
- **Subagent invocation adapter** — the Pi-facing deep module for one `subagent`
  tool call: selects single or parallel mode, publishes immutable live snapshots,
  formats final text and details, and applies one failure rule. Child execution
  stays in the runner; scheduling stays in the Parallel subagent batch.
- **Parallel subagent batch** — one ordered, bounded-concurrency execution of
  subagent tasks. The deep module owns validation, launch resolution, scheduling,
  and immutable task-state snapshots; Pi-specific rendering stays in its adapter.
- **Repo query batch** — the read-only batched evidence tool (`repo_query`) behind
  the subagent runner: one `executeRepoQuery` interface; validation, path safety,
  dedupe, truncation, and formatting hide inside.

## Safety

- **Guardian** — the in-process model review of risky tool calls
  (`policy-permissions/`); verdicts land as `auto-review-verdict` entries.
- **Permission enforcement lifecycle** — the deep in-process module in
  `policy-permissions/` that owns permission mode, decision ordering, prompted
  denials, one-shot retry approvals, Guardian fallback, and verdict persistence
  policy. Pi event capture, rendering, and concrete host calls stay outside.
