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

## Subscriptions & quotas

- **Subscription probe** — the shared probe machinery in
  `subscription-usage/src/probe.ts`: bounded fetch (timeout, abort,
  response-size limit), the 15-minute staleness policy, the result states
  (`ok`, `auth-required`, `unavailable`, `contract-unknown`), and the card
  row builders in `card.ts`. One probe, N provider adapters.
- **Provider probe adapter** — one provider's wire contract behind the
  probe seam (`codex` and `ollama` in `subscription-usage/`): auth
  inspection, request header candidates, contract check, normalization,
  and card text. Adding a provider means adding an adapter, never copying
  the probe.

## Settings & profiles

- **Settings document** — the `.pi/settings.json` document and the shared
  read/mutate machinery in `_shared/settings-document.ts`.
- **Profile** — a full settings document in `.pi/profiles/<name>.json`;
  switching replaces the active document.
- **Session profile binding** — the resolver in `_shared/active-profile.ts`
  that owns the entry-wins/marker-fallback precedence.
- **Plan Mode lifecycle** — the deep orchestration module that owns live Plan
  State, transitions, Profile rollback, tool projection, proposed-plan state,
  and ordering across Plan Runtime and Plan Review.

## Repository snapshots

- **Repository snapshot** — an immutable, commit-pinned source tree under `.pi/repos`.
- **Repository store** — the module that owns acquisition, manifests, limits, listing, locking, and explicit removal.

## Safety

- **Guardian** — the in-process model review of risky tool calls
  (`policy-permissions/`); verdicts land as `auto-review-verdict` entries.
