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
- **Persistent dashboard runtime** — the shared lifetime store in
  `_shared/dashboard-runtime.ts` both dashboards sit on: one runtime per symbol
  key; claim/release, orphan grace, and close-on-quit hide behind it.

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
  read/mutate machinery in `_shared/settings-document.ts`.
- **Profile** — a full settings document in `.pi/profiles/<name>.json`;
  switching replaces the active document.
- **Session profile binding** — the deep module in
  `_shared/session-profile-binding.ts` that resolves one immutable binding per
  `session_start`, owns entry/handoff/marker/reload precedence and validated
  Profile persistence, supplies the concrete Settings document path, applies
  Profile-aware adapter paths before stable initialization, isolates adapter
  failures, and performs reverse cleanup.
- **Plan Mode lifecycle** — the deep orchestration module that owns live Plan
  State, transitions, Profile rollback, tool projection, proposed-plan state,
  and ordering across Plan Runtime and Plan Review.

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

- **Parallel subagent batch** — one ordered, bounded-concurrency execution of
  subagent tasks. The deep module owns validation, launch resolution, scheduling,
  and immutable task-state snapshots; Pi-specific rendering stays in its adapter.
- **Repo query batch** — the read-only batched evidence tool (`repo_query`) behind
  the subagent runner: one `executeRepoQuery` interface; validation, path safety,
  dedupe, truncation, and formatting hide inside.

## Safety

- **Guardian** — the in-process model review of risky tool calls
  (`policy-permissions/`); verdicts land as `auto-review-verdict` entries.
