# Own the list/detail choreography in the Dashboard client shell

## Outcome

The Dashboard client shell absorbs the list/detail choreography that both telemetry
dashboard page adapters hand-roll today: selection reconcile against offered keys,
remember-before-scope-change, row-click re-render, the detail-or-empty decision, and
Analysis's scattered `renderedFingerprint` bookkeeping. One new factory,
`dashCreateListDetailWorkspace`, lands in `_shared/dashboard-client.ts` behind a single
`sync(forcedKey?)` entry point; the Analysis and Usage page adapters shrink to
declarative descriptors plus their own DOM. Rendered behavior stays identical: every
assertion in both `page.test.ts` suites keeps passing **without editing those files**.

## What this buys

- **Locality.** The invariant cluster — remember-before-reconcile ordering, first-offered
  fallback persistence, render-if-changed fingerprinting, staleness guarding, empty-state
  discipline — is implemented and tested once in the shell instead of being re-declared at
  ~14 hand-maintained sites across two pages.
- **Deletion.** The whole `renderedFingerprint` lifecycle (declaration + 7 touchpoints —
  the 4 hand-written resets, the `renderDetail` assignment, the failure reset, and the
  refresh comparison),
  `rememberSelection()` and its 4 call sites, `selectRequestForCurrentView()` and its 3
  call sites, the refresh path's `visible`/detail-decision juggling, and three empty-label
  constructions collapse into one factory call. Net −22 lines in Analysis (121 deleted,
  99 added), +3 in Usage (34 deleted, 37 added), +39 lines in the shell factory — all
  three measured by executing these steps literally against the current files.
- **Bug class killed at the root.** "Forgot `renderedFingerprint = null` on a transition"
  and "forgot `rememberSelection()` before a scope change" become structurally impossible:
  the auto-remember snapshot makes the store happen whether or not the adapter remembers.
- **Leverage.** Two real adapters (Analysis: hardest caller; Usage: simplest) share one
  deep module. A third dashboard gets list/detail with async detail for ~15 descriptor
  lines.

## Evidence (current line numbers, `telemetry-analysis/page-client.ts` unless noted)

- The choreography loop is hand-rolled at four sites: tab `onActivate` `:411–425`,
  subagent-row click `:447–458`, request-row click `:494–501`, refresh success `:576–597`.
- `renderedFingerprint` bookkeeping: declaration `:27`, resets `:393, :418, :452, :498`,
  assignment `:515`, failure reset `:560`, comparison `:595`.
- Memory choreography: `rememberSelection` `:367–369` (store), `selectRequestForCurrentView`
  `:375–389` (keep + parse). Usage: `sessionMemory.keep` `:529`, click store `:544–546`
  (`telemetry-usage/page-client.ts`).
- Detail bookkeeping: `renderEmptyDetail` `:391–395`, `renderDetail` prelude `:509–516`,
  staleness guard `:520`, failure `:559–562`.
- Empty labels constructed three times: `:424` (tab.label), `:457` (agent.label),
  `:589–594` (refresh's channel/subagent label logic).
- `_shared/dashboard-request-lifecycle.ts`: `read(stream, …)` aborts the previous read on
  the same stream and drops late deliveries; `cancel(stream)` aborts and clears — the
  supersede discipline the staleness guard sits on.

## Decisions (grilling round, recommended answers adopted)

**D1 — Scope: both dashboards, not Analysis-only.**
Two adapters make the seam real (one adapter = hypothetical seam). Usage's churn is ≈
net-zero lines but converts it into a genuine second adapter and conformance; a third
dashboard inherits the behavior for free.

**D2 — Responsibility split: the shell owns state and choreography, never page DOM.**
It decides *what is selected* and *whether/when to render*, never *how anything looks*.
Row construction, aria dialect (`aria-pressed` vs listbox `aria-selected`), groups,
badges, detail DOM, empty messages: all adapter-side. This is what makes zero DOM deltas
achievable.

**D3 — The fetch stays adapter-side.** The shell never receives the request-lifecycle
instance (rejects Designer 3's `requests`/`stream`/`path` options). The adapter keeps its
`requests.read('detail', …)` call and the `data-selection`/open-pointer bookkeeping; the
shell hands it `isCurrent()` and `invalidate()`. The client shell and the Dashboard
request lifecycle stay two modules with one shared seam.

**D4 — No multi-list abstraction, no `rowMark`.** (Rejects Designer 2's machinery.) One
workspace per page; Analysis's two lists are both re-rendered by the single `renderLists`
hook. Row selected-state marking stays adapter-side, so the shell cannot drift the DOM.

**D5 — Auto-remember via scope snapshot.** The workspace stores `lastScope`/`lastKey` —
the pair it last rendered — and re-stores it on every `sync()` *before* re-reading
`scopeKey()`. This reproduces today's `rememberSelection()` call order even though
adapters mutate their state before calling `sync()`. Adapter discipline (documented in
the factory): every mutation of anything `scopeKey()`/`offers()` reads must be followed
by one `sync()`. All current call sites already comply.

**D6 — `isCurrent` is scope-aware.** `() => lastScope === scopeKey() && lastKey === key`
(Designer 3's refinement over Designer 1's key-only check). The scope clause is a
zero-cost defensive superset, not a same-key-across-scope race killer: when the same key
re-resolves under a new scope it behaves identically to the key-only check — both accept,
because the guard reads the live snapshot (`lastScope`/`scopeKey()` both point at the new
scope) and the fetch target depends only on the key, never on the fetch's origin scope
(probed against the implemented factory). Its one real addition: it rejects a fetch that
lands after an adapter mutates a scope input without a `sync` — a discipline-violation
net the key-only check lacks.

**D7 — Usage adopts no fingerprint.** Its detail is synchronous and its hosts are rebuilt
per render; omitting `fingerprint` renders the detail on every sync — exactly today's
behavior. No behavior change smuggled in.

**D8 — Naming.** Factory `dashCreateListDetailWorkspace` in the `dashCreate*` family;
CONTEXT.md term **"Dashboard list/detail workspace"**.

**D9 — DOM contract.** Zero deltas on every asserted token (tabs, `aria-controls`/
`aria-labelledby`, `dataset.sequence`/`dataset.part`, `aria-pressed`, listbox
`aria-selected`, `.detail-pane h2`, `details.analysis-section[open]` persistence,
`data-selection` on the pane, `.dash-empty` texts, `.session-detail`). Two unasserted
near-deltas, both verified invisible: (a) `renderSubagentList` also runs on request-row
clicks where it didn't — it produces byte-identical DOM (early-return on non-subagent
channels, idempotent rebuild otherwise; probed on the migrated page: identical
`subagentList` outerHTML across a request-row click on the subagent channel); (b) Usage's
`selectedSessionId` is nulled during an empty search where today it goes stale —
unobservable, because the next non-empty sync re-derives the selection from memory, which
still holds it.

**D10 — Test strategy: replace, don't layer.** New tests at the shell's interface in
`dashboard-client.test.ts` (existing linkedom style, helper exposed via
`dashboardTestHelpers`). Both page suites must pass **unchanged** — they are the DOM
contract. If a page test needs an edit, stop: that is a DOM delta and the design is wrong.

## Design-it-twice record

Three parallel designers over the same brief:

- **Designer 1 (minimal)** — `dashCreateDetailWorkspace`: one factory, one runtime entry
  point `sync(forcedKey?)`; auto-remember via scope snapshot; fingerprint/staleness/cancel
  behind the seam; ~25-line implementation. **Chosen as the base.**
- **Designer 2 (flexible)** — `dashCreateListDetail`: multi-list descriptors, `rowMark`
  aria helper, optional detail host/abort. Rejected: the multi-list abstraction has ~1.5
  users and `rowMark` moves the aria invariant outside the shell's enforcement — machinery
  before a second use.
- **Designer 3 (hardest-caller)** — `activate`/`sync`/`pick` trio with the shell
  dispatching `requests.read` itself. Rejected: couples the shell to the request-lifecycle
  module and adds four options (`requests`, `stream`, `path`, `placeholder`) that exist
  for one page. **Adopted its scope-aware `isCurrent` refinement.**

Comparison: D1 and D3 match on depth and locality; they split on seam placement — D3 puts
transport behind the shell's interface, D1 keeps the shell in-process and DOM/state-only,
which matches the shell's existing vocabulary (`dashCreateSelectionMemory`,
`dashCreateTablist` know nothing of fetches). D1 wins on YAGNI and on keeping the
interface the test surface for both pages' real shapes.

## The interface (final)

Added to `_shared/dashboard-client.ts` directly after `dashCreateSelectionMemory`:

```js
function dashCreateListDetailWorkspace({
	memory,       // a dashCreateSelectionMemory() instance shared by the page
	scopeKey,     // () => string            memory view key (opaque, page-owned format)
	offers,       // () => string[]          ordered offered keys; order is the fallback policy
	select,       // (key: string|null) => void   mirror the resolved selection into page state
	renderLists,  // () => void              adapter re-renders all list DOM from its own state
	renderDetail, // (ctx) => void           ctx = { isCurrent(), invalidate() }
	renderEmpty,  // () => void              adapter renders the empty-detail state (may cancel its own reads)
	fingerprint,  // optional (key) => string; omit — detail renders on every sync (synchronous pages)
}) {
	let lastScope = null;
	let lastKey = null;
	let lastFingerprint = null;
	function sync(forcedKey) {
		// auto-remember: store the last *rendered* pair under its own scope snapshot,
		// before re-reading possibly-mutated page state.
		if (lastKey != null) memory.store(lastScope, lastKey);
		if (forcedKey != null) memory.store(scopeKey(), forcedKey);
		const key = memory.keep(scopeKey(), offers());
		const scope = scopeKey();
		const forced = forcedKey != null;
		lastScope = scope;
		lastKey = key;
		select(key);
		renderLists();
		if (key == null) {
			lastFingerprint = null;
			renderEmpty();
			return;
		}
		const next = fingerprint ? fingerprint(key) : null;
		if (!forced && fingerprint && next === lastFingerprint) return;
		lastFingerprint = next;
		renderDetail({
			isCurrent: () => lastScope === scopeKey() && lastKey === key,
			invalidate() { lastFingerprint = null; },
		});
	}
	return { sync };
}
```

**Invariants (documented in the factory and pinned by shell tests):**

1. `sync(forcedKey?)` is the only runtime entry point. `forcedKey` present ⇒ transition
   semantics (fingerprint guard bypassed — this is what replaces the request-row click's
   hand-written `renderedFingerprint = null`, the only transition that knows its key
   before `sync`); absent ⇒ refresh semantics (guard active). The tab-`onActivate` and
   subagent-click rewrites also sync unforced, and that is safe by a stronger argument:
   a scope change always resolves a different key (the scopes partition the records —
   every `(sequence, part)` key is offered under exactly one scope), and
   `itemFingerprint` equality implies the same sequence and part, hence the same key,
   hence the same scope — so the guard can never swallow a transition render. The empty
   transition resets the fingerprint in the shell's empty phase instead.
2. Order inside `sync`: auto-remember → forced store → `keep` reconcile → snapshot update
   → `select` → `renderLists` → detail phase (empty | skip | render).
3. `offers()` order is the fallback policy: `keep` persists `offers[0]` on a miss and
   leaves memory untouched on an empty offering (fixed `dashCreateSelectionMemory`
   semantics, unchanged and re-tested).
4. Keys and scope keys are opaque non-null strings; the workspace never parses them.
   Scopes are disjoint across views (`'subagent\0<id>'`, channel keys, `'sessions'`).
5. Adapter discipline: every mutation of anything `scopeKey()`/`offers()` reads must be
   followed by one `sync()`. The auto-remember snapshot makes a forgotten
   `rememberSelection()` impossible, but a forgotten `sync()` would skip the store.
6. `fingerprint(key)` is read after `select(key)` has mirrored the selection, so the hook
   may compute from page state.
7. Empty phase does not touch memory and resets the fingerprint; read cancellation on
   empty stays adapter-side inside `renderEmpty` (only Analysis has in-flight reads).

## Implementation steps

### Step 1 — Shell factory (`_shared/dashboard-client.ts`)

Insert `dashCreateListDetailWorkspace` (code above) after `dashCreateSelectionMemory`.
No other change to the file; `dashCreateTablist`, formatters, `guard` untouched.

### Step 2 — Shell tests (`_shared/dashboard-client.test.ts`)

Expose the factory in the vm harness: `dashboardTestHelpers` gains
`createListDetailWorkspace: dashCreateListDetailWorkspace`. Add tests (each with a fresh
`selectionMemory()` and stub hooks recording calls):

1. **empty offering** — `sync()` with `offers: () => []` calls `select(null)`,
   `renderLists`, then `renderEmpty`; memory untouched (second `keep` on the same view
   still returns the pre-test stored key).
2. **first reconcile** — unoffered memory → first offered key wins, is persisted, and
   reaches `select`; `renderLists` runs before `renderDetail`; a `fingerprint` hook that
   reads the select-mirrored state must see the new key (invariant 6, pinned here).
3. **forced sync** — `sync(key)` where `fingerprint` would match still renders the detail
   (transition semantics) and stores the key.
4. **refresh no-op** — second unforced `sync()` with unchanged `fingerprint` renders no
   detail (`select` and `renderLists` still run, matching today's unconditional list
   renders on refresh); changed `fingerprint` re-renders the detail.
5. **auto-remember across scopes** — after a sync that rendered key K under scope S,
   change `scopeKey`/`offers` and sync again; assert `memory.keep(S, [K, …])` returns K
   (the store happened without an explicit adapter store call).
6. **staleness token** — `ctx.isCurrent()` is `true` when invoked inside `renderDetail`;
   after a later `sync()` that resolves a different key, the captured `isCurrent()`
   returns `false`. (A scope change that re-resolves the same key leaves it `true` —
   same fetch target; see D6. Capture the first `ctx` before the second `sync` replaces
   it.)
7. **invalidate** — call `ctx.invalidate()` (simulated failure); the next unforced sync
   with the same fingerprint re-renders.
8. **fingerprint omitted** — every unforced sync renders the detail (Usage mode).

### Step 3 — Analysis migration (`telemetry-analysis/page-client.ts`)

Delete (current line numbers):

- `:27` `let renderedFingerprint = null;`
- `:367–369` `rememberSelection` (and call sites `:411`, `:449`, `:497`, and the refresh
  call inside `:576–597`)
- `:375–389` `selectRequestForCurrentView` (call sites `:417`, `:451`, and in the refresh
  block)
- `:393` the `renderedFingerprint = null;` line inside `renderEmptyDetail` (the function
  itself stays — it becomes the `renderEmpty` hook body; its `requests?.cancel('detail')`
  stays, satisfying invariant 7 adapter-side)
- `:411, :417–418, :421–424` — the tab `onActivate` body between the scope-DOM toggles
  and the trailing focus
- `:449–457` — the subagent-row click body between the same-selection guard and the end
- `:495–500` — the request-row click body
- `:509, :515` — `renderDetail`'s fingerprint local and its `renderedFingerprint`
  assignment (the `openPointers`/`dataset.selection` lines between them move into the
  hook unchanged)
- `:520` — the success-time staleness guard
- `:560` — the failure body's `renderedFingerprint = null;`
- `:579–597` — the refresh block's `visible` juggling, reconcile, `rememberSelection()`,
  list renders, and the detail-or-empty-or-skip decision

Add:

```js
const workspace = dashCreateListDetailWorkspace({
	memory: selectionMemory,
	scopeKey: selectionKey,
	offers: () => visibleSummaries().flatMap((item) => {
		const defaultKey = selectionKeyOf(item.sequence, defaultPart(item));
		const otherKey = selectionKeyOf(item.sequence, defaultPart(item) === 'response' ? 'request' : 'response');
		return [defaultKey, otherKey];
	}),
	select(key) {
		if (key == null) {
			selectedSequence = null;
			selectedPart = 'request';
			return;
		}
		const separator = key.indexOf(':');
		selectedSequence = Number(key.slice(0, separator));
		selectedPart = key.slice(separator + 1);
	},
	renderLists() {
		renderSubagentList();
		renderRequestList();
	},
	fingerprint: () => {
		const item = selectedItem();
		return item ? itemFingerprint(item, selectedPart) : null;
	},
	renderEmpty: () => renderEmptyDetail(emptyMessage()),
	renderDetail({ isCurrent, invalidate }) {
		const item = selectedItem();
		const part = selectedPart;
		const detailSelection = selectionKeyOf(item.sequence, part);
		const openPointers = detailPane.dataset.selection === detailSelection
			? expandedPointers()
			: new Set();
		detailPane.dataset.selection = detailSelection;
		detailPane.replaceChildren(element('div', 'status', 'Loading ' + part + ' #' + item.sequence + '...'));
		requests.read('detail', '/api/records/' + item.sequence, {
			success(detail) {
				if (!isCurrent()) return;
				/* unchanged body from today's :522–556 */
			},
			failure(caught) {
				invalidate();
				detailPane.replaceChildren(element('div', 'alert', caught.message));
			},
		});
	},
});

function selectedItem() {
	return visibleSummaries().find((item) => item.sequence === selectedSequence) ?? null;
}

function emptyMessage() {
	if (activeChannel === 'subagent') {
		const subagent = availableSubagents().find((agent) => agent.id === selectedSubagentId);
		return 'No captured requests for ' + (subagent?.label || 'Subagents') + '.';
	}
	return 'No captured requests for ' + (tabs.find((tab) => tab.key === activeChannel)?.label || activeChannel) + '.';
}
```

Rewrite the four choreography sites:

- Tab `onActivate`: keep the same-tab guard, the scope-DOM toggles
  (`aria-labelledby`, `subagent-mode`, `subagentList.hidden`), then
  `syncSelectedSubagent(); workspace.sync(); if (focused) sourceTablist.focus(tab.key);`.
  (`rememberSelection` before the mutation is replaced by the snapshot inside `sync`.)
- Subagent-row click: `if (agent.id === selectedSubagentId) return; selectedSubagentId = agent.id; workspace.sync();`
- Request-row click: `workspace.sync(selectionKeyOf(item.sequence, part));`
- Refresh success: `summaries = data.records.slice().reverse(); syncSelectedSubagent(); sourceTablist.update(); workspace.sync();`

Keep as-is: `selectedSequence`/`selectedPart` mirrors, `selectionKeyOf`, `selectionKey`,
`syncSelectedSubagent`, `itemFingerprint`, `defaultPart`, `visibleSummaries`,
`renderSubagentList`/`renderRequestList` row internals, all detail DOM,
`renderEmptyDetail` (minus the fingerprint line), polling, banners.

### Step 4 — Usage migration (`telemetry-usage/page-client.ts`)

Delete `updateSessionWorkspace` (`:522–552`) and its three call sites (`:546`, `:568`,
`:572`). Rebuild `renderSessions` (`:554–573`) so the workspace element and the workspace
instance are created together:

```js
function renderSessions() {
	renderCards(currentData.total, true);
	panel.replaceChildren(element("h2", "", "Sessions"));
	const toolbar = element("div", "sessions-toolbar");
	const label = element("label", "", "Search sessions");
	label.htmlFor = "session-search";
	const input = element("input");
	input.id = "session-search";
	input.type = "search";
	input.placeholder = "Name, message, project, or ID";
	input.value = sessionQuery;
	const workspace = element("div", "sessions-layout dash-workspace");
	const visibleSessions = () => currentData.sessions.filter((session) => matchesSession(session, sessionQuery));
	const sessionWorkspace = dashCreateListDetailWorkspace({
		memory: sessionMemory,
		scopeKey: () => "sessions",
		offers: () => visibleSessions().map((session) => session.id),
		select(id) { selectedSessionId = id; },
		renderLists() {
			workspace.replaceChildren();
			if (!visibleSessions().length) return;
			const list = element("div", "session-list");
			list.setAttribute("role", "listbox");
			list.setAttribute("aria-label", "Sessions");
			for (const session of visibleSessions()) {
				const button = element("button", "session-row dash-row");
				button.type = "button";
				button.setAttribute("role", "option");
				button.setAttribute("aria-selected", String(session.id === selectedSessionId));
				button.append(
					element("span", "session-title", sessionTitle(session)),
					element("span", "session-project", session.cwd),
					element("span", "session-metrics", formatDate(session.created) + " · " + formatInteger(session.total.tokens) + " tokens · " + formatCost(session.total.cost)),
				);
				button.addEventListener("click", () => sessionWorkspace.sync(session.id));
				list.append(button);
			}
			workspace.append(list);
		},
		renderDetail() {
			const selected = visibleSessions().find((session) => session.id === selectedSessionId);
			workspace.append(renderSessionDetail(selected));
		},
		renderEmpty() {
			workspace.append(element("div", "dash-empty", currentData.sessions.length ? "No sessions match this search" : "No sessions recorded"));
		},
	});
	input.addEventListener("input", () => {
		sessionQuery = input.value;
		sessionWorkspace.sync();
	});
	toolbar.append(label, input);
	panel.append(toolbar, workspace);
	sessionWorkspace.sync();
}
```

Notes: `fingerprint` omitted (synchronous detail — invariant 8); no
`data-selection` appears (the hook never writes it); a fresh instance per
`renderSessions` is safe because the module-level `sessionMemory` carries the selection
across re-creations, matching today's per-render `keep` reconcile.

### Step 5 — CONTEXT.md

In the **Telemetry dashboards** section, directly after the **Dashboard selection
memory** entry, add:

> - **Dashboard list/detail workspace** — the shared inline-browser behavior in the
>   Dashboard client shell (`dashCreateListDetailWorkspace`): one workspace per page owns
>   the list/detail choreography behind a single `sync` entry point. It auto-remembers
>   the last rendered selection into the Dashboard selection memory through its own scope
>   snapshot (adapters mutate freely and never hand-write the store), reconciles the
>   offered keys through the memory's keep fallback, drives one adapter hook that
>   re-renders all list DOM, and owns the detail phase: render-if-changed fingerprint,
>   the staleness `isCurrent` guard handed to the detail render, failure invalidation,
>   and the empty state. Adapters keep every line of row and detail DOM, the fetch
>   itself, and the meaning of keys and scope keys (composite page-adapter vocabulary).
>   Analysis dashboard (two lists, two-level selection, async detail) and Usage dashboard
>   (one listbox, synchronous detail) are its two adapters.

Also append the term where the "Dashboard client shell" entry lists what it owns, so the
two entries cross-reference.

### Step 6 — Verification

```sh
cd .pi
npx vitest run extensions/_shared/dashboard-client.test.ts \
  extensions/telemetry-analysis/page.test.ts extensions/telemetry-usage/page.test.ts
# full suite (insurance; nothing else touches these files):
pnpm test
```

Grep gates:

- `rg -c renderedFingerprint .pi/extensions/telemetry-analysis/page-client.ts` → 0 matches
- `rg -n 'rememberSelection|selectRequestForCurrentView' .pi/extensions/telemetry-analysis/page-client.ts` → 0 matches
- `rg -n "updateSessionWorkspace" .pi/extensions/telemetry-usage/page-client.ts` → 0 matches
- Both page clients still contain no `ArrowRight`/`ArrowLeft`/`Home` handling (existing
  assertions keep enforcing this)

## Behavior-preservation notes (the near-deltas)

1. `renderSubagentList` now also runs on request-row clicks (via `renderLists`). It
   early-returns on non-subagent channels and rebuilds identical DOM otherwise. Unasserted;
   verified byte-identical (identical `subagentList` outerHTML across a request-row click
   on the subagent channel).
2. Usage's `selectedSessionId` becomes `null` during an empty search (today: goes stale).
   Unobservable: the next non-empty sync re-derives the selection from memory, which
   still holds the id; today's stale-id path resolves through the same `keep`.
3. Analysis refresh no longer pre-computes `visible` for the detail decision; the shell's
   `keep` + fingerprint compare produce the same render/empty/skip outcome for every case
   enumerated in the page tests (restore-`worker` sequence, expand/collapse-preserving
   refresh, Guardian empty tab).
4. Usage's click now stores the previous id before the new one (auto-remember + forced
   store). Final memory state identical to today's single store.

## Risks and mitigations

- **Auto-remember discipline (invariant 5).** A page-state mutation without a following
  `sync()` would skip a memory store. Mitigation: the discipline is one sentence in the
  factory; every current site already ends its handlers with a sync-shaped tail, and the
  shell tests pin the store-on-sync behavior.
- **Fingerprint hook depends on `select` ordering (invariant 6).** Pinned by shell test 2
  (reconcile order, including a fingerprint hook that reads the select-mirrored state) —
  if the order ever changes, the test fails before pages do.
- **linkedom/vm harness quirks** (dataset, `aria` attributes). Mitigated: the harness is
  already exercised by six shell tests and both page suites; no new DOM APIs are used.
- **Silent behavior drift in migration.** Mitigated: Step 6's grep gates plus the
  unchanged page suites; any needed page-test edit halts the migration for reassessment.

## Verification record

This plan was executed once, end to end, in a scratch worktree (steps 1–4 plus Step 6's
targeted runs, typecheck, and gates; Step 5 is documentation-only). The full `pnpm test`
sweep was not re-run — no other suite embeds these files (verified by import grep, below),
so the `_shared` run is the widest affected surface. Results, recorded here so no
implementer has to take the empirical claims on faith:

- All three suites pass with the page tests untouched: `dashboard-client.test.ts` 14
  (6 pre-existing + 8 new, per Step 2), `telemetry-analysis` 44, `telemetry-usage` 53;
  full `_shared` directory 502 tests; `tsc --noEmit` clean; every grep gate reports 0.
- Measured deltas (the figures quoted in "What this buys"): Analysis net −22 lines
  (121 deleted / 99 added), Usage net +3 (34 deleted / 37 added), shell factory +39.
- `isCurrent` probes: same key re-resolved under a changed scope → still `true` (D6's
  claim corrected accordingly); scope input mutated without `sync` → `false` (the scope
  clause's actual benefit).
- D9(a) probe: `subagentList` outerHTML is byte-identical across a request-row click on
  the subagent channel.
- Only `telemetry-analysis/page.ts` and `telemetry-usage/page.ts` import
  `dashboard-client`; no other suite embeds the page clients, so the full `pnpm test`
  insurance run covers no additional consumers.

## Out of scope

- Fingerprint render-if-changed for Usage (no async detail; adopt only if a use appears).
- Week-start math dedup across `telemetry-usage` client/payload (separate candidate).
- Row keyboard roving or focus restoration (neither page has it today; native tab order).
- Row diffing/virtualization (both pages `replaceChildren`; the 1.5 s poll cost is unchanged).
- The other review candidates (Subagent store, session-closed outcome, selector surface,
  Model reference lookup, Todo module law, Advisor loader, custom-header deletion).

## Execution order

Steps 1–2 (shell + shell tests, green with untouched pages) → Step 3 (Analysis suite
green) → Step 4 (Usage suite green) → Step 5 (CONTEXT.md) → Step 6 (gates + full suite).
Each step ends with its suite passing; any failure stops the migration at that step.